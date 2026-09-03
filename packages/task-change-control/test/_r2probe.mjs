import { Context } from '@deepseek-ai/cordis';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { TaskStore } from 'dsh-task-orchestrator/store';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import changeControlPlugin from 'dsh-change-control';
import plugin from '../src/index.js';
const dir = mkdtempSync(join(tmpdir(), 'r2p-'));
const ctx = new Context();
await ctx.plugin(SystemPrompt);
await ctx.plugin(ToolRuntime, {});
const ts = new TaskStore({ dbPath: join(dir, 't.db') });
ctx.provide('taskOrchestrator', Object.freeze({
  get: ts.get.bind(ts), update: ts.update.bind(ts),
  updateIf: (id,e,p)=>ts.updateIf(id,e,p), complete: ts.complete.bind(ts),
  createReviewerLauncher: () => ({ async launch(){ return { sessionId: 'sess-review-x' }; } }),
}));
await ctx.plugin(changeControlPlugin, { storePath: join(dir, 'c.json') });
await ctx.plugin(plugin);
const proof = (c)=>({beforeRevision:'b', afterRevision:'a', commit_sha:c, files_changed:['f'], tests_run:['t'], remaining_blockers:[], criteria:[{id:'ship',satisfied:true}], deviations:[], workerChecks:['ok'], controllerPreflight:['ok'], summary:'x'});
const task = await ts.create({ title:'g', description:'d', status:'ready', workspace: dir, worker_profile:'w', acceptance_criteria:['ship'] });
const { change } = await ctx.taskChangeControl.bootstrapTask(task.id);
const plan = await ctx.changeControl.submitPlan(change.id, { steps:['s'] });
await ctx.changeControl.acceptPlan(change.id, plan.id, { authorized:true, actor:'host' });
await ctx.changeControl.transition(change.id, 'IMPLEMENTING', {});
await ts.claim(task.id, 'w', { lease_seconds: 300 });
await ts.start(task.id, 'w', {});
await ctx.changeControl.bindRole(change.id, 'sess-w', 'worker', { worker:'w' });
await ctx.changeControl.submitProof(change.id, proof('c1'), { sessionId:'sess-w', expectedWorker:'w' });
await ts.complete(task.id, { commit_sha:'c1', files_changed:['f'], tests_run:['t'], remaining_blockers:[] }, { worker:'w' });
const rv1 = await ctx.taskChangeControl.runGovernedReview(task.id);
console.log('rv1', rv1.outcome, rv1.sessionId);
// fail1
const out1 = await ctx.taskChangeControl.applyReviewOutcome(task.id, { sessionId: rv1.sessionId, verdict:'fail', findings:[{severity:'critical',category:'t',location:'x',problem:'p1',fix:'f',requiredOutcome:'ok'}] });
console.log('fail1 ->', out1.outcome);
// repair round
await ctx.taskChangeControl.prepareRepairAttempt(task.id);
await ts.claim(task.id, 'w2', { lease_seconds: 300 });
await ts.start(task.id, 'w2', {});
await ctx.changeControl.bindRole(change.id, 'sess-w2', 'worker', { worker:'w2' });
const fs2 = (await ctx.changeControl.status(change.id)).openFindings;
await ctx.changeControl.submitRepair(change.id, { findings: fs2.map((f)=>({findingId: f.id, status:'fixed', claim:'ok'})), proof: {...proof('c2'), beforeRevision: 'a', afterRevision: 'a2'} }, { workerId: 'w2' });
console.log('after repair state:', (await ctx.changeControl.get(change.id)).state);
await ts.updateIf(task.id, { status: 'running', claimed_by: 'w2' }, { status: 'in_review', commit_sha: 'c2' });
const rv2 = await ctx.taskChangeControl.runGovernedReview(task.id);
console.log('rv2', rv2);
const out2 = await ctx.taskChangeControl.applyReviewOutcome(task.id, { sessionId: rv2.sessionId, verdict:'fail', findings:[{severity:'critical',category:'t',location:'x',problem:'p2',fix:'f',requiredOutcome:'ok'}] });
console.log('fail2 ->', out2);
