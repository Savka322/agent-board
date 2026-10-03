# agent-board

[Русский](README.ru.md)

A local kanban board for coding agents. Every agent run goes through a task card, so you can see who is doing what right now and what is blocked by what. Every run also leaves a history: the card, the review rounds, the report and the outcome.

- **Orchestrator:** Claude Code with the bundled `agent-board` skill. It cuts an epic into task cards, starts every run, reviews every diff, runs the tests and merges.
- **Executors:** Codex CLI. Each task runs in its own git worktree and branch.
- **You:** watch the board in the browser, answer the questions the orchestrator escalates and approve the final merge.

> **Early, Windows-first.** Built and tested on Windows 11. The memory limiter (Job Objects) and notifications are Windows-only for now.

> **Agents write code in your repository.** The board works in its own worktrees and local `agent/*` and `epic/*` branches. It does not touch the files of your working copy and never pushes. Still, use a repository you have backed up, and read what you merge.

## What the code enforces

The rules live in code, not in a prompt:

- **No card, no run.** Codex starts only through `agentctl start` or `agentctl resume` on a card.
- **Scope.** `accept` refuses a diff that touches files outside the card's `allowed_files`, unless the orchestrator records a reason.
- **At most 3 runs per task.** After that, the card has to be re-cut.
- **Questions.** An unsure executor stops with a question. The orchestrator answers it or escalates it to you. Tasks that depend on the same decision wait for your answer.
- **Memory budget.** Test runs and agents share one ceiling (16 GB by default), and each run gets its own Windows Job Object. Running out of memory is reported as `oom`, not as a failing test.
- **Merge approval.** The epic branch goes into your base branch only after you click "Approve merge" on the board. `epic merge` never pushes and refuses to merge into a checkout with uncommitted changes.

## Requirements

- Windows 10 or 11
- [Bun](https://bun.sh) 1.4+
- Git 2.38+
- [Codex CLI](https://github.com/openai/codex) 0.159+, logged in (`codex login`)
- [Claude Code](https://claude.com/claude-code) for the orchestrator

## Install

```bash
git clone https://github.com/Savka322/agent-board.git
cd agent-board
bun install
bun run web:build
```

Check that your machine supports what the board needs: detached processes, killing a process tree, Job Objects, notifications and SQLite. The check shows one test notification.

```bash
bun probes/run-all.ts
```

Install the orchestrator skill for Claude Code. It goes to `~/.claude/skills/agent-board`, with the path to this checkout written in:

```bash
bun run agentctl install-skill
```

Optional: register an app name for Windows notifications. Without it, notifications come from PowerShell. This writes one registry key under `HKCU`; `notify uninstall` removes it.

```bash
bun run agentctl notify install
```

## Quick start

**1. Start the board** and keep the terminal open:

```bash
bun run agentctl serve
```

Then open http://127.0.0.1:8790.

**2. Describe your project** in `~/.agent-board/projects/<name>.toml`:

```toml
name = "shop"
repo = 'D:\code\shop'
base_branch = "main"
light_tests = ["bun test --bail"]                  # the executor may run these itself
gates = [{ cmd = "bun test", ram_est_gb = 2 }]     # only the orchestrator runs these, under the memory budget
data_links = [{ from = 'D:\code\shop\node_modules', to = "node_modules", mode = "link" }]
rules = ["TypeScript strict. Follow the existing style."]

[executor]
kind = "codex"
model = "<codex model id>"
effort = "high"
sandbox = "workspace-write"
extra_config = []
```

All the fields are described in the [profile reference](skills/agent-board/references/profile.md).

Executors have no network, so install your project's dependencies before you start. A worktree contains tracked files only; bring folders such as `node_modules` into it with `data_links`.

Register the profile:

```bash
bun run agentctl project add shop
```

**3. Hand over an epic.** Open Claude Code in your project and say what you want:

> Put an epic on the board: retry failed webhook deliveries with backoff.

The skill does the rest. It shows you the cards and waits for your yes. Then it starts the executors, reviews their work and brings questions to the board. When every task is done, click **Approve merge** on the board.

## Without Claude Code

`agentctl` is a plain CLI, and you can drive the cycle by hand. `bun run agentctl --help` lists every command. The card format is in the [card template](skills/agent-board/references/card-template.md).

```bash
bun run agentctl epic new shop PAY "Webhook retries"
bun run agentctl task add PAY cards/PAY-1.md
bun run agentctl task promote PAY-1
bun run agentctl start PAY-1
bun run agentctl wait --for review
bun run agentctl review PAY-1
bun run agentctl gate PAY-1
bun run agentctl accept PAY-1
```

When every task is done and you have approved the merge on the board:

```bash
bun run agentctl epic merge PAY
```

## How it works

Columns: Canceled, To do, Next, In progress, Review, Needs your answer, Done.

```text
todo --promote--> next --start--> running --run ends--> review --accept--> done
                                     ^                    |
                                     +---- resume --------+   review note, at most 3 runs
                   next <-- answer -- needs_owner <-------+   question escalated to you
                   todo <-- reject -----------------------+   the card was wrong
```

- `agentctl serve` runs the dispatcher and the web board in one process. The dispatcher works out which tasks can start, watches the runs and wakes the orchestrator through `agentctl wait`. It never starts work by itself.
- Each run is a detached process, so restarting `serve` does not kill the agents. The raw Codex stream is stored next to the live log you see on the board.
- The Codex sandbox cannot commit. `accept` commits the executor's changes and merges them `--no-ff` into the epic branch.

## Where things live

| What | Where |
|---|---|
| Database, run logs, cards | `~/.agent-board/` (override with `AGENT_BOARD_HOME`) |
| Project profiles | `~/.agent-board/projects/<name>.toml` |
| Task worktrees | `~/.agent-board/worktrees/<project>/<task>/`, on branches `agent/<task>` |
| Installed skill | `~/.claude/skills/agent-board/` |

## Settings

`bun run agentctl settings` shows them; `--set key=value` changes one.

| Key | Default | Meaning |
|---|---|---|
| `max_slots` | 5 | Executors running at the same time |
| `memory_limit_gb` | 16 | Shared ceiling for test runs and agents |
| `executor_memory_gb` | 2 | Share of the ceiling each running agent takes |
| `stale_minutes` | 10 | Silence before a run is marked as possibly stuck |
| `web_port` | 8790 | Port of the web board |

## Security

- The web server listens on `127.0.0.1` only. Every write needs a token issued at start and a matching `Origin`, so other pages in your browser cannot post to the board.
- Executors run in the Codex `workspace-write` sandbox without network access.

## Limitations

- Windows only for now. Other platforms need their own memory limiter (for example cgroups on Linux) and notifier; the interfaces are there.
- One executor type: Codex CLI.
- Hitting the subscription rate limit is detected heuristically from Codex's error output.
- One user on one machine.

## Development

```bash
bun test
bun run typecheck
```

Commits are scanned for secrets with [gitleaks](https://github.com/gitleaks/gitleaks). Enable the hook with `git config core.hooksPath .githooks`.

## License

[MIT](LICENSE)
