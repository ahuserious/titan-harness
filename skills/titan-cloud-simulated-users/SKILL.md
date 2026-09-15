---
name: titan-cloud-simulated-users
description: Run simulated users on cloud providers through titan-harness — /cloud-simulated-users probes the Cursor cloud, TestMu/HyperExecute, Kane --remote and Momentic lanes (ready or vacant, names only), writes host-persisted setup advice with a read-only setup agent, and runs one lane through its verify runner so results land in the run store as hashed evidence. Use when a workflow needs production-swe or platform-update evidence from real devices or a cloud agent, when a lane reports vacant, or when setting up CURSOR_API_KEY / kane-cli / the testmu or momentic MCP servers.
---

# titan-cloud-simulated-users

Cloud simulated users are the remote half of `/local-dev-verify`: real devices, cloud
browsers and a cloud coding agent exercising the app, with every result hashed into an
evidence package (`evidence/<nodeId>/evidence.json`) instead of a chat claim.

## Lanes

| provider | lane | runner | needs (names only) | skill |
|---|---|---|---|---|
| `cursor-cloud` | Cursor background agents | `cursor-cloud` | `CURSOR_API_KEY`, a pushed `titan/<runId>` branch, `.titan/cursor.yaml` | this skill |
| `testmu-hyperexecute` | TestMu AI cloud (HyperExecute) | `testmu` | the `testmu` MCP server enabled + logged in | `testmu-cloud-testing` |
| `kane-remote` | KaneAI on cloud devices | `kane` | `kane-cli` on PATH (`npm i -g @testmuai/kane-cli`, `kane-cli login`) | `kane-cli-browser-runs` |
| `momentic` | Momentic AI E2E | `momentic` | `MOMENTIC_API_KEY` or `MOMENTIC_CONFIG` + the `momentic` server enabled | `momentic-e2e` |

Aliases: `cursor`, `testmu`, `hyperexecute`, `kane`, `momentic-e2e`.

## Commands

- `/cloud-simulated-users` (or `probe`) — the matrix: `✓ ready` or `○ vacant` with the
  missing environment-variable names, binaries and servers. Never a value.
- `/cloud-simulated-users setup <provider>` — a read-only worker child loads the provider's
  skill, inspects the project and answers with JSON advice; the host writes it into
  `.titan/terraform/remote-testing.md` (one section per provider, replaced on re-run,
  credential-looking lines dropped). Install commands are printed; they run only after an
  explicit confirm. The child never writes files.
- `/cloud-simulated-users run <provider> --objective "<text>" [--devices a,b] [--ref <branch>]`
  — a one-node `verify` workflow on the provider's runner. The store receives
  `cloud-sim.preflight`, `cloud-sim.started`, one `cloud-sim.exec` per subprocess, the
  runner's `evidence.captured`, and `cloud-sim.finished` with the package hash. A vacant
  provider refuses to run and names what is missing.
- `/cloud-simulated-users advice` — prints `.titan/terraform/remote-testing.md`.

## Cursor cloud specifics

The runner preflights `GET /v1/me` with the key from `CURSOR_API_KEY`, requires the
starting branch on the remote (`git ls-remote --heads origin <ref>`), launches the agent
idempotently (`agentId = sha256(runId + nodeId)`), polls until a terminal status, then
downloads the artifacts into the evidence dir. `.titan/cursor.yaml` (template under
`.pi/titan-harness/templates/cursor.yaml`) supplies `env.type`, `env.name`, `repo`,
`startingRef` (`titan/<runId>` is substituted per run) and `api_base`. A run passes only
with a result text AND at least one downloadable artifact hashed.

## Fail-closed rules

- `ready` is decided by presence of names, never by reading values.
- A skipped or unavailable lane is reported as such; it is never a pass.
- The evidence package must be `matched` (the tier's or the node's required kinds observed
  and hashed) for the verify node to succeed.
- Nothing is installed, exported or written outside `.titan/terraform/remote-testing.md`
  by this command; the setup agent runs with read-only tools.

## Runnable today (this machine, 2026-09-15)

All four lanes probe vacant: no `CURSOR_API_KEY`, `kane-cli` not installed, `momentic`
disabled and unkeyed, `testmu` present in the catalog but its login not verified. The
`setup` path is the intended first step; `/titan-doctor` shows the same vacancies.
