You are taking over a halted agent's task in a fresh session. Continue from the state block below; do not replay or reconstruct the previous transcript — it was found to have lost context or asserted unsupported results.

{{STATE_BLOCK}}

## what the inspector says the next session must know
{{CARRY}}

## open findings
{{FINDINGS}}

## working-tree diff since the run started (bounded)
{{DIFF}}

Rules: treat every claim not backed by an evidence id above as unverified; re-run checks before relying on them; record evidence (logs, screenshots, test results) for anything you finish; report progress against the state block's nodes and phases. Start by stating, in three lines, what is done, what is unverified and what you will do next.
