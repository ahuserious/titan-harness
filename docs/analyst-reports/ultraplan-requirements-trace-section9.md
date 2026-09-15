## 9. Requirements trace

Definitions (§7.3): **design status** = coverage of the brief's literal requirement with an executable acceptance test; **runnable today** = what `/titan-doctor` would report on this machine after the named phase with current credentials (Codex OAuth invalid; no Anthropic, OpenRouter, InfraNodus, Cursor or Kane credentials in Pi; Momentic disabled). Item ids follow §2 and the brief excerpts in Appendix F.

| Brief item | Plan sections | Design status | Runnable today |
|---|---|---|---|
| G1 Macro stale on Higgsfield; prefer packs + vendor docs | §2 G1–G9, §7 P1 | full | yes after P1 |
| G2 mcp2cli Python vs Rust | §2 G1–G9, §7 P1 | full | yes after P1 |
| G3 Higgsfield guardrails on both skills + combos | §2 G1–G9, §7 P1 | full | yes after P1 |
| G4 Named links documented, not installed | §2 G1–G9, §7 P0/P1 | full (documentation; the CLIs stay uninstalled by design) | yes after P1 |
| G5 Macro has no titan docs | §7 P1 note | n/a (Macro is outside the plugin) | n/a |
| G6 Verdict B scope; no mega-CLI; no Fusion Drive merge | §1 D1/D14, §7 | full | yes |
| G7 Ship list and pins | §7 pins, `modules/pins.ts` | full | yes after P1 |
| G8 Add-now list (guardrails, cli note, disambiguation, named links, DivMagic, Tokens Studio/Untitled UI/21st.dev) | §2 G1–G9, §7 P1 | full | yes after P1 |
| G9 Leave-out list | §1 (nothing added from it) | full | yes |
| H1 Sidebar totals (token burn, cost, avg tps/agent, completion rate) | §2 H1, §6.5, §7 P2 | partial by substitution: metrics full; rendered on the bar and monitor top row because Pi has no sidebar (disagreement 13) | yes after P2 |
| H2 `/create-workflow` clean context, xhigh frontier default, live statusline | §2 H2, §4.6, §7 P7, Appendix B.5 | full | after P7; default `openai-codex/gpt-6-astra` needs `/login openai-codex`, otherwise the `xai/grok-4.6` fallback |
| H3 Verification tiers × modes (six tiers, hard evidence, per-device suites, separate auditor, n-of-3 then re-author) | §2 H3a–f, §3.5, §5.2–5.3, §7 P4 | full (content tier via approval receipts + preset catalog; both loops of §5.3) | fixtures after P4; live Cursor and Kane lanes vacant until `CURSOR_API_KEY` and `kane-cli login` |
| H4 `/workflow-monitor` states, colours, phase rail, side terminal | §2 H4, §5.4, §7 P6 | full in-process; side terminal partial (Orca/tmux opt-in); nested subagents one level | yes after P6 |
| H5 Watchdog incl. compaction + four review triggers | §2 H5, §5.5, §7 P5 | full (logical clearing instead of deletion) | after P5; child compaction-event ingest depends on the P5 spike, usage pre-emption is primary |
| H6 `/ultraplan` until the user exits plan mode, then workflow-architect | §2 H6, §4.5, §7 P7 | full | after P7 with ≥ 3 seats on the fallback roster |
| H7 `/terraform` (wayfinder originalization, ontology, connectors, automations) | §2 H7, §5.7, §7 P8/P9 | full; autonomous triggering opt-in (no Pi scheduler) | after P8; InfraNodus stage vacant until `INFRANODUS_API_KEY`, `declared`-confidence fallback runs |
| H8 `/local-dev-verify` (local deploy, simulated users, video + screenshots + log snapshots, report) | §2 H8, §5.8, §7 P8 | partial: `video` only with Momentic enabled or `ffmpeg` present | after P8 with Orca or Kane present |
| H9 `/cloud-simulated-users` (multi-remote flows, connect helper, monitor streaming, architect advice) | §2 H9, §5.8, §7 P8 | full | after P8: probe + setup-agent path only until Kane is installed, Cursor/TestMu credentials exist and Momentic is enabled |
| H10 `shift+tab` levels 0–3 with fan-out defaults, live fusion config | §2 H10, §4, §1 D5, §7 P2 | full (`shift+tab` conditional on rebind; "live" = next command) | after P2: `/titan-level` and `alt+l` immediately, `shift+tab` after the rebind |
| H11 Fusion roster + elevation defaults | §2 H11, §4.5, §5.3 | full | after P7 on fallbacks (Fable and muse vacant, Astra after login) |
| H12 Grok subagents analysed the Archon/K-Dense workflows | §2 H12, Appendix A, `docs/analyst-reports/` | done: six analyst reports (two Grok headless, four Claude) are inputs; committed with a sha256 list in P9 | yes |
| A1 System prompt override | §2 A1 | full (existing flags) | yes |
| A2 Structured output | §2 A2, §1 D12 | partial v1 (best effort), full v2 | v1 after P3, v2 after P7 |
| A3 NoSQL + hashed logs | §2 A3, §6 | full for hashed logs; NoSQL replaced by the JSONL chain by recommendation | after P2 |
| A4 Best-of-n | §2 A4 | full | after P4 |
| A5 Visual DAG builder + authoring skill | §2 A5, §7 P9 | partial: viewer + YAML authoring, no canvas | after P9 |
| A6 YAML validator | §2 A6, §3.4 | full | after P3 |
| A7 Hooks | §2 A7 | partial: static child-side gates; Claude SDK matrix not portable | after P3 |
| A8 Lateral pass to clean context | §2 A8, §5.5 | full | after P3 |
| A9 Subagent tools y/n | §2 A9 | full (existing `childToolsFor`) | yes |
| A10 Interleaved reasoning + re-authoring | §2 A10 | full | after P4 |
| A11 Hypothesis workflow | §2 A11 | full | after P4 |
| A12 Personas + mimeographs on fusion | §2 A12 | full | after P7 |
| A13 InfraNodus MCP as local dependency | §2 A13, §1 D14, §7 P1/P7 | full | catalog entry after P1 (`disabled: true`); vacant until `INFRANODUS_API_KEY` |
| InfraNodus gap 1 (levels ↔ entity context) | §4.2 level-2 `entry`, `trigger.entity_profile`, terraform `harness_defaults`, ontology hint | full | after P8 |
| InfraNodus gap 2 (levels ↔ verification/elevation) | §5.3, §1 D10/D11 | full | after P4 |
| InfraNodus gap 3 (review ↔ compaction/ledger) | §5.3 reviewer inputs, §5.5 state block, §6 | full | after P5 |

