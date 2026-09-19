import type { WorkflowProjection } from './workflow-projection.ts';

/** Observer-local interaction state; never persisted to the run or sent to a model. */
export interface WorkflowTuiState { expanded: Set<string>; selected: number; offset: number; help: boolean; followSelection?: boolean }
export const createWorkflowTuiState = (): WorkflowTuiState => ({ expanded: new Set(), selected: 0, offset: 0, help: false });
const clean = (s: unknown): string => String(s ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/[^\x20-\x7e]/g, '?');
const fit = (s: string, n: number): string => n <= 0 ? '' : s.length <= n ? s.padEnd(n) : n > 3 ? s.slice(0, n - 3) + '...' : s.slice(0, n);
const isActive = (s: string) => ['running', 'working', 'dispatched-working', 'in-review', 'edit-round-n', 'harvesting', 'compacting', 'resuming', 'authoring-workflow', 'repairing-workflow', 'system-run'].includes(s);
const mark = (s: string): string => isActive(s) ? '[>]' : /failed|error|stalemate/.test(s) ? '[!]' : /cancel|stop|abort/.test(s) ? '[-]' : /done|complete|success|verified/.test(s) ? '[x]' : '[ ]';

export function workflowFooter(p: WorkflowProjection): string {
 const rate = p.stats.avgTps === undefined ? '--' : p.stats.avgTps.toFixed(1);
 return `avg ${rate} tok/s | ${p.stats.running} running | ${p.stats.measured}/${p.stats.samples} measured`;
}

export function renderWorkflowTui(p: WorkflowProjection, local: WorkflowTuiState, width: number, height: number) {
 width = Math.max(1, Math.floor(width)); height = Math.max(1, Math.floor(height));
 const inner = Math.max(0, width - 2), border = '+' + '-'.repeat(inner) + '+';
 const row = (text: string) => fit('|' + fit(clean(text), inner) + '|', width);
 const body: Array<{text: string; phase?: number}> = p.warnings.map(warning => ({text: "! " + warning}));
 p.phases.forEach((phase, i) => {
  const open = local.expanded.has(phase.id), selected = i === local.selected;
  const active = phase.tasks.filter(t => isActive(t.state)).length;
  body.push({ text: `${selected ? '>' : ' '} ${open ? 'v' : '>'} ${phase.title} (${phase.tasks.length}; ${active} active)`, phase: i });
  if (open) for (const t of phase.tasks) {
   body.push({ text: `    ${mark(t.state)} ${t.title}` });
   body.push({ text: `        ${t.state} | ${t.role}` });
   if (inner >= 40) body.push({ text: `        ${t.model ?? '--'} (${t.modelSource}) | ${t.tokens ?? '--'} tok | ${t.seconds === undefined ? '--' : t.seconds.toFixed(1)}s` });
   if (t.error) body.push({ text: `        ! ${t.error}` });
  }
 });
 if (!body.length) body.push({text: '  No workflow tasks recorded.'});
 const fixed = [row(`WORKFLOW ${p.name}`), row(`${p.status} | ${p.stats.running} running | ${p.stats.finished} finished`), fit(border,width)];
 const footer = [fit(border,width), row(workflowFooter(p)), row(local.help ? 'J/K move; Enter expand; [/] scroll; Q close' : 'J/K move Enter expand [/] scroll H help Q close')];
 const available = Math.max(0, height - fixed.length - footer.length);
 const selectedRow = body.findIndex(r => r.phase === local.selected);
 let offset = Math.max(0, Math.min(local.offset, Math.max(0, body.length - available)));
 if (local.followSelection !== false && selectedRow >= 0 && available > 1) {
  if (selectedRow < offset) offset = selectedRow;
  if (selectedRow >= offset + available - 1) offset = Math.max(0, selectedRow - available + 2);
 }
 const more = body.length > offset + available;
 const shown = body.slice(offset, offset + Math.max(0, available - (more ? 1 : 0)));
 const hitRows = new Map<number, number>();
 shown.forEach((r,i) => { if (r.phase !== undefined) hitRows.set(fixed.length + i + 1, r.phase); });
 const lines = [...fixed,...shown.map(r=>row(r.text)),...(more && available ? [row(`... ${body.length-offset-shown.length} more rows`)] : []),...footer].slice(0,height);
 return { lines, hitRows, offset };
}

export function applyWorkflowTuiInput(p: WorkflowProjection, state: WorkflowTuiState, input: string, hitRows?: Map<number,number>): WorkflowTuiState {
 const next = {...state,expanded: new Set(state.expanded)};
 if (input === 'j' || input === '\x1b[B') { next.followSelection = true; next.selected = Math.min(Math.max(0,p.phases.length-1),next.selected+1); }
 if (input === 'k' || input === '\x1b[A') { next.followSelection = true; next.selected = Math.max(0,next.selected-1); }
 const click = /^\x1b\[<0;(\d+);(\d+)M$/.exec(input);
 const clicked = click ? hitRows?.get(Number(click[2])) : undefined;
 if (clicked !== undefined) next.selected = clicked;
 if (input === '\r' || input === ' ' || clicked !== undefined) {
  const id = p.phases[next.selected]?.id;
  if (id) next.expanded.has(id) ? next.expanded.delete(id) : next.expanded.add(id);
 }
 if (input === ']' || input === '\x1b[6~') { next.offset += 5; next.followSelection = false; }
 if (input === '[' || input === '\x1b[5~') { next.offset = Math.max(0,next.offset-5); next.followSelection = false; }
 if (input === 'h') next.help = !next.help;
 return next;
}
