#!/usr/bin/env bun
/** Loopback-only human observer. No provider, tool dispatch, store writes or cancellation. */
import { readWorkflowProjection, readTaskOutput } from '../extensions/titan-harness/modules/monitor/workflow-projection.ts';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
export function startWorkflowObserver(runDir: string, port = 0) {
    const token = randomBytes(24).toString('hex');
    const base = fileURLToPath(new URL('../web/workflow/', import.meta.url));
    const server = Bun.serve({ hostname: '127.0.0.1', port, async fetch(req) {
            const url = new URL(req.url);
            const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'" };
            if (req.headers.get('host') !== `127.0.0.1:${server.port}`)
                return new Response('Forbidden host', { status: 403, headers });
            if (req.method !== 'GET')
                return new Response('Read-only observer', { status: 405, headers });
            if (url.pathname === '/api/snapshot' || url.pathname === '/api/output') {
                if (req.headers.get('authorization') !== `Bearer ${token}`)
                    return new Response('Observer token required', { status: 401, headers });
                try {
                    if (url.pathname === '/api/output')
                        return new Response(readTaskOutput(runDir, url.searchParams.get('task') ?? ''), { headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' } });
                    const projection = readWorkflowProjection(runDir);
                    const after = url.searchParams.get('after');
                    return Response.json({ kind: after === projection.cursor ? 'unchanged' : 'snapshot', reset: !!after && after !== projection.cursor, projection: after === projection.cursor ? undefined : projection, cursor: projection.cursor }, { headers });
                }
                catch (e) {
                    return Response.json({ error: 'Snapshot unavailable; evidence may be incomplete', detail: e instanceof Error ? e.message : String(e) }, { status: 409, headers });
                }
            }
            const routes: Record<string, string> = { '/': 'index.html', '/index.html': 'index.html', '/client.js': 'client.js', '/style.css': 'style.css' };
            const file = routes[url.pathname];
            if (!file)
                return new Response('Not found', { status: 404, headers });
            return new Response(Bun.file(resolve(base, file)), { headers });
        } });
    return { server, url: `http://127.0.0.1:${server.port}/#${token}`, stop: () => server.stop(true) };
}
if (import.meta.main) {
    const args = process.argv.slice(2);
    const value = (key: string) => { const i = args.indexOf(key); return i >= 0 ? args[i + 1] : undefined; };
    if (args.includes('--help') || !value('--run')) {
        console.log('Usage: bun scripts/titan-workflow-view.ts --run <run-directory> [--port 4319]\nRead-only chat output + right workflow pane. Popout shares the same producer.');
        process.exit(args.includes('--help') ? 0 : 2);
    }
    const run = resolve(value('--run')!);
    readWorkflowProjection(run);
    const port = Number(value('--port') ?? 0);
    if (!Number.isInteger(port) || port < 0 || port > 65535)
        throw new Error('Invalid port');
    const observer = startWorkflowObserver(run, port);
    console.log(observer.url);
    for (const signal of ['SIGINT', 'SIGTERM'] as const)
        process.on(signal, () => { observer.stop(); process.exit(0); });
}
