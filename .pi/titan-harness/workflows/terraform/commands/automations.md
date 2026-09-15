---
description: automations.md — which recurring runs the entity needs, and which triggers may author workflows on their own (opt-in)
---
$inputs.contract

# Task: automations.md

Propose the recurring automations this entity needs: telemetry refreshes, evidence
sweeps, reports, syncs. For each: name, cadence (`every: 6h`, `daily`, a 5-field cron),
the workflow it should run, inputs, the evidence it must leave behind, and the human who
reads its output. Then an "Autonomous authoring" section listing which automations may
call `/create-workflow` by themselves — default none; the operator opts in by name.

Installed workflows and their triggers (JSON):

```json
$inputs.workflows
```

The host appends ready-to-run `orca automations create …` recipe lines for every
installed workflow that declares a `trigger:`; do not write shell commands yourself.

Rules: cite the entity sections that justify each automation `(entity: <section>)`;
`unknown` where the sources are silent; no execution claims.

## Entity document
$entity.output
