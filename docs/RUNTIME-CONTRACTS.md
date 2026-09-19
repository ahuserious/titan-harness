# Titan runtime contracts

Titan is a Pi extension package. Pi supplies the model session and extension API; Titan supplies orchestration, workflow execution, reviewers, monitoring and state handling. Installing its skills in another host does not install that runtime.

## Roles and personas

ARCHITECT coordinates; BUILDER executes assigned work; AUDITOR assesses the builder result. Personas are selectable prompt lenses, not a replacement for the roles or Pi named agents. The packaged personas are contrarian, cursor-cloud-swe, evidence-auditor, implementer, researcher, sim-user, test-author and workflow-architect. Inspect effective /stack settings rather than assuming a provider/model from an example.

## Workflow execution

The YAML schema and validator live under extensions/titan-harness/modules/workflow. The executor receives dependencies explicitly. Workflow output includes run identity, node status and retained evidence. A structured-output node must submit its result through its declared schema. Review the relevant tests before changing cancellation, admission or retry behavior.

## Evidence and completion

Keep claimed output, verifier result and accepted evidence distinct. Tests and smoke checks prove only their exercised scope. A configured provider is not proof of a successful authenticated call. Failed or incomplete work must remain visibly unresolved.

## Context and settings

Provider/model choices, fan-out and watchdog behavior are controlled by effective Pi/Titan settings. Saved configuration changes apply at the runtime boundaries documented by the host; they do not retroactively alter already-running sessions.

See [README](../README.md), [installation](../INSTALL.md), and [the v0.9 interface specification](PRD-v0.9-live-tui.md) for the shipped user surface.
