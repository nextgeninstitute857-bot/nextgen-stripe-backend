import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const runtime = process.env.AYLA_TEST_PGLITE_PATH;
const source = fs.readFileSync(new URL('../lib/content-registry-postgres.js', import.meta.url), 'utf8');
function queryBetween(startMarker, endMarker, startAt = 0) {
  const start = source.indexOf(startMarker, startAt);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, 'Locate the actual import query');
  return source.slice(start + startMarker.length, end);
}
const metadataSql = queryBetween('if (metadataPayload.length) await client.query(`', '`, [job.exam_track, JSON.stringify(metadataPayload)]);');
const questionId = '00000000-0000-4000-8000-000000000001';

test('actual import writers preserve reviewed question taxonomy during later metadata refreshes', { skip: !runtime }, async t => {
  const { PGlite } = await import(pathToFileURL(runtime).href);
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE content_questions(id uuid,exam_track text,canonical_hash text,title text,question_html text,explanation_html text,correct_answer_id int,system_key text,subject_key text,status text,taxonomy jsonb,media_refs jsonb,source_data jsonb,updated_at timestamptz);
    CREATE TABLE content_question_taxonomy_overrides(question_id uuid,status text,taxonomy jsonb);
    CREATE TABLE content_source_aliases(question_id uuid,collection_id uuid);
    CREATE TABLE content_collections(id uuid,status text);
    CREATE TABLE content_collection_destinations(collection_id uuid,enabled boolean);
  `);
  async function seed({ taxonomy, overrideStatus = null }) {
    await db.exec('DELETE FROM content_questions; DELETE FROM content_question_taxonomy_overrides;');
    await db.query(`INSERT INTO content_questions VALUES ($1,'usmle-step-2','stable-hash','Clinical title','Same question','Earlier explanation',1,'4','1','draft',$2::jsonb,'[]','{"source_rank":1}',NOW())`, [questionId, JSON.stringify(taxonomy)]);
    if (overrideStatus) await db.query('INSERT INTO content_question_taxonomy_overrides VALUES ($1,$2,$3::jsonb)', [questionId, overrideStatus, JSON.stringify(taxonomy)]);
  }
  const reviewed = { source: 'question_override', review_status: 'approved', topic_key: 'stable_angina', review_id: 'reviewed-batch' };
  const imported = { source: 'native_import', topic_key: 'clinical_reasoning' };
  async function importMetadata() {
    await db.query(metadataSql, ['usmle-step-2', JSON.stringify([{
      canonical_hash: 'stable-hash', title: 'Clinical title', question_html: 'Same question', explanation_html: 'Updated explanation',
      correct_answer_id: 2, system_key: '4', subject_key: '1', taxonomy: imported, media_refs: [],
      source_rank: 2, source_data: { source_rank: 2, source_adapter: 'amboss_sba_v1' },
    }])]);
    return (await db.query('SELECT * FROM content_questions WHERE id=$1', [questionId])).rows[0];
  }
  try {
    await t.test('higher-ranked reimport refreshes permitted metadata without losing an active override', async () => {
      await seed({ taxonomy: reviewed, overrideStatus: 'active' });
      const row = await importMetadata();
      assert.deepEqual(row.taxonomy, reviewed);
      assert.equal(row.explanation_html, 'Updated explanation', 'The source refresh still executes');
      assert.equal(row.correct_answer_id, 1, 'The non-owned answer-key rule remains unchanged');
      assert.equal(row.status, 'draft');
      assert.equal((await db.query('SELECT status FROM content_question_taxonomy_overrides')).rows[0].status, 'active');
    });
    await t.test('the question override marker protects the latest row independently of the override lookup', async () => {
      await seed({ taxonomy: reviewed });
      assert.deepEqual((await importMetadata()).taxonomy, reviewed);
    });
    await t.test('ordinary and disabled-override imports still receive their new source taxonomy', async () => {
      for (const overrideStatus of [null, 'disabled']) {
        await seed({ taxonomy: { source: 'native_import', topic_key: 'older_hint' }, overrideStatus });
        assert.deepEqual((await importMetadata()).taxonomy, imported);
      }
    });
  } finally { await db.close(); }
});
