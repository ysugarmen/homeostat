# Before and after

`homeostat bench` measures what the plugin changes. It sends the same tasks through headless Claude Code twice, once with the Homeostat plugin off ("before") and once with it on ("after"), on your own code repo, and compares:

- **accuracy** on questions about your code, graded against answers your reviewers wrote;
- **corrections**: how often a coding task needed failed test output sent back before it passed;
- **repeated mistakes**: how often the agent made the mistake a reviewer once corrected;
- **cost, time and turns** per task, from Claude Code's own report.

Unlike [`homeostat eval`](eval.md), which scores rule selection without a model, every bench run is a real Claude Code session. It spends your usage: read [Budget](#budget) before the first run.

## Tasks

Write them in a YAML file in the KB repo, for example `bench/tasks.yaml`. Keep the KB repo private: the tasks describe your code.

```yaml
version: 1
model: claude-sonnet-5-5          # every agent run uses this model
judge_model: claude-opus-5-5      # optional; the default
repo: ../api                      # the code repo checkout, relative to this file
permission_mode: acceptEdits      # optional; coding runs only, the same in both conditions
questions:
  - id: db-url-last-at
    prompt: "Why do we split the database URL at the last '@' instead of using urlsplit?"
    reference: "Passwords are not URL-encoded and can contain '@', so only the last one ends the credentials."
    must_mention: ["not URL-encoded", "last @"]   # optional key facts
    source: "rule db-url-last-at"                  # optional; ignored by the runner
coding:
  - id: sms-model-validator
    base: 3f2c9e1                  # the commit before the fix
    prompt: "Add validation to the SMS model so an empty sender is rejected."
    grade:
      tests:
        files: { "tests/test_sms.py": "fixtures/sms-model-validator/test_sms.py" }
        cmd: "uv run pytest tests/test_sms.py -q"
        timeout: 300
    max_feedback: 3
  - id: retry-helper
    base: 8a71d04
    prompt: "Call the partner's status endpoint from the sync job."
    grade:
      judge:
        mistake: "Called fetch directly, with no retry or timeout."
        fix: "Goes through the shared http client's retry helper."
```

| Key | Meaning |
| --- | --- |
| `model` | The agents' model, pinned for every run. |
| `judge_model` | The judge's model (default `claude-opus-5-5`); `--judge-model` overrides it. Keep it different from `model`. |
| `repo` | The code repo checkout, relative to the task file (or `--repo`). Questions run in it as it is; coding tasks in a fresh worktree of it. |
| `permission_mode` | Claude Code's `--permission-mode` for coding runs. The default, `acceptEdits`, lets the agent edit files and refuses commands that would ask. `bypassPermissions` also lets it run commands; use it only on a machine you would let any command run on. |
| `questions[].reference` | The answer, in your reviewers' words. The judge compares with it. |
| `questions[].must_mention` | Facts a right answer must contain, in substance. |
| `coding[].base` | The commit the task starts from: the parent of the fix. It must be in the checkout. |
| `coding[].grade.tests` | Hidden tests: `files` maps a path in the repo to a file next to the task file; `cmd` runs them; `timeout` in seconds (300). |
| `coding[].grade.judge` | When tests are impractical: the `mistake` the reviewer corrected and what the `fix` does. |
| `coding[].max_feedback` | How many times failed test output goes back to the agent (3). |
| `source` | Where the task came from, for you. |

Ids are lowercase letters, digits, `.`, `_` and `-`. A coding task has exactly one of `tests` or `judge`.

**Good tasks** come from your own history: a question a newcomer asked that a rule answers, a PR where a reviewer corrected the agent. Take the commit before the fix as `base`, phrase the prompt as a developer would (without the answer in it), and write the hidden test from the fix's own test. Include tasks the KB has nothing about, too, so a gain on the rest is not just more context everywhere.

## Running

```sh
homeostat bench run --tasks bench/tasks.yaml --condition before --budget 5 --dry-run
homeostat bench run --tasks bench/tasks.yaml --condition before --budget 5
homeostat bench run --tasks bench/tasks.yaml --condition after --budget 5
homeostat bench report --tasks bench/tasks.yaml
```

| Flag | Meaning |
| --- | --- |
| `--tasks <file>` | The task file. |
| `--condition before\|after` | Plugin off or on. |
| `--budget <usd>` | Required. Stop before this run spends more (below). |
| `--repeats <n>` | Runs per task (2). |
| `--only <ids>` | Only these tasks, comma-separated. |
| `--out <dir>` | Results folder (default `results/` next to the task file). |
| `--judge-model <model>` | The judge's model. |
| `--plugin <id>` | The plugin's Claude Code id, `name@marketplace` (default: found with `claude plugin list`). |
| `--repo <dir>` | The code repo, instead of the task file's `repo`. |
| `--timeout <minutes>` | The longest one agent call may take (30). |
| `--dry-run` | Print what would run and an estimate. Nothing is called. |

Runs go one at a time, never in parallel: first repeat 1 of every task, then repeat 2.

**A question** is one call, `claude -p <prompt> --output-format json --model <model>`, in the code repo, and then one judge call that scores the answer 0 (wrong), 1 (partly) or 2 (right) against `reference` and `must_mention`.

**A coding task** gets a fresh `git worktree add --detach` of `base` in a temporary folder, and the agent runs there.

- **With tests**, the agent's change (new files included, any change to the hidden test paths left out) is applied to a second clean worktree of `base`, the hidden test files are copied in, and `cmd` runs with its timeout. If it fails, the last 2,500 characters of output go back to the same session with `claude -p --resume <session>`, up to `max_feedback` times. Each of those rounds is one **correction**. A task is **solved** if its tests pass at all, and counts as a **repeated mistake** if they did not pass the first time: the hidden test is the one that catches the mistake the reviewer corrected.
- **With a judge**, one judge call reads the change against `mistake` and `fix`: `repeated-mistake`, `ok` (solved) or `incomplete`. There are no corrections.

The worktrees are removed afterwards. Your checkout itself is never changed.

**The judge** is a separate `claude -p` call on `judge_model`: no tools, no settings files, no MCP servers, no session saved, the plugin off, and a JSON Schema for its reply, which is checked again on arrival. An unusable reply is asked once more; a second leaves the run unscored (it shows in the report as unfinished). Both attempts count in the budget.

## How the plugin is turned off {#plugin-off}

For a "before" call the runner adds

```text
--settings '{"enabledPlugins":{"homeostat@homeostat":false}}'
```

with the plugin's real id from `claude plugin list --json`. Claude Code layers `--settings` over your settings files for that one process, so the plugin is disabled for the call: its hooks are not registered, its MCP server does not start and its skills are not loaded. Your settings files are not written, and everything else (other plugins, MCP servers, `CLAUDE.md`, permissions) stays as it is, so the plugin is the only difference between the conditions. As a second guard, the call's environment has `HOMEOSTAT_AGENT=1`, which makes Homeostat's hooks do nothing even if they were loaded.

You can check the switch without spending anything:

```sh
claude --settings '{"enabledPlugins":{"homeostat@homeostat":false}}' mcp list    # no plugin:homeostat server
claude --settings '{"enabledPlugins":{"homeostat@homeostat":false}}' --debug-file /tmp/cc.log mcp list
grep 'plugin homeostat' /tmp/cc.log    # "enabled=false; will NOT register, plugin is disabled"
```

"After" is your normal setup. Before running, the runner checks that the plugin is installed (and, for "after", enabled), and stops if not. Both conditions allow the plugin's MCP tools (`--allowedTools mcp__plugin_homeostat_homeostat`), since a headless run cannot ask you; in "before" they do not exist.

The plugin is not the only way rules reach an agent. If the code repo has files written by `homeostat export` (a `CLAUDE.md` block, `.claude/rules`, `AGENTS.md`), "before" sees them too. Remove them in the tasks' `base` commits, or know that "before" is not knowledge-free.

## Budget {#budget}

Claude Code reports a cost for each call (`total_cost_usd`), on an API key or a subscription alike; on a Team or Max plan it is the API-price equivalent, which tracks how much of your weekly limit a run uses. The runner adds up every call, agents and judge, and:

- **before each task and each call**, stops if what is spent plus a deliberately high estimate for it would pass `--budget`. The estimate is 1.5 times the most a call of that kind has cost so far (in this run or earlier results), or before any: $1 for a question, $3 for a coding task, $1.50 for a correction, $0.30 for a judge call;
- passes what is left to each call as `--max-budget-usd`, so even one call cannot overrun it;
- **stops at the first rate or usage limit** Claude Code reports, in its JSON or its exit, and keeps everything finished so far.

A timed-out call reports no cost, so its estimate is counted instead. `--dry-run` prints the estimate for what is left, and the worst case with every correction used. Start with `--only` one task and `--repeats 1` to see real costs.

The budget is per invocation. When a run stops, it says what it spent and how many runs are left.

## Resume

Each finished (task, repeat) is one line in `<out>/<condition>.jsonl`. A rerun of the same command skips those, so a run cut by the budget or a limit continues where it stopped. A task cut in the middle runs again from the start. To redo a task, delete its lines.

## Results

`<out>/before.jsonl` and `<out>/after.jsonl` hold, per run:

| Field | Meaning |
| --- | --- |
| `id`, `kind`, `repeat`, `condition`, `at` | Which run, and when |
| `model`, `judgeModel` | The models |
| `score` | Questions: 0, 1 or 2; null when the judge gave no usable verdict |
| `grade`, `outcome` | Coding: `tests` (`solved`, `unsolved`) or `judge` (`repeated-mistake`, `ok`, `incomplete`) |
| `solved`, `repeatedMistake`, `corrections` | Coding |
| `agentCostUsd`, `judgeCostUsd`, `costUsd` | Cost: the agent's calls, the judge's, both |
| `durationMs`, `turns`, `tokens` | The agent's calls: time, turns, input, output and cache tokens |
| `sessionId` | The agent's Claude Code session |
| `error` | Why the run did not finish normally: `timeout`, `error_max_turns`, `judge-unusable` |

The answers, diffs, test output and the judge's reasons go to `<out>/<condition>-transcripts/`, one Markdown file per run. The runner writes a `.gitignore` in `<out>` that keeps them out of git: they hold your code. The results files hold no prompts, answers or code, so you can commit them to the private KB repo.

## Report

`homeostat bench report --tasks bench/tasks.yaml` (or `--out <dir>`) prints one row per measure:

| Measure | |
| --- | --- |
| Questions: right | share scored 2 |
| Questions: mean score | 0 to 2 |
| Coding: repeated mistake | share |
| Coding: corrections per task | tasks graded by tests |
| Coding: solved | share |
| Cost, time, turns per task | the agent's calls, not the judge's |

Each task counts once: its value is the mean of its repeats. Per condition you get the median and mean over tasks; then the **change** (after minus before, over tasks run in both), a **95% interval** on it from 2,000 bootstrap resamples of the tasks (seeded, so it prints the same each time), and the **spread**: the mean range across a task's repeats, which shows how much a rerun alone moves the numbers. An interval that includes zero is no evidence of a difference.

### Public JSON {#json}

`homeostat bench report --json [file]` prints (or writes) aggregates only, for a public page. It holds no task id, prompt, answer, diff, session or repo name:

```json
{
  "schema": "homeostat-bench/1",
  "generatedAt": "2026-10-25T10:00:00.000Z",
  "models": ["claude-sonnet-5-5"],
  "judgeModels": ["claude-opus-5-5"],
  "repeats": { "before": 2, "after": 2 },
  "dates": { "first": "2026-10-20", "last": "2026-10-24" },
  "tasks": { "questions": 12, "coding": 8, "codingTests": 5, "codingJudge": 3 },
  "runs": { "before": 40, "after": 40 },
  "measures": [
    {
      "name": "question_accuracy",
      "unit": "share",
      "before": { "tasks": 12, "runs": 24, "mean": 0.42, "median": 0.5, "spread": 0.25 },
      "after": { "tasks": 12, "runs": 24, "mean": 0.71, "median": 0.75, "spread": 0.17 },
      "pairedTasks": 12,
      "delta": 0.29,
      "ci95": [0.12, 0.46]
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `measures[].name` | `question_accuracy`, `question_score`, `coding_repeated_mistake`, `coding_corrections`, `coding_solved`, `cost_usd`, `time_s`, `turns` |
| `unit` | `share` (0 to 1), `score` (0 to 2), `count`, `usd` or `seconds` |
| `before`, `after` | `tasks` and `runs` with a value; `mean` and `median` over task means; `spread`, the mean range across repeats (null without repeats) |
| `pairedTasks`, `delta`, `ci95` | Tasks in both conditions; the mean of after minus before over them; the 95% bootstrap interval (null under two tasks) |

Numbers with no data are `null`.

## Caveats

- **Small samples.** Twenty tasks with two repeats is a small sample, and agent runs vary from one run to the next. Read the interval and the spread before the change. Run more repeats before you quote a number.
- **The judge is a model.** It is noisy and can be wrong, especially on partly-right answers. It runs on a different model from the agents, sees the reference and the answer only, and is asked once more on unusable output, but a score of 1 is a judgement call. Read a sample of transcripts. Hidden tests are the firmer measure.
- **Overfitting.** Tasks taken from the rules the KB holds measure whether the KB answers them, which it was built to do. Add tasks the KB knows nothing about, and keep tasks you used to write a rule out of the set you report.
- **The plugin is not the only channel.** Exported rules files in the code repo reach "before" too ([above](#plugin-off)).
- **Cost is Claude Code's figure,** the API-price equivalent, not your bill.
- **The environment changes.** Run both conditions close together, with the same Claude Code version, model and KB, or the comparison measures those too.
