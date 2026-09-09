import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { contentQbankFacetQuery, contentQbankFacetsQuery, contentQbankQuestionsQuery, contentQbankSelectionPredicate } from '../lib/content-registry-postgres.js';
import { buildAylaQbankFacetTree } from '../lib/aylamed-qbank-facets.js';
import { nclexTaxonomySourceBinding } from '../lib/content-nclex-variant-taxonomy.js';

// Optional local PostgreSQL/WASM runtime; never connects to a service or loads
// production credentials. Unit tests have no additional package dependency.
const runtime = process.env.AYLA_TEST_PGLITE_PATH;
test('PostgreSQL exact branch membership preserves all depths, tuple boundaries and legacy fallbacks', {skip: !runtime}, async()=>{
  const {PGlite}=await import(pathToFileURL(runtime).href);
  const db=new PGlite();
  try {
    await db.exec('CREATE TABLE branch_questions (id uuid, taxonomy jsonb, system_key text, title text, source_data jsonb)');
    const keys=['system_key','subsystem_key','topic_key','subtopic_key'];
    const rows=Array.from({length:160},(_,i)=>({
      id:`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`,
      taxonomy:{system_key:`system-${i%8}`,subsystem_key:`subsystem-${i%11}`,topic_key:`topic-${i%17}`,subtopic_key:`leaf-${i}`},
      system_key:'fallback',title:'Original question',source_data:{},
    }));
    rows[0].taxonomy={system_key:'a|b',subsystem_key:'c',topic_key:'d',subtopic_key:'e'};
    rows[1].taxonomy={system_key:'a',subsystem_key:'b|c',topic_key:'d',subtopic_key:'e'};
    rows[2].taxonomy={system_key:"quotes' OR TRUE --",subsystem_key:'腎臓',topic_key:'line\nfeed',subtopic_key:'[x,y]'};
    rows[3].taxonomy={system_key:'',subsystem_key:'legacy',subtopic_key:''};rows[3].title='Legacy clinical title';
    rows[4].taxonomy=null;rows[4].system_key=null;rows[4].title=null;
    rows[5].taxonomy={system_key:'broad',subsystem_key:'source',topic_key:'',subtopic_key:''};
    await db.query(`INSERT INTO branch_questions SELECT * FROM jsonb_to_recordset($1::jsonb)
      AS r(id uuid,taxonomy jsonb,system_key text,title text,source_data jsonb)`,[JSON.stringify(rows)]);
    const pathOf=row=>({
      system_key:row.taxonomy?.system_key||row.system_key||'unclassified',
      subsystem_key:row.taxonomy?.subsystem_key??'',
      topic_key:row.taxonomy?.topic_key??(row.title||'unclassified'),
      subtopic_key:row.taxonomy?.subtopic_key??'',
    });
    const full=rows.slice(10,110).map(pathOf),prefix=(row,n)=>Object.fromEntries(keys.slice(0,n).map(k=>[k,pathOf(row)[k]]));
    const cases=[undefined,[],full,
      [prefix(rows[0],2)], [prefix(rows[1],2)], [pathOf(rows[2])],
      [prefix(rows[3],3)], [{system_key:'unclassified'}], [prefix(rows[5],2)],
      [prefix(rows[6],1),prefix(rows[7],2),prefix(rows[8],3),pathOf(rows[9]),...full],
      [{system_key:'absent',subsystem_key:'missing'}],
    ];
    for(const selection_paths of cases){
      const query=contentQbankSelectionPredicate({filters:{selection_paths}});
      const actual=(await db.query(`SELECT q.id FROM branch_questions q WHERE TRUE ${query.sql} ORDER BY q.id`,query.values)).rows.map(r=>r.id);
      const expected=rows.filter(row=>selection_paths===undefined||selection_paths.some(path=>Object.entries(path).every(([k,v])=>pathOf(row)[k]===v))).map(r=>r.id).sort();
      assert.deepEqual(actual,expected);
    }
    const selected=contentQbankSelectionPredicate({filters:{selection_paths:full}});
    const explained=(await db.query(`EXPLAIN (FORMAT JSON) SELECT q.id FROM branch_questions q WHERE TRUE ${selected.sql}`,selected.values)).rows[0]['QUERY PLAN'];
    assert.match(JSON.stringify(explained),/hashed SubPlan/,'Selected branches should be hashed once, not rescanned for every question');
  } finally { await db.close(); }
});

test('PostgreSQL executes facet and selection predicates against adversarial eligibility fixtures', {skip: !runtime}, async()=>{
  const {PGlite}=await import(pathToFileURL(runtime).href);
  const db=new PGlite();
  try {
    await db.exec(`
      CREATE TABLE content_questions (id uuid primary key,exam_track text,status text,system_key text,taxonomy jsonb,source_data jsonb,media_refs jsonb,title text);
      CREATE TABLE content_collections (id uuid primary key,status text,source_profile text,source_namespace text,source_provider text,collection_key text,title text,source_year smallint,approved_at timestamptz,created_at timestamptz);
      CREATE TABLE content_source_aliases (id uuid primary key,question_id uuid,collection_id uuid,created_at timestamptz);
      CREATE TABLE content_collection_destinations (collection_id uuid,destination text,enabled boolean,destination_scope text);
      CREATE TABLE content_media_assets (id uuid,object_key text,status text);
      CREATE TABLE content_video_assets (id uuid,provider_id text,embed_url text,status text);
      CREATE TABLE content_source_alias_media (source_alias_id uuid,media_asset_id uuid,media_ref text,status text);
      CREATE TABLE content_source_alias_videos (source_alias_id uuid,video_asset_id uuid,media_ref text,status text);
      CREATE TABLE content_question_media (question_id uuid,media_asset_id uuid,media_ref text,status text);
      CREATE TABLE content_question_videos (question_id uuid,video_asset_id uuid,media_ref text,status text);
    `);
    const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
    for(const [n,enabled,scope,year] of [[101,true,'',2026],[102,true,'',2026],[103,false,'',2026],[104,true,'pilot',2026],[105,true,'',2020]]) {
      await db.query(`INSERT INTO content_collections VALUES ($1,'approved','other','authorized','Original','fixture','Fixture', $2,NOW(),NOW())`,[uuid(n),year]);
      await db.query(`INSERT INTO content_collection_destinations VALUES ($1,'aylamed_qbank',$2,$3)`,[uuid(n),enabled,scope]);
    }
    const taxonomy=(system='cardio',subtopic='rate',source='provider_mapping')=>({system_key:system,subsystem_key:'clinical',topic_key:'af',subtopic_key:subtopic,
      labels:{system,subsystem:'Clinical grouping',topic:'Atrial fibrillation',subtopic},source,review_status:'approved'});
    const fixtures=[
      [1,101,taxonomy(),{}], [2,101,taxonomy('cardio','anticoag'),{difficulty:50}], [3,102,taxonomy('pulmonary','airway'),{difficulty:20}],
      [4,101,taxonomy(),{status:'draft'}], [5,101,taxonomy(),{exam:'mccqe'}], [6,103,taxonomy(),{}],
      [7,101,taxonomy(),{media:['missing-image']}], [8,101,taxonomy(),{item_format:'multiple_response'}],
      [9,104,taxonomy(),{}], [10,105,taxonomy(),{}],
      [11,101,{...taxonomy('source','opaque','multi_exam_source_taxonomy_v1'),labels:{system:'Source grouping',subsystem:'Source discipline',topic:'A patient has chest pain for three days',subtopic:'Guessed task'}},{}],
      [12,101,taxonomy('neuro','authored','aylamed_owned_json'),{}],
    ];
    for(const [n,c,t,options] of fixtures) {
      const source={statistics:{peopleTaken:100,correctTaken:options.difficulty??80},item_format:options.item_format||'single_best_answer'};
      await db.query('INSERT INTO content_questions VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',[uuid(n),options.exam||'usmle-step-1',options.status||'approved',t.system_key,t,source,options.media||[],'Original question']);
      await db.query('INSERT INTO content_source_aliases VALUES ($1,$2,$3,NOW())',[uuid(1000+n),uuid(n),uuid(c)]);
    }
    // A second bank alias must not double-count the same question.
    await db.query('INSERT INTO content_source_aliases VALUES ($1,$2,$3,NOW())',[uuid(2001),uuid(1),uuid(102)]);
    await db.exec(`
      ALTER TABLE content_questions ADD COLUMN student_qid text, ADD COLUMN question_html text, ADD COLUMN explanation_html text, ADD COLUMN correct_answer_id int;
      ALTER TABLE content_collections ADD COLUMN display_policy jsonb DEFAULT '{}';
      ALTER TABLE content_source_aliases ADD COLUMN source_item_id text, ADD COLUMN source_namespace text, ADD COLUMN source_data jsonb DEFAULT '{}';
      CREATE TABLE content_answers (question_id uuid,answer_id int,text_html text);
      ALTER TABLE content_media_assets ADD COLUMN media_kind text, ADD COLUMN content_type text;
      ALTER TABLE content_source_alias_media ADD COLUMN placement text, ADD COLUMN created_at timestamptz;
      ALTER TABLE content_source_alias_videos ADD COLUMN placement text, ADD COLUMN created_at timestamptz;
      ALTER TABLE content_question_media ADD COLUMN placement text, ADD COLUMN created_at timestamptz;
      ALTER TABLE content_question_videos ADD COLUMN placement text, ADD COLUMN created_at timestamptz;
    `);
    const common={examTrack:'usmle-step-1'};
    async function ids(options={}) {
      const query=contentQbankFacetQuery({...common,...options});
      return (await db.query(`SELECT q.id ${query.sql} ORDER BY q.id`,query.values)).rows.map(row=>row.id);
    }
    assert.deepEqual(await ids(),[1,2,3,11,12].map(uuid));
    assert.deepEqual(await ids({collectionIds:[]}),[]);
    assert.deepEqual(await ids({collectionIds:[uuid(102)]}),[1,3].map(uuid));
    assert.deepEqual(await ids({filters:{selection_paths:[]}}),[]);
    assert.deepEqual(await ids({filters:{selection_paths:[{system_key:'cardio'},{system_key:'pulmonary'}]}}),[1,2,3].map(uuid));
    assert.deepEqual(await ids({filters:{selection_paths:[{system_key:'cardio',subsystem_key:'clinical',topic_key:'af',subtopic_key:'anticoag'}]}}),[uuid(2)]);
    assert.deepEqual(await ids({filters:{selection_paths:[{system_key:'cardio'},{system_key:'pulmonary'}],difficulty:'hard'}}),[uuid(3)]);
    assert.deepEqual(await ids({filters:{system_key:'cardio',selection_paths:[{system_key:'pulmonary'}]}}),[]);
    const history={seenQuestionIds:[uuid(1),uuid(3)],incorrectQuestionIds:[uuid(2)],markedQuestionIds:[uuid(3)]};
    assert.deepEqual(await ids({filters:{status:'unused'},history}),[2,11,12].map(uuid));
    assert.deepEqual(await ids({filters:{status:'incorrect'},history}),[uuid(2)]);
    assert.deepEqual(await ids({filters:{status:'marked'},history}),[uuid(3)]);
    assert.deepEqual(await ids({filters:{status:'incorrect'},history:{...history,incorrectQuestionIds:[]}}),[]);
    assert.deepEqual(await ids({filters:{selection_paths:[{system_key:"cardio' OR TRUE --"}]}}),[]);
    assert.deepEqual(await ids({destinationScope:'pilot'}),[1,2,3,9,11,12].map(uuid));
    const query=contentQbankFacetsQuery(common);
    const rows=(await db.query(query.sql,query.values)).rows;
    const tree=buildAylaQbankFacetTree(rows,common);
    assert.equal(tree.question_count,5);
    assert.equal(JSON.stringify(tree).includes('chest pain'),false);
    assert.equal(tree.nodes.find(node=>node.selection_path.system_key==='source').children[0].children.length,0);
    assert.equal(tree.nodes.find(node=>node.selection_path.system_key==='neuro').children[0].children[0].children[0].level,'subtopic');
    for(const filters of [{selection_paths:[]},{status:'marked'},{difficulty:'hard'},{selection_paths:[{system_key:'cardio'},{system_key:'pulmonary'}]}]) {
      const filtered=contentQbankFacetsQuery({...common,filters,history});
      const result=buildAylaQbankFacetTree((await db.query(filtered.sql,filtered.values)).rows,common);
      assert.equal(result.question_count,(await ids({filters,history})).length);
      const delivery=contentQbankQuestionsQuery({...common,selectionPaths:filters.selection_paths,status:filters.status,difficulty:filters.difficulty,history,limit:200,seed:'fixture'});
      const delivered=(await db.query(delivery.sql,delivery.values)).rows.map(row=>row.id).sort();
      assert.deepEqual(delivered,(await ids({filters,history})).sort());
    }

    // Older approved banks must retain the same question after its flat
    // taxonomy becomes a reviewed, source-bound RN/PN path envelope.
    const sharedId=uuid(3001), original=taxonomy('source-nursing','original');
    const shared={kind:'nclex_variant_paths_v1',source:'question_override',review_status:'approved',
      review_id:uuid(3900),fallback_taxonomy:original,paths:{},source_bindings:[]};
    const sources=[];
    for(const [index,variant] of ['nclex_rn','nclex_pn'].entries()){
      const source={collection_id:uuid(3101+index),collection_title:`BoardVitals ${variant}`,collection_key:`bv-${variant}`,
        source_provider:'BoardVitals',source_profile:'other',source_namespace:`bv-${variant}-2025`,source_item_id:'123',source_file:''};
      sources.push(source);
      shared.paths[variant]=taxonomy(variant,'reviewed');
      shared.source_bindings.push(nclexTaxonomySourceBinding(source,variant));
      await db.query('INSERT INTO content_collections (id,status,source_profile,source_namespace,source_provider,collection_key,title,source_year,approved_at,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,2025,NOW(),NOW())',
        [source.collection_id,'approved',source.source_profile,source.source_namespace,source.source_provider,source.collection_key,source.collection_title]);
      await db.query("INSERT INTO content_collection_destinations VALUES ($1,'aylamed_qbank',TRUE,'')",[source.collection_id]);
    }
    await db.query("INSERT INTO content_questions (id,exam_track,status,system_key,taxonomy,source_data,media_refs,title,correct_answer_id) VALUES ($1,'nclex','approved','source-nursing',$2,'{}','[]','Shared nursing question',1)",[sharedId,original]);
    await db.query("INSERT INTO content_answers VALUES ($1,1,'Answer')",[sharedId]);
    for(const [index,source] of sources.entries())await db.query('INSERT INTO content_source_aliases (id,question_id,collection_id,created_at,source_namespace,source_item_id,source_data) VALUES ($1,$2,$3,NOW(),$4,$5,$6)',
      [uuid(3201+index),sharedId,source.collection_id,source.source_namespace,source.source_item_id,{}]);
    async function nursingIds(source,filters={}){
      const q=contentQbankFacetQuery({examTrack:'nclex',collectionIds:[source.collection_id],filters});
      return (await db.query('SELECT q.id '+q.sql,q.values)).rows.map(r=>r.id);
    }
    for(const source of sources)assert.deepEqual(await nursingIds(source),[sharedId]);
    await db.query('UPDATE content_questions SET taxonomy=$1 WHERE id=$2',[shared,sharedId]);
    for(const [index,source] of sources.entries()){
      const variant=['nclex_rn','nclex_pn'][index], selection_paths=[{system_key:variant}];
      assert.deepEqual(await nursingIds(source),[sharedId],'2025 bank visibility must survive reviewed variant mapping');
      assert.deepEqual(await nursingIds(source,{selection_paths}),[sharedId]);
      assert.deepEqual(await nursingIds(source,{selection_paths:[{system_key:index?'nclex_rn':'nclex_pn'}]}),[]);
      const facet=contentQbankFacetsQuery({examTrack:'nclex',collectionIds:[source.collection_id]});
      const tree=buildAylaQbankFacetTree((await db.query(facet.sql,facet.values)).rows,{examTrack:'nclex'});
      assert.equal(tree.question_count,1);
      assert.equal(tree.nodes[0].selection_path.system_key,variant);
      const delivery=contentQbankQuestionsQuery({examTrack:'nclex',collectionIds:[source.collection_id],selectionPaths:selection_paths,limit:5,seed:'older-bank'});
      const delivered=(await db.query(delivery.sql,delivery.values)).rows;
      assert.deepEqual(delivered.map(r=>r.id),[sharedId]);
      assert.equal(delivered[0].taxonomy.system_key,variant);
    }
    // Changed provenance falls back to the original path; incomplete fallback
    // and disabled destinations still cannot enter an older-bank test.
    await db.query("UPDATE content_source_aliases SET source_item_id='changed' WHERE question_id=$1",[sharedId]);
    for(const source of sources){assert.deepEqual(await nursingIds(source),[sharedId]);assert.deepEqual(await nursingIds(source,{selection_paths:[{system_key:'source-nursing'}]}),[sharedId]);}
    await db.query('UPDATE content_questions SET taxonomy=$1 WHERE id=$2',[{...shared,fallback_taxonomy:{system_key:'source-nursing'}},sharedId]);
    for(const source of sources)assert.deepEqual(await nursingIds(source),[]);
    await db.query('UPDATE content_questions SET taxonomy=$1 WHERE id=$2',[shared,sharedId]);
    await db.query('UPDATE content_collection_destinations SET enabled=FALSE WHERE collection_id=ANY($1::uuid[])',[sources.map(s=>s.collection_id)]);
    for(const source of sources)assert.deepEqual(await nursingIds(source),[]);
  } finally { await db.close(); }
});
