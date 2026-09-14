---
name: relume-library
description: Search Relume's library of 1,000+ real React components and vendor the matching section into the project with its Tailwind preset, primitives, and icons. Use for marketing pages, landing pages, and "give me a <section> like Relume".
---

# relume-library
## Setup
- Server `relume` (remote `https://relume-library-mcp.relume.io/mcp`, Relume account OAuth). First run configures path aliases, the Relume Tailwind preset, and icons; accept those project edits knowingly.

## Playbook
1. Describe the section in plain language ("pricing with three tiers and a toggle"); search returns real library components by slug, not generated guesses.
2. Fetch the chosen component by slug; it lands as editable code with shared primitives (button, card, `cn`) and the Tailwind preset.
3. Keep Relume's spacing/typography tokens unless the project already has a design system; if it does (shadcn tokens, Figma variables), map instead of duplicating.
4. Compose pages from sections; reuse primitives rather than pulling near-duplicate components.

## Guardrails
- Vendored code is yours to edit; do not re-fetch to "update" a component you already customized.
- Check the license/plan implications before shipping Relume components in client work if the account is a trial.
