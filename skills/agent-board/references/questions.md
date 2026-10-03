# Triage of executor questions

A `BLOCKED` run creates a question with `target: "claude"`. Decide who answers it.

| The question is about… | Who answers | How |
|---|---|---|
| How to implement something the card already decides | You | `agentctl answer <QID> "<answer>"`, then `agentctl resume <ID> --note <file>` |
| A missing detail you can settle from the code (naming, file layout, an edge case with an obvious answer) | You | Same. If other cards depend on the same choice, also add a decision key to them |
| Behavior the owner would notice: product semantics, money, risk, security, data loss, anything irreversible | Owner | `agentctl ask <ID> --kind stop --decision <key> --text … --option … --recommend …` |
| A choice the executor can make now and revisit later cheaply | Owner, non-blocking | `agentctl ask <ID> --kind assume …` — the work continues on the default |
| The card is wrong or impossible | You | `agentctl reject <ID>`, re-cut the card |

## Writing a question for the owner

- One or two sentences of substance. No jargon the owner has not used.
- Options with their consequences, as short as possible.
- Your recommendation **and why**.
- The decision key, so the board knows which tasks it holds. The owner sees "holds N tasks"; questions that hold more come first.

An answer is written into the decisions log and injected into every later card with that key, so the same question is never asked twice.
