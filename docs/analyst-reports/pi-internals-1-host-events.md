# Pi 0.85.1 extension API (analyst: pi-internals) — A1 events (doc: PI/docs/extensions.md, 3023 lines; examples PI/examples/extensions/)
PI=/snap/pi-coding-agent/current/lib/pi/packages/coding-agent (compiled dist + full markdown docs)
| Event | Doc line | Payload / return |
| project_trust | :353 | {cwd} → {trusted:"yes"|"no"|"undecided", remember?} |
| resources_discover | :372 | {cwd, reason:"startup"|"reload"} → {skillPaths, promptPaths, themePaths} |
| session_start | :391 | {reason:"startup"|"reload"|"new"|"resume"|"fork", previousSessionFile?} |
| session_info_changed | :403 | {name?} |
| session_before_switch | :414 | {reason:"new"|"resume", targetSessionFile?} → {cancel:true} |
| session_before_fork | :434 | {entryId, position:"before"|"at"} → {cancel} / {skipConversationRestore} |
| session_before_compact | :453 | {preparation, branchEntries, customInstructions, reason:"manual"|"threshold"|"overflow", willRetry, signal} → {cancel:true} OR {compaction:{summary, firstKeptEntryId, tokensBefore, usage?}} |
| session_compact | :476 | {compactionEntry, fromExtension, reason, willRetry} |
| session_compact_failed | :483 | {reason, errorMessage?, aborted, willRetry, fromExtension} |
| session_before_tree / session_tree | :494/:506 | {preparation, signal} → {summary:{summary, usage?, details}} / {newLeafId, oldLeafId, summaryEntry, fromExtension} |
| session_shutdown | :511 | {reason:"quit"|"reload"|"new"|"resume"|"fork", targetSessionFile?} |
| before_agent_start | :532 | {prompt, images, systemPrompt, systemPromptOptions{customPrompt, selectedTools, toolSnippets, promptGuidelines, appendSystemPrompt, cwd, contextFiles, skills}} → {message?, systemPrompt?} (chained across extensions) |
| agent_start / agent_end / agent_settled | :566-584 | {} / {messages} / {} — agent_settled = no retry/compaction/follow-up left; ctx.isIdle() true |
| ui_prompt_start / ui_prompt_end | :588 | {reason:"ui_prompt", kind:"select"|"confirm"|"input"|"editor"|"custom", title?} |
| turn_start / turn_end | :612 | {turnIndex, timestamp} / {turnIndex, message, toolResults} |
| message_start / message_update / message_end | :626 | {message} / {message, assistantMessageEvent} / {message} → may return {message} (same role) |
| tool_execution_start / _update / _end | :668 | {toolCallId, toolName, args} / +partialResult / {toolCallId, toolName, result, isError} |
| context | :703 | {messages} (deep copy) → {messages} |
| before_provider_headers | :716 | mutate event.headers in place; null deletes; not re-fired on retry (:733) |
| before_provider_request | :735 | {payload} → returned value replaces payload (chained, load order) |
| after_provider_response | :753 | {status, headers} |
| model_select | :772 | {model, previousModel?, source:"set"|"cycle"|"restore"} |
| thinking_level_select | :789 | {level, previousLevel} notification-only |
| tool_call | :806 | {toolName, toolCallId, input(mutable)} → {block, reason?, terminate?} |
| tool_result | :862 | {toolName, toolCallId, input, content, details, isError, usage} → partial patch; chains |
| user_bash | :881 | {command, excludeFromContext, cwd} → {operations} / {result} |
| input | :911 | {text, images, source:"interactive"|"rpc"|"extension", streamingBehavior ...} |
Confirmed from dist: core/agent-session.js:1496-1510 (manual compact) and :1757-1771 (auto) emit session_before_compact; extension may return {cancel} or {compaction}. Pi keybinding app.thinking.cycle defaultKeys "shift+tab" (core/keybindings.js:36).
