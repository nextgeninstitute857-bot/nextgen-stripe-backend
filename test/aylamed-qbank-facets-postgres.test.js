import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { contentQbankFacetQuery, contentQbankFacetsQuery, contentQbankQuestionsQuery } from '../lib/content-registry-postgres.js';
import { buildAylaQbankFacetTree } from '../lib/aylamed-qbank-facets.js';

// Optional local PostgreSQL/WASM runtime; never connects to a service or loads
// production credentials. Unit tests have no additional package dependency.
const runtime = process.env.AYLA_TEST_PGLITE_PATH;
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
  } finally { await db.close(); }
});
