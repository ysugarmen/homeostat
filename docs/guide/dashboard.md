# Dashboard

```sh
homeostat dashboard --dir path/to/team-kb     # http://localhost:4747
```

A local, read-mostly view of the KB and this machine's event log. It binds to localhost, loads nothing external, and sends nothing anywhere.

| Page | Shows |
| --- | --- |
| Overview | Health, agent liveness (last run, failures, next run), recent activity |
| Entries | Every rule by status, with the full explanation per rule |
| Members | Who contributes and reviews |
| Coverage | Areas and repos with and without rules |
| Impact | Sessions given rules, rules per session, the most-used rules, MCP tool use |
| Documents | Section reads and session use; sections unused and unconfirmed for 90 days are marked for review |
| Desire paths | Tool names agents guessed, which may be worth making real |
| Events | The raw event log |
| Settings | Forms for every key in `homeostat.yaml`; changes are written to the file, to commit on a branch |

`homeostat up` serves it too, alongside the scheduled agents. In Docker it listens on all interfaces: put it behind your own authentication.
