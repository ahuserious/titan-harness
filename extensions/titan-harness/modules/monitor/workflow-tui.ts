import type { WorkflowProjection } from './workflow-projection.ts';

/** Observer-local interaction state; never persisted to the run or sent to a model. */
export interface WorkflowTuiState { expanded: Set<string>; selected: number; offset: number; help: boolean; followSelection?: boolean; group?: 'all' | 'running' | 'finished' }
export const createWorkflowTuiState = (p?: WorkflowProjection): WorkflowTuiState => ({ expanded: new Set(p?.phases.filter(phase => phase.tasks.some(t => isActive(t.state))).map(phase => phase.id)), selected: 0, offset: 0, help: false, group: 'all' });
const clean = (s: unknown): string => String(s ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/[^\x20-\x7e]/g, '?');
const fit = (s: string, n: number): string => n <= 0 ? '' : s.length <= n ? s.padEnd(n) : n > 3 ? s.slice(0, n - 3) + '...' : s.slice(0, n);
const isActive = (s: string) => ['running', 'working', 'dispatched-working', 'in-review', 'edit-round-n', 'harvesting', 'compacting', 'resuming', 'authoring-workflow', 'repairing-workflow', 'system-run'].includes(s);
const mark = (s: string): string => isActive(s) ? '[>]' : /failed|error|stalemate/.test(s) ? '[!]' : /cancel|stop|abort/.test(s) ? '[-]' : /done|complete|success|verified/.test(s) ? '[x]' : '[ ]';

const isFinished = (state: string) => ['execution_completed','completed','failed','cancelled','skipped','stopped'].includes(state);
function visiblePhases(p: WorkflowProjection, group = 'all') {
 return p.phases.map((phase,index) => ({...phase,index,tasks:phase.tasks.filter(t => group === 'all' || (group === 'finished' ? isFinished(t.state) : !isFinished(t.state)))})).filter(phase => group === 'all' || phase.tasks.length > 0 || (group === 'running' && p.phases[phase.index].tasks.length === 0));
}
export function workflowFooter(p: WorkflowProjection, width = 120): string {
 const rate = p.stats.avgTps === undefined ? '--' : p.stats.avgTps.toFixed(1);
 const tasks = p.tasks.length ? p.tasks : p.phases.flatMap(phase=>phase.tasks);
 const models = [...new Set(tasks.filter(t => isActive(t.state) && t.model).map(t => `${t.modelSource === 'observed' ? 'observed' : t.modelSource === 'configured' ? 'configured' : '?'}:${clean(t.model)}`))];
 const prefix = `Workspace | avg ${rate} tok/s | `, suffix = ` | ${p.stats.running} running`;
 const budget = Math.max(0,width-prefix.length-suffix.length);
 const source = models.every(m=>m.startsWith('configured:')) ? 'configured' : models.every(m=>m.startsWith('observed:')) ? 'observed' : 'mixed';
 let label = models.length ? `${source} +${models.length}` : 'models ?';
 for (let n = models.length; n >= 1; n--) {
  const candidate = models.slice(0,n).join(', ') + (n < models.length ? ` +${models.length-n}` : '');
  if (candidate.length <= budget) { label = candidate; break; }
 }
 if (prefix.length+label.length+suffix.length <= width) return prefix+label+suffix;
 const compact = `Workspace|avg ${rate} tok/s|${models.length ? (source === 'configured' ? 'cfg+' : source === 'observed' ? 'obs+' : 'mix+')+models.length : 'models?'}|${p.stats.running} run`;
 return fit(compact,width).trimEnd();
}

export function renderWorkflowTui(p: WorkflowProjection, local: WorkflowTuiState, width: number, height: number) {
 width = Math.max(1, Math.floor(width)); height = Math.max(1, Math.floor(height));
 const inner = Math.max(0, width - 2), border = '+' + '-'.repeat(inner) + '+';
 const row = (text: string) => fit('|' + fit(clean(text), inner) + '|', width);
 const body: Array<{text: string; phase?: number}> = [];
 const phases = visiblePhases(p, local.group);
 if (local.help) {
  body.push({text:`Failures ${p.stats.failed} | cancelled ${p.stats.cancelled} | unreviewed ${p.stats.unreviewed}`});
  body.push({text:`Measured ${p.stats.measured}/${p.stats.samples} samples | ${p.stats.observedTokens} observed tokens`});
  body.push({text:`Estimated rate ${p.stats.estimatedTps === undefined ? '--' : p.stats.estimatedTps.toFixed(1)} tok/s (not measured)`});
  body.push({text:'Exact-one-review: unknown; independent receipts unavailable'});
  body.push({text:'Model labels: cfg = configured, obs = observed dispatch'});
  for (const warning of p.warnings) {
   const text = clean('! '+warning); const size = Math.max(1,inner-2);
   for (let i=0;i<text.length;i+=size) body.push({text:text.slice(i,i+size)});
  }
 }
 phases.forEach((phase) => {
  const i = phase.index;
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
 if (!body.length) body.push({text: `  No ${local.group === 'all' ? '' : local.group + ' '}tasks recorded.`});
 const fixed = [fit(border,width), row(`WORKFLOW ${p.name}`), row(`${p.status} | ${p.stats.running} running | ${p.stats.finished} finished`), row(`${local.group === 'all' ? '[A All]' : 'A All'}  ${local.group === 'running' ? '[R Running]' : 'R Running'}  ${local.group === 'finished' ? '[F Finished]' : 'F Finished'}`), ...(p.warnings.length ? [row(`! ${p.warnings.length} evidence notes - H details`)] : []), fit(border,width)];
 const footer = [fit(border,width), row(workflowFooter(p,inner)), row(local.help ? 'J/K move; Enter expand; [/] scroll; Q close' : 'J/K Enter [/] scroll H details Q close'), fit(border,width)];
 const available = Math.max(0, height - fixed.length - footer.length);
 const selectedRow = body.findIndex(r => r.phase === local.selected);
 let offset = Math.max(0, Math.min(local.offset, Math.max(0, body.length - available)));
 if (!local.help && local.followSelection !== false && selectedRow >= 0 && available > 1) {
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
 const phases = visiblePhases(p,state.group), indices = phases.map(phase=>phase.index);
 if (input === 'a' || input === 'r' || input === 'f') { next.group = input === 'r' ? 'running' : input === 'f' ? 'finished' : 'all'; next.selected = visiblePhases(p,next.group)[0]?.index ?? 0; next.offset = 0; next.followSelection = true; }
 const position = Math.max(0,indices.indexOf(next.selected));
 if (input === 'j' || input === '\x1b[B') { next.followSelection = true; next.selected = indices[Math.min(indices.length-1,position+1)] ?? 0; }
 if (input === 'k' || input === '\x1b[A') { next.followSelection = true; next.selected = indices[Math.max(0,position-1)] ?? 0; }
 const click = /^\x1b\[<0;(\d+);(\d+)M$/.exec(input);
 const clicked = click ? hitRows?.get(Number(click[2])) : undefined;
 if (clicked !== undefined) next.selected = clicked;
 if (input === '\r' || input === ' ' || clicked !== undefined) {
  const id = p.phases[next.selected]?.id;
  if (id) next.expanded.has(id) ? next.expanded.delete(id) : next.expanded.add(id);
 }
 if (input === ']' || input === '\x1b[6~') { next.offset += 5; next.followSelection = false; }
 if (input === '[' || input === '\x1b[5~') { next.offset = Math.max(0,next.offset-5); next.followSelection = false; }
 if (input === 'h') { next.help = !next.help; next.offset = 0; }
 return next;
}
