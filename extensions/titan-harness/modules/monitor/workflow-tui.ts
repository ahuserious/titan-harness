import type { WorkflowProjection } from './workflow-projection.ts';

/** Observer-local interaction state; never persisted to the run or sent to a model. */
export interface WorkflowTuiState { expanded: Set<string>; selected: number; offset: number; help: boolean; followSelection?: boolean; group?: 'all' | 'running' | 'finished' }
export const createWorkflowTuiState = (p?: WorkflowProjection): WorkflowTuiState => ({ expanded: new Set(p?.phases.filter(phase => phase.tasks.some(t => isActive(t.state))).map(phase => phase.id)), selected: 0, offset: 0, help: false, group: 'all' });
const clean = (s: unknown): string => String(s ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/[^\x20-\x7e]/g, '?');
const fit = (s: string, n: number): string => n <= 0 ? '' : s.length <= n ? s.padEnd(n) : n > 3 ? s.slice(0, n - 3) + '...' : s.slice(0, n);
const isActive = (s: string) => ['running', 'working', 'dispatched-working', 'in-review', 'edit-round-n', 'harvesting', 'compacting', 'resuming', 'authoring-workflow', 'repairing-workflow', 'system-run'].includes(s);
const mark = (s: string): string => isActive(s) ? '[>]' : s === 'failed' ? '[!]' : ['cancelled','skipped'].includes(s) ? '[-]' : s === 'execution_completed' ? '[#]' : ['queued','pending'].includes(s) ? '[.]' : '[?]';

/** Groups classify this selected workflow, never its children. */
function workflowFinished(p: WorkflowProjection): boolean {
 return ['completed','failed','aborted','reauthored','stalemate','interrupted','cancelled','stopped'].includes(p.reportedStatus ?? p.status);
}
function visiblePhases(p: WorkflowProjection, group = 'all') {
 const finished = workflowFinished(p);
 return group !== 'all' && (group === 'finished') !== finished ? [] : p.phases.map((phase,index) => ({...phase,index}));
}
const tokens = (n?: number) => n === undefined ? '--' : n >= 1e6 ? `${+(n/1e6).toFixed(1)}M` : n >= 1000 ? `${+(n/1000).toFixed(1)}k` : String(n);
const duration = (n?: number) => n === undefined || !Number.isFinite(n) || n < 0 ? '--' : n >= 3600 ? `${Math.floor(n/3600)}h ${Math.floor(n%3600/60)}m` : n >= 60 ? `${Math.floor(n/60)}m ${Math.floor(n%60)}s` : `${Math.floor(n)}s`;
const elapsed = (start?: string, end?: string) => start && end ? duration((Date.parse(end)-Date.parse(start))/1000) : '--';

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
  body.push({text:'[#] executed [>] running [!] failed [-] stopped [.] pending [?] unknown'});
  body.push({text:'Executed counts are not acceptance or review approval.'});
  for (const warning of p.warnings) {
   const text = clean('! '+warning); const size = Math.max(1,inner-2);
   for (let i=0;i<text.length;i+=size) body.push({text:text.slice(i,i+size)});
  }
 }
 const finished = workflowFinished(p);
 const showWorkflow = local.group === 'all' || (local.group === 'finished') === finished;
 const groupTitle = finished ? 'Finished' : 'Running';
 // One selected run is available: do not manufacture session task history.
 if (showWorkflow) {
  body.push({text: `${groupTitle} 1`});
  body.push({text: `> ${p.name}`});
  body.push({text: `  Workflow | ${p.status} | ${elapsed(p.startedAt,p.endedAt ?? (p.status === 'running' && !workflowFinished(p) ? new Date().toISOString() : undefined))}`});
  const meta = p as WorkflowProjection & {agentCount?: number; description?: string};
  body.push({text: `  ${meta.agentCount === undefined ? '--' : meta.agentCount} agents | ${tokens(p.stats.observedTokens)} observed tokens`});
  if (meta.description) {
   const size = Math.max(1,inner-2);
   let summary = clean(meta.description);
   while (summary.length) {
    const space = summary.lastIndexOf(' ',size);
    const end = summary.length <= size ? summary.length : space > 0 ? space : size;
    body.push({text:'  '+summary.slice(0,end)});summary = summary.slice(end).trimStart();
   }
  }
  body.push({text: '  Phases (executed/total)'});
 }
 phases.forEach((phase) => {
  const i = phase.index;
  const open = local.expanded.has(phase.id), selected = i === local.selected;
  const executed = phase.tasks.filter(t => mark(t.state) === '[#]').length;
  const failed = phase.tasks.filter(t => mark(t.state) === '[!]').length;
  const stopped = phase.tasks.filter(t => mark(t.state) === '[-]').length;
  const counts = `${executed}/${phase.tasks.length}`;
  body.push({ text: `${selected ? '>' : ' '} ${open ? 'v' : '>'} ${fit(clean(phase.title),Math.max(1,inner-counts.length-6))} ${counts}`, phase: i });
  const cells = phase.tasks.map(t => mark(t.state));
  const perRow = Math.max(1,Math.floor((inner-4)/3));
  if (!cells.length) body.push({text:'    [.] No tasks recorded'});
  for (let n=0;n<cells.length;n+=perRow) body.push({text:'    '+cells.slice(n,n+perRow).join('')});
  if (failed || stopped) body.push({text:`    ${failed} failed | ${stopped} stopped`});
  if (open && phase.tasks.length) {
   const wide = inner >= 58;
   const modelWidth = Math.max(12, Math.min(24,Math.floor(inner*.24)));
   const agentWidth = Math.max(8,inner-modelWidth-23);
   const columns = (agent: string, model: string, tok: string, time: string) => `    ${fit(clean(agent),agentWidth)} ${fit(clean(model),modelWidth)} ${fit(tok,7)} ${fit(time,8)}`;
   if (wide) body.push({text:columns('Agent','Model','Tokens','Time')});
   for (const t of phase.tasks) {
    const model = t.model ? `${t.modelSource === 'configured' ? 'cfg' : t.modelSource === 'observed' ? 'obs' : '?'}:${t.model}` : '--';
    body.push({text:wide ? columns(`${mark(t.state)} ${t.title}`,model,tokens(t.tokens),duration(t.seconds)) : `    ${mark(t.state)} ${t.title}`});
    if (!wide) body.push({text:`        ${model} | ${tokens(t.tokens)} tok | ${duration(t.seconds)}`});
    // Completion describes execution only, never acceptance or review authority.
    if (local.help || mark(t.state) !== '[#]') body.push({text:`        ${t.state} | ${t.role}`});
    if (t.error) {
     const text = clean('! '+t.error), size = Math.max(1,inner-4);
     for (let n=0;n<text.length;n+=size) body.push({text:'    '+text.slice(n,n+size)});
    }
   }
  }
 });
 if (!showWorkflow) body.push({text: `No ${local.group} workflow in this selected run.`});
 if (local.group === 'all') body.push({text: `${finished ? 'Running' : 'Finished'} 0`});
 const fixed = [fit(border,width), row('Background tasks'), row(`${local.group === 'all' ? '[A All]' : 'A All'}  ${local.group === 'running' ? '[R Running]' : 'R Running'}  ${local.group === 'finished' ? '[F Finished]' : 'F Finished'}`), ...(p.warnings.length ? [row(`! ${p.warnings.length} evidence notes - H details`)] : []), fit(border,width)];
 const footer = [fit(border,width), row(workflowFooter(p,inner)), row(local.help ? 'J/K move; Enter expand; [/] scroll; Q close' : 'J/K Enter [/] scroll H details Q close'), fit(border,width)];
 const available = Math.max(0, height - fixed.length - footer.length);
 const selectedRow = body.findIndex(r => r.phase === local.selected);
 let offset = Math.max(0, Math.min(local.offset, Math.max(0, body.length - available)));
 if (!local.help && local.followSelection === true && selectedRow >= 0 && available > 1) {
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
 if (input === 'a' || input === 'r' || input === 'f') { next.group = input === 'r' ? 'running' : input === 'f' ? 'finished' : 'all'; next.selected = visiblePhases(p,next.group)[0]?.index ?? 0; next.offset = 0; next.followSelection = false; }
 const position = Math.max(0,indices.indexOf(next.selected));
 if (input === 'j' || input === '\x1b[B') { next.followSelection = true; next.selected = indices[Math.min(indices.length-1,position+1)] ?? 0; }
 if (input === 'k' || input === '\x1b[A') { next.followSelection = true; next.selected = indices[Math.max(0,position-1)] ?? 0; }
 const click = /^\x1b\[<0;(\d+);(\d+)M$/.exec(input);
 const clicked = click ? hitRows?.get(Number(click[2])) : undefined;
 if (clicked !== undefined) next.selected = clicked;
 if (input === '\r' || input === ' ' || clicked !== undefined) {
  const id = p.phases[next.selected]?.id;
  if (id && indices.includes(next.selected)) next.expanded.has(id) ? next.expanded.delete(id) : next.expanded.add(id);
 }
 if (input === ']' || input === '\x1b[6~' || /^\x1b\[<65;/.test(input)) { next.offset += 5; next.followSelection = false; }
 if (input === '[' || input === '\x1b[5~' || /^\x1b\[<64;/.test(input)) { next.offset = Math.max(0,next.offset-5); next.followSelection = false; }
 if (input === 'h') { next.help = !next.help; next.offset = 0; }
 return next;
}
