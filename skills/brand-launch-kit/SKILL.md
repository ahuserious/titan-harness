---
name: brand-launch-kit
description: Combo workflow: Brandfetch brand data → Higgsfield hero media → Macro launch doc/tasks, assembling a launch kit for a company or product. Use for "make launch assets for <company>".
---

# brand-launch-kit
## Steps
1. `brandfetch-brand-kit`: resolve the domain, save palette/logos/fonts/description to `brand.json` in the artifacts dir.
2. `higgsfield-media`: generate 2-3 hero candidates on the brand palette; pick with the user; final render once. Studio rules (first-party only, no OpenRouter; 5–8 s looping Framer heroes, not films; credit cost before video batches): Higgsfield is first-party only — never route Higgsfield/Seedance/Veo/Kling/Sora/Hailuo/Wan through OpenRouter; the win is 5–8 s looping hero clips for Framer, not films; state the expected credit cost and get a yes before any video batch.
3. `macro-workspace`: create or update the launch doc (brief, assets table with links, checklist) and the task list; draft the announcement email but do not send.
4. Report: doc link, asset paths, spend, open questions.

## Rules
- Brand assets stay in the brand's own materials; no lookalike campaigns for third parties.
- Every generated asset gets a manifest line (prompt, model, cost).
- One stack: Tailwind + shadcn + tokens; Relume / Untitled UI for Framer clients; DivMagic + Brandfetch feed RAW; shadcn is what we ship. A launch kit's web pieces follow it (`design-to-code-pipeline`, `divmagic-raw`).
