---
name: agent-board
description: Orchestrate coding agents through agent-board — cut work into task cards, start Codex executors with agentctl, wait for board events, review diffs and run gates, answer or escalate questions, accept and merge. Use when the user wants to hand work to Codex / executor agents, to "put an epic on the board", or mentions agentctl or agent-board.
---

# agent-board — orchestrator playbook

You are the **orchestrator**. Executors (Codex CLI) write code on task cards. You cut the work, start every run, review every result, and merge. The owner watches the web board and answers the questions you escalate.

All state lives in the board. Change it **only** through `agentctl`; never edit the database, never call `codex` directly.

## Hard rules

- No card, no run. Every executor call is `agentctl start` or `agentctl resume` on a card.
- The board never starts work by itself. You start every run — and only after re-reading the card.
- Never trust an executor's "tests passed". Read the whole diff and run the gates yourself (`agentctl gate`).
- Never merge into the project's base branch without the owner's approval on the board. `agentctl epic merge` enforces it; do not work around it.
- Never touch the profile's `forbidden` files, never push, never change the client repo's config or hooks.
- At most 3 runs per task, including starts after an owner answer or rate-limit requeue. After that, re-cut the card or fix it yourself.
- Report to the owner in the owner's language.

## Before you start

```bash
agentctl status                 # board reachable? what is running?
agentctl settings               # max_slots, memory_limit_gb, stale_minutes, web_port
agentctl memory                 # memory leases (all tests share one budget)
```

- The dispatcher and the web board must be running: `agentctl serve` as a long-lived background process (one per home; a second one exits 1). The owner opens `http://127.0.0.1:<web_port>`.
- The project must have a profile at `<home>/projects/<name>.toml` (home = `$AGENT_BOARD_HOME` or `~/.agent-board`). Then run `agentctl project add <name>`. Profile fields: [references/profile.md](references/profile.md).
- `agentctl` runs from the agent-board checkout as `bun run agentctl …`, or from the packaged `agentctl.exe`.

## 1. Cut the epic

1. Read the relevant code first. Cards must be self-contained: the executor sees only the card, the project rules and the answered decisions.
2. Write one card per task — Markdown with TOML front matter, template in [references/card-template.md](references/card-template.md). For each card:
   - narrow `allowed_files`; parallel tasks must not overlap, otherwise the board will not start them together;
   - `deps` between tasks;
   - `decisions` — a snake_case key for every open choice the task depends on;
   - `light_tests` (the executor may run them);
   - `gates` with `ram_est_gb` (only you run them, under the memory budget);
   - concrete `acceptance`.
3. Show the plan to the owner: the list of cards, their order and the open decisions. **Wait for a yes.**
4. Register it:
   ```bash
   agentctl epic new <project> <EPIC> "<title>"
   agentctl task add <EPIC> <card.md>     # for each card
   agentctl task promote <ID>             # todo → next, in priority order
   ```

## 2. The loop

Wait for board events in the background — never poll by hand:

```bash
agentctl wait --for ready,review,answer,assumption_rejected,stale,failed --after <cursor> --timeout 1800 --json
```

Keep the returned `cursor` and pass it back next time; then no event is lost. Exit code 3 means the timeout passed: just wait again.

| Event | What you do |
|---|---|
| `ready` | Re-read the card against newly answered decisions; fix the card file if needed. Then `agentctl start <ID>`. Exit 2 = refused: read the reasons (`deps_pending`, `waiting_answer`, `no_slot`, `file_overlap`, `no_memory`, `paused`, `max_rounds`) |
| `review` | Review (section 3). The payload carries the run outcome: `done`, `partial`, `blocked`, `failed`, `canceled`, `rate_limited` |
| `answer` | The owner answered. Check the answer does not contradict other cards, then `agentctl start <ID>` continues the executor's session; `--fresh` starts over |
| `assumption_rejected` | Task still in `review` → resume with the correction. Already `done` → cut a follow-up task |
| `stale` | `agentctl log <ID>`. Really stuck → `agentctl stop <ID>`, then resume with a note |
| `failed` | Read `runs/<ID>/<round>/stderr.log`. Infrastructure → resume. Card problem → `reject`, fix the card, start again |

`paused` / `resumed` (subscription rate limit) need no action: the board requeues the task, and `canStart` says `paused` until it ends.

## 3. Review

```bash
agentctl review <ID> --json        # changed files (outside_allowed flags), diff stat, report, last events
git -C <home>/worktrees/<project>/<ID> diff              # read ALL of it, plus new files
agentctl gate <ID>                  # card/profile gates under the memory budget; exit 2 = fail or oom
```

Checklist: [references/review-checklist.md](references/review-checklist.md). Then exactly one of:
- `agentctl accept <ID>` — commits the executor's changes and merges `--no-ff` into the epic branch. If files outside `allowed_files` are justified: `--allow-extra "<reason>"`. A merge conflict → exit 2: merge the epic branch into the task worktree, resolve, commit, accept again.
- `agentctl resume <ID> --note <file>` — a precise review note: numbered points, each with the problem, the evidence and the expected fix.
- `agentctl reject <ID>` — the card was wrong; fix the card, then `promote` and `start` again.

A gate that ends `oom` is not a red test: the board already retried it alone with the whole budget. If it is still `oom`, the code leaks or the estimate is wrong — raise `ram_est_gb` in the card or investigate.

## 4. Questions

An executor that cannot continue ends its run `BLOCKED` with a question addressed to you. Triage it with [references/questions.md](references/questions.md):
- **Inside the card's scope** → answer it yourself: `agentctl answer <QID> "<answer>"`, then `agentctl resume <ID> --note <file>`.
- **Substance, money, risk, or a product choice** → escalate to the owner:
  ```bash
  agentctl ask <ID> --kind stop --decision <key> --text "<question>" --option "<a>" --option "<b>" --recommend "<your pick and why>"
  ```
  The task moves to "Needs your answer". The owner answers on the board (or in Telegram, if configured) and you get an `answer` event.
- **The card itself is wrong** → `agentctl reject <ID>` and re-cut it.

Assumptions in executor reports become non-blocking `assume` questions for the owner automatically; you only act on `assumption_rejected`.

## 5. Close the epic

1. All tasks `done` or `canceled` → tell the owner, with a short summary: what was built, rounds per task, anything surprising.
2. The owner clicks "Approve merge" on the board.
3. Run `agentctl epic merge <EPIC>`. It refuses (exit 2) when the base branch's working copy has tracked modifications — then give the owner the printed manual commands; never force it.

## Working unattended (owner asleep)

- Keep the `wait` loop running and keep the machine awake while runs are active.
- Decide small things yourself and log each decision (what, why, how to undo) in a decisions file the owner reads in the morning.
- On a blocking question: escalate it with `ask`, let the running executors finish, record the state, stop.
- Shut the machine down only if the owner asked for it.

## Footguns

[references/footguns.md](references/footguns.md) — Windows paths and junctions, the Codex sandbox, `codex.cmd` quoting, rate limits, data links.
