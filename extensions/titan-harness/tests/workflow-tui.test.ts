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
  expect(workflowFooter(p)).toContain('avg -- tok/s');expect(workflowFooter(p)).toContain('0/1 measured');
  expect(renderWorkflowTui(p,local,100,30).lines.join('\n')).toContain('(configured)');
 });
 test('terminal parent with running child stays incomplete and glyph does not animate',()=>{
  const p=fixture(),local=applyWorkflowTuiInput(p,createWorkflowTuiState(),' ');
  const a=renderWorkflowTui(p,local,80,30).lines.join('\n');
  expect(a).toContain('incomplete');expect(a).toContain('[>] Builder');
  expect(renderWorkflowTui(p,local,80,30).lines.join('\n')).toBe(a);
 });
 test('long phase lists preserve selected row with an overflow indicator',()=>{
  const p=fixture();p.phases=Array.from({length:30},(_,i)=>({id:String(i),title:`Phase ${i}`,tasks:[]}));
  const local=createWorkflowTuiState();local.selected=15;const frame=renderWorkflowTui(p,local,44,12);
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
