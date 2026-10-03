# Project profile

`<home>/projects/<name>.toml`, registered with `agentctl project add <name>`. It lives outside the client repo: the board never writes into the client repo except its own worktrees and `agent/*` / epic branches.

```toml
name = "shop"                                  # slug
repo = 'D:\code\shop'                          # absolute path to the client repo
base_branch = "main"
epic_branch_pattern = "epic/{epic}"
light_tests = ["bun test --bail"]              # default light tests for cards that have none
gates = [{ cmd = "bun test", ram_est_gb = 2 }] # default gates for cards that have none
data_links = [
  # untracked data the tests need; mode "copy" (default, safe) or "link" (shared content)
  { from = 'D:\data\fixtures', to = "fixtures", mode = "copy" },
]
forbidden = ["config/production.*", ".env*", "deploy/**"]
rules = [                                       # injected into every executor prompt
  "TypeScript strict. Follow the existing style.",
]

[executor]
kind = "codex"
model = "<codex model id>"
effort = "high"                                 # low | medium | high | xhigh | max
sandbox = "workspace-write"
extra_config = []                               # extra `-c key=value` for codex, no quotes
```
