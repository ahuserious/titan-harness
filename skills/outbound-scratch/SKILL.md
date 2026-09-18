---
name: outbound-scratch
description: "Build ranked outbound contact lists with Exa (web) and Fiber (B2B records) into the Macro scratch CRM. Use when the user says scratch CRM, scratch pad, scratch org, Salesforce sandbox, test.salesforce.com, Outbound Prospecting, Grok Bot outbound, or wants lists ranked for the person sending the message. Never treat a Developer Edition or production My Domain as a Salesforce sandbox."
---

# outbound-scratch

Scratch CRM for outbound list tests is the Macro project **Outbound scratch**, not Salesforce.

## Why this exists

Grok Bot Outbound Prospecting and Pi both used to hear "scratch CRM" and open `test.salesforce.com` (Salesforce sandbox). That is the wrong host for a Developer Edition or production My Domain. Macro is the CRM for this motion. Salesforce stays eval until a deal needs it.

## Hosts (do not mix)

| Phrase | Meaning | Login / store |
|---|---|---|
| scratch pad / scratch CRM | this Macro folder | https://macro.com/app/project/dc54cf4f-74f8-4e11-9d4f-eb6f46ffe00a |
| Salesforce sandbox | a copy of a paying production org | `test.salesforce.com` and `mydomain--name.sandbox.my.salesforce.com` |
| Salesforce scratch org | DX ephemeral org | `test.salesforce.com` (only when `sf org create scratch` was actually run) |
| Developer Edition / production My Domain | live org, including `adjective-noun-NNNN.my.salesforce.com` | `login.salesforce.com` or that My Domain. Never the Sandbox toggle. |

If Chrome or history has no `*.sandbox.my.salesforce.com` host, there is no sandbox to log into. A password reset on the My Domain does not apply on `test.salesforce.com`.

## Tools

| Tool | Job |
|---|---|
| Exa (`pi-exa` in Pi, Exa plugin in Grok Bot) | Public web: listings, company pages, posts, news, people-on-the-web |
| Fiber (`fiber` MCP, `fiber-b2b-data`) | Canonical people/company graph, live LinkedIn, work email/phone reveal |
| Macro (`macro-workspace`) | Scratch CRM: raw list, ranked list, run notes |
| Salesforce plugin | Do not install for this motion. Do not launch sandbox OAuth. |

Grok Bot: drop plugin `Salesforce` (id 47725205) from Outbound Prospecting. Keep Exa. Add Fiber at `https://mcp.fiber.ai/mcp/v3` (OAuth) and Macro. Do not put a Salesforce consumer key or secret in chat.

Pi: this package already ships Macro and Fiber in `mcp/mcp.json`. Exa is `pi-exa`. Do not add a Salesforce MCP URL that contains `/sandbox/`.

## Pipeline

1. Lock a **sender packet** before any search: who is contacting, brand, one-sentence offer, proof they can cite, who should take the meeting, geo, hard-no, Fiber credit cap.
2. **Exa** discovery. Listings and public hooks only. Tag `source: exa`.
3. **Fiber** people/company search from the same intent. No reveal yet. Tag `source: fiber`.
4. **Merge raw.** Dedupe key = LinkedIn URL, else domain + full name. Do not sort yet.
5. **Rank for the sender**, not vendor relevance. Score 0-5 each: buy path, trigger, warmth this sender can cite, opener only this sender could send, work-channel reach. Drop if any of: no buy path, no hook, personal-email-only, already contacted, hard-no.
6. **Bucket.** `this_week` (total ≥ 16, or buy path 5 and trigger ≥ 4) / `nurture` / `drop`.
7. **Reveal** Fiber contact details only for `this_week`, after credits. Never invent an email.
8. **Write a run doc** in the Macro Outbound scratch project from the Run template. No send without an explicit yes.

## Grok Bot repair (Outbound Prospecting)

If the bot is waiting on a Salesforce connect card or opened `test.salesforce.com`:

1. Cancel that OAuth. Do not complete sandbox login.
2. Tell the bot: scratch CRM is Macro Outbound scratch; Salesforce sandbox is out of scope.
3. Connect Fiber V3 and Macro. Leave Exa as web search.
4. Resume from the sender packet, not from Salesforce.

Port 8787 is Grok Bot's own listener. Do not start a second Salesforce desktop OAuth that expects `http://localhost:8787/callback` while Grok Bot holds that port.

## Guardrails

- Never paste Salesforce consumer keys, consumer secrets, Fiber keys, or session ids into chat, Macro, or git. If one was pasted, rotate it in the vendor console; do not repeat it.
- Do not dual-write to Salesforce from this skill.
- Facts without a source URL stay blank.
- Draft only. The user sends.
