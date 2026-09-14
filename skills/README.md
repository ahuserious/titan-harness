# Skill pack

Curated skills for the MCP catalog in `../mcp/mcp.json`. Registered through `package.json` → `pi.skills`, so `pi install` exposes them; copy a folder into `~/.pi/agent/skills/` for other hosts, or `.claude/skills/` for Claude Code.

| Skill | Kind | Pairs with |
|---|---|---|
| `figma-design-context` | server | Pull Dev Mode design context from Figma, create or modify frames/components/variables, and turn selections into code |
| `shadcn-components` | server | Browse, search, and install shadcn/ui components and blocks through the shadcn MCP server, including private registries via components |
| `relume-library` | server | Search Relume's library of 1,000+ real React components and vendor the matching section into the project with its Tailwind preset, primitives, and icons |
| `brandfetch-brand-kit` | server | Fetch a company's brand kit (logos, colors, fonts, description, socials) by domain, ticker, ISIN, or name through the Brandfetch MCP, identify merchants from statement strings, and build Logo CDN URLs |
| `higgsfield-media` | server | Generate images and video (Sora, Veo, Kling and 30+ models) through Higgsfield's hosted MCP for marketing assets, hero visuals, product shots, and short clips |
| `macro-workspace` | server | Search, read, create, and edit documents, tasks, emails, and channel posts in a Macro workspace through the official Macro MCP |
| `testmu-cloud-testing` | server | Run, triage, and audit tests on the TestMu AI (formerly LambdaTest) cloud through its MCP: HyperExecute orchestration, Automation failure triage, SmartUI visual regression, Accessibility (WCAG/ADA/508) audits, and Test Manager |
| `kane-cli-browser-runs` | server | Drive Kane CLI (TestMu AI's KaneAI terminal agent) to run natural-language browser flows in a real Chrome and return pass/fail with shareable proof |
| `momentic-e2e` | server | Author and run Momentic AI end-to-end tests (web, iOS, Android) through the Momentic MCP and its YAML test format |
| `framer-agent` | server | Connect to a Framer project with Framer's official agent integration (npx @framer/agent setup, then /framer) to edit canvas and components, manage CMS collections, and publish; fall back to the marketplace MCP plugin for read-only design context |
| `design-to-code-pipeline` | combo | Combo workflow: Figma design → tokens → shadcn/Relume components → Framer or app code, with the titan-harness fanning out builders |
| `brand-launch-kit` | combo | Combo workflow: Brandfetch brand data → Higgsfield hero media → Macro launch doc/tasks, assembling a launch kit for a company or product |
| `ship-and-verify` | combo | Combo workflow: gate a build with TestMu cloud runs, Kane CLI browser flows, and Momentic E2E before merge, wired into /titan-auto-validate |
| `titan-orchestration` | harness | the 3-tier hierarchy, commands, hotkeys |
| `titan-auditor` | harness | the audit contract and verdict format |
| `mcp-cli-bridges` | bridge | Call any MCP server from bash with mcp2cli (Python) or mcporter (TypeScript) instead of loading tool schemas into context; list tools, pass args, handle auth headers |

Each `SKILL.md` has: Setup (server + auth), Playbook, Guardrails. Tool names are discovered live (`/mcp` in Pi) because vendors rename them; the skills describe capabilities, not brittle signatures.
