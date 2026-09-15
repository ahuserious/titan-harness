---
name: divmagic-raw
description: Take a DivMagic RAW export (styles/components captured from a reference page by the DivMagic Chrome extension) and feed it into the Brandfetch/tokens pipeline; DivMagic is a Chrome extension, not an MCP server, and must not be wrapped as one. Use when a client points at a live site and says "like this".
---

# divmagic-raw
## What it is
- DivMagic is a Chrome extension, not MCP. The human clicks an element in the browser, exports RAW (HTML plus computed CSS, or DivMagic's Tailwind/React conversion) and pastes or saves the export. There is no server, no endpoint and no tool schema: do not add it to `mcp.json`, do not put it behind mcp2cli or mcporter, do not script or "wrap" it. Nothing in this package installs it.

## Playbook
1. Ask the human for the RAW export (pasted or as a saved file) of the specific element or section; never scrape the site to reproduce it.
2. Read the export for tokens only: colors, type scale, spacing, radii, shadows, motion timings. Feed those into the brand kit (`brandfetch-brand-kit` → `brand.json`) and the token map of `design-to-code-pipeline` (Tokens Studio + Style Dictionary when the project has them).
3. Rebuild with shadcn primitives on those tokens (`shadcn-components`); Relume / Untitled UI for Framer clients. The RAW markup is a reference, never shipped code.
4. Note the source URL and date next to the export in the artifacts dir.

## Rules
- One stack: Tailwind + shadcn + tokens; Relume / Untitled UI for Framer clients; DivMagic + Brandfetch feed RAW; shadcn is what we ship.
- Reference and inspiration only: no verbatim copies of a third party's design, copy or assets.
