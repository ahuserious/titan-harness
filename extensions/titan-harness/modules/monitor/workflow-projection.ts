/** Human-only, read-only projection. Execution state NEVER issues acceptance authority. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonicalJson, sha256, GENESIS, type ChainRow } from '../hash-chain.ts';
import type { AgentRecord, RunMeta } from '../run-store.ts';
import { throughputFromLedger } from '../ledger.ts';
import type { LedgerRow } from '../ledger.ts';
export interface WorkflowTask {
    id: string;
    title: string;
    kind?: string;
    startedAt?: string;
    endedAt?: string;
    role: string;
    state: string;
    phase: string;
    model?: string;
    modelSource: 'configured' | 'observed' | 'unknown';
    tokens?: number;
    seconds?: number;
    error?: string;
    outputAvailable: boolean;
}
export interface WorkflowProjection {
    schemaVersion: 1;
    cursor: string;
    runId: string;
    name: string;
    description?: string;
    /** Unique observed agent identities; execution nodes are not agents. */
    agentCount?: number;
    status: string;
    /** Producer lifecycle status; does not override incomplete evidence or grant acceptance. */
    reportedStatus?: string;
    startedAt: string;
    endedAt?: string;
    phases: Array<{
        id: string;
        title: string;
        tasks: WorkflowTask[];
    }>;
    tasks: WorkflowTask[];
    stats: {
        running: number;
        finished: number;
        failed: number;
        cancelled: number;
        unreviewed: number;
        observedTokens: number;
        avgTps?: number;
        estimatedTps?: number;
        measured: number;
        samples: number;
        exactOneReview: null;
    };
    warnings: string[];
    sourceDigest: string;
}
const terminal = new Set(['execution_completed', 'failed', 'cancelled', 'skipped']);
const active = new Set(['dispatched-working', 'in-review', 'edit-round-n', 'harvesting', 'compacting', 'inspecting-compaction', 'resuming', 'authoring-workflow', 'repairing-workflow', 'system-run', 'running']);
const normalize = (s: string) => s === 'done-verified' || s === 'done-unverified' || s === 'success' ? 'execution_completed' : s === 'aborted' ? 'cancelled' : s === 'failed-review' || s === 'watchdog-failed' || s === 'stalemate' ? 'failed' : active.has(s) ? 'running' : s;
const count = (n: unknown): number | undefined => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined;
const timestamp = (value: unknown): string | undefined => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined;
const safe = (id: string) => id.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').replace(/-+$/, '') || 'x';
function scopedFile(dir: string, relative: string): string { const root = fs.realpathSync(dir); const file = path.join(root, relative); if (fs.existsSync(file) && !fs.realpathSync(file).startsWith(root + path.sep))
    throw new Error('Observer path escapes selected run'); return file; }
function chain(text: string, runId: string): ChainRow[] { let prev = GENESIS; const rows: ChainRow[] = []; for (const line of text.split('\n').filter(x => x.trim())) {
    const row = JSON.parse(line);
    const { hash, ...body } = row;
    if (row.seq !== rows.length + 1 || row.prev !== prev || hash !== sha256(canonicalJson(body)) || row.runId !== runId)
        throw new Error('Incomplete evidence: invalid chain or run identity');
    rows.push(row);
    prev = hash;
} return rows; }
/** Reads exact bytes once; cursor hashes those bytes, independent of wall clock and observer. */
export function readWorkflowProjection(runDir: string): WorkflowProjection {
    const missing = new Set<string>();
    const sources: Record<string, string> = {};
    const read = (rel: string, optional = false) => { try {
        return sources[rel] = fs.readFileSync(scopedFile(runDir, rel), 'utf8');
    }
    catch (e) {
        if (optional && (e as NodeJS.ErrnoException).code === 'ENOENT') {
            missing.add(rel);
            return '';
        }
        throw e;
    } };
    const run = JSON.parse(read('run.json')) as RunMeta;
    if (!run.runId || !run.startedAt)
        throw new Error('Invalid run identity');
    const events = chain(read('events.jsonl', true), run.runId);
    const ledger = chain(read('ledger.jsonl', true), run.runId) as unknown as LedgerRow[];
    const records: AgentRecord[] = [];
    let names: string[] = [];
    try {
        names = fs.readdirSync(scopedFile(runDir, 'agents')).filter(n => n.endsWith('.json')).sort();
    }
    catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
            throw e;
    }
    const agentIds = new Set<string>();
    for (const name of names) {
        const a = JSON.parse(read('agents/' + name));
        if (typeof a.agentId !== 'string' || !a.agentId || agentIds.has(a.agentId) || safe(a.agentId) + '.json' !== name)
            throw new Error('Duplicate or invalid agent identity');
        agentIds.add(a.agentId);
        records.push(a);
    }
    const phases = new Map<string, {
        id: string;
        title: string;
        tasks: WorkflowTask[];
    }>();
    for (const title of run.phases ?? [])
        phases.set(title, { id: title, title, tasks: [] });
    const tasks = new Map<string, WorkflowTask>();
    const task = (id: string) => { let t = tasks.get(id); if (!t) {
        t = { id, title: id, role: 'worker', state: 'queued', phase: 'Workflow', modelSource: 'unknown', outputAvailable: false };
        tasks.set(id, t);
    } return t; };
    const capturedStart = events.find(e => e.type === 'workflow.start')?.data as any;
    const description = typeof capturedStart?.description === 'string' ? capturedStart.description : undefined;
    const configuredTitles = new Set<string>();
    const declaredNodes = new Set<string>();
    if (Array.isArray(capturedStart?.layers)) {
        for (const id of capturedStart.layers.flat()) { if (typeof id === 'string') task(id); }
    }
    if (Array.isArray(capturedStart?.nodes)) {
        for (const node of capturedStart.nodes) {
            if (!node || typeof node.id !== 'string' || !node.id) continue;
            declaredNodes.add(node.id);
            const t = task(node.id);
            if (typeof node.phase === 'string') t.phase = node.phase;
            if (typeof node.kind === 'string') t.kind = node.kind;
            if (typeof node.role === 'string') t.role = node.role;
            if (typeof node.title === 'string') { t.title = node.title; configuredTitles.add(node.id); }
        }
    }
    const emittedNodeIds = new Set(events.filter(e => e.type === 'node.start' || e.type === 'node.end').map(e => (e.data as any)?.nodeId).filter(Boolean));
    const nodeIds = new Set([...declaredNodes, ...emittedNodeIds]);
    const observedAgentIds = new Set(agentIds);
    const endedNodes = new Set<string>();
    let currentPhase = 'Workflow';
    const starts = new Map<string, string>();
    const warnings = ['Acceptance and exact-one-review statistics require source-bound independent receipts; unavailable for this store schema.'];
    for (const event of events) {
        const d = (event.data ?? {}) as Record<string, any>;
        if (event.type === 'phase.start' && typeof d.phase === 'string')
            currentPhase = d.phase;
        const id = typeof d.agentId === 'string' ? d.agentId : typeof d.nodeId === 'string' ? d.nodeId : undefined;
        if (!id)
            continue;
        if (!['node.start', 'node.end', 'agent.start', 'agent.end'].includes(String(event.type)))
            continue;
        const t = task(id);
        if (event.type === 'agent.start' || event.type === 'agent.end') {
            observedAgentIds.add(id);
            if (!nodeIds.has(id)) t.kind = 'agent';
        } else if (typeof d.type === 'string') t.kind = d.type;
        if (typeof d.phase === 'string')
            t.phase = d.phase;
        else if (t.phase === 'Workflow' && (event.type === 'node.start' || event.type === 'agent.start'))
            t.phase = event.type === 'node.start' ? currentPhase : tasks.get(d.nodeId)?.phase ?? currentPhase;
        if (typeof d.role === 'string')
            t.role = d.role;
        if (!configuredTitles.has(id) && typeof d.label === 'string')
            t.title = d.label;
        const wasTerminal = terminal.has(t.state);
        if (event.type === 'node.start' || event.type === 'agent.start') {
            if (!terminal.has(t.state))
                t.state = d.skipped ? 'skipped' : 'running';
            if (!wasTerminal && !d.skipped && timestamp(event.ts)) {
                starts.set(id, starts.get(id) ?? event.ts);
                t.startedAt ??= event.ts;
            }
        }
        else if (event.type === 'node.end' && !endedNodes.has(id)) {
            endedNodes.add(id);
            t.state = normalize(d.status ?? 'unknown');
        }
        else if (!nodeIds.has(id) && !terminal.has(t.state)) {
            t.state = event.type === 'node.end' ? normalize(d.status ?? 'unknown') : d.aborted ? 'cancelled' : d.ok === true ? 'execution_completed' : d.ok === false ? 'failed' : 'unknown';
        }
        if (String(event.type).endsWith('.end') && terminal.has(t.state) && !t.endedAt && timestamp(event.ts) && (!t.startedAt || Date.parse(event.ts) >= Date.parse(t.startedAt)))
            t.endedAt = event.ts;
        if (typeof d.error === 'string')
            t.error = d.error;
        const duration = count(d.durationMs);
        if (duration !== undefined)
            t.seconds = duration / 1000;
        else if (String(event.type).endsWith('.end') && starts.has(id)) {
            const delta = (Date.parse(event.ts) - Date.parse(starts.get(id)!)) / 1000;
            if (Number.isFinite(delta) && delta >= 0)
                t.seconds = delta;
        }
    }
    const workflowEndEvent = events.filter(e => e.type === 'workflow.end').at(-1);
    const workflowEnd = workflowEndEvent?.data as any;
    for (const [id, state] of Object.entries(workflowEnd?.nodes ?? {})) {
        if (typeof state !== 'string') continue;
        const t = task(id);
        if (!emittedNodeIds.has(id) && !terminal.has(t.state)) {
            t.state = normalize(state);
            if (terminal.has(t.state) && timestamp(workflowEndEvent?.ts) && (!t.startedAt || Date.parse(workflowEndEvent!.ts) >= Date.parse(t.startedAt))) t.endedAt = workflowEndEvent!.ts;
        }
    }
    for (const a of records) {
        if (!a.agentId)
            throw new Error('Invalid agent identity');
        const t = task(a.agentId);
        if (!nodeIds.has(a.agentId) && !terminal.has(t.state))
            t.state = normalize(a.state);
        t.role = a.role || t.role;
        if (!configuredTitles.has(a.agentId)) t.title = a.callsign || t.title;
        if (!nodeIds.has(a.agentId)) t.kind = 'agent';
        if (a.model) {
            t.model = a.model;
            t.modelSource = 'configured';
        } // legacy store has no independent effective-route provenance
        const input = count(a.usage?.input), output = count(a.usage?.output);
        if (input !== undefined && output !== undefined)
            t.tokens = input + output;
        if (t.phase === 'Workflow') {
            const parent = tasks.get(a.agentId.split('#')[0]);
            if (parent && parent !== t)
                t.phase = parent.phase;
        }
    }
    for (const t of tasks.values()) {
        try {
            const meta = JSON.parse(read('artifacts/nodes/' + safe(t.id) + '.meta.json', true) || 'null');
            t.outputAvailable = meta?.nodeId === t.id && typeof meta?.sha256 === 'string';
        }
        catch {
            warnings.push('Invalid output metadata for ' + t.id);
        }
        if (!phases.has(t.phase))
            phases.set(t.phase, { id: t.phase, title: t.phase, tasks: [] });
        phases.get(t.phase)!.tasks.push(t);
    }
    const list = [...tasks.values()];
    const unresolved = list.filter(t => !terminal.has(t.state));
    const runTerminal = ['completed', 'failed', 'aborted', 'reauthored', 'stalemate'].includes(run.status);
    const receiptStatus = workflowEnd?.frozen ? 'reauthored' : workflowEnd?.status === 'cancelled' ? 'aborted' : workflowEnd?.status;
    const missingTerminalEvidence = runTerminal && (!events.length || !list.length || (run.workflow && (!workflowEnd || receiptStatus !== run.status)));
    const status = runTerminal && (unresolved.length || missingTerminalEvidence) ? 'incomplete' : run.status;
    if (!events.length) warnings.push('Execution event capture is missing or empty.');
    if (missingTerminalEvidence) warnings.push('Terminal event receipt or task inventory is missing or inconsistent.');
    if (status === 'incomplete')
        warnings.push('Terminal workflow has unresolved tasks or incomplete evidence.');
    const tp = throughputFromLedger(ledger);
    // Refuse a torn observation when the producer changed files during collection.
    for (const [rel, text] of Object.entries(sources)) {
        if (fs.readFileSync(scopedFile(runDir, rel), 'utf8') !== text)
            throw new Error('Snapshot changed during read; retry');
    }
    for (const rel of missing) {
        if (fs.existsSync(scopedFile(runDir, rel)))
            throw new Error('Snapshot changed during read; retry');
    }
    let finalNames: string[] = [];
    try {
        finalNames = fs.readdirSync(scopedFile(runDir, 'agents')).filter(n => n.endsWith('.json')).sort();
    }
    catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
            throw e;
    }
    if (canonicalJson(finalNames) !== canonicalJson(names))
        throw new Error('Agent inventory changed during read; retry');
    warnings.push('File snapshot checked for concurrent changes; not an atomic producer checkpoint.');
    const sourceDigest = sha256(canonicalJson(sources));
    return { schemaVersion: 1, cursor: run.runId + ':' + sourceDigest, sourceDigest, runId: run.runId, name: run.workflow?.name ?? run.command ?? run.runId, description, agentCount: observedAgentIds.size, status, reportedStatus: run.status, startedAt: run.startedAt, endedAt: run.endedAt, phases: [...phases.values()], tasks: list, stats: { running: list.filter(t => t.state === 'running').length, finished: list.filter(t => terminal.has(t.state)).length, failed: list.filter(t => t.state === 'failed').length, cancelled: list.filter(t => t.state === 'cancelled').length, unreviewed: list.length, observedTokens: list.reduce((n, t) => n + (t.tokens ?? 0), 0), avgTps: tp.measured.tokensPerSecond, estimatedTps: tp.estimated.tokensPerSecond, measured: tp.coverage.measuredSamples, samples: tp.coverage.totalSamples, exactOneReview: null }, warnings };
}
/** Output only, scoped to a known task and validated against its store metadata. No arbitrary transcript paths. */
export function readTaskOutput(runDir: string, taskId: string): string {
    const p = readWorkflowProjection(runDir);
    const task = p.tasks.find(t => t.id === taskId);
    if (!task?.outputAvailable)
        throw new Error('No recorded output for selected task');
    const meta = JSON.parse(fs.readFileSync(scopedFile(runDir, 'artifacts/nodes/' + safe(taskId) + '.meta.json'), 'utf8'));
    const file = scopedFile(runDir, 'artifacts/nodes/' + safe(taskId) + '.md');
    if (fs.statSync(file).size > 2 * 1024 * 1024)
        throw new Error('Output exceeds observer limit (2 MiB)');
    const text = fs.readFileSync(file, 'utf8');
    if (meta.nodeId !== taskId || sha256(text) !== meta.sha256)
        throw new Error('Output digest mismatch');
    return text;
}
