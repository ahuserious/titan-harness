---
name: brandfetch-brand-kit
description: Fetch a company's brand kit (logos, colors, fonts, description, socials) by domain, ticker, ISIN, or name through the Brandfetch MCP, identify merchants from statement strings, and build Logo CDN URLs. Use when a task needs real brand assets or brand context.
---

# brandfetch-brand-kit
## Setup
- Server `brandfetch` (remote `https://mcp.brandfetch.io/mcp`). OAuth in the browser, or a `bf1…` MCP token from the Brandfetch dashboard (Keys and MCP page). Search + Logo CDN also accept a free Client ID.

## Playbook
1. Resolve the entity first: search by name when you only have a name; look up by domain when you have it (domain lookups are the canonical path).
2. Pull the brand data once; extract logos (prefer SVG, note dark/light variants), primary/secondary colors with hex, fonts, and the short description.
3. For UI work hand the palette to `shadcn-components`/`relume-library` as tokens; for media hand the logo + palette to `higgsfield-media`.
4. For statement/transaction strings use the merchant-identification tool, then confirm with a domain lookup.
5. Use Logo CDN URLs for anything that should stay up to date rather than downloading assets into the repo.

## Guardrails
- Brand assets are trademarks: use them for the brand's own properties or with permission; say so when the request looks like impersonation.
- Cache results in the artifacts dir when fanning out to several agents; do not re-query per agent.
