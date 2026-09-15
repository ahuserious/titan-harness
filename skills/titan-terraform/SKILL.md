---
name: titan-terraform
description: Originalize the entity behind a repository with /terraform — entity, ontology, roadmap, automations and connectors docs under .titan/terraform with source digests, a harness_defaults block that level 2 consumes, connector probes and orca automation recipes; refuses to overwrite without --refresh
---

# titan-terraform

`/terraform` runs the shipped `terraform` workflow (`.pi/titan-harness/workflows/terraform/`)
over the project's own documents and persists five files a planner can trust:

| file | written by | host appendix |
|---|---|---|
| `.titan/terraform/entity.md` | best-of-3 fusion seats + judge: Domain, Organization, Audience, Platform, Infrastructure, Talent, Financials, Intent, Vision, Bias | `harness_defaults:` YAML block (kept when the seat's is valid, titan defaults otherwise) |
| `ontology.md` | one seat over the InfraNodus graph when the bridge is keyed, else declared | `confidence: observed` line, or the declared banner |
| `roadmap.md` | one seat: workstreams, Now/Next/Later, missing information | — |
| `automations.md` | one seat: cadences, evidence, autonomous-authoring opt-ins | `orca automations create …` recipe per installed workflow with a `trigger:` |
| `connectors.md` | one seat over `connectors.yaml` | probe table (reachable / vacant by NAME) and `connectors.yaml` created from the default catalog when missing |

Every file ends with a Sources table (path, sha256, bytes) of what was gathered:
README, AGENTS.md/CLAUDE.md, vision.md, intent.md, manifests, `docs/*.md`, `.titan/*.md`,
existing terraform docs, git remotes. The `verify` node (research-planning tier, verifier
runner) checks entity + roadmap claims against the sources: a citation to a section that
does not exist, or an execution claim ("tests pass"), fails the run.

## Commands

- `/terraform` — gather, run, persist; refuses to overwrite docs that already exist.
- `/terraform --refresh` — overwrite every section.
- `/terraform --section entity|ontology|roadmap|automations|connectors` — persist only that section (overwriting it). The DAG still runs whole: every section derives from entity.md.
- `/terraform --dry-run` — the layer plan, the gathered sources with digests, the connector probe and the recipe list; nothing spent.

## What level 2 reads

`readHarnessDefaults(cwd)` parses the `harness_defaults:` block of entity.md:

```yaml
harness_defaults:
  level: 2
  tier: prototype-analytics
  review: required
  exa: true
  budget_usd: 25
  personas: [implementer, evidence-auditor]
```

Only valid values survive (level 0–3, a known tier, review required|optional|none);
anything else falls back to the titan defaults and the block says so.

## Connectors and automations

`connectors.yaml` declares existing surfaces only — MCP servers of the titan catalog,
`gh`, `orca linear`, read-only scripts with credentials named by environment variable.
Values never belong in the file; an entry with `NAME=value` is refused. The probe names
what is missing (`env INFRANODUS_API_KEY`, `binary gh on PATH`, `mcp server macro`).
Recipes are printed, never executed: copy the `orca automations create` line, or arm the
in-process scheduler with `/workflow schedule arm <name>`.

## Guardrails

- Seats are tool-less and write nothing; only the host touches `.titan/terraform/`.
- `unknown` beats a guess: a seat that invents a number fails verification.
- The ontology is graph-derived only when `/titan-doctor` shows the InfraNodus key; otherwise the section is declared and says so.
