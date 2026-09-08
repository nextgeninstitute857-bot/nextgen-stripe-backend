import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { exportQuestionTaxonomyReviewPage, reviewQuestionTaxonomyBatch } from '../lib/content-question-taxonomy-review.js';
import { contentQbankFacetsQuery, contentQbankFacetQuery, contentQbankQuestionsQuery, contentQbankCatalogQuery, contentQbankQuestionDisplay } from '../lib/content-registry-postgres.js';
import { NCLEX_VARIANT_TAXONOMY_KIND } from '../lib/content-nclex-variant-taxonomy.js';
import { buildAylaQbankFacetTree } from '../lib/aylamed-qbank-facets.js';
const runtime = process.env.AYLA_TEST_PGLITE_PATH;
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const taxonomy = topic => ({ system_key: 'cardiovascular', subsystem_key: 'valvular_disease', topic_key: topic || 'aortic_stenosis', subtopic_key: 'diagnosis', labels: { system: 'Cardiovascular', subsystem: 'Valvular disease', topic: topic ? 'Aortic regurgitation' : 'Aortic stenosis', subtopic: 'Diagnosis' } });
const options = { allowedSystems: ['Cardiovascular'], actorId: 'test-reviewer' };

test('PostgreSQL reviewed question workflow preserves content and enforces atomic stale-safe batches', { skip: !runtime }, async t => {
  const { PGlite } = await import(pathToFileURL(runtime).href);
  const db = new PGlite();
  async function reset(count = 3) {
    await db.exec(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;
      CREATE TABLE content_questions (id uuid primary key,student_qid text,exam_track text,canonical_hash text,title text,question_html text,explanation_html text,correct_answer_id int,system_key text,subject_key text,status text,media_refs jsonb,source_data jsonb,taxonomy jsonb,updated_at timestamptz default now());
      CREATE TABLE content_answers(question_id uuid references content_questions(id),answer_id int,text_html text);
      CREATE TABLE content_collections(id uuid primary key,destinations jsonb,status text,source_profile text,source_namespace text,source_provider text,collection_key text,title text,source_year int,approved_at timestamptz default now(),created_at timestamptz default now());
      CREATE TABLE content_source_aliases(id uuid primary key,question_id uuid references content_questions(id),collection_id uuid references content_collections(id),source_namespace text,source_item_id text,created_at timestamptz default now(),source_data jsonb default '{}');
      CREATE TABLE content_collection_destinations(collection_id uuid references content_collections(id),destination text,enabled bool,destination_scope text);
      CREATE TABLE content_question_taxonomy_overrides(id uuid primary key,question_id uuid unique references content_questions(id),exam_track text,taxonomy jsonb,previous_taxonomy jsonb,status text,reason text,created_by text,updated_by text,revision int,created_at timestamptz default now(),updated_at timestamptz default now());
      CREATE TABLE content_taxonomy_audit_events(id uuid primary key,question_id uuid,exam_track text,action text,before_state jsonb,after_state jsonb,note text,actor_id text);
      CREATE TABLE content_question_taxonomy_imports(id uuid primary key,exam_track text,payload_fingerprint text,result jsonb,review_manifest jsonb,created_by text);
      CREATE TABLE student_history(id int,question_id uuid,score int);
      CREATE TABLE content_media_assets(id uuid,object_key text,status text);
      CREATE TABLE content_video_assets(id uuid,provider_id text,embed_url text,status text);
      CREATE TABLE content_source_alias_media(source_alias_id uuid,media_asset_id uuid,media_ref text,status text);
      CREATE TABLE content_source_alias_videos(source_alias_id uuid,video_asset_id uuid,media_ref text,status text);
      CREATE TABLE content_question_media(question_id uuid,media_asset_id uuid,media_ref text,status text);
      CREATE TABLE content_question_videos(question_id uuid,video_asset_id uuid,media_ref text,status text);
    `);
    await db.query(`INSERT INTO content_collections VALUES ($1,'["aylamed_qbank"]','approved','other','authorized','Original','fixture','Fixture',2026,NOW(),NOW())`, [id(1000)]);
    await db.query(`INSERT INTO content_collection_destinations VALUES ($1,'aylamed_qbank',true,'')`, [id(1000)]);
    for (let n = 1; n <= count; n++) {
      await db.query(`INSERT INTO content_questions VALUES ($1,$2,'usmle-step-1',$3,'Synthetic clinical title','<p>Synthetic question evidence.</p>','<p>Synthetic explanation evidence.</p>',1,'source-system','source-subject','approved','[]','{"sysName":"Native system"}','{}',NOW())`, [id(n), `NGQ-${n}`, `hash-${n}`]);
      await db.query('INSERT INTO content_answers VALUES ($1,1,$2),($1,2,$3)', [id(n), 'Answer one', 'Answer two']);
      await db.query('INSERT INTO content_source_aliases(id,question_id,collection_id,source_namespace,source_item_id) VALUES ($1,$2,$3,$4,$5)', [id(2000+n), id(n), id(1000), 'fixture-source', String(n)]);
    }
    await db.query('INSERT INTO student_history VALUES (1,$1,50)', [id(1)]);
  }
  const page = extra => exportQuestionTaxonomyReviewPage(db, { examTrack: 'usmle_step_1', ...options, ...extra });
  async function manifest(numbers = [1, 2], reviewId = 9000) {
    const exported = await page({ questionIds: numbers.map(id) });
    return { exam_track: 'usmle_step_1', review_id: id(reviewId), items: exported.questions.map(q => ({ question_id: q.id, expected_evidence_fingerprint: q.evidence_fingerprint,
      taxonomy: taxonomy(), reason: 'Reviewed complete synthetic evidence and clinical hierarchy.' })) };
  }
  const preview = input => reviewQuestionTaxonomyBatch(db, { ...input, apply: false }, options);
  const apply = (input, dry, client = db) => reviewQuestionTaxonomyBatch(client, { ...input, apply: true, expected_fingerprint: dry.fingerprint }, options);
  const count = async table => Number((await db.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
  async function immutableState() {
    return {
      questions: (await db.query('SELECT id,student_qid,exam_track,canonical_hash,title,question_html,explanation_html,correct_answer_id,system_key,subject_key,status,media_refs,source_data FROM content_questions ORDER BY id')).rows,
      answers: (await db.query('SELECT * FROM content_answers ORDER BY question_id,answer_id')).rows,
      aliases: (await db.query('SELECT * FROM content_source_aliases ORDER BY id')).rows,
      publication: (await db.query('SELECT * FROM content_collection_destinations')).rows,
      history: (await db.query('SELECT * FROM student_history')).rows,
    };
  }
  try {
    await t.test('cursor export passes 200 rows and explicit IDs deduplicate and enforce exam/source scope', async () => {
      await reset(205);
      const a = await page(); const b = await page({ after: a.next_after }); const c = await page({ after: b.next_after });
      assert.deepEqual([a.count, b.count, c.count], [100, 100, 5]); assert.equal(c.has_more, false);
      assert.equal(new Set([...a.questions, ...b.questions, ...c.questions].map(q => q.id)).size, 205);
      assert.equal(a.questions[0].question_html, '<p>Synthetic question evidence.</p>');
      assert.equal(a.questions[0].answers.length, 2); assert.equal(a.questions[0].native.labels.sysName, 'Native system');
      assert.equal((await page({ questionIds: [id(1), id(1)] })).count, 1);
      await assert.rejects(page({ questionIds: [id(1), id(999)] }), { statusCode: 404 });
      await assert.rejects(page({ questionIds: [id(1)], examTrack: 'mccqe' }), { statusCode: 404 });
      await assert.rejects(page({ questionIds: [id(1)], sourceNamespace: 'wrong-source' }), { statusCode: 404 });
      await assert.rejects(page({ questionIds: [id(1)], after: id(2) }), { statusCode: 400 });
      await assert.rejects(page({ questionIds: Array(101).fill(id(1)) }), { statusCode: 400 });
    });
    await t.test('preview has zero writes; mixed question paths apply with audit, stable IDs and matching facet totals', async () => {
      await reset(); const before = await immutableState();
      const input = await manifest(); input.items[1].taxonomy = taxonomy('aortic_regurgitation');
      const dry = await preview(input);
      assert.equal(dry.updated_count, 2); assert.equal(await count('content_question_taxonomy_imports'), 0);
      assert.equal(await count('content_question_taxonomy_overrides'), 0); assert.equal(await count('content_taxonomy_audit_events'), 0);
      const saved = await apply(input, dry);
      assert.equal(saved.applied, true); assert.equal(saved.updated_count, 2);
      assert.equal(await count('content_question_taxonomy_overrides'), 2); assert.equal(await count('content_taxonomy_audit_events'), 2);
      assert.deepEqual(await immutableState(), before);
      const q = (await page({ questionIds: [id(1)] })).questions[0];
      assert.equal(q.taxonomy.review_status, 'approved'); assert.equal(q.taxonomy.source, 'question_override'); assert.equal(q.override.status, 'active');
      const query = contentQbankFacetsQuery({ examTrack: 'usmle-step-1' });
      const tree = buildAylaQbankFacetTree((await db.query(query.sql, query.values)).rows, { examTrack: 'usmle-step-1' });
      assert.equal(tree.question_count, 3); assert.equal(tree.coverage.reviewed_question_count, 2);
      const replay = await apply(input, dry); assert.equal(replay.replayed, true); assert.equal(await count('content_taxonomy_audit_events'), 2);
      assert.deepEqual({ ...replay, replayed: false }, saved);
      const storedManifest = (await db.query('SELECT review_manifest FROM content_question_taxonomy_imports')).rows[0].review_manifest;
      assert.equal(storedManifest.items[0].reason, input.items[0].reason);
    });
    await t.test('changed evidence, answer text, payload and out-of-scope IDs fail without partial writes', async () => {
      await reset(); const input = await manifest(); const dry = await preview(input);
      await db.query('UPDATE content_answers SET text_html=$2 WHERE question_id=$1 AND answer_id=1', [id(2), 'Changed answer evidence']);
      await assert.rejects(apply(input, dry), { statusCode: 409 });
      assert.equal(await count('content_question_taxonomy_imports'), 0); assert.equal(await count('content_question_taxonomy_overrides'), 0);
      const fresh = await manifest(); const freshDry = await preview(fresh); fresh.items[0].reason = 'Changed after preview without another review.';
      await assert.rejects(apply(fresh, freshDry), { statusCode: 409 });
      fresh.items[1].question_id = id(999); await assert.rejects(preview(fresh), { statusCode: 404 });
      assert.equal(await count('content_taxonomy_audit_events'), 0);
    });
    await t.test('existing active overrides require explicit current revision and unchanged exact paths stay idempotent', async () => {
      await reset(); const original = await manifest(); await apply(original, await preview(original));
      const changed = await manifest([1], 9001);
      await assert.rejects(preview(changed), { statusCode: 409 });
      changed.items[0].expected_override_revision = 99; await assert.rejects(preview(changed), { statusCode: 409 });
      changed.items[0].expected_override_revision = 1;
      const same = await preview(changed); assert.equal(same.unchanged_count, 1);
      const unchanged = await apply(changed, same); assert.equal(unchanged.updated_count, 0); assert.equal(await count('content_taxonomy_audit_events'), 2);
      const next = await manifest([1], 9002); next.items[0].expected_override_revision = 1; next.items[0].taxonomy = taxonomy('aortic_regurgitation');
      const nextDry = await preview(next); await apply(next, nextDry);
      assert.equal((await page({ questionIds: [id(1)] })).questions[0].override.revision, 2);
      const beforeState = (await db.query('SELECT previous_taxonomy FROM content_question_taxonomy_overrides WHERE question_id=$1', [id(1)])).rows[0].previous_taxonomy;
      assert.deepEqual(beforeState, {});
    });
    await t.test('failure after updates rolls back every classification, receipt and audit', async () => {
      await reset(); const input = await manifest(); const dry = await preview(input); let auditWrites = 0;
      const failing = { query: async (sql, values) => {
        if (sql.includes('INSERT INTO content_taxonomy_audit_events') && ++auditWrites === 2) throw new Error('Injected audit failure');
        return db.query(sql, values);
      } };
      await assert.rejects(apply(input, dry, failing), /Injected audit failure/);
      assert.equal(await count('content_question_taxonomy_imports'), 0); assert.equal(await count('content_question_taxonomy_overrides'), 0); assert.equal(await count('content_taxonomy_audit_events'), 0);
      assert.ok((await page()).questions.every(q => Object.keys(q.taxonomy).length === 0));
    });
    await t.test('database locks freeze fingerprinted parent/child relations with bounded local timeouts', async () => {
      await reset(); const input = await manifest(); const dry = await preview(input); let checked = false;
      const inspecting = { query: async (sql, values) => {
        if (sql.startsWith('SELECT q.*,to_jsonb(o)')) {
          const held = (await db.query(`SELECT DISTINCT c.relname FROM pg_locks l JOIN pg_class c ON c.oid=l.relation WHERE l.granted AND l.mode='RowShareLock'`)).rows.map(row => row.relname);
          for (const table of ['content_collections', 'content_collection_destinations', 'content_questions', 'content_answers', 'content_source_aliases', 'content_question_taxonomy_overrides']) assert.ok(held.includes(table), `row locks acquired for ${table}`);
          const settings = (await db.query("SELECT current_setting('lock_timeout') AS lock_timeout,current_setting('statement_timeout') AS statement_timeout")).rows[0];
          assert.deepEqual(settings, { lock_timeout: '5s', statement_timeout: '15s' });
          const foreignKeys = (await db.query("SELECT conrelid::regclass::text AS child,confrelid::regclass::text AS parent FROM pg_constraint WHERE contype='f'")).rows;
          for (const [child, parent] of [['content_answers', 'content_questions'], ['content_source_aliases', 'content_questions'], ['content_collection_destinations', 'content_collections']]) assert.ok(foreignKeys.some(row => row.child === child && row.parent === parent));
          checked = true;
        }
        return db.query(sql, values);
      } };
      await apply(input, dry, inspecting); assert.equal(checked, true);
      assert.equal((await db.query("SELECT current_setting('lock_timeout') AS setting")).rows[0].setting, '0');
    });
    await t.test('collection identity/registration changes after preview fail and PostgreSQL lock errors roll back', async () => {
      await reset(); const input = await manifest(); const dry = await preview(input);
      await db.query('UPDATE content_collections SET title=$2 WHERE id=$1', [id(1000), 'Changed source identity']);
      await assert.rejects(apply(input, dry), { statusCode: 409 });
      assert.equal(await count('content_question_taxonomy_imports'), 0);
      const fresh = await manifest(); const freshDry = await preview(fresh);
      const conflicting = { query: async (sql, values) => {
        if (sql.startsWith('SELECT q.*,to_jsonb(o)')) return db.exec("DO $$ BEGIN RAISE EXCEPTION 'lock conflict fixture' USING ERRCODE='55P03'; END $$");
        return db.query(sql, values);
      } };
      await assert.rejects(apply(fresh, freshDry, conflicting), { statusCode: 409 });
      assert.equal(await count('content_question_taxonomy_imports'), 0); assert.equal(await count('content_question_taxonomy_overrides'), 0);
    });
    await t.test('NCLEX export/apply uses per-question RN/PN systems and blocks missing or conflicting source variants', async () => {
      await reset(4);
      await db.exec(`UPDATE content_questions SET exam_track='nclex'; UPDATE content_collections SET title='NCLEX RN bank';`);
      await db.query(`INSERT INTO content_collections SELECT $1,destinations,status,source_profile,source_namespace,source_provider,'pn','NCLEX PN bank',source_year,approved_at,created_at FROM content_collections LIMIT 1`, [id(1001)]);
      await db.query(`INSERT INTO content_collections SELECT $1,destinations,status,source_profile,source_namespace,source_provider,'generic','NCLEX unspecified',source_year,approved_at,created_at FROM content_collections LIMIT 1`, [id(1002)]);
      await db.query('UPDATE content_source_aliases SET collection_id=$2 WHERE question_id=$1', [id(2), id(1001)]);
      await db.query('UPDATE content_source_aliases SET collection_id=$2 WHERE question_id=$1', [id(4), id(1002)]);
      await db.query(`INSERT INTO content_source_aliases(id,question_id,collection_id,source_namespace,source_item_id) VALUES ($1,$2,$3,'second-source','3')`, [id(2500), id(3), id(1001)]);
      const exported = await page({ examTrack: 'nclex' });
      assert.deepEqual(exported.allowed_systems, []);
      const [rn, pn, mixed, missing] = exported.questions;
      assert.equal(rn.nclex_variant, 'nclex_rn'); assert.equal(pn.nclex_variant, 'nclex_pn');
      assert.equal(mixed.classification_blocked_reason, 'nclex_variant_conflict'); assert.equal(missing.classification_blocked_reason, 'nclex_variant_missing');
      function reviewed(q, system) {
        return { question_id: q.id, expected_evidence_fingerprint: q.evidence_fingerprint, nclex_variant: q.nclex_variant,
          taxonomy: { ...taxonomy(), system_key: system.toLowerCase().replace(/[^a-z0-9]+/g, '_'), labels: { ...taxonomy().labels, system } }, reason: 'Reviewed source variant and complete synthetic evidence.' };
      }
      const input = { exam_track: 'nclex', review_id: id(9100), items: [reviewed(rn, 'Pharmacological and Parenteral Therapies'), reviewed(pn, 'Coordinated Care')] };
      await apply(input, await preview(input));
      assert.equal(await count('content_question_taxonomy_overrides'), 2);
      const blocked = { exam_track: 'nclex', review_id: id(9101), items: [{ ...reviewed(mixed, 'Management of Care'), nclex_variant: 'nclex_rn' }] };
      await assert.rejects(preview(blocked), { statusCode: 422 });
      const freshRn = (await page({ examTrack: 'nclex', questionIds: [rn.id] })).questions[0];
      const wrong = { exam_track: 'nclex', review_id: id(9102), items: [{ ...reviewed(freshRn, 'Coordinated Care'), nclex_variant: 'nclex_pn', expected_override_revision: 1 }] };
      await assert.rejects(preview(wrong), { statusCode: 409 });
    });
    await t.test('explicit shared review preserves both bank selections and rejects stale or ambiguous provenance', async () => {
      await reset(6);
      await db.exec(`UPDATE content_questions SET exam_track='nclex'; UPDATE content_collections SET title='NCLEX RN bank';`);
      await db.query(`INSERT INTO content_collections SELECT $1,destinations,status,source_profile,source_namespace,source_provider,'pn','NCLEX PN bank',source_year,approved_at,created_at FROM content_collections LIMIT 1`, [id(1001)]);
      await db.query(`INSERT INTO content_collection_destinations VALUES ($1,'aylamed_qbank',true,'')`, [id(1001)]);
      for (let n = 1; n <= 6; n++) await db.query(`INSERT INTO content_source_aliases(id,question_id,collection_id,source_namespace,source_item_id) VALUES ($1,$2,$3,'second-source',$4)`, [id(2500+n), id(n), id(1001), String(n)]);
      const exported = await page({ examTrack: 'nclex' }), before = await immutableState();
      assert.ok(exported.questions.every(q => q.shared_classification_allowed && q.classification_blocked_reason === 'nclex_variant_conflict'));
      const systems = exported.questions[0].shared_allowed_systems; assert.equal(systems.length, 6);
      const input = { exam_track: 'nclex', review_id: id(9200), items: exported.questions.map((q, i) => ({ question_id: q.id,
        expected_evidence_fingerprint: q.evidence_fingerprint, nclex_variants: q.shared_nclex_variants,
        taxonomy: { ...taxonomy(), system_key: systems[i].toLowerCase().replace(/ /g, '_'), labels: { ...taxonomy().labels, system: systems[i] } },
        reason: 'Explicit review of a common category for both independently evidenced source variants.' })) };
      const dry = await preview(input); assert.equal(await count('content_question_taxonomy_overrides'), 0);
      await db.query('UPDATE content_collections SET title=$2 WHERE id=$1', [id(1001), 'Ambiguous NCLEX RN and PN bank']);
      await assert.rejects(apply(input, dry), { statusCode: 422 }); assert.equal(await count('content_question_taxonomy_imports'), 0);
      await db.query('UPDATE content_collections SET title=$2 WHERE id=$1', [id(1001), 'NCLEX PN bank']);
      const applied = await apply(input, dry); assert.equal(applied.updated_count, 6); assert.deepEqual(await immutableState(), before);
      for (const collection of [id(1000), id(1001)]) {
        const opts = { examTrack: 'nclex', collectionIds: [collection] }, query = contentQbankFacetsQuery(opts);
        const tree = buildAylaQbankFacetTree((await db.query(query.sql, query.values)).rows, { examTrack: 'nclex' });
        assert.equal(tree.question_count, 6); assert.equal(tree.coverage.reviewed_question_count, 6);
        assert.deepEqual(tree.nodes.map(n => n.label).sort(), [...systems].sort());
        for (const item of input.items) {
          const path = Object.fromEntries(['system_key', 'subsystem_key', 'topic_key', 'subtopic_key'].map(k => [k, item.taxonomy[k]]));
          const selection = contentQbankFacetQuery({ ...opts, filters: { selection_paths: [path] } });
          assert.deepEqual((await db.query('SELECT q.id ' + selection.sql, selection.values)).rows.map(q => q.id), [item.question_id]);
        }
      }
      const replay = await apply(input, dry); assert.equal(replay.replayed, true); assert.equal(await count('content_taxonomy_audit_events'), 6);
      const refreshed = await page({ examTrack: 'nclex' });
      assert.ok(refreshed.questions.every(q => q.override.revision === 1 && q.taxonomy.review_status === 'approved'));
    });
    await t.test('shared variant paths agree across facets, counts, catalog and delivery with safe provenance fallback', async () => {
      await reset(2);
      await db.exec(`UPDATE content_questions SET exam_track='nclex'; UPDATE content_collections SET title='NCLEX RN bank';`);
      await db.query(`INSERT INTO content_collections SELECT $1,destinations,status,source_profile,source_namespace,source_provider,'pn','NCLEX PN bank',source_year,approved_at,created_at FROM content_collections LIMIT 1`, [id(1001)]);
      await db.query(`INSERT INTO content_collection_destinations VALUES ($1,'aylamed_qbank',true,'')`, [id(1001)]);
      for (let n = 1; n <= 2; n++) await db.query(`INSERT INTO content_source_aliases(id,question_id,collection_id,source_namespace,source_item_id) VALUES ($1,$2,$3,'second-source',$4)`, [id(2500+n), id(n), id(1001), String(n)]);
      for (const [collection,variant] of [[1000,'RN'],[1001,'PN']]) await db.query(`UPDATE content_source_aliases SET source_data=$2 WHERE collection_id=$1`, [id(collection), { import_source_file: `C:\\archive\\NCLEX ${variant} questions.json` }]);
      // Use the full delivery schema as well as the lightweight facet schema.
      await db.exec(`ALTER TABLE content_collections ADD COLUMN display_policy jsonb DEFAULT '{}';
        ALTER TABLE content_media_assets ADD COLUMN media_kind text, ADD COLUMN content_type text;
        ALTER TABLE content_source_alias_media ADD COLUMN placement text, ADD COLUMN created_at timestamptz;
        ALTER TABLE content_source_alias_videos ADD COLUMN placement text, ADD COLUMN created_at timestamptz;
        ALTER TABLE content_question_media ADD COLUMN placement text, ADD COLUMN created_at timestamptz;
        ALTER TABLE content_question_videos ADD COLUMN placement text, ADD COLUMN created_at timestamptz;`);
      const exported = await page({ examTrack: 'nclex' }), before = await immutableState();
      const path = (system, i) => ({ ...taxonomy(i ? 'aortic_regurgitation' : undefined), system_key: system.toLowerCase().replace(/ /g, '_'), labels: { ...taxonomy(i ? 'aortic_regurgitation' : undefined).labels, system } });
      const input = { exam_track: 'nclex', review_id: id(9300), items: exported.questions.map((q,i) => ({
        question_id: q.id, expected_evidence_fingerprint: q.evidence_fingerprint, nclex_variants: q.shared_nclex_variants,
        taxonomy: { kind: NCLEX_VARIANT_TAXONOMY_KIND, paths: {
          nclex_rn: path(i ? 'Pharmacological and Parenteral Therapies' : 'Management of Care', i),
          nclex_pn: path(i ? 'Pharmacological Therapies' : 'Coordinated Care', i),
        }, source_bindings: q.shared_source_bindings }, reason: 'Reviewed both synthetic exam paths and complete original source bindings.',
      })) };
      assert.ok(input.items.every(item => item.taxonomy.source_bindings.every(b => b.source_file.startsWith('NCLEX '))));
      const invalid = structuredClone(input); invalid.items[0].taxonomy.source_bindings[0].source_item_id = 'unreviewed';
      await assert.rejects(preview(invalid), { statusCode: 409 });
      const dry = await preview(input); assert.equal(await count('content_question_taxonomy_overrides'), 0);
      await apply(input, dry); assert.deepEqual(await immutableState(), before);
      const queryRows = async query => (await db.query(query.sql, query.values)).rows;
      for (const [variant,collection] of [['nclex_rn',1000],['nclex_pn',1001]]) {
        const opts = { examTrack: 'nclex', collectionIds: [id(collection)] };
        const tree = buildAylaQbankFacetTree(await queryRows(contentQbankFacetsQuery(opts)), opts);
        assert.equal(tree.question_count, 2); assert.equal(tree.coverage.reviewed_question_count, 2);
        assert.deepEqual(tree.nodes.map(n => n.label).sort(), input.items.map(i => i.taxonomy.paths[variant].labels.system).sort());
        const catalog = await queryRows(contentQbankCatalogQuery(opts)); assert.equal(catalog.reduce((n,r) => n+r.question_count,0), 2);
        for (const item of input.items) {
          const expected = item.taxonomy.paths[variant], selection = Object.fromEntries(['system_key','subsystem_key','topic_key','subtopic_key'].map(k=>[k,expected[k]]));
          const countQuery = contentQbankFacetQuery({ ...opts, filters: { selection_paths: [selection] } });
          assert.deepEqual((await db.query('SELECT q.id '+countQuery.sql,countQuery.values)).rows.map(q=>q.id), [item.question_id]);
          const rows = await queryRows(contentQbankQuestionsQuery({ ...opts, selectionPaths: [selection], seed: 'stable' }));
          assert.deepEqual(rows.map(q=>q.id),[item.question_id]);
          const projected = contentQbankQuestionDisplay(rows[0]);
          for (const key of ['system_key','subsystem_key','topic_key','subtopic_key','labels']) assert.deepEqual(projected.taxonomy[key],expected[key]);
          assert.equal(projected.taxonomy.review_status,'approved');assert.equal(projected.taxonomy.review_id,input.review_id);
          assert.ok(!JSON.stringify(projected).includes('source_bindings'));assert.ok(!JSON.stringify(projected).includes('fallback_taxonomy'));
          assert.ok(catalog.some(row=>row.system_key===expected.system_key&&row.subtopic_key===expected.subtopic_key));
          const otherVariant = variant==='nclex_rn'?'nclex_pn':'nclex_rn';
          assert.equal((await queryRows(contentQbankQuestionsQuery({ ...opts, systemKey: item.taxonomy.paths[otherVariant].system_key, seed:'stable' }))).length,0);
        }
      }
      const both = { examTrack:'nclex',collectionIds:[id(1000),id(1001)] };
      const delivered = await queryRows(contentQbankQuestionsQuery({ ...both,seed:'stable' }));assert.equal(delivered.length,2);
      const bothCatalog = await queryRows(contentQbankCatalogQuery(both));
      assert.deepEqual(bothCatalog.map(r=>r.system_key).sort(),delivered.map(r=>r.system_key).sort());
      const replay = await apply(input,dry);assert.equal(replay.replayed,true);assert.equal(await count('content_taxonomy_audit_events'),2);
      const fresh = await page({examTrack:'nclex'});
      const same = { ...input,review_id:id(9301),items:input.items.map((i,n)=>({...i,expected_evidence_fingerprint:fresh.questions[n].evidence_fingerprint,expected_override_revision:1})) };
      assert.equal((await preview(same)).unchanged_count,2);
      // A source identity change does not inherit the old variant's approval.
      await db.query(`UPDATE content_source_aliases SET source_item_id='changed' WHERE collection_id=$1 AND question_id=$2`,[id(1001),id(1)]);
      const pnOpts={examTrack:'nclex',collectionIds:[id(1001)]};
      const changed = buildAylaQbankFacetTree(await queryRows(contentQbankFacetsQuery(pnOpts)),pnOpts);
      assert.equal(changed.question_count,2);assert.equal(changed.coverage.reviewed_question_count,1);
      const fallback = (await queryRows(contentQbankQuestionsQuery({...pnOpts,seed:'stable'}))).find(q=>q.id===id(1));assert.deepEqual(fallback.taxonomy,{});
      // Renaming a collection also invalidates its binding, preserving access.
      await db.query(`UPDATE content_collections SET title='Renamed NCLEX PN' WHERE id=$1`,[id(1001)]);
      const renamed = buildAylaQbankFacetTree(await queryRows(contentQbankFacetsQuery(pnOpts)),pnOpts);
      assert.equal(renamed.question_count,2);assert.equal(renamed.coverage.reviewed_question_count,0);
      const rnOpts={examTrack:'nclex',collectionIds:[id(1000)]};
      assert.equal(buildAylaQbankFacetTree(await queryRows(contentQbankFacetsQuery(rnOpts)),rnOpts).coverage.reviewed_question_count,2);
      await db.query(`UPDATE content_collection_destinations SET enabled=false WHERE collection_id=$1`,[id(1001)]);
      assert.equal((await queryRows(contentQbankQuestionsQuery({...pnOpts,seed:'stable'}))).length,0);
    });
  } finally { await db.close(); }
});
