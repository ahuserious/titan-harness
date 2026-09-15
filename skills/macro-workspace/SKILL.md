---
name: macro-workspace
description: Search, read, create, and edit documents, tasks, emails, and channel posts in a Macro workspace through the official Macro MCP. Use when the source of truth for a brief, spec, or task list lives in Macro (macro.com).
---

# macro-workspace
## Setup
- Server `macro` (remote `https://mcp-server.macro.com/mcp`, OAuth). Tools mirror the Macro UI: search, read, create documents, edit document trees, send/draft email, update tasks and CRM, post to channels, read calls.

## Known stale spots in Macro (read before trusting a Macro doc about tooling)
- Macro's "Tool Stack" rows that describe Higgsfield as first-party-API-only are stale: Higgsfield has a hosted MCP (`https://mcp.higgsfield.ai/mcp`, in this catalog and in the Grok plugin). Prefer the packs and higgsfield.ai/mcp over those rows, and say so when you quote them.
- Macro's own skills are only "What I Did Yesterday" and "Catch Me Up". Macro has no Untitled UI, Pi-plugin or titan docs; the sources of truth for those live in this package (`skills/`, `mcp/README.md`, `docs/named-links.md`).

## Playbook
1. Search before creating: Macro is @-linked; find the existing doc/task and link to it.
2. Reading: pull the document once, quote the relevant sections in the plan, and cite the doc link in results.
3. Writing: prefer surgical edits (Macro applies them as CRDT peers) over replacing whole documents; keep headings stable so links survive.
4. Email and channel posts are outward-facing: draft, show the user, send only on approval.
5. Tasks: update status/assignee with a one-line note of what changed and why.

## Guardrails
- Acts under the signed-in user's permissions; anything sent is attributed to them.
- Do not paste secrets or credentials into Macro documents.
