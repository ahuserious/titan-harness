import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunStore } from '../modules/run-store.ts';
import { startWorkflowObserver } from '../../../scripts/titan-workflow-view.ts';
test('observer requires token, reconnects by cursor, rejects mutation and preserves producer', async () => { const root = mkdtempSync(join(tmpdir(), 'workflow-http-')); const store = new RunStore(root); const { dir } = store.open({ cwd: root, projectSlug: 'test', status: 'running' }); const original = readFileSync(join(dir, 'run.json'), 'utf8'); const observer = startWorkflowObserver(dir); try {
    const url = new URL(observer.url);
    const token = url.hash.slice(1);
    url.hash = '';
    const api = new URL('/api/snapshot', url);
    expect((await fetch(api)).status).toBe(401);
    const headers = { Authorization: 'Bearer ' + token };
    const first = await (await fetch(api, { headers })).json();
    expect(first.kind).toBe('snapshot');
    api.searchParams.set('after', first.cursor);
    const same = await (await fetch(api, { headers })).json();
    expect(same.kind).toBe('unchanged');
    expect((await fetch(api, { method: 'POST', headers })).status).toBe(405);
    store.upsertAgent(dir, { agentId: 'x', state: 'failed' });
    const next = await (await fetch(api, { headers })).json();
    expect(next.kind).toBe('snapshot');
    expect(next.reset).toBe(true);
    expect(next.projection.stats.failed).toBe(1);
    expect(readFileSync(join(dir, 'run.json'), 'utf8')).toBe(original);
}
finally {
    observer.stop();
    expect(store.readRun(dir).status).toBe('running');
    rmSync(root, { recursive: true, force: true });
} });
