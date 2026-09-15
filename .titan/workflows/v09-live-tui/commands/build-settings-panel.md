Read $ARTIFACTS_DIR/spec-map.md and `extensions/titan-harness/tests/settings-panel.test.ts`.

Implement R4 (Settings panel with MCP toggles and quick configs):
1. Create `extensions/titan-harness/modules/settings-panel.ts`:
   - Implement a custom TUI overlay panel opened via `ctrl+,` (with `alt+,` twin).
   - Display the live harness configuration in one unified screen: level/shape, builder/worker/watchdog/verifier/exa pools, concurrency cap, budget, watchdog (on/off, model, thinking, compaction mode), monitor mode, auditor on/off, anonymize, model bar on/off.
   - Allow in-place editing (select, toggle, numeric edit) and persist changes immediately through `writeStackSettings`.
   - Opening the panel must be entirely deterministic and spend zero model tokens.
2. MCP catalog toggling:
   - Merge catalogs: package `mcp/mcp.json` → user `~/.config/mcp/mcp.json` → project `.mcp.json`.
   - List every MCP server with state: enabled, disabled, or missing required environment variable.
   - Allow toggling enabled/disabled per server. Persist toggles to the user configuration file (`~/.config/mcp/mcp.json`), never modifying package files.
   - Strictly redact credential values from the UI.
   - Prompt the user to execute `/reload` upon toggling.
3. Quick configs:
   - Save current settings state as named presets under `~/.pi/titan-harness/configs/<name>.json`.
   - Support listing, saving, and applying presets both from the panel and via `/titan-config save|apply|list <name>`.
4. Register `ctrl+,` and `alt+,` shortcuts and `/titan-config` commands in `extensions/titan-harness/titan-harness.ts`.

Run `bun test extensions/titan-harness/tests/settings-panel.test.ts` and verify all tests pass green.
