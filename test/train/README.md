# Reply trainer

How the agent's replies are measured and improved. Nothing here runs in the normal tests.

The agent is not retrained: Claude's own model never changes. What changes is what it is given and what is checked after it:

1. The instructions (`src/brain/static-prompt.ts`).
2. The knowledge (`seed/knowledge/`: the store pages, the owner's reply playbook, the owner rules).
3. The checks in code that run on every reply before it is sent (`src/brain/rules.ts`, `src/brain/sanitize.ts`).
4. The routing: which model answers which chat (`src/brain/route.ts`).

## The loop

1. `scenarios.json` holds real kinds of customer chats, each with what a good reply must do.
2. Dump the exact prompt the live agent would send for each chat:
   `TRAIN_DIR=/some/dir TRAIN_MODE=dump npx vitest run --config test/train/vitest.config.ts`
   This writes `system.txt` (instructions and knowledge) and `requests.json`.
3. Have Haiku and Sonnet answer every request as the system prompt says. Save the answers as
   `answers-haiku.json` and `answers-sonnet.json` in the same folder: `{ "<id>": { ...decision JSON... } }`.
4. Run the answers through the agent's real checks:
   `TRAIN_DIR=/some/dir TRAIN_MODE=check TRAIN_MODEL=haiku npx vitest run --config test/train/vitest.config.ts`
   This writes `final-haiku.json`: what the customer would have received, whether an Urgent item was raised, and what the checks changed.
5. Read each result against its `expect`. For every miss, fix the cause (an instruction, a missing fact, a check that is too strict or too loose) and run again.
6. When the owner sends a screenshot of a bad reply, add that chat to `scenarios.json` so it stays fixed.
