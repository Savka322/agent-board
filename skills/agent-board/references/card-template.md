# Task card template

A card is Markdown with TOML front matter between `+++` lines. The front matter holds every field except `goal`; the Markdown body is the goal.

```markdown
+++
id = "PAY-3"                      # ^[A-Z][A-Z0-9]*-\d+[a-z]?$
title = "Retry failed webhook deliveries"
epic = "PAY"
allowed_files = [                 # globs, as narrow as possible
  "src/webhooks/retry.ts",
  "src/webhooks/retry.test.ts",
]
deps = ["PAY-1"]                  # tasks that must be done first
decisions = ["retry_backoff"]     # snake_case keys of open choices this task relies on
light_tests = ["bun test src/webhooks/retry.test.ts"]   # the executor may run these
gates = [                         # only the orchestrator runs these, under the memory budget
  { cmd = "bun test src/webhooks", ram_est_gb = 1 },
]
acceptance = [
  "a failed delivery is retried 3 times with exponential backoff",
  "retries stop after a 2xx response",
  "no change to the public webhook payload",
]
notes = "Optional context that does not fit elsewhere."
+++
What to build and why, in plain words. Point to the files and functions to read first.
Say what must NOT change. Mention traps you already know about.
```

## What makes a good card

- **Self-contained.** The executor sees only this card, the project rules, the answered decisions and, on resume, your note. Name the files to read.
- **One reviewable change.** If the diff will be longer than you want to read in one go, split the card.
- **Narrow `allowed_files`.** Every file outside them is flagged at review. Parallel cards must not overlap.
- **Decisions are explicit.** Any choice you are not sure the owner agrees with gets a decision key. Answered decisions are injected into every card that lists the key.
- **Acceptance is checkable.** Each line is something you can verify in the diff or with a gate.
- **Gates carry an honest `ram_est_gb`.** Too low → `oom`, then an exclusive retry; too high → gates wait for memory needlessly. After a few runs the board learns the real peak.
