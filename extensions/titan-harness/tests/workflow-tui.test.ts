import {describe,test,expect} from 'bun:test';
import {applyWorkflowTuiInput,createWorkflowTuiState,renderWorkflowTui,workflowFooter} from '../modules/monitor/workflow-tui.ts';
import type {WorkflowProjection} from '../modules/monitor/workflow-projection.ts';
const fixture = (): WorkflowProjection => ({schemaVersion:1,cursor:'run:hash',sourceDigest:'hash',runId:'run',name:'Example',status:'incomplete',startedAt:'2026-09-19T00:00:00Z',phases:[{id:'first',title:'Build',tasks:[{id:'a',title:'Builder\x1b[2J',role:'builder',state:'running',phase:'Build',model:'example',modelSource:'configured',outputAvailable:false}]},{id:'second',title:'Build',tasks:[]}],tasks:[],stats:{running:1,finished:0,failed:0,cancelled:0,unreviewed:1,observedTokens:0,measured:0,samples:1,exactOneReview:null},warnings:[]});
describe('shared workflow terminal observer',()=>{
 test('expansion is independent for duplicate phase titles, keyboard and mouse agree',()=>{
  const p=fixture(),start=createWorkflowTuiState();
  const first=applyWorkflowTuiInput(p,start,'\r');
  expect(first.expanded.has('first')).toBe(true);expect(first.expanded.has('second')).toBe(false);expect(start.expanded.size).toBe(0);
  const frame=renderWorkflowTui(p,first,80,30);const hit=[...frame.hitRows].find(([,index])=>index===1)!;
  const mouse=applyWorkflowTuiInput(p,first,`\x1b[<0;8;${hit[0]}M`,frame.hitRows);
  const keys=applyWorkflowTuiInput(p,applyWorkflowTuiInput(p,first,'j'),' ');
  expect([...mouse.expanded]).toEqual([...keys.expanded]);expect(mouse.selected).toBe(1);
 });
 test('bounded ASCII lines resist terminal controls and disclose unknown measurements',()=>{
  const p=fixture(),local=applyWorkflowTuiInput(p,createWorkflowTuiState(),' ');
  for(const width of [1,4,22,44,80]){const frame=renderWorkflowTui(p,local,width,16);expect(frame.lines.length).toBeLessThanOrEqual(16);for(const line of frame.lines){expect(line.length).toBeLessThanOrEqual(width);expect(line).toMatch(/^[\x20-\x7e]*$/);}}
  expect(workflowFooter(p)).toContain('avg -- tok/s');expect(workflowFooter(p)).toContain('Workspace');
  expect(renderWorkflowTui(p,local,100,30).lines.join('\n')).toContain('cfg:example');
 });
 test('terminal parent with running child stays incomplete and glyph does not animate',()=>{
  const p=fixture(),local=applyWorkflowTuiInput(p,createWorkflowTuiState(),' ');
  const a=renderWorkflowTui(p,local,80,30).lines.join('\n');
  expect(a).toContain('incomplete');expect(a).toContain('[>] Builder');
  expect(renderWorkflowTui(p,local,80,30).lines.join('\n')).toBe(a);
 });
 test('long phase lists preserve selected row with an overflow indicator',()=>{
  const p=fixture();p.phases=Array.from({length:30},(_,i)=>({id:String(i),title:`Phase ${i}`,tasks:[]}));
  const local=createWorkflowTuiState();local.selected=15;local.followSelection=true;const frame=renderWorkflowTui(p,local,44,12);
  expect(frame.lines.join('\n')).toContain('Phase 15');expect(frame.lines.join('\n')).toContain('more rows');expect(frame.offset).toBeGreaterThan(0);
 });
});

describe('native sidebar projection integration',()=>{
 test('native focus uses the shared frame and phase interaction without mutating projection', async()=>{
  const {createSidebarController}=await import('../modules/cmd-sidebar.ts');
  const p=fixture();let render:any,interaction:any;let refreshes=0;
  const controller=createSidebarController({store:()=>({readRun:()=>({runId:'run'})} as any),cwd:()=>'/project',currentRunDir:()=>'/run',loadedFor:()=>undefined,projection:()=>p,notify:()=>{},panel:()=>{},openOverlay:(_ctx,r,_close,i)=>{render=r;interaction=i;return {close(){},refresh(){refreshes++}};}});
  try {
   controller.setExpanded(true);controller.open({},undefined,true);
   expect(interaction.focus).toBe(true);
   expect(render(0,{width:80,height:25}).join('\n')).toContain('[>] Builder');
   interaction.input(' ');
   expect(render(0,{width:80,height:25}).join('\n')).not.toContain('[>] Builder');
   expect(refreshes).toBeGreaterThan(0);expect(p.phases[0].tasks).toHaveLength(1);
  } finally {controller.close();}
 });
 test('projection failures render explicitly unavailable instead of fake success',async()=>{
  const {createSidebarController}=await import('../modules/cmd-sidebar.ts');let render:any;
  const controller=createSidebarController({store:()=>({readRun:()=>({runId:'run'})} as any),cwd:()=>'/project',currentRunDir:()=>'/run',loadedFor:()=>undefined,projection:()=>{throw new Error('torn evidence')},notify:()=>{},panel:()=>{},openOverlay:(_ctx,r)=>{render=r;return {close(){},refresh(){}};}});
  try {controller.open({});expect(render(0,{width:80,height:25}).join('\n')).toContain('unavailable');}finally{controller.close();}
 });
});


describe('terminal groups and metric details',()=>{
 test('groups classify the workflow and never filter completed or failed phase children',()=>{
  const p=fixture();p.phases[1].tasks=[{id:'b',title:'Failed verifier',role:'reviewer',state:'failed',phase:'Build',modelSource:'unknown',outputAvailable:false}];
  const local=createWorkflowTuiState(p);local.expanded.add('second');expect(local.expanded.has('first')).toBe(true);
  const running=applyWorkflowTuiInput(p,local,'r');
  const runningText=renderWorkflowTui(p,running,100,45).lines.join('\n');
  expect(runningText).toContain('[R Running]');expect(runningText).toContain('Failed verifier');expect(runningText).toContain('incomplete');
  const empty=applyWorkflowTuiInput(p,local,'f');expect(renderWorkflowTui(p,empty,100,30).lines.join('\n')).toContain('No finished workflow');
  expect(applyWorkflowTuiInput(p,empty,' ').expanded).toEqual(empty.expanded);
  p.status='failed';p.endedAt='2026-09-19T00:03:00Z';
  const finished=applyWorkflowTuiInput(p,local,'f');
  const text=renderWorkflowTui(p,finished,100,45).lines.join('\n');
  expect(text).toContain('Finished 1');expect(text).toContain('Failed verifier');expect(text).toContain('Builder');expect(text).toContain('3m 0s');expect(text).toContain('1 failed');
 });
 test('execution grids count successful execution without implying acceptance',()=>{
  const p=fixture();p.phases[0].tasks.push(...['execution_completed','failed','cancelled','queued'].map((state,i)=>({...p.phases[0].tasks[0],id:String(i),title:state,state})));
  const local=createWorkflowTuiState(p),text=renderWorkflowTui(p,local,100,50).lines.join('\n');
  expect(text).toContain('1/5');expect(text).toContain('[>][#][!][-][.]');expect(text).toContain('Agent');expect(text).toContain('Model');expect(text).toContain('Tokens');expect(text).toContain('Time');
  expect(text).not.toContain('accepted');
  const detail=renderWorkflowTui(p,applyWorkflowTuiInput(p,local,'h'),100,50).lines.join('\n');expect(detail).toContain('not acceptance');
 });
 test('mouse wheel scrolls independently of phase selection',()=>{
  const p=fixture(),local=createWorkflowTuiState(p);
  const down=applyWorkflowTuiInput(p,local,'\x1b[<65;12;8M');expect(down.offset).toBe(5);expect(down.followSelection).toBe(false);
  expect(applyWorkflowTuiInput(p,down,'\x1b[<64;12;8M').offset).toBe(0);
 });
 test('warnings are compact by default and metrics distinguish estimates',()=>{
  const p=fixture();p.warnings=Array(30).fill('Detailed evidence warning');p.stats.estimatedTps=42;p.stats.cancelled=2;p.stats.failed=1;
  const local=createWorkflowTuiState(p);const initial=renderWorkflowTui(p,local,100,25).lines.join('\n');
  expect(initial).toContain('30 evidence notes');expect(initial).toContain('Builder');expect(initial).not.toContain('Detailed evidence warning');
  const detail=renderWorkflowTui(p,applyWorkflowTuiInput(p,local,'h'),100,25).lines.join('\n');
  expect(detail).toContain('Estimated rate 42.0 tok/s (not measured)');expect(detail).toContain('Measured 0/1 samples');expect(detail).toContain('Exact-one-review: unknown');expect(detail).toContain('cancelled 2');
 });
 test('footer preserves configured provenance and overflow counts within width',()=>{
  const p=fixture();p.tasks=Array.from({length:5},(_,i)=>({...p.phases[0].tasks[0],id:String(i),model:'provider/model-'+i}));
  const full=workflowFooter(p,120);expect(full).toContain('configured:');expect(full).toMatch(/\+[1-5]/);
  const narrow=workflowFooter(p,44);expect(narrow.length).toBeLessThanOrEqual(44);expect(narrow).toContain('Workspace');expect(narrow).toContain('avg -- tok/s');expect(narrow).toContain('cfg+5');expect(narrow).toContain('1 run');
 });
});

test('headless shared telemetry never becomes a model-facing panel', async()=>{
 const {createSidebarController}=await import('../modules/cmd-sidebar.ts');const p=fixture();let panels=0;const notices:string[]=[];
 const controller=createSidebarController({store:()=>({readRun:()=>({runId:'run'})} as any),cwd:()=>'/project',currentRunDir:()=>'/run',loadedFor:()=>undefined,projection:()=>p,notify:(_ctx,message)=>notices.push(message),panel:()=>{panels++},openOverlay:()=>undefined});
 controller.open({});expect(panels).toBe(0);expect(notices.join(' ')).not.toContain('example');expect(notices.join(' ')).toContain('human UI');
});

 test('workflow card keeps captured metadata and does not invent terminal elapsed time',()=>{
  const p=Object.assign(fixture(),{description:'Research, draft and review the workflow.',agentCount:8,status:'failed'});
  const text=renderWorkflowTui(p,createWorkflowTuiState(p),100,40).lines.join('\n');
  expect(text).toContain('Background tasks');expect(text).toContain('8 agents');expect(text).toContain(p.description);expect(text).toContain('Workflow | failed | --');
  expect(text).not.toContain('Stop workflow');
 });

test('reported terminal run with incomplete projection groups as Finished without accepting children',()=>{
 const p=fixture();p.reportedStatus='completed';p.status='incomplete';
 const local=createWorkflowTuiState(p);local.group='finished';
 const text=renderWorkflowTui(p,local,100,40).lines.join('\n');
 expect(text).toContain('Finished 1');expect(text).toContain('incomplete');expect(text).toContain('[>]');expect(text).not.toContain('Running 1');
});

test('unrecognized states never increment phase executed counts',()=>{
 const p=fixture();p.phases[0].tasks[0].state='not-completed';const local=createWorkflowTuiState(p);local.expanded.add('first');
 const text=renderWorkflowTui(p,local,100,40).lines.join('\n');expect(text).toContain('0/1');expect(text).toContain('[?]');expect(text).not.toContain('[#]');
});
