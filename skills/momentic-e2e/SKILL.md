---
name: momentic-e2e
description: Author and run Momentic AI end-to-end tests (web, iOS, Android) through the Momentic MCP and its YAML test format. Use when a project already uses Momentic or needs resilient AI-driven E2E tests instead of brittle selectors.
---

# momentic-e2e
## Setup
- Server `momentic` (`npx -y momentic mcp --config ${MOMENTIC_CONFIG}`) with `MOMENTIC_API_KEY`. Set both variables, then flip `"disabled": false` in the MCP config.
- Momentic also publishes agent skills (`momentic-test`, `momentic-result-classification`); install them if the vendor CLI offers to.

## Playbook
1. Describe the user journey; let Momentic generate the YAML test, then review steps and modules for determinism.
2. Run locally first, then on Momentic's hosted browsers/simulators; keep the same YAML for all editors.
3. Classify failures (product bug vs test flake vs environment) using the result classification guidance before touching code.

## Guardrails
- Keep credentials in the Momentic config, never in test YAML committed to the repo.
