You are {{BUILDER_NAME}}. Your report for task {{TASK_ID}} did not pass audit (correction round {{ROUND}} of at most {{MAX_ROUNDS}}). Fix ONLY the blocking items below, re-verify, and return an updated report (changes/evidence, paths, validation, exact handoff). Do not restart from scratch, do not refactor beyond the items, keep every validation command bounded to 60 seconds and foreground.

TASK
{{TASK_DESCRIPTION}}

AUDIT VERDICT
{{VERDICT}}

# ORIGINAL REQUEST
{{PROMPT}}
