---
name: design-to-code-pipeline
description: Combo workflow: Figma design → tokens (Tokens Studio + Style Dictionary when the file has them) → shadcn/Relume components → Framer or app code, with the titan-harness fanning out builders. Use when a task goes from a design file to shipped UI.
---

# design-to-code-pipeline
## Steps
1. **Context** (`figma-design-context`): fetch the target frame, extract tokens and component inventory, write `design-brief.md` in the artifacts dir.
2. **Tokens**: if the Figma file carries Tokens Studio sets, export that token JSON and build it with Style Dictionary into the CSS variables / Tailwind theme the components consume; otherwise the token map from step 1 is the source. Either way one source of truth per token, with the mapping table in the brief.
3. **Brand** (`brandfetch-brand-kit`, optional): pull real palette/logos when the brief references a company brand. A client's "make it like this site" reference arrives as a DivMagic RAW export (`divmagic-raw`) and is read for tokens only; DivMagic + Brandfetch feed RAW, they never ship.
4. **Plan** (`/titan-opinion` or `/titan-collaborate` in titan-harness): architect proposes the component map: which sections come from Relume (`relume-library`), which primitives from shadcn (`shadcn-components`), which are custom.
5. **Build**: builders vendor components and wire tokens; every builder gets the brief and the token map, never the raw Figma payload or the RAW export.
6. **Verify**: screenshot vs frame; run `ship-and-verify`.
7. **Publish**: for Framer sites use `framer-agent` (CMS + publish on approval); for app code open the PR.

## Rules
- One stack: Tailwind + shadcn + tokens; Relume / Untitled UI for Framer clients; DivMagic + Brandfetch feed RAW; shadcn is what we ship. No second component library: 21st.dev and similar galleries are inspiration, not dependencies.
- One source of truth per token; document the mapping table in the brief.
- Fan-out builders never edit the same file; the harness's writer lease enforces it.
