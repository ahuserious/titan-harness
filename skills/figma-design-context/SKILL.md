---
name: figma-design-context
description: Pull Dev Mode design context from Figma, create or modify frames/components/variables, and turn selections into code. Use when a task references a Figma file, frame, component, design token, or "match the design".
---

# figma-design-context
## Setup
- Server `figma` (remote `https://mcp.figma.com/mcp`, OAuth). In Pi: `/mcp`, pick `figma`, authenticate. Any plan works.
- Discover the live tool list first (`/mcp` → figma → tools, or the `mcp` proxy tool with `list`). Tool names change; do not guess them.

## Playbook
1. Get the file key and node id from the URL the user gives (`figma.com/design/<fileKey>/...?node-id=<id>`).
2. Fetch design context for that node (layout, tokens, variables, component props, code hints). Read once, keep the summary, do not re-fetch per component.
3. Map tokens to the project: Tailwind theme, CSS variables, or the design system in `components.json` (shadcn) / Relume preset. Never hardcode hex values that exist as variables.
4. Build the UI with `shadcn-components` or `relume-library` skills; compare against the frame at the end.
5. For write operations (create frames, components, variables, FigJam stickies/connectors) confirm the target page and be explicit about what will change; Figma edits are live.

## Guardrails
- Large frames: request the top-level node, then children on demand; a full-page fetch can blow the context.
- Screenshots/images from Figma are for verification, not for pasting into the transcript at scale.
- Treat design tokens as the source of truth; if code and design disagree, say so instead of silently changing either.
