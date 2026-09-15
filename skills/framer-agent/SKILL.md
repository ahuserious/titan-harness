---
name: framer-agent
description: Connect to a Framer project with Framer's official agent integration (npx @framer/agent setup, then /framer) to edit canvas and components, manage CMS collections, and publish; fall back to the marketplace MCP plugin for read-only design context. Use for Framer sites.
---

# framer-agent
## Setup (official)
```
npx @framer/agent setup     # browser grant to the project; installs the Framer skills
/framer                     # inside the agent
```
Works with any agent that can run a terminal command or call an MCP tool. Edits happen on an auto-created branch. `@framer/agent` is documented, not installed, not on PATH: `npx` fetches it on first use and nothing in this package wraps it as an MCP server (`docs/named-links.md`).

## Fallback (marketplace "MCP" plugin)
- Install the plugin in Framer, copy the user-specific URL (with optional session secret), set `FRAMER_MCP_URL`, flip `framer-mcp-plugin` to `"disabled": false`. The plugin window must stay open (collapse it).

## Component sources for Framer clients
- Relume (`relume-library`) for real sections. Untitled UI (eval for Framer clients): a Framer-native kit under evaluation for client sites, not part of the shipped code stack. One stack: Tailwind + shadcn + tokens; Relume / Untitled UI for Framer clients; DivMagic + Brandfetch feed RAW; shadcn is what we ship.
- Hero motion for Framer slots comes from `higgsfield-media`: 5–8 s looping clips, first-party only, credit cost stated first.

## Playbook
1. Read the project structure and design tokens before editing; respect breakpoints (desktop/tablet/phone).
2. CMS: list collections and fields first; add/update items with `draft: true` until reviewed; `publish_site` only on explicit approval (drafts never publish).
3. Redirects and analytics changes are site-wide: show the diff before applying.

## Guardrails
- Publishing is public and immediate; always confirm.
