import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTOMATION_DEFAULTS, easternInstant, weeklyWindow, updateAutomationSettings, automationPlans, planReadiness, runAssessmentAutomation } from '../lib/lms-assessment-automation.js';

const now=Date.parse('2026-09-19T21:01:00Z');
const enabled=Date.parse('2026-09-15T21:00:00Z');
const settings=()=>updateAutomationSettings({}, {weekly_enabled:true},'admin',enabled);
const lecture=(id,date='2026-09-17',system='Cardiology')=>({id,title:id,date,system,start_at:`${date}T16:00:00.000Z`,end_at:`${date}T17:00:00.000Z`,completed:true,ready:true,text:'Evidence from this lecture. '.repeat(30)});

test('Saturday 5 p.m. uses Eastern daylight saving, not a fixed UTC offset',()=>{
  assert.equal(new Date(easternInstant('2026-09-19','17:00')).toISOString(),'2026-09-19T21:00:00.000Z');
  assert.equal(new Date(easternInstant('2026-12-19','17:00')).toISOString(),'2026-12-19T22:00:00.000Z');
  assert.equal(weeklyWindow(settings(),now).from_at,'2026-09-12T21:00:00.000Z');
  assert.equal(weeklyWindow(settings(),Date.parse('2026-09-19T20:59:59Z'),true).due_at,'2026-09-19T21:00:00.000Z');
  const winter=weeklyWindow(settings(),Date.parse('2026-11-07T22:01:00Z'));
  assert.equal((Date.parse(winter.to_at)-Date.parse(winter.from_at))/3600000,169);
});

test('time is editable, invalid settings rejected, and activation never backfills',()=>{
  const changed=updateAutomationSettings(settings(),{weekly_time:'16:00',weekly_day:0},'admin',now);
  assert.equal(weeklyWindow(changed,now,true).due_at,'2026-09-20T20:00:00.000Z');
  assert.equal(automationPlans({courseId:'c',settings:changed,lectures:[lecture('s')],now}).length,0);
  assert.throws(()=>updateAutomationSettings({}, {weekly_time:'25:00'}));
  assert.throws(()=>updateAutomationSettings({}, {weekly_day:0,weekly_time:'02:30'}));
  assert.throws(()=>updateAutomationSettings({}, {weekly_enabled:'true'}));
  assert.throws(()=>updateAutomationSettings({}, {publish_now:true}));
  assert.equal(AUTOMATION_DEFAULTS.weekly_enabled,false);
});

test('weekly scope cannot include older/future lectures and missing notes hold the run',()=>{
  const lectures=[lecture('old','2026-09-10'),lecture('current'),lecture('future','2026-09-21')];
  const [plan]=automationPlans({courseId:'c',settings:settings(),lectures,now});
  assert.deepEqual(plan.lectures.map(s=>s.id),['current']);
  assert.equal(planReadiness(plan).ready,true);
  plan.lectures[0].ready=false;
  assert.equal(planReadiness(plan).ready,false);
  const broken=lecture('broken'); broken.start_at=null;
  assert.equal(planReadiness(automationPlans({courseId:'c',settings:settings(),lectures:[broken],now})[0]).ready,false);
});

test('grand assessment waits for the final system lecture and never mixes systems',()=>{
  const config=updateAutomationSettings({}, {grand_enabled:true},'admin',enabled);
  const lectures=[lecture('cardio1'),lecture('cardio2','2026-09-21'),lecture('renal','2026-09-22','Renal')];
  assert.equal(automationPlans({courseId:'c',settings:config,lectures,now}).length,0);
  const plans=automationPlans({courseId:'c',settings:config,lectures,now:Date.parse('2026-09-21T18:00:00Z')});
  assert.equal(plans.length,1);
  assert.deepEqual(plans[0].lectures.map(s=>s.id),['cardio1','cardio2']);
  assert.equal(plans[0].question_count,80);
  assert.equal(automationPlans({courseId:'c',settings:config,lectures:[lecture('past','2026-09-10')],now}).length,0);
});

function harness() {
  const db={assessmentAutomation:{settings:{c:settings()},runs:{}},assessments:{},unrelated:{keep:true}};
  let queue=Promise.resolve(); let calls=0;
  const options={read:async()=>structuredClone(db),mutate:fn=>{const p=queue.then(()=>fn(db));queue=p.catch(()=>{});return p;},catalog:()=>[lecture('one')],now:()=>now,generate:async ({checkpoint})=>{calls++; await checkpoint();return {questions:Array.from({length:40},(_,i)=>({id:`q${i}`,stem:'test fixture'})),quality_report:{version:'test',source_count:1,human_review_required:true}};}};
  return {db,options,calls:()=>calls};
}
test('concurrent ticks and restart produce one unpublished draft only',async()=>{
  const h=harness();
  await Promise.all([runAssessmentAutomation(h.options),runAssessmentAutomation(h.options)]);
  await runAssessmentAutomation(h.options);
  assert.equal(h.calls(),1);
  const drafts=Object.values(h.db.assessments);
  assert.equal(drafts.length,1); assert.equal(drafts[0].is_published,false);
  assert.equal(drafts[0].block_count,2); assert.equal(drafts[0].duration_minutes,60);
  assert.equal(h.db.unrelated.keep,true);
});
test('switching off during AI work cancels persistence',async()=>{
  const h=harness();
  h.options.generate=async ({checkpoint})=>{h.db.assessmentAutomation.settings.c=updateAutomationSettings(settings(),{weekly_enabled:false},'admin',now);await checkpoint();throw Error('unreachable');};
  await runAssessmentAutomation(h.options);
  assert.equal(Object.keys(h.db.assessments).length,0);
  assert.match(Object.values(h.db.assessmentAutomation.runs)[0].error,/stopped|changed/);
});
test('failed quality checks are held, not retried every heartbeat',async()=>{
  const h=harness();let calls=0;
  h.options.generate=async()=>{calls++;throw Error('Ambiguous answer');};
  await runAssessmentAutomation(h.options);await runAssessmentAutomation(h.options);
  assert.equal(calls,1);assert.equal(Object.keys(h.db.assessments).length,0);
  assert.equal(Object.values(h.db.assessmentAutomation.runs)[0].status,'failed');
});
test('stale in-flight reservation is held for explicit retry after restart',async()=>{
  const h=harness();const [plan]=automationPlans({courseId:'c',settings:settings(),lectures:[lecture('one')],now});
  h.db.assessmentAutomation.runs[plan.key]={...plan,status:'generating',updated_at:'2026-09-19T18:00:00Z'};
  await runAssessmentAutomation(h.options);
  assert.equal(h.calls(),0);assert.equal(h.db.assessmentAutomation.runs[plan.key].status,'failed');
});
