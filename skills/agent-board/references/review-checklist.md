# Review checklist

Go through it for every `review` event, before `accept`.

1. **Scope.** `agentctl review <ID> --json` → no `outside_allowed` files, or a reason you would write into `--allow-extra`. No changes to the profile's forbidden files.
2. **Read the whole diff.** `git -C <worktree> diff` plus every new file. Not just the stat, not just the executor's summary.
3. **Acceptance.** Tick each acceptance line against the diff. Missing one → resume.
4. **Tests are real.** New behavior has tests; the tests assert behavior, not implementation trivia; nothing is skipped or loosened to make the suite pass. A test that passes when the feature fails is a bug.
5. **Gates.** `agentctl gate <ID>`: `pass` for all. `fail` → resume with the failing output. `oom` after the exclusive retry → investigate.
6. **Report honesty.** Compare the report's `tests_run` with the log (`agentctl log <ID>`). Claims you cannot see in the log do not count.
7. **Assumptions.** They are yours to check: the owner does not see them. Hold each one against the card and the code. Wrong → resume. Fine → nothing to do; `accept` records the ones with a decision key in the decisions log. Behavior the owner would notice (product semantics, money, risk) that the card did not settle → `agentctl ask <ID> --kind assume` with options and your recommendation.
8. **Leftovers.** No debug prints, stray files, commented-out code, or personal paths and secrets.
9. **Consistency.** Matches the code around it: naming, comment density, idioms, the project's language for comments.

A good resume note is a numbered list. For each point: what is wrong, the evidence (file:line, command output), and what you expect instead. End with the acceptance for this round.
