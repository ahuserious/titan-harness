---
name: design-to-code-pipeline
description: Combo workflow: Figma design → tokens → shadcn/Relume components → Framer or app code, with the fusion-harness fanning out builders. Use when a task goes from a design file to shipped UI.
---

# design-to-code-pipeline
## Steps
1. **Context** (`figma-design-context`): fetch the target frame, extract tokens and component inventory, write `design-brief.md` in the artifacts dir.
2. **Brand** (`brandfetch-brand-kit`, optional): pull real palette/logos when the brief references a company brand.
3. **Plan** (`/fh-opinion` or `/fh-collaborate` in pi-fusion-stack): architect proposes the component map: which sections come from Relume (`relume-library`), which primitives from shadcn (`shadcn-components`), which are custom.
4. **Build**: builders vendor components and wire tokens; every builder gets the brief and the token map, never the raw Figma payload.
5. **Verify**: screenshot vs frame; run `ship-and-verify`.
6. **Publish**: for Framer sites use `framer-agent` (CMS + publish on approval); for app code open the PR.

## Rules
- One source of truth per token; document the mapping table in the brief.
- Fan-out builders never edit the same file; the harness's writer lease enforces it.
