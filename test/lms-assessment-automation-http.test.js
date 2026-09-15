import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import jwt from 'jsonwebtoken';

test('automation settings are authenticated, editable and durable without generating assessments', {timeout:60000}, async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'assessment-automation-'));
  const secret='isolated-assessment-test-secret';
  const course='automation-course';
  await fs.writeFile(path.join(dir,'live-session-db.json'),JSON.stringify({users:{admin:{id:'admin',role:'admin',email:'admin@example.test'},student:{id:'student',role:'student',email:'student@example.test'}},courses:{[course]:{id:course,name:'USMLE teaching',status:'active'}},roadmaps:{[course]:{days:[{id:'day1',date:'2026-12-18',class_time:'12:00',system:'Cardiology',title:'Cardiology lecture',is_published:true}]}},assessments:{}}));
  await fs.writeFile(path.join(dir,'aylamed-db.json'),'{}');
  await fs.writeFile(path.join(dir,'crm-db.json'),'{}');
  const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const p=server.address().port;server.close(()=>resolve(p));});});
  const output=[];
  const child=spawn(process.execPath,['server.js'],{cwd:fileURLToPath(new URL('..',import.meta.url)),env:{...process.env,PORT:String(port),DATA_DIR:dir,AUTH_JWT_SECRET:secret,AYLA_AUTH_JWT_SECRET:secret,OPENAI_API_KEY:'test-disabled-scheduler-no-ai-calls',AI_ENABLED:'true',DATABASE_URL:'',BOOTSTRAP_ADMIN_EMAIL:'',BOOTSTRAP_ADMIN_PASSWORD:'',NEXTGEN_ASSESSMENT_SCHEDULER_ENABLED:'false',NEXTGEN_BACKEND_HEARTBEAT_ENABLED:'false',NEXTGEN_AUTO_ZOOM_PREP_ENABLED:'false',ZOOM_RECORDING_RECOVERY_ENABLED:'false',NEXTGEN_BILLING_EXPIRY_RUNNER_ENABLED:'false',AYLA_QBANK_ADAPTATION_ENABLED:'false'},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',s=>output.push(String(s)));child.stderr.on('data',s=>output.push(String(s)));
  const base=`http://127.0.0.1:${port}`;
  const api=async(route,{role='admin',method='GET',body}={})=>{
    const response=await fetch(base+route,{method,headers:{'content-type':'application/json',...(role?{authorization:`Bearer ${jwt.sign({sub:role,role},secret)}`}:{})},body:body?JSON.stringify(body):undefined});
    return {status:response.status,data:await response.json()};
  };
  try {
    let healthy=false;
    for(let i=0;i<200;i++) {if(child.exitCode!==null)throw Error(output.join(''));try{if((await fetch(base+'/health')).ok){healthy=true;break;}}catch{}await new Promise(r=>setTimeout(r,75));}
    assert.ok(healthy,output.join(''));
    const route=`/admin/assessments/automation?course_id=${course}`;
    assert.equal((await api(route,{role:''})).status,401);
    assert.equal((await api(route,{role:'student'})).status,403);
    const initial=await api(route);assert.equal(initial.status,200);assert.equal(initial.data.settings.weekly_enabled,false);
    const save=await api('/admin/assessments/automation',{method:'PATCH',body:{course_id:course,weekly_enabled:true,grand_enabled:true,weekly_day:6,weekly_time:'17:00',weekly_question_count:40,grand_question_count:80}});
    assert.equal(save.status,200,JSON.stringify(save.data));
    assert.equal((await api('/admin/assessments/automation',{role:'student',method:'PATCH',body:{course_id:course,weekly_enabled:false}})).status,403);
    assert.equal((await api('/admin/assessments/automation',{method:'PATCH',body:{course_id:course,weekly_time:'30:00'}})).status,400);
    const changed=await api('/admin/assessments/automation',{method:'PATCH',body:{course_id:course,weekly_time:'16:15'}});
    assert.equal(changed.status,200);assert.equal((await api(route)).data.settings.weekly_time,'16:15');
    const off=await api('/admin/assessments/automation',{method:'PATCH',body:{course_id:course,weekly_enabled:false,grand_enabled:false}});
    assert.equal(off.status,200);
    const disk=JSON.parse(await fs.readFile(path.join(dir,'live-session-db.json'),'utf8'));
    assert.equal(disk.assessmentAutomation.settings[course].weekly_enabled,false);
    assert.equal(Object.keys(disk.assessments).length,0);
  } finally {
    child.kill();await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);});
    // Test-owned, uniquely created temporary directory only.
    if(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep))await fs.rm(dir,{recursive:true,force:true});
  }
});
