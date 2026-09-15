import { createHash, randomUUID } from 'node:crypto';
import { sourceFingerprint } from './lms-assessment-quality.js';

export const EASTERN = 'America/New_York';
export const AUTOMATION_DEFAULTS = Object.freeze({ weekly_enabled: false, grand_enabled: false, weekly_day: 6, weekly_time: '17:00', timezone: EASTERN, weekly_question_count: 40, grand_question_count: 80, revision: 0 });
const dayMs = 86400000;
const iso = (ms) => new Date(ms).toISOString();
const hash = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0,24);
export function easternParts(value) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA',{ timeZone:EASTERN,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23' }).formatToParts(new Date(value)).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
}
export function easternInstant(date, time) {
  const target = Date.parse(`${date}T${time}:00Z`);
  let value = target;
  for (let i=0;i<4;i++) {
    const p=easternParts(value);
    const local=Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
    value += target-local;
  }
  const p=easternParts(value);
  // Nonexistent DST wall times are never silently shifted.
  if (`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`!==`${date}T${time}`) return null;
  return value;
}
const addDate = (date, amount) => new Date(Date.parse(`${date}T12:00:00Z`)+amount*dayMs).toISOString().slice(0,10);
export function weeklyWindow(settings, now=Date.now(), next=false) {
  const p=easternParts(now);
  const today=`${p.year}-${p.month}-${p.day}`;
  const weekday=new Date(`${today}T12:00:00Z`).getUTCDay();
  let date=addDate(today,-((weekday-settings.weekly_day+7)%7));
  let due=easternInstant(date,settings.weekly_time);
  if (!due || due>now) { date=addDate(date,-7); due=easternInstant(date,settings.weekly_time); }
  if (next) { date=addDate(date,7); due=easternInstant(date,settings.weekly_time); if (!due) {date=addDate(date,7); due=easternInstant(date,settings.weekly_time);} }
  return { date, due_at:iso(due), from_at:iso(easternInstant(addDate(date,-7),settings.weekly_time) ?? due-7*dayMs), to_at:iso(due) };
}

export function updateAutomationSettings(previous={}, patch={}, actor='admin', now=Date.now()) {
  const allowed=['weekly_enabled','grand_enabled','weekly_day','weekly_time','weekly_question_count','grand_question_count'];
  if (Object.keys(patch).some(k=>!allowed.includes(k))) throw new Error('Unsupported automation setting');
  const next={...AUTOMATION_DEFAULTS,...previous,...patch,timezone:EASTERN};
  if (typeof next.weekly_enabled!=='boolean' || typeof next.grand_enabled!=='boolean') throw new Error('On/off controls must be boolean');
  if (!Number.isInteger(next.weekly_day) || next.weekly_day<0 || next.weekly_day>6 || !/^([01]\d|2[0-3]):[0-5]\d$/.test(next.weekly_time)) throw new Error('Choose a valid day and time');
  // Avoid ambiguous/nonexistent DST hours when Sunday scheduling is selected.
  if (next.weekly_day===0 && /^(01|02):/.test(next.weekly_time)) throw new Error('On Sunday, choose a time outside 1–3 a.m. to avoid daylight-saving ambiguity');
  for (const key of ['weekly_question_count','grand_question_count']) if (![20,40,60,80,100,120].includes(next[key])) throw new Error('Question count must be 20–120 in blocks of 20');
  if (next.weekly_enabled && (!previous.weekly_enabled || next.weekly_day!==previous.weekly_day || next.weekly_time!==previous.weekly_time)) next.weekly_enabled_at=iso(now);
  if (next.grand_enabled && !previous.grand_enabled) next.grand_enabled_at=iso(now);
  return {...next,revision:Number(previous.revision||0)+1,updated_at:iso(now),updated_by:actor};
}

export function automationPlans({courseId,settings,lectures,now=Date.now()}) {
  const plans=[];
  if (settings.weekly_enabled) {
    const window=weeklyWindow(settings,now);
    if (window.due_at >= (settings.weekly_enabled_at || iso(now))) {
      plans.push({key:`weekly:${courseId}:${window.date}`,kind:'weekly',course_id:courseId,title:`Weekly Assessment — ${window.date}`,window,question_count:settings.weekly_question_count,lectures:lectures.filter(s=>s.start_at ? s.start_at>=window.from_at && s.start_at<window.to_at : s.date>=window.from_at.slice(0,10) && s.date<=window.to_at.slice(0,10))});
    }
  }
  if (settings.grand_enabled) {
    const systems=[...new Set(lectures.map(s=>s.system).filter(Boolean))];
    for (const system of systems) {
      const rows=lectures.filter(s=>s.system===system);
      if (rows.some(s=>!s.end_at)) continue;
      const due=rows.map(s=>s.end_at).sort().at(-1);
      if (due>iso(now) || due<(settings.grand_enabled_at || iso(now))) continue;
      plans.push({key:`grand:${courseId}:${hash(system.toLowerCase())}`,kind:'grand',course_id:courseId,system,title:`${system} — Grand Assessment`,question_count:settings.grand_question_count,window:{from_at:rows.map(s=>s.start_at).sort()[0],to_at:due,due_at:due},lectures:rows});
    }
  }
  return plans;
}

export function planReadiness(plan) {
  const problems=[];
  if (!plan.lectures.length) problems.push('No eligible lectures in this period.');
  for (const s of plan.lectures) {
    if (!s.completed || !s.start_at || !s.end_at || s.start_at<plan.window.from_at || s.end_at>plan.window.to_at) problems.push(`${s.title}: lecture not completed within the assessment period`);
    if (!s.ready || String(s.text||'').trim().length<300) problems.push(`${s.title}: published notes not ready`);
  }
  return {ready:!problems.length,problems};
}

export function publicAutomationState(db,courseId,lectures,now=Date.now()) {
  const settings={...AUTOMATION_DEFAULTS,...db.assessmentAutomation?.settings?.[courseId]};
  const runs=Object.values(db.assessmentAutomation?.runs||{}).filter(r=>r.course_id===courseId).sort((a,b)=>String(b.updated_at).localeCompare(String(a.updated_at))).slice(0,20);
  const next=weeklyWindow(settings,now,true);
  const upcoming=lectures.filter(s=>s.start_at && s.start_at>=next.from_at && s.start_at<next.to_at);
  return {settings,next_weekly_at:settings.weekly_enabled?next.due_at:null,weekly_window:next,weekly_lectures:upcoming.map(({text,...s})=>s),runs};
}

// One persisted reservation per course/period. AI work never runs under the DB
// write lock. Restarts, double ticks, and toggles cannot produce duplicate drafts.
export async function runAssessmentAutomation({read,mutate,catalog,generate,now=Date.now}) {
  const db=await read();
  const results=[];
  for (const [courseId,stored] of Object.entries(db.assessmentAutomation?.settings||{})) {
    const settings={...AUTOMATION_DEFAULTS,...stored};
    const courseLectures=catalog(db,courseId,now());
    const plans=automationPlans({courseId,settings,lectures:courseLectures,now:now()});
    // Explicit retries retain the original period, even after the next week starts.
    for (const row of Object.values(db.assessmentAutomation?.runs||{})) {
      if (row.course_id!==courseId || row.status!=='queued' || plans.some(p=>p.key===row.key) || !settings[row.kind==='weekly'?'weekly_enabled':'grand_enabled']) continue;
      const retryLectures=row.kind==='grand' ? courseLectures.filter(s=>s.system===row.system) : row.source_ids.map(id=>courseLectures.find(s=>s.id===id)||{id,title:id,ready:false,completed:false});
      plans.push({...row,lectures:retryLectures,explicit_retry:true});
    }
    for (const plan of plans) {
      const token=randomUUID();
      const reserved=await mutate(current=>{
        const live=current.assessmentAutomation?.settings?.[courseId];
        if (!live || live.revision!==settings.revision || !live[plan.kind==='weekly'?'weekly_enabled':'grand_enabled']) return false;
        current.assessmentAutomation.runs ||= {};
        const prior=current.assessmentAutomation.runs[plan.key];
        if (prior && ['completed','failed','cancelled','generating'].includes(prior.status)) {
          if (prior.status==='generating' && now()-Date.parse(prior.heartbeat_at||prior.updated_at)>2*60*60*1000) Object.assign(prior,{status:'failed',error:'Generation was interrupted. Review and retry this run.',updated_at:iso(now())});
          return false;
        }
        if (prior?.retry_after && Date.parse(prior.retry_after)>now()) return false;
        const readiness=planReadiness(plan);
        const row={key:plan.key,course_id:courseId,kind:plan.kind,title:plan.title,system:plan.system||null,window:plan.window,question_count:plan.question_count,source_ids:plan.lectures.map(s=>s.id),updated_at:iso(now()),created_at:prior?.created_at||iso(now()),attempt_count:Number(prior?.attempt_count||0),revision:settings.revision};
        if (!readiness.ready) {
          current.assessmentAutomation.runs[plan.key]={...row,status:plan.lectures.length?'waiting_for_notes':'skipped',error:readiness.problems.join('; '),retry_after:iso(now()+30*60*1000)};
          return false;
        }
        current.assessmentAutomation.runs[plan.key]={...row,status:'generating',token,heartbeat_at:iso(now()),source_fingerprint:sourceFingerprint(plan.lectures),attempt_count:row.attempt_count+1};
        return true;
      });
      if (!reserved) continue;
      const verify=async(current)=>{
        const live=current.assessmentAutomation?.settings?.[courseId];
        const row=current.assessmentAutomation?.runs?.[plan.key];
        if (!live || live.revision!==settings.revision || !live[plan.kind==='weekly'?'weekly_enabled':'grand_enabled'] || row?.token!==token || row.status!=='generating') throw new Error('Automation was stopped or its settings changed.');
        const freshLectures=catalog(current,courseId,now());
        const refreshed=plan.explicit_retry ? {...plan,lectures:plan.kind==='grand'?freshLectures.filter(s=>s.system===plan.system):plan.source_ids.map(id=>freshLectures.find(s=>s.id===id)||{id,title:id,ready:false,completed:false})} : automationPlans({courseId,settings:live,lectures:freshLectures,now:now()}).find(p=>p.key===plan.key);
        if (!refreshed || !planReadiness(refreshed).ready || sourceFingerprint(refreshed.lectures)!==row.source_fingerprint) throw new Error('Lecture sources or schedule changed during generation. Review and retry.');
      };
      try {
        const checkpoint=async()=>mutate(async current=>{await verify(current); current.assessmentAutomation.runs[plan.key].heartbeat_at=iso(now());});
        const result=await generate({sources:plan.lectures,questionCount:plan.question_count,checkpoint,previousStems:Object.values(db.assessments||{}).filter(a=>a.course_id===courseId).flatMap(a=>(a.questions||[]).map(q=>q.stem)).slice(-160)});
        await mutate(async current=>{
          await verify(current);
          const id=`auto-assessment-${hash(plan.key)}`;
          current.assessments ||= {};
          if (current.assessments[id]) throw new Error('An assessment already exists for this run.');
          current.assessments[id]={id,course_id:courseId,title:plan.title,description:`${plan.kind==='weekly'?'Weekly lecture-only':'Whole-system'} assessment. AI checks passed; tutor review is required before publishing.`,source_type:'session_notes',source_scope:plan.kind==='weekly'?'week':'system',source_system:plan.system||'',source_session_ids:plan.lectures.map(s=>s.id),source_note_ids:plan.lectures.map(s=>s.note_id).filter(Boolean),source_window:plan.window,source_truncated:false,automation_run_key:plan.key,generator_version:result.quality_report.version,quality_report:result.quality_report,questions:result.questions.map((q,i)=>({...q,block_number:Math.floor(i/20)+1})),question_count:result.questions.length,block_mode:true,block_count:result.questions.length/20,questions_per_block:20,duration_per_block_minutes:30,duration_minutes:result.questions.length*1.5,total_duration_minutes:result.questions.length*1.5,secure_mode:true,shuffle_questions:true,show_result_after_submit:true,is_published:false,status:'draft',created_at:iso(now()),updated_at:iso(now()),created_by:'weekly_assessment_automation',created_by_name:'Assessment automation'};
          Object.assign(current.assessmentAutomation.runs[plan.key],{status:'completed',assessment_id:id,completed_at:iso(now()),updated_at:iso(now()),error:null});
          current.assessments[id].assessment_type = plan.kind === 'grand' ? 'system_end' : 'weekly';
          current.assessments[id].system = plan.system || '';
        });
        results.push({key:plan.key,status:'completed'});
      } catch(error) {
        await mutate(current=>{
          const row=current.assessmentAutomation?.runs?.[plan.key];
          if (row?.token===token) Object.assign(row,{status:'failed',error:String(error.message||error).slice(0,1600),updated_at:iso(now())});
        });
        results.push({key:plan.key,status:'failed'});
      }
    }
  }
  return results;
}
