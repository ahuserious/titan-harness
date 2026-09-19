import { test, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson, GENESIS, sha256 } from '../modules/hash-chain.ts';
import { RunStore } from '../modules/run-store.ts';
import { readWorkflowProjection, readTaskOutput } from '../modules/monitor/workflow-projection.ts';
const roots: string[] = [];
afterEach(() => { for (const p of roots.splice(0))
    rmSync(p, { recursive: true, force: true }); });
function fixture() { const root = mkdtempSync(join(tmpdir(), 'workflow-projection-')); roots.push(root); const store = new RunStore(root); const { dir, runId } = store.open({ cwd: root, projectSlug: 'test', workflow: { name: 'Evidence test' }, status: 'running', phases: ['Build', 'Review'] }); return { root, store, dir, runId }; }
test('successful execution and legacy verified are never source-bound acceptance', () => { const { store, dir } = fixture(); store.upsertAgent(dir, { agentId: 'build', state: 'done-verified', model: 'configured/alias' }); store.appendEvent(dir, 'node.end', { nodeId: 'build', status: 'success' }); const p = readWorkflowProjection(dir); expect(p.stats.exactOneReview).toBeNull(); expect(p.tasks[0].state).toBe('execution_completed'); expect(p.tasks[0].modelSource).toBe('configured'); expect(p.stats.unreviewed).toBe(1); });
test('terminal parent with unresolved child remains incomplete', () => { const { store, dir } = fixture(); store.upsertAgent(dir, { agentId: 'build', state: 'dispatched-working' }); store.updateRun(dir, { status: 'completed' }); const p = readWorkflowProjection(dir); expect(p.reportedStatus).toBe('completed'); expect(p.status).toBe('incomplete'); expect(p.tasks[0].state).toBe('running'); expect(p.stats.exactOneReview).toBeNull(); });
test('late start cannot revive terminal task; replay is idempotent', () => { const { store, dir } = fixture(); store.appendEvent(dir, 'node.end', { nodeId: 'build', status: 'failed', error: 'check failed' }); store.appendEvent(dir, 'node.start', { nodeId: 'build', phase: 'Build' }); const a = readWorkflowProjection(dir), b = readWorkflowProjection(dir); expect(a.tasks[0].state).toBe('failed'); expect(a.cursor).toBe(b.cursor); expect(a.stats).toEqual(b.stats); });
test('corrupt evidence fails closed and output path is scoped', () => { const { dir } = fixture(); writeFileSync(join(dir, 'events.jsonl'), '{bad'); expect(() => readWorkflowProjection(dir)).toThrow(); expect(() => readTaskOutput(dir, '../../etc/passwd')).toThrow(); });
test('agent success cannot hide later node failure', () => { const { store, dir } = fixture(); store.appendEvent(dir, 'node.start', { nodeId: 'build' }); store.appendEvent(dir, 'agent.start', { nodeId: 'build', agentId: 'build' }); store.appendEvent(dir, 'agent.end', { nodeId: 'build', agentId: 'build', ok: true }); store.appendEvent(dir, 'node.end', { nodeId: 'build', status: 'failed', error: 'schema invalid' }); expect(readWorkflowProjection(dir).tasks[0].state).toBe('failed'); });
test('node remains running after worker returns until its result settles', () => { const { store, dir } = fixture(); store.appendEvent(dir, 'node.start', { nodeId: 'build' }); store.appendEvent(dir, 'agent.end', { nodeId: 'build', agentId: 'build', ok: true }); expect(readWorkflowProjection(dir).tasks[0].state).toBe('running'); });
test('duplicate agent identities fail closed', () => { const { store, dir } = fixture(); const a = store.upsertAgent(dir, { agentId: 'build', state: 'failed' }); writeFileSync(join(dir, 'agents', 'duplicate.json'), JSON.stringify(a)); expect(() => readWorkflowProjection(dir)).toThrow(); });
test('scoped output requires matching content digest', () => { const { store, dir } = fixture(); store.upsertAgent(dir, { agentId: 'build', state: 'done-unverified' }); store.writeArtifact(dir, 'build', 'valid output'); expect(readTaskOutput(dir, 'build')).toBe('valid output'); writeFileSync(join(dir, 'artifacts', 'nodes', 'build.md'), 'changed'); expect(() => readTaskOutput(dir, 'build')).toThrow(); });
test('empty or truncated terminal event evidence cannot appear complete',()=>{const {store,dir}=fixture();store.updateRun(dir,{status:'completed'});writeFileSync(join(dir,'events.jsonl'),'');expect(readWorkflowProjection(dir).status).toBe('incomplete');});
test('planned and unreached cancelled nodes are retained',()=>{const {store,dir}=fixture();store.appendEvent(dir,'workflow.start',{layers:[['build'],['unreached']]});store.appendEvent(dir,'node.start',{nodeId:'build'});store.appendEvent(dir,'node.end',{nodeId:'build',status:'success'});store.appendEvent(dir,'workflow.end',{status:'cancelled',nodes:{build:'success',unreached:'cancelled'}});store.updateRun(dir,{status:'aborted'});const p=readWorkflowProjection(dir);expect(p.tasks.find(t=>t.id==='unreached')?.state).toBe('cancelled');expect(p.stats.cancelled).toBe(1);expect(p.status).toBe('aborted');});
test('terminal workflow summary cannot conceal running child',()=>{const {store,dir}=fixture();store.appendEvent(dir,'node.start',{nodeId:'build'});store.appendEvent(dir,'workflow.end',{status:'completed',nodes:{build:'success'}});store.updateRun(dir,{status:'completed'});expect(readWorkflowProjection(dir).status).toBe('incomplete');});

test('captured inventory retains queued phase, exact title and kind without counting nodes as agents', () => {
    const { store, dir, root } = fixture();
    store.appendEvent(dir, 'workflow.start', { description: 'Captured purpose', layers: [['build'], ['review']], nodes: [
        { id: 'build', phase: 'Build', kind: 'bash', title: 'Exact configured label' },
        { id: 'review', phase: 'Review', kind: 'prompt', title: 'Review evidence' },
    ] });
    writeFileSync(join(root, 'workflow.yaml'), 'description: changed after execution');
    expect(readWorkflowProjection(dir).tasks.find(t => t.id === 'review')).toMatchObject({ state: 'queued', phase: 'Review', kind: 'prompt' });
    store.appendEvent(dir, 'node.start', { nodeId: 'build', type: 'bash' });
    store.appendEvent(dir, 'agent.start', { agentId: 'review', nodeId: 'review', label: 'generated/label' });
    store.upsertAgent(dir, { agentId: 'review', callsign: 'record default' });
    const p = readWorkflowProjection(dir);
    expect(p.description).toBe('Captured purpose');
    expect(p.agentCount).toBe(1);
    expect(p.tasks.find(t => t.id === 'build')).toMatchObject({ phase: 'Build', kind: 'bash', title: 'Exact configured label' });
    expect(p.tasks.find(t => t.id === 'review')).toMatchObject({ phase: 'Review', kind: 'prompt', title: 'Review evidence' });
});

test('task times require execution evidence and agent return cannot end its running node', () => {
    const { store, dir } = fixture();
    store.appendEvent(dir, 'workflow.start', { layers: [['build'], ['queued']] });
    store.appendEvent(dir, 'node.start', { nodeId: 'build' });
    store.appendEvent(dir, 'agent.start', { nodeId: 'build', agentId: 'build' });
    store.appendEvent(dir, 'agent.end', { nodeId: 'build', agentId: 'build', ok: true });
    let p = readWorkflowProjection(dir);
    expect(Number.isFinite(Date.parse(p.tasks[0].startedAt!))).toBe(true);
    expect(p.tasks[0].endedAt).toBeUndefined();
    expect(p.tasks[1].startedAt).toBeUndefined();
    expect(p.tasks[1].endedAt).toBeUndefined();
    store.appendEvent(dir, 'node.end', { nodeId: 'build', status: 'failed' });
    p = readWorkflowProjection(dir);
    expect(Number.isFinite(Date.parse(p.tasks[0].endedAt!))).toBe(true);
    expect(p.tasks[0].state).toBe('failed');
    expect(p.stats.exactOneReview).toBeNull();
});

test('legacy metadata stays unknown and late starts do not invent a start time', () => {
    const { store, dir } = fixture();
    store.appendEvent(dir, 'node.end', { nodeId: 'build', status: 'failed' });
    store.appendEvent(dir, 'node.start', { nodeId: 'build' });
    const p = readWorkflowProjection(dir);
    expect(p.description).toBeUndefined();
    expect(p.agentCount).toBe(0);
    expect(p.tasks[0].kind).toBeUndefined();
    expect(p.tasks[0].startedAt).toBeUndefined();
    expect(Number.isFinite(Date.parse(p.tasks[0].endedAt!))).toBe(true);
});


test('invalid event timestamps remain unknown', () => {
    const { dir, runId } = fixture();
    let prev = GENESIS;
    const rows = ['node.start', 'node.end'].map((type, index) => {
        const body = { runId, seq: index + 1, prev, ts: 'not-a-time', type, data: { nodeId: 'build', status: 'success' } };
        const row = { ...body, hash: sha256(canonicalJson(body)) };
        prev = row.hash;
        return JSON.stringify(row);
    });
    writeFileSync(join(dir, 'events.jsonl'), rows.join('\n') + '\n');
    const task = readWorkflowProjection(dir).tasks[0];
    expect(task.startedAt).toBeUndefined();
    expect(task.endedAt).toBeUndefined();
    expect(task.seconds).toBeUndefined();
});
