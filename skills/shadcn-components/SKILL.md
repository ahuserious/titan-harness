---
name: shadcn-components
description: Browse, search, and install shadcn/ui components and blocks through the shadcn MCP server, including private registries via components.json. Use for React/Next.js UI work, "add a <component>", or building from a design system.
---

# shadcn-components
## Setup
- Server `shadcn` (`npx -y shadcn@latest mcp`). No key for the public registry. Private registries: entries in the project's `components.json` plus `REGISTRY_TOKEN` in the environment.
- Requires a project with `components.json` (`npx shadcn@latest init` if missing). Ask before initializing in a repo that has no UI stack yet.

## Scope
- shadcn is what we ship: Tailwind + shadcn + tokens is the one code stack. 21st.dev (no MCP, not a second component library) is a browsing gallery of shadcn-style components for inspiration; anything taken from it is rebuilt on the project's shadcn primitives and tokens, never added as a dependency.

## Playbook
1. Search the registry for the primitive or block that matches the request (e.g. "data table", "pricing section", `@namespace/component` for namespaced registries).
2. Read the component's usage and dependencies before installing; install exactly the named components, not a bundle.
3. Wire it in using the project's existing patterns (imports from `@/components/ui`, the `cn` helper, theme tokens).
4. When the design came from Figma, keep the token mapping from `figma-design-context`; do not restyle the primitive with ad-hoc classes.
5. Run the project's lint/typecheck after installing.

## Guardrails
- Installation writes files into the repo: list what will be added and where before running it in a shared branch.
- Do not upgrade the shadcn CLI or pin `@latest` in project scripts without asking; the MCP entry already uses `@latest` only for the server process.
