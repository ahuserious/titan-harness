---
name: testmu-cloud-testing
description: Run, triage, and audit tests on the TestMu AI (formerly LambdaTest) cloud through its MCP: HyperExecute orchestration, Automation failure triage, SmartUI visual regression, Accessibility (WCAG/ADA/508) audits, and Test Manager. Use for cloud browser/device test runs and their debugging.
---

# testmu-cloud-testing
## Setup
- Server `testmu` (remote `https://mcp.lambdatest.com/mcp`, OAuth on testmuai.com). Existing LambdaTest credentials keep working.

## Playbook
1. HyperExecute: ask the tool to generate the YAML for the project's runner, review it, commit it, then trigger the run.
2. Automation triage: fetch test details, command/network/console logs for a failed session id; summarize root cause with evidence lines.
3. SmartUI: compare builds for visual regressions (pixel/layout/DOM); attach the diff links to the report.
4. Accessibility: run the audit on the target URL/app; report violations grouped by WCAG criterion with remediation.
5. Test Manager: keep cases/runs in sync with the work item being shipped.

## Guardrails
- Cloud minutes and device time cost money: prefer targeted runs over full suites while iterating.
- Never paste raw session logs into chat; summarize and link.
