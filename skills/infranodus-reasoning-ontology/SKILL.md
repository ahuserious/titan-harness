---
name: infranodus-reasoning-ontology
description: Run the InfraNodus reasoning-ontology stage (ontology graph → contextual hint → reasoning optimization) over project documents, plans or run notes through the local `infranodus` MCP server, and push learned relations into InfraNodus memory; degrades to a declared-confidence banner when the server is unkeyed.
---

# InfraNodus reasoning ontology

InfraNodus is a text-network tool: it turns text into a knowledge graph and reports the
main clusters, the gaps between them and the concepts that bridge them. titan uses it as
a **stage**, never as a store: `modules/infranodus.ts` only orchestrates tool calls, the
results land in the run's artifacts like any other node output.

## Setup

- Server: the package catalog (`mcp/mcp.json`) ships `infranodus` as
  `npx -y infranodus-mcp-server` with `INFRANODUS_API_KEY` from the environment and
  `disabled: true` until the key exists.
- Key: `/titan-doctor --import-infranodus-key` copies an existing key (environment, a
  local `mcp-server-infranodus/.env`, or `~/.claude.json`) into
  `~/.config/mcp/mcp.json` after a confirm and never prints it. Manual route: export
  `INFRANODUS_API_KEY` before launching Pi and enable the server. Get a key at
  https://infranodus.com/api-access.
- Check: `/titan-doctor` shows `InfraNodus MCP (user config)` ready or vacant; `/mcp`
  lists `titan_harness__infranodus` when pi-mcp-adapter loaded it.

Two clients talk to the same server: pi-mcp-adapter (tools the model calls in chat) and
titan's own stdio client (`modules/mcp-client.ts`) for workflow `mcp_tool` nodes and the
stage below. Both read the same catalog; a missing variable disables the entry with a
reason that names the variable only.

## The stage

`ontologyStage(bridge, text, { purpose, graphName?, save?, mode? })`:

1. `generate_ontology_graph` over the text (`saveGraph` false unless asked; `graphName`
   normalized to InfraNodus's 28-character lowercase-dash rule; `ontologyMode`
   `codebase` for repository structure, `procedural` for a how-it-works digest).
2. `generate_contextual_hint` over the same text — the structural summary a planner or
   RAG step can carry.
3. `optimize_reasoning` — is the text biased, focused, diversified or dispersed, and
   which gap to develop next.

Result: `{ confidence: "observed" | "declared", ontology, hint, reasoning, calls[] }`.
The ontology call decides the confidence; hint and optimize failures are recorded in
`calls[]` without demoting it. When the server is disabled, unkeyed or failing the stage
returns `confidence: "declared"` with the reason and the banner
"InfraNodus ontology unavailable — this section is declared (model-written), not
graph-derived." — `/terraform` prints that banner on the ontology section and continues.

Every InfraNodus tool needs a `context` field of 15–25 third-person words;
`contextSentence(purpose)` derives one deterministically (first-person words are
replaced, short purposes padded, long ones cut). Never put credentials, names or
personal data in it.

## Memory

`rememberRelations(bridge, [{ from, to, relation, note? }], graphName)` writes
`[[from]] relation [[to]]` statements with `memory_add_relations` (entity detection
off, because the wikilinks already mark the entities). Use it at the end of a run for
the relations the run established (feature → module, decision → evidence id, persona →
outcome), so a later `/terraform --refresh` or plan can recall them.

## Workflow node recipe

```yaml
- id: ontology
  depends_on: [entity]
  mcp_tool:
    server: infranodus
    tool: generate_ontology_graph
    args:
      text: $entity.output
      context: "The terraform workflow condenses the project entity document into an ontology to seed the roadmap and the automation plan."
      saveGraph: false
      includeAnalytics: true
  on_fail: { action: cancel }      # or route with `when` on a probe node when the server may be vacant
```

`mcp_tool` nodes fail closed: no bridge, a disabled server or an `isError` result fails the
node. Guard optional stages with a probe node (`bash: node scripts/… --check`) and a
`when` on its output, or accept the declared banner path in the prompt that follows.

## Guardrails

- The stage never invents graph data: no ontology call, no `observed` confidence.
- Keep `saveGraph` off unless the user asked for a persistent graph; saving appends to
  an existing name.
- Text is sent to InfraNodus's hosted API; do not send secrets or private data the
  project has not cleared for it.
