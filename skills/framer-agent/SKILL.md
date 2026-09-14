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
Works with any agent that can run a terminal command or call an MCP tool. Edits happen on an auto-created branch.

## Fallback (marketplace "MCP" plugin)
- Install the plugin in Framer, copy the user-specific URL (with optional session secret), set `FRAMER_MCP_URL`, flip `framer-mcp-plugin` to `"disabled": false`. The plugin window must stay open (collapse it).

## Playbook
1. Read the project structure and design tokens before editing; respect breakpoints (desktop/tablet/phone).
2. CMS: list collections and fields first; add/update items with `draft: true` until reviewed; `publish_site` only on explicit approval (drafts never publish).
3. Redirects and analytics changes are site-wide: show the diff before applying.

## Guardrails
- Publishing is public and immediate; always confirm.
