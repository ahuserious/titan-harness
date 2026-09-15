---
name: titan-local-dev-verify
description: Verify a locally running app with simulated users: start (or point at) the app, let sim-user workers write realistic flows, replay them in a headless Chromium over CDP (or Kane when installed) and hand the architect hashed screenshots, snapshots, console and network logs, plus a video when ffmpeg exists. Use for "does this actually work in a browser" before an audit, a ship node, or a production-swe tier run.
---

# /local-dev-verify — simulated users against a local app

`/local-dev-verify [--url <u>] [--start "<cmd>"] [--flows <file.json>] [--workers <n>] [--no-video] [--port <n>] [--timeout <s>]`

What it does, in order:

1. **Starts the app** with `--start "<cmd>"` or a recipe detected from the project: `package.json` scripts `dev` (`npm run dev`, or `bun run dev` / `pnpm dev` by lockfile) or `start`, a `pyproject.toml` `[project.scripts]` entry (`uv run <name>`), a `Procfile` `web:` line, or a bare `index.html` (`python3 -m http.server`). The process runs in its own group with its log under the run directory. With `--url` and no recipe it assumes the app is already running.
2. **Probes the URL** (`--url`, the port the log announces, or `http://localhost:3000`) until it answers 2xx/3xx or the timeout (60 s) passes — a silent app ends the command as `unavailable`, never as a pass.
3. **Picks the driver**: `kane-cli` on PATH → the `kane` runner (TestMu's agentic browser); else a headless Chromium → the `cdp-browser` runner (Playwright's `chrome-headless-shell` or `chrome` under `~/.cache/ms-playwright`, or `brave-browser` / `google-chrome` / `chromium` on PATH; `TITAN_CHROMIUM=<path>` overrides). Neither → `unavailable: no Kane, no Chromium`.
4. **Sim-user workers** (`--workers`, default the shape's worker pool capped at 5) each read a page snapshot and write 2–4 realistic flows as JSON steps (`prompts/USER_PROMPT_SIM_USER.md`: a person with a goal, then the careless things people do). `--flows <file>` replays your own flows instead (`{"flows":[{"name","url","steps":[…]}]}`).
5. **Replays every flow** in a fresh browser, screenshotting after each step (PNG evidence plus a JPEG copy under `frames/` that only feeds the video), and writes the evidence package: `screenshot` (step frames), `snapshot` (page text), `console-log`, `network-log`, `report` (flow-result.json), `script` (the flow), and `video` (WebM/VP8 — the one codec Playwright's bundled ffmpeg carries) when ffmpeg is on PATH or in Playwright's cache (`~/.cache/ms-playwright/ffmpeg-*`), otherwise `missingInformation: ["video: unavailable (ffmpeg not found)"]`. Every file is hashed (`capturedBy: observed`, `source: cdp`), which counts as a simulated-user capture for the production-swe tier.
6. **Reports**: an `inbox.architect` event with the summary and evidence paths, a panel with one row per flow (steps ok/total, screenshots, video, evidence status), and the app is stopped.

Everything runs as a workflow in the run store (`~/.pi/titan-harness/runs/<project>/<runId>/`): nodes `probe` → `snapshot` → `sim-user-<n>` → `collect` → `verify` → `report`, so `/workflow-monitor` and `/workflow status` show it and `node scripts/verify-ledger.mjs <runDir>` checks the chain.

## Steps the driver understands

```json
{"goto": "http://localhost:3000/pricing"}
{"click": "Say hello"}                      {"click": "#submit"}
{"fill": {"selector": "#email", "value": "ada@example.com"}}
{"press": "Enter"}                          {"wait": "#greeting"}   {"wait": 500}
{"expect": "Hello, Ada"}                    {"snapshot": true}      {"eval": "document.title"}
```

A flow stops at its first failing step and keeps the failure screenshot; `flow-result.json` names the step and the error. Selectors come from the snapshot (`#id`, `[name=…]`), clicks may name the visible text of a link or button.

## By hand

- `node scripts/cdp-browser.mjs doctor` — which Chromium and ffmpeg this machine offers
- `node scripts/cdp-browser.mjs snapshot --url http://localhost:3000` — what a worker sees
- `node scripts/cdp-browser.mjs run --flow flow.json --out ./evidence/flow-1` — replay one flow (exit 0 ok, 1 a step failed, 2 bad flow, 3 no Chromium)
- `node scripts/stitch-video.mjs --frames ./evidence/flow-1 --out flow.webm --fps 2` — the frames as a WebM video (exit 3 when ffmpeg is unavailable)

In a workflow: `verify: { runner: cdp-browser, flows_file: flows.json, video: true }` with `evidence: { require: [screenshot, snapshot, console-log, network-log] }`.

## Guardrails

- Chromium runs with `--no-sandbox` (Ubuntu's AppArmor blocks the user-namespace sandbox for unprivileged binaries) in a throw-away profile; point it only at apps you started or trust.
- The flows are evidence of what a browser did, not of what the app should do: pair this with an auditor or a `verify` node that checks the acceptance list.
- No credentials are read or stored; a login flow types what you put in the flow file, so keep secrets out of flow files that land in the run store.
- This Orca build has no browser automation and Kane is not installed here — `/titan-doctor` shows which driver is live.
