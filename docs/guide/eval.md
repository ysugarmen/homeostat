# Measuring selection

`homeostat eval` checks that the right rules reach a session. You write cases: the files a session touches, or what an agent would search for, and the rules it should get. The command runs each case through the same code the session hook and the MCP tools use, and reports how high the expected rules ranked. It makes no model call, so it can run in the KB repo's CI.

## Cases

Put them in `eval/selection.yaml` in the KB repo (or pass `--file`):

```yaml
cases:
  - name: tax file
    repo: api                      # multi-repo KB: the session's repo
    paths: [services/billing/tax.ts]
    expect: [billing-tax-per-line]
  - name: refund question
    repo: api
    task: how do I refund part of a gift card payment
    expect: [billing-gift-card-partial, billing-refund-idempotency]
```

| Key | Meaning |
| --- | --- |
| `paths` | Files the session touches. Scored through session selection: what the SessionStart hook and the MCP `context` tool serve, under the session's token budget. |
| `task` | Text an agent would search for. Scored through keyword search: what the MCP `search` tool and `homeostat search` return (10 hits). |
| `repo` | The session's repo in a multi-repo KB; without it, only the shared rules. |
| `expect` | Rule ids that should be served. Order does not matter. |
| `name` | Optional label for the report. |

A case with both `paths` and `task` is scored twice, once per surface. Expected rules must exist in that repo (or the shared rules) and be accepted. The eval reads the KB the way your own sessions do (pending lessons included) and ignores team-only areas, so every rule can be a case.

Good cases are the ones that went wrong: a rule nobody saw though it named the file being changed, a search that missed the obvious rule. Add one whenever that happens.

## Output

For each case: the rank of the first expected rule and how many were served. Then, per surface and overall, at k = 1, 3, 5 and 10:

| Metric | Means |
| --- | --- |
| Hit@k | Share of cases with an expected rule in the top k |
| MRR@k | Mean of 1/rank of the first expected rule within k |
| nDCG@k | Rank-weighted gain against the ideal order |
| Recall@k | Share of expected rules in the top k |
| Precision@k | Share of the top k that was expected (divided by k) |
| R-precision | Precision at the number of expected rules: for one expected rule, "was it first" |
| MRR | Untruncated: tells "ranked too low" from "never found" |
| served | Share of expected rules actually served: within the token budget for a session, in the 10 hits for search |

A session ranks every rule that applies: those served first, then the ones that did not fit. `--json` prints the same as one object.

## Exit code

`homeostat eval` exits 1 only when:

- a case names an unknown rule or repo, or a rule that is never served (a candidate, a rejected decision);
- most cases reach no expected rule at all, which means the cases are wrong (paths, repo, ids), not the ranking;
- a floor given with `--min` is missed. Floors are over all cases: `--min hit@5=0.8 mrr=0.5 served=0.9`. Metrics at a cutoff are `hit`, `mrr`, `ndcg`, `recall` and `precision` with `@1`, `@3`, `@5` or `@10`; `mrr`, `r-precision` and `served` take none.

Otherwise it exits 0, however low the numbers: set floors once you know your baseline.

## The built-in fixture

Homeostat's own tests run a synthetic KB of 150 rules in two repos and a shared core, with 40 cases (`packages/core/test/selection-fixture.ts`). It includes the hard kinds: a general rule naming the touched file, a broadly scoped rule whose text names the exact helper, one specific file among thirty generic ones, near-duplicate titles, and search words found only in a rule's body. Measured at a 1,600-token session budget:

| Surface | Hit@1 | Hit@3 | Hit@10 | MRR | nDCG@10 | served |
| --- | --- | --- | --- | --- | --- | --- |
| session (25 cases) | 0.200 | 0.240 | 0.720 | 0.312 | 0.373 | 0.829 |
| search (15 cases) | 1.000 | 1.000 | 1.000 | 1.000 | 0.992 | 1.000 |

The metrics are adapted from vectorize-io/hindsight, MIT.
