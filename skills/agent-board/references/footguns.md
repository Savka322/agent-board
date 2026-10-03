# Footguns

Verified on Windows 11 with Codex CLI 0.159 and Bun 1.4.

## Windows

- **Junctions.** Worktrees with Bun's `node_modules` contain junctions. `git worktree remove --force` leaves the folder behind ("Directory not empty"). The board removes the leftover with `cmd /d /s /c rmdir /s /q "<path>"`, which does not follow junctions. Never delete such folders with PowerShell 5.1 `Remove-Item -Recurse`: it walks into junctions and can delete their targets.
- **Spaces in paths.** Passing a quoted path through `cmd.exe /c` from Node/Bun needs `windowsVerbatimArguments: true`. Otherwise `cmd` gets `\"` and fails with a syntax error.
- **`codex` resolves to `codex.cmd`.** Arguments pass through `cmd.exe`, so never embed quotes in `-c key=value`: Codex parses the value as TOML and falls back to the raw string.

## Codex CLI

- Without stdin (`-` or `</dev/null`) `codex exec` waits for input forever.
- `codex exec resume <session>` has no `-s` flag; set the sandbox with `-c sandbox_mode=workspace-write`.
- Without `-c model_reasoning_summary=concise` the stream has no reasoning items, so the board's live log shows no "think" lines.
- Inside the sandbox the executor cannot commit (the worktree's `.git` points outside the writable root), cannot run `taskkill`, and cannot show toasts. The board does all of that from outside.
- `usage.input_tokens` in `turn.completed` grows across resumes. It looks cumulative per session.

## Rate limits

- A run that hits the subscription limit ends `rate_limited`. The board pauses for 15 min, doubling per consecutive hit up to 2 h, and requeues the task. Do not fight it.
- Five executors at maximum reasoning effort can exhaust a subscription in a few hours. Use fewer slots or lower effort for simple cards.

## Data

- `data_links` default to `mode = "copy"`. `mode = "link"` uses a hard link or junction: the content is **shared**, and an executor's test that writes to it writes into your real data.
- Untracked files of the client repo (local databases, `.env`) are not in a worktree unless you add a data link.

## Memory

- Every gate and every executor runs under its own Job Object lease; the sum never exceeds `memory_limit_gb`. A Bun process alone commits ~100 MB; a Python test run with scientific imports can commit 1 GB+.
- `oom` comes from the job's limit message, not from guessing; the gate's log says which signal decided.
