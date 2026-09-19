#!/usr/bin/env bun
/** Read-only observer. Run in an existing right-side terminal pane; never dispatches work. */
import { readWorkflowProjection } from '../extensions/titan-harness/modules/monitor/workflow-projection.ts';
import { createWorkflowTuiState, renderWorkflowTui, applyWorkflowTuiInput } from '../extensions/titan-harness/modules/monitor/workflow-tui.ts';
import path from 'node:path';

const args = process.argv.slice(2), at = args.indexOf('--run');
if (at < 0 || !args[at+1] || args.includes('--help')) {
 console.log('Usage: bun scripts/titan-workflow-tui.ts --run <run-directory> [--once]\nRead-only workflow observer. J/K navigate, Enter expand, [/] scroll, H help, Q exit.');
 process.exit(at < 0 && !args.includes('--help') ? 2 : 0);
}
const runDir = path.resolve(args[at+1]);
let local = createWorkflowTuiState();
let projection: ReturnType<typeof readWorkflowProjection>;
let layout: ReturnType<typeof renderWorkflowTui>;
const interactive = process.stdin.isTTY && process.stdout.isTTY && !args.includes('--once');
let closed = false, timer: ReturnType<typeof setInterval> | undefined;
function restore() {
 if (closed) return; closed = true;
 if (timer) clearInterval(timer);
 if (interactive) { process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[?1049l'); }
}
function draw() {
 try {
  projection = readWorkflowProjection(runDir);
  local.selected = Math.max(0,Math.min(local.selected,projection.phases.length-1));
  layout = renderWorkflowTui(projection,local,process.stdout.columns || 80,process.stdout.rows || 30);
  local.offset = layout.offset;
  process.stdout.write((interactive ? '\x1b[H\x1b[2J' : '') + layout.lines.join('\n') + '\n');
 } catch(error) {
  if (!interactive) { console.error(String(error)); process.exitCode = 1; return; }
  process.stdout.write('\x1b[H\x1b[2JWorkflow observer unavailable; retrying. Q closes observer.\n');
 }
}
if (interactive) {
 process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h');
 process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
 process.stdin.on('data',(data: string) => {
  for (const input of data.match(/\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[[AB]|\x1b\[[56]~|[\s\S]/g) ?? []) {
   if (input === 'q' || input === '\x03' || input === '\x1b') { restore(); return; }
   if (projection) local = applyWorkflowTuiInput(projection,local,input,layout?.hitRows);
  }
  if (!closed) draw();
 });
 process.stdout.on('resize', draw);
 process.once('SIGINT',restore); process.once('SIGTERM',restore); process.once('exit',restore);
 timer = setInterval(draw,1000);
}
draw();
