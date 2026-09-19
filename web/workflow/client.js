const $ = id => document.getElementById(id);
const token = location.hash.slice(1);
const detached = new URLSearchParams(location.search).has('popout');
let cursor = '', state, selectedOutput = '', outputFocusKey = '', stopped = false, workflowExpanded = true, finishedExpanded = true;
const expanded = new Set(), touched = new Set();
const finishedStates = new Set(['completed', 'failed', 'aborted', 'reauthored', 'stalemate', 'cancelled', 'stopped']);
const workflowFinished = p => finishedStates.has(p.reportedStatus ?? p.status);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = String(text);
  return node;
};
const fmt = n => n === undefined ? '—' : new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
const duration = seconds => {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const s = Math.floor(seconds), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
  return h ? `${h}h ${m}m ${s % 60}s` : m ? `${m}m ${s % 60}s` : `${s}s`;
};
const stateLabel = s => ({ execution_completed: 'Executed · review unknown', completed: 'Execution finished · review unknown', running: 'Running', pending: 'Pending', queued: 'Pending', failed: 'Failed', aborted: 'Stopped', cancelled: 'Stopped', skipped: 'Skipped', incomplete: 'Incomplete', reauthored: 'Needs reauthoring', stalemate: 'Stalled' })[s] ?? s;
const shortModel = task => task.model ? task.model.split('/').at(-1) : '—';
function elapsed(start, end, active) {
  if (!start || (!end && !active)) return undefined;
  const a = Date.parse(start), b = end ? Date.parse(end) : Date.now();
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? (b - a) / 1000 : undefined;
}
function elapsedNode(start, end, active, fallback) {
  const node = el('span', 'elapsed', duration(elapsed(start, end, active) ?? fallback));
  if (start && !end && active) node.dataset.started = start;
  return node;
}
function progress(tasks, compact = false) {
  const grid = el('div', `progress-grid${compact ? ' compact-progress' : ''}`);
  const counts = { executed: 0, running: 0, failed: 0, stopped: 0, pending: 0 };
  for (const task of tasks) {
    const group = task.state === 'execution_completed' ? 'executed' : task.state === 'running' ? 'running' : task.state === 'failed' ? 'failed' : ['cancelled', 'skipped'].includes(task.state) ? 'stopped' : 'pending';
    counts[group]++;
  }
  grid.setAttribute('role', 'img');
  grid.setAttribute('aria-label', `${tasks.length} tasks: ${counts.executed} executed, ${counts.running} running, ${counts.failed} failed, ${counts.stopped} stopped or skipped, ${counts.pending} pending or unknown. Execution is not acceptance.`);
  for (const task of tasks.slice(0, 256)) {
    const cell = el('span', `progress-cell ${task.state}`);
    cell.title = `${task.title}: ${stateLabel(task.state)}`;
    cell.setAttribute('aria-hidden', 'true');
    grid.append(cell);
  }
  if (tasks.length > 256) grid.append(el('span', 'progress-overflow', `+${tasks.length - 256}`));
  if (!tasks.length) grid.append(el('span', 'inventory-unknown', 'Task inventory unavailable'));
  return grid;
}
async function api(path) {
  const response = await fetch(path, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
  if (!response.ok) throw new Error(`Observer unavailable (${response.status})`);
  return response;
}
async function openOutput(task) {
  selectedOutput = task.id;
  outputFocusKey = document.activeElement?.dataset?.focusKey ?? 'output:' + task.id;
  $('output-title').textContent = task.title;
  $('output-text').textContent = 'Loading recorded output…';
  $('output-dialog').showModal();
  try {
    const response = await api('/api/output?task=' + encodeURIComponent(task.id));
    const text = await response.text();
    if (selectedOutput === task.id && $('output-dialog').open) $('output-text').textContent = text;
  } catch (error) { if (selectedOutput === task.id) $('output-text').textContent = error.message; }
}
function taskTable(tasks) {
  const table = el('table', 'agent-table');
  const caption = el('caption', 'sr-only', 'Task execution. Model identities marked configured are not verified provider dispatch receipts.');
  const head = el('thead'), titles = el('tr');
  for (const title of ['Agent / task', 'Model', 'Tokens', 'Time']) {
    const th = el('th', '', title); th.scope = 'col'; titles.append(th);
  }
  head.append(titles); table.append(caption, head);
  const body = el('tbody');
  for (const task of tasks) {
    const row = el('tr', `task-row ${task.state}`);
    row.title = `${task.role} · ${stateLabel(task.state)}`;
    const name = el('td', 'agent-name'), nameLine = el('div', 'agent-name-line');
    const glyph = task.state === 'execution_completed' ? '✓' : task.state === 'failed' ? '!' : task.state === 'cancelled' ? '−' : '';
    const mark = el('span', 'row-mark', glyph); mark.setAttribute('aria-hidden', 'true');
    const title = task.outputAvailable ? el('button', 'output-link', task.title) : el('span', 'task-name', task.title);
    title.title = `${task.title} · ${stateLabel(task.state)}`;
    if (task.outputAvailable) {
      title.dataset.focusKey = 'output:' + task.id;
      title.setAttribute('aria-label', `Open recorded output: ${task.title}`);
      title.onclick = () => openOutput(task);
    }
    nameLine.append(mark, title); name.append(nameLine);
    const model = el('td', 'model-name', shortModel(task));
    model.title = task.model ? `${task.model} (${task.modelSource})` : 'Effective model unknown';
    model.setAttribute('aria-label', model.title);
    if (task.modelSource === 'configured' && task.model) model.append(el('sup', 'configured-mark', '†'));
    const tokens = el('td', 'number-cell', fmt(task.tokens));
    const time = el('td', 'number-cell task-time');
    if (task.state === 'failed') time.append(el('span', 'error-label', 'Error'));
    else if (task.state === 'cancelled') time.append(el('span', 'stopped-label', 'Stopped'));
    else time.append(elapsedNode(task.startedAt, task.endedAt, task.state === 'running' && !state.endedAt && !workflowFinished(state), task.seconds));
    row.append(name, model, tokens, time); body.append(row);
    if (task.error) {
      const errorRow = el('tr', 'error-detail'), errorCell = el('td', '', task.error);
      errorCell.colSpan = 4; errorRow.append(errorCell); body.append(errorRow);
    }
  }
  table.append(body); return table;
}
function workflowCard(p) {
  const card = el('article', 'workflow-card');
  const head = el('div', 'workflow-card-head');
  const toggle = el('button', 'workflow-title', p.name);
  toggle.dataset.focusKey = 'workflow';
  toggle.setAttribute('aria-expanded', String(workflowExpanded));
  toggle.append(el('span', 'chevron', workflowExpanded ? '⌄' : '›'));
  toggle.onclick = () => { workflowExpanded = !workflowExpanded; render(); };
  head.append(toggle); card.append(head);
  const meta = el('div', 'workflow-meta');
  meta.append(el('span', '', 'Workflow'), elapsedNode(p.startedAt, p.endedAt, !workflowFinished(p) && p.status !== 'incomplete'));
  if (p.status !== 'running') meta.append(el('span', 'run-state ' + p.status, stateLabel(p.status)));
  card.append(meta);
  const counts = el('div', 'workflow-counts', `${p.agentCount === undefined ? '— agents' : p.agentCount + ' agents'}  ·  ${fmt(p.stats.observedTokens)} observed tokens`);
  card.append(counts);
  if (!workflowExpanded) { card.append(progress(p.tasks, true)); return card; }
  if (p.description) card.append(el('p', 'workflow-description', p.description));
  const terminalNotice = p.status === 'incomplete' ? 'Run evidence is incomplete. Unresolved task states are retained for inspection.' : ['aborted', 'cancelled', 'stopped'].includes(p.status) ? 'The workflow stopped. Recorded outputs and task states remain available.' : p.status === 'failed' ? 'The workflow failed. Expand its phases to inspect recorded errors.' : undefined;
  if (terminalNotice) {
    const notice = el('div', 'run-notice ' + p.status);
    notice.append(el('strong', '', stateLabel(p.status)), el('p', '', terminalNotice)); card.append(notice);
  }
  card.append(el('h4', 'phases-heading', 'Phases'));
  const phases = el('div', 'phases');
  for (const phase of p.phases) {
    const open = touched.has(phase.id) ? expanded.has(phase.id) : phase.tasks.some(task => task.state === 'running');
    const section = el('section', 'phase' + (open ? ' expanded' : ''));
    const button = el('button', 'phase-toggle' + (phase.tasks.some(t => t.state === 'failed') ? ' has-error' : ''));
    button.dataset.focusKey = 'phase:' + phase.id;
    button.setAttribute('aria-expanded', String(open));
    const top = el('span', 'phase-top');
    const executed = phase.tasks.filter(t => t.state === 'execution_completed').length;
    const counter = el('span', 'phase-count', phase.tasks.length ? `${executed}/${phase.tasks.length}` : '—');
    counter.title = 'Executed / total tasks. Failed, stopped and unreviewed are distinct; this is not acceptance.';
    top.append(el('span', 'phase-name', phase.title), counter, el('span', 'chevron', open ? '⌄' : '›'));
    button.append(top, progress(phase.tasks));
    button.onclick = () => {
      touched.add(phase.id); if (open) expanded.delete(phase.id); else expanded.add(phase.id);
      render();
    };
    section.append(button);
    if (open && phase.tasks.length) section.append(taskTable(phase.tasks));
    phases.append(section);
  }
  card.append(phases);
  const telemetry = el('div', 'workflow-telemetry');
  telemetry.append(el('span', '', `avg ${p.stats.avgTps?.toFixed(1) ?? '—'} tok/s`), el('span', '', `${p.stats.measured}/${p.stats.samples} measured samples`));
  if (p.stats.estimatedTps !== undefined) telemetry.append(el('span', '', `response est. ${p.stats.estimatedTps.toFixed(1)} tok/s`));
  card.append(telemetry, el('div', 'identity-note', '† Configured model identity. Execution marks do not imply independent acceptance.'));
  return card;
}
function render() {
  if (!state) return;
  const focusKey = document.activeElement?.dataset?.focusKey;
  const p = state, s = p.stats, finished = workflowFinished(p);
  $('run-name').textContent = p.name; $('title').textContent = p.name;
  const compact = $('workflow-card'); compact.replaceChildren();
  compact.append(el('span', 'compact-title', p.name), el('span', 'compact-chevron', '›'));
  const meta = el('span', 'compact-meta', `Workflow  ·  ${p.agentCount === undefined ? '—' : p.agentCount} agents  ·  `);
  meta.append(elapsedNode(p.startedAt, p.endedAt, !finished && p.status !== 'incomplete')); compact.append(meta, progress(p.tasks, true));
  $('running-workflows').replaceChildren(); $('finished-workflows').replaceChildren();
  (finished ? $('finished-workflows') : $('running-workflows')).append(workflowCard(p));
  if (finished) $('running-workflows').append(el('p', 'empty', 'No running workflow.'));
  $('finished-count').textContent = finished ? '1' : '0';
  $('finished-workflows').hidden = !finishedExpanded;
  $('finished-toggle').setAttribute('aria-expanded', String(finishedExpanded));
  $('finished-chevron').textContent = finishedExpanded ? '⌄' : '›';
  const stats = $('stats'); stats.replaceChildren();
  for (const [name, value] of [['Avg generation tok/s', s.avgTps?.toFixed(1) ?? '—'], ['Estimated response tok/s', s.estimatedTps?.toFixed(1) ?? '—'], ['Measured samples', `${s.measured}/${s.samples}`], ['Exactly one review', '—'], ['Unreviewed tasks', s.unreviewed], ['Failed / stopped', `${s.failed} / ${s.cancelled}`]]) {
    const row = el('div', 'metric'); row.append(el('span', '', name), el('strong', '', value)); stats.append(row);
  }
  const evidence = $('evidence'); evidence.replaceChildren();
  for (const warning of p.warnings) evidence.append(el('p', '', warning));
  evidence.append(el('p', '', 'Response estimates include network and reasoning time. Generation timing is not inferred.'), el('p', 'digest', 'Snapshot ' + p.sourceDigest.slice(0, 16)));
  const models = [...new Set(p.tasks.filter(t => t.state === 'running' && t.model).map(t => t.model))];
  const modelsLabel = models.length ? models[0] + (models.length > 1 ? ` +${models.length - 1}` : '') + ' (configured)' : '—';
  $('footer').textContent = `Workspace | avg ${s.avgTps?.toFixed(1) ?? '—'} tok/s | ${modelsLabel} | ${s.running} running`;
  const messages = $('messages'); messages.replaceChildren();
  for (const task of p.tasks.filter(t => t.outputAvailable)) {
    const message = el('article', 'message');
    message.append(el('span', 'message-author', task.role), el('h3', '', task.title), el('p', 'muted', stateLabel(task.state)));
    const button = el('button', 'outline-button', 'Read recorded output');
    button.dataset.focusKey = 'message:' + task.id; button.onclick = () => openOutput(task); message.append(button); messages.append(message);
  }
  if (focusKey && !$('output-dialog').open) {
    const target = [...document.querySelectorAll('[data-focus-key]')].find(n => n.dataset.focusKey === focusKey);
    (target ?? $('workflow-card')).focus({ preventScroll: true });
  }
}
function showPanel() {
  document.body.classList.remove('panel-hidden'); $('workflow-card').setAttribute('aria-expanded', 'true');
  $('popout').focus();
}
$('workflow-card').onclick = showPanel;
$('finished-toggle').onclick = () => { finishedExpanded = !finishedExpanded; render(); };
$('close-output').onclick = () => $('output-dialog').close();
$('output-dialog').addEventListener('close', () => {
  selectedOutput = '';
  const target = [...document.querySelectorAll('[data-focus-key]')].find(node => node.dataset.focusKey === outputFocusKey);
  (target ?? document.querySelector('[data-focus-key="workflow"]') ?? $('expand-panel')).focus({ preventScroll: true });
  outputFocusKey = '';
});
$('popout').onclick = () => {
  const win = window.open('/?popout=1#' + token, 'titan-workflow-' + (state?.runId ?? ''), 'popup,width=740,height=900');
  if (!win) $('connection').textContent = 'Popout blocked — allow popups for this page';
};
$('expand-panel').onclick = () => {
  const wide = document.body.classList.toggle('panel-expanded');
  $('expand-panel').setAttribute('aria-pressed', String(wide));
  $('expand-panel').setAttribute('aria-label', wide ? 'Restore background tasks size' : 'Expand background tasks');
};
$('close-panel').onclick = () => {
  if (detached) { window.close(); return; }
  document.body.classList.remove('panel-expanded'); document.body.classList.add('panel-hidden');
  $('expand-panel').setAttribute('aria-pressed', 'false'); $('expand-panel').setAttribute('aria-label', 'Expand background tasks');
  $('workflow-card').setAttribute('aria-expanded', 'false'); $('workflow-card').focus();
};
if (detached) { document.body.classList.add('popout'); $('popout').hidden = true; }
async function poll() {
  if (stopped) return;
  try {
    const response = await api('/api/snapshot?after=' + encodeURIComponent(cursor));
    const frame = await response.json();
    if (frame.kind === 'snapshot' && frame.cursor !== cursor) { state = frame.projection; cursor = frame.cursor; render(); }
    for (const node of document.querySelectorAll('[data-started]')) node.textContent = duration(elapsed(node.dataset.started, undefined, true));
    $('connection').textContent = '● Connected'; $('connection').className = 'connected';
  } catch { $('connection').textContent = 'Disconnected · retrying'; $('connection').className = 'disconnected'; }
  finally { if (!stopped) setTimeout(poll, 1000); }
}
window.addEventListener('pagehide', () => { stopped = true; });
poll();
