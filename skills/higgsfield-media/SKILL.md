---
name: higgsfield-media
description: Generate images and video (Sora, Veo, Kling and 30+ models) through Higgsfield's hosted MCP for marketing assets, hero visuals, product shots, and short clips. Use when a task asks for generated media rather than stock. Studio rules: first-party only, no OpenRouter; 5–8 s looping Framer heroes, not films; credit cost stated before any video batch.
---

# higgsfield-media
## Setup
- Server `higgsfield` (remote `https://mcp.higgsfield.ai/mcp`, OAuth). Uses the account's plan credits; no API key. Pi loads it from this package's catalog (`mcp/mcp.json` through the `pi.mcp` manifest key, see `mcp/README.md`); a user or project `mcp.json` entry of the same name outranks the package copy.
- Official CLI, as-is: `npm i -g @higgsfield/cli` then `higgsfield auth login` (or `npx @higgsfield/cli`). Documented, not installed, not on PATH, not wrapped by this package: use it when the MCP is not connected or for batch scripts, and never put it behind mcp2cli or mcporter. See `docs/named-links.md`.

## Studio rules (first-party only, no OpenRouter; 5–8 s looping Framer heroes, not films; credit cost before video batches)
- Higgsfield is first-party only — never route Higgsfield/Seedance/Veo/Kling/Sora/Hailuo/Wan through OpenRouter. Every generation goes through the Higgsfield MCP or the official CLI; this catalog has no OpenRouter video server and none may be added.
- Loops, not films: the win is 5–8 s looping hero clips for Framer, not films. Brief every video as a loop: one subject, one camera move, first and last frame matched, brand palette, the aspect ratio of the Framer slot it fills. Anything longer is an editing job, not a generation job.
- Credits first: state the expected credit cost and get a yes before any video batch. One low-cost candidate first, then the final render once; no batch without the yes.

## Playbook
1. Nail the brief before generating: subject, style, aspect ratio, duration (video: 5–8 s, looping), brand colors (from `brandfetch-brand-kit` if applicable), and what "done" looks like.
2. Generate one candidate at a low cost setting first; iterate on the prompt, then produce the final at target quality.
3. Save outputs under the project's assets folder or the run's artifacts dir with a manifest (prompt, model, seed/settings, cost) so the result is reproducible.
4. For video, keep clips short and stitch in the editor; do not burn credits on long generations you cannot review.

## Guardrails
- Every generation spends credits: state the expected cost and get a yes for batches or video.
- No likenesses of real people, logos you do not own, or content the account's policy forbids.
