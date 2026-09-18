---
name: fiber-b2b-data
description: "Search and enrich B2B companies and people through Fiber AI hosted MCP. Use when building outbound lists, enriching LinkedIn profiles, revealing work emails or phones, or the user names Fiber.ai, people search, or contact data. Confirm credits before reveal or bulk audience calls."
---

# fiber-b2b-data
## Setup
- Server `fiber` (remote `https://mcp.fiber.ai/mcp/v3`, OAuth). Pi loads it from this package's catalog (`mcp/mcp.json` through the `pi.mcp` manifest key, see `mcp/README.md`); a user or project `mcp.json` entry of the same name outranks the package copy.
- V3 is OAuth only. Do not point an API-key flow at `/mcp/v3`. If the host already has a Fiber key (`sk_live_…`), use `https://mcp.fiber.ai/mcp/v2` with header `x-api-key` in a user/project override, not in this repo.
- Grok Bot: add the same V3 URL as an HTTP MCP plugin. Do not use the Salesforce plugin as a Fiber stand-in.
- Exa stays web search (`pi-exa` in Pi, Exa plugin in Grok Bot). Fiber is B2B records. They are not substitutes.

## Playbook
1. Check credits (`getOrgCredits` / `api_getOrgCredits`) before a search that will reveal emails or build an audience.
2. Discover with structured people/company search or natural-language intent translated to filters. Do not reveal yet.
3. Dedupe on LinkedIn URL. Enrich live profile only when the row already ranks as worth a first touch.
4. Reveal work email/phone only for the ranked `this_week` bucket. Log `chargeInfo`. Never invent an address from a pattern.
5. Write the row to the scratch CRM in Macro (`outbound-scratch` skill), not to Salesforce sandbox.

## Guardrails
- Chargeable calls spend Fiber credits. State expected cost and get a yes for bulk reveal or audience build.
- Never paste API keys or consumer secrets into chat, Macro, or git.
- Personal-email spray is out of scope. Prefer work channels.
- Salesforce is eval. A Developer Edition My Domain (for example `velocity-ruby-6443.my.salesforce.com`) logs in at production (`login.salesforce.com`), not `test.salesforce.com`.
