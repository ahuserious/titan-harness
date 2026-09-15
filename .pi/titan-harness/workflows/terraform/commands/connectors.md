---
description: connectors.md — the systems the entity's workflows read and write, as existing surfaces (MCP catalog, gh, orca linear, env-named scripts)
---
$inputs.contract

# Task: connectors.md

Describe the connectors the entity's workflows need, as EXISTING surfaces only — never a
new client: MCP servers already in the titan catalog (macro for org docs, figma and
brandfetch for brand, testmu for test data, infranodus for graphs), the `gh` CLI for GitHub
issues and PRs, `orca linear` for tickets, and read-only `script:` nodes with credentials
named by environment variable (name only, never a value). For each connector: what it is
for, which workflow nodes use it, the read/write scope, and what happens when it is vacant.

Current `.titan/terraform/connectors.yaml` (empty when none exists yet):

```yaml
$inputs.connectors_yaml
```

The host appends the live probe table (reachable / vacant, missing pieces by name) and
creates connectors.yaml from the default catalog when it is missing; do not print
credential values or shell commands.

Rules: cite `(entity: <section>)`; `unknown` where the sources are silent.

## Entity document
$entity.output
