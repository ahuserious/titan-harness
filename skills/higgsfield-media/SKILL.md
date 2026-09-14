---
name: higgsfield-media
description: Generate images and video (Sora, Veo, Kling and 30+ models) through Higgsfield's hosted MCP for marketing assets, hero visuals, product shots, and short clips. Use when a task asks for generated media rather than stock.
---

# higgsfield-media
## Setup
- Server `higgsfield` (remote `https://mcp.higgsfield.ai/mcp`, OAuth). Uses the account's plan credits; no API key.

## Playbook
1. Nail the brief before generating: subject, style, aspect ratio, duration (video), brand colors (from `brandfetch-brand-kit` if applicable), and what "done" looks like.
2. Generate one candidate at a low cost setting first; iterate on the prompt, then produce the final at target quality.
3. Save outputs under the project's assets folder or the run's artifacts dir with a manifest (prompt, model, seed/settings, cost) so the result is reproducible.
4. For video, keep clips short and stitch in the editor; do not burn credits on long generations you cannot review.

## Guardrails
- Every generation spends credits: state the expected cost and get a yes for batches or video.
- No likenesses of real people, logos you do not own, or content the account's policy forbids.
