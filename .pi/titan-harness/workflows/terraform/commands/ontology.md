---
description: ontology.md — the concepts, relations and gaps of the entity, graph-derived when InfraNodus ran, declared otherwise
---
$inputs.contract

# Task: ontology.md

Write the ontology of the entity described below: the twenty to forty concepts a planner
must know, how they relate (`A → relation → B` lines), the clusters they form, and the
structural gaps (concepts that should connect but do not in the sources).

InfraNodus graph (JSON from the host's ontology stage, or the word `unavailable`):

```json
$inputs.ontology_graph
```

Rules:
- When the graph is present, derive clusters, bridges and gaps FROM IT and say so in a
  first line `confidence: observed (InfraNodus)`. Quote node and cluster names as given.
- When it reads `unavailable`, write `confidence: declared` on the first line and derive the
  ontology from the entity document alone; mark every gap as a hypothesis.
- Cite the entity document sections you used, e.g. `(entity: Platform)`.
- No execution claims, no invented data.

## Entity document
$entity.output
