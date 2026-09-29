import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('past holiday ignores media-less meeting placeholders, blocks teaching evidence, and preserves attachments and student work', {timeout: 70000}, async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'past-holiday-test-'));
  const dbPath = path.join(dataDir, 'live-session-db.json');
  const password = 'LocalHolidayTest9!';
  const salt = 'past-holiday-test-salt';
  const db = { users: {admin: {id:'admin', email:'holiday@example.com', role:'admin', status:'active', salt,
    password_hash:crypto.pbkdf2Sync(password,salt,120000,64,'sha512').toString('hex')}}, courses:{}, roadmaps:{}, liveSessions:{}, recordings:{}, notes:{}, attendance:{},
    assessmentAttempts:{keep:{id:'keep',score:87}}, roadmapProgress:{keep:{id:'keep',completed:true}}, pointEvents:{keep:{points:10}} };
  for (const cid of ['safe','notes','attendance','unpublished','placeholder','orphaned','transcript']) {
    db.courses[cid] = {id:cid,name:cid,status:'active'};
    const days = [10,11].map((n,i)=>({id:`${cid}-d${i}`,course_id:cid,date:`2026-09-${n}`,scheduled_date:`2026-09-${n}`,title:`CNS — Day ${i+1}`,system:'Central Nervous System',system_day:i+1,day_number:i+1,instructional_day_number:i+1,source_master_map_index:100+i,status:'scheduled',roadmap_status:'scheduled',is_published:true,live_session_id:`${cid}-s${i}`,session_id:`${cid}-s${i}`,uworld_qids:[`qid-${i}`],...(i===0?{video_url:'https://example.test/day1'}:{})}));
    days.push({id:`${cid}-off`,course_id:cid,date:'2026-09-12',status:'holiday',is_schedule_placeholder:true});
    db.roadmaps[cid]={id:cid,course_id:cid,skip_sundays:true,settings:{timezone:'America/New_York',class_time:'12:00'},days};
    for (const day of days.slice(0,2)) db.liveSessions[day.session_id]={id:day.session_id,course_id:cid,roadmap_day_id:day.id,scheduled_date:day.date,scheduled_time:'12:00',scheduled_timezone:'America/New_York',status:'completed',topic:day.title};
  }
  db.notes['notes-s0']={session_id:'notes-s0',published:true,notes:'Reviewed lecture notes'};
  db.notes['transcript-s0']={session_id:'transcript-s0',published:false,transcript_text:'A short imported transcript that is real content.'};
  db.attendance.present={session_id:'attendance-s0',user_id:'student'};
  db.recordings.hidden={id:'hidden',session_id:'unpublished-s0',course_id:'unpublished',recording_url:'https://example.test/hidden',published:false};
  // Zoom creates this meeting-only row before a recording or transcript exists.
  db.recordings['placeholder-meeting']={id:'placeholder-meeting',meeting_id:'placeholder-meeting',session_id:'placeholder-s0',course_id:'placeholder',topic:'CNS — Day 1',published:false,created_at:'2026-09-10T12:00:00.000Z'};
  // A stale session pointer with no corresponding media row must not block a holiday.
  db.liveSessions['orphaned-s0'].recording_id='orphaned-meeting-with-no-recording';
  db.recordings.keep={id:'keep',recording_key:'keep',session_id:'safe-s1',course_id:'safe',roadmap_day_id:'safe-d1',recording_url:'https://example.test/recording',published:true};
  Object.assign(db.liveSessions['safe-s1'],{recording_key:'keep',recording_url:'https://example.test/recording'});
  db.notes['safe-s1']={session_id:'safe-s1',notes:'Keep the lecture text',published:true};
  db.attendance.keep={session_id:'safe-s1',user_id:'student',minutes:40};
  await fs.writeFile(dbPath,JSON.stringify(db));
  await fs.writeFile(path.join(dataDir,'crm-db.json'),'{}');
  await fs.writeFile(path.join(dataDir,'aylamed-db.json'),'{}');
  const port = await new Promise(resolve=>{const socket=net.createServer();socket.listen(0,'127.0.0.1',()=>{const value=socket.address().port;socket.close(()=>resolve(value));});});
  const root=fileURLToPath(new URL('..',import.meta.url));
  const child=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PORT:String(port),DATA_DIR:dataDir,AUTH_JWT_SECRET:'test-holiday-secret',AYLA_AUTH_JWT_SECRET:'test-ayla-secret',DATABASE_URL:'',OPENAI_API_KEY:'',NEXTGEN_BACKEND_HEARTBEAT_ENABLED:'false',NEXTGEN_AUTO_ZOOM_PREP_ENABLED:'false',ZOOM_RECORDING_RECOVERY_ENABLED:'false',NEXTGEN_BILLING_EXPIRY_RUNNER_ENABLED:'false'},stdio:['ignore','pipe','pipe']});
  let logs='';child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
  const base=`http://127.0.0.1:${port}`;
  let token='';
  const api=async(route,body,method='POST')=>{const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,data:await response.json()};};
  try {
    let ready=false;
    for(let i=0;i<160;i++){try{if((await fetch(base+'/health')).ok){ready=true;break;}}catch{} if(child.exitCode!==null)break;await new Promise(r=>setTimeout(r,100));}
    assert.ok(ready,logs);
    const unauthorized=await api('/admin/roadmap/safe-d0/retrospective-holiday',{course_id:'safe',dry_run:true});
    assert.equal(unauthorized.status,401);
    const login=await api('/auth/login',{email:'holiday@example.com',password});token=login.data.token;assert.ok(token);
    for(const cid of ['notes','attendance','unpublished','transcript']){
      const before=await fs.readFile(dbPath,'utf8');
      const blocked=await api(`/admin/roadmap/${cid}-d0/retrospective-holiday`,{course_id:cid,dry_run:true});
      assert.equal(blocked.status,409,JSON.stringify(blocked.data));
      assert.equal(await fs.readFile(dbPath,'utf8'),before);
    }
    const placeholderRoute='/admin/roadmap/placeholder-d0/retrospective-holiday';
    const placeholderBefore=await fs.readFile(dbPath,'utf8');
    const placeholderPreview=await api(placeholderRoute,{course_id:'placeholder',dry_run:true});
    assert.equal(placeholderPreview.status,200,JSON.stringify(placeholderPreview.data));
    assert.equal(placeholderPreview.data.selected_revision,null);
    assert.equal(placeholderPreview.data.media_less_recording_references_preserved,1);
    assert.equal(placeholderPreview.data.recording_anchors_preserved,0,'meeting-only placeholder is not a recording-bearing anchor');
    assert.match(placeholderPreview.data.message,/media-less Zoom meeting placeholder/);
    assert.equal(await fs.readFile(dbPath,'utf8'),placeholderBefore,'meeting-only placeholder preview must not modify the database');

    const orphanedPreview=await api('/admin/roadmap/orphaned-d0/retrospective-holiday',{course_id:'orphaned',dry_run:true});
    assert.equal(orphanedPreview.status,200,JSON.stringify(orphanedPreview.data));
    assert.equal(orphanedPreview.data.selected_revision,null);
    assert.equal(orphanedPreview.data.media_less_recording_references_preserved,0);

    const placeholderApplied=await api(placeholderRoute,{
      course_id:'placeholder',
      apply:true,
      preview_token:placeholderPreview.data.preview_token,
      confirm:placeholderPreview.data.confirmation_required,
    });
    assert.equal(placeholderApplied.status,200,JSON.stringify(placeholderApplied.data));
    const afterPlaceholderApply=JSON.parse(await fs.readFile(dbPath,'utf8'));
    assert.deepEqual(afterPlaceholderApply.recordings['placeholder-meeting'],db.recordings['placeholder-meeting'],'meeting-only Zoom row must be preserved unchanged');
    assert.equal(afterPlaceholderApply.liveSessions['placeholder-s0'].status,'cancelled');
    assert.equal(afterPlaceholderApply.roadmaps.placeholder.days[0].status,'holiday');

    const route='/admin/roadmap/safe-d0/retrospective-holiday';
    const beforePreview=await fs.readFile(dbPath,'utf8');
    const preview=await api(route,{course_id:'safe',dry_run:true});
    assert.equal(preview.status,200,JSON.stringify(preview.data));
    assert.equal(preview.data.new_final_date,'2026-09-14','skip occupied Saturday holiday and Sunday');
    assert.equal(preview.data.recording_anchors_preserved,1,'the real linked recording remains a fixed anchor');
    assert.equal(await fs.readFile(dbPath,'utf8'),beforePreview);
    const invalid=await api(route,{course_id:'safe',apply:true,preview_token:'stale',confirm:preview.data.confirmation_required});
    assert.equal(invalid.status,409);
    await api('/admin/live-sessions/safe-s1',{description:'Changed after preview'},'PATCH');
    const stale=await api(route,{course_id:'safe',apply:true,preview_token:preview.data.preview_token,confirm:preview.data.confirmation_required});
    assert.equal(stale.status,409,'changed session invalidates the preview');
    const fresh=await api(route,{course_id:'safe',dry_run:true});
    const applied=await api(route,{course_id:'safe',apply:true,preview_token:fresh.data.preview_token,confirm:fresh.data.confirmation_required,reason:'Class was off.'});
    assert.equal(applied.status,200,JSON.stringify(applied.data));
    const saved=JSON.parse(await fs.readFile(dbPath,'utf8'));
    assert.equal(saved.roadmaps.safe.days[0].status,'holiday');
    assert.equal(saved.liveSessions['safe-s0'].status,'cancelled');
    assert.equal(saved.liveSessions['safe-s0'].student_visible,false);
    assert.equal(saved.roadmaps.safe.days[1].source_master_map_index,100);
    const tail=saved.roadmaps.safe.days.at(-1);
    assert.equal(tail.source_master_map_index,101);
    assert.equal(tail.video_url,undefined,'do not leak the previous packet into the new tail');
    assert.deepEqual(tail.uworld_qids,['qid-1']);
    assert.equal(saved.recordings.keep.session_id,'safe-s1');
    assert.equal(saved.recordings.keep.recording_url,db.recordings.keep.recording_url);
    assert.equal(saved.recordings.keep.published,true);
    assert.equal(saved.liveSessions['safe-s1'].scheduled_date,'2026-09-11');
    assert.equal(saved.notes['safe-s1'].notes,db.notes['safe-s1'].notes);
    assert.equal(saved.attendance.keep.minutes,40);
    assert.deepEqual(saved.assessmentAttempts.keep,db.assessmentAttempts.keep);
    assert.deepEqual(saved.pointEvents.keep,db.pointEvents.keep);
    assert.deepEqual(saved.roadmapProgress.keep,db.roadmapProgress.keep);
    const once=await fs.readFile(dbPath,'utf8');
    const repeat=await api(route,{course_id:'safe',apply:true,preview_token:fresh.data.preview_token,confirm:fresh.data.confirmation_required});
    assert.equal(repeat.status,409);
    assert.equal(await fs.readFile(dbPath,'utf8'),once,'a repeated click does not shift the course twice');
  } finally {
    if(child.exitCode===null) await new Promise(resolve=>{child.once('exit',resolve);child.kill('SIGTERM');});
    // Remove only the exact temporary fixture directory created by this test.
    assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir())+path.sep));
    await fs.rm(dataDir,{recursive:true,force:true});
  }
});
