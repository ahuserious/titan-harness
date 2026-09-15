# Skill pack

Curated skills for the MCP catalog in `../mcp/mcp.json`. Registered through `package.json` → `pi.skills`, so `pi install` exposes them; copy a folder into `~/.pi/agent/skills/` for other hosts, or `.claude/skills/` for Claude Code. 24 skills: ten server skills, three combo workflows, nine harness skills, one bridge, one reference.

| Skill | Kind | Pairs with |
|---|---|---|
| `figma-design-context` | server | Pull Dev Mode design context from Figma, create or modify frames/components/variables, and turn selections into code |
| `shadcn-components` | server | Browse, search, and install shadcn/ui components and blocks through the shadcn MCP server, including private registries via components.json; shadcn is what we ship (21st.dev is inspiration only, no MCP) |
| `relume-library` | server | Search Relume's library of 1,000+ real React components and vendor the matching section into the project with its Tailwind preset, primitives, and icons |
| `brandfetch-brand-kit` | server | Fetch a company's brand kit (logos, colors, fonts, description, socials) by domain, ticker, ISIN, or name through the Brandfetch MCP, identify merchants from statement strings, and build Logo CDN URLs |
| `higgsfield-media` | server | Generate images and video (Sora, Veo, Kling and 30+ models) through Higgsfield's hosted MCP; studio rules: first-party only, no OpenRouter; 5–8 s looping Framer heroes, not films; credit cost before any video batch; `@higgsfield/cli` documented as-is |
| `macro-workspace` | server | Search, read, create, and edit documents, tasks, emails, and channel posts in a Macro workspace through the official Macro MCP; notes which Macro "Tool Stack" rows are stale |
| `testmu-cloud-testing` | server | Run, triage, and audit tests on the TestMu AI (formerly LambdaTest) cloud through its MCP: HyperExecute orchestration, Automation failure triage, SmartUI visual regression, Accessibility (WCAG/ADA/508) audits, and Test Manager |
| `kane-cli-browser-runs` | server | Drive Kane CLI (TestMu AI's KaneAI terminal agent) to run natural-language browser flows in a real Chrome and return pass/fail with shareable proof |
| `momentic-e2e` | server | Author and run Momentic AI end-to-end tests (web, iOS, Android) through the Momentic MCP and its YAML test format |
| `framer-agent` | server | Connect to a Framer project with Framer's official agent integration (npx @framer/agent setup, then /framer) to edit canvas and components, manage CMS collections, and publish; fall back to the marketplace MCP plugin for read-only design context; Untitled UI (eval for Framer clients) |
| `design-to-code-pipeline` | combo | Combo workflow: Figma design → tokens (Tokens Studio + Style Dictionary) → shadcn/Relume components → Framer or app code, with the titan-harness fanning out builders |
| `brand-launch-kit` | combo | Combo workflow: Brandfetch brand data → Higgsfield hero media (studio rules apply) → Macro launch doc/tasks, assembling a launch kit for a company or product |
| `ship-and-verify` | combo | Combo workflow: gate a build with TestMu cloud runs, Kane CLI browser flows, and Momentic E2E before merge, wired into /titan-auto-validate |
| `titan-orchestration` | harness | the 3-tier hierarchy, commands, hotkeys |
| `titan-auditor` | harness | the audit contract and verdict format |
| `titan-workflow-authoring` | harness | Author `.titan/workflows/<name>/<name>.yaml` DAGs for `/workflow`: the node types, `$id.output` hand-offs, `when` routing, roles, hooks, evidence; `/workflow validate` before `/workflow run` |
| `titan-watchdog` | harness | The titan-native watchdog: compaction state block + bounded inspector, child pre-emption at 75 % of context (logical clear or fresh resume on the architect's model), stalemate and held-spend gates, `/titan-watchdog`, and its relationship to pi-subagents' own watchdog |
| `titan-ultraplan` | harness | `/ultraplan`: grill the brief in plan mode, anonymous fusion seats draft, the judge ranks, the fuser merges, every seat ACKs the fused bytes; `/plan` routes here at level 3 |
| `titan-terraform` | harness | `/terraform`: entity, ontology, roadmap, automations and connectors docs under `.titan/terraform` with source digests, the `harness_defaults` block level 2 consumes, connector probes and `orca automations` recipes |
| `titan-local-dev-verify` | harness | `/local-dev-verify`: start or point at the local app, sim-user workers write flows, a headless Chromium replays them over CDP (Kane when installed), hashed screenshots, snapshots, console and network logs for the architect |
| `titan-cloud-simulated-users` | harness | `/cloud-simulated-users`: probe the Cursor cloud, TestMu/HyperExecute, Kane `--remote` and Momentic lanes by name, host-persisted setup advice from a read-only agent, recorded runs streamed into the store |
| `infranodus-reasoning-ontology` | harness | The InfraNodus reasoning-ontology stage (ontology graph → contextual hint → reasoning optimization) over documents, plans or run notes through titan's MCP bridge, plus `memory_add_relations`; declared-confidence fallback when the server is unkeyed |
| `mcp-cli-bridges` | bridge | Call any MCP server from bash with the Python mcp2cli (knowsuchagency) or mcporter (TypeScript); named links per server; not the Rust mcp2cli the Grok plugin uses |
| `divmagic-raw` | reference | DivMagic is a Chrome extension (RAW export of styles/components), not an MCP server; its export feeds Brandfetch/tokens and is rebuilt on shadcn |

Each `SKILL.md` has: Setup (server + auth), Playbook, Guardrails. Tool names are discovered live (`/mcp` in Pi) because vendors rename them; the skills describe capabilities, not brittle signatures.

The one-stack rule the combo skills share: Tailwind + shadcn + tokens; Relume / Untitled UI for Framer clients; DivMagic + Brandfetch feed RAW; shadcn is what we ship.

First-party CLIs the skills refer to (Kane CLI, `npx @framer/agent`, `@higgsfield/cli`, the two mcp2cli binaries, mcporter, mcp-to-cli) are documented, not installed, not on PATH: see `../docs/named-links.md`.
