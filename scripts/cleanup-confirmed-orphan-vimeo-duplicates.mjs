import axios from 'axios';
import pg from 'pg';

const duplicateProviderIds = ['1211041968', '1211041972'];
const retainedProviderIds = ['1211031627', '1211031636'];
const token = process.env.VIMEO_ACCESS_TOKEN || process.env.VIMEO_TOKEN;

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
if (!token) throw new Error('VIMEO_ACCESS_TOKEN is required');

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('render.com') ? { rejectUnauthorized: false } : undefined,
});

await client.connect();
try {
  const { rows: retained } = await client.query(`
    SELECT va.provider_id, COUNT(qv.id)::int AS mappings
    FROM content_video_assets va
    LEFT JOIN content_question_videos qv ON qv.video_asset_id = va.id
    WHERE va.provider_id = ANY($1::text[])
    GROUP BY va.id
  `, [retainedProviderIds]);
  if (retained.length !== retainedProviderIds.length || retained.some((row) => row.mappings < 1)) {
    throw new Error('Safety stop: retained Vimeo assets are missing or unmapped');
  }

  const { rows: duplicates } = await client.query(`
    SELECT va.id, va.provider_id, va.original_name, va.sha256,
           COUNT(qv.id)::int AS mappings
    FROM content_video_assets va
    LEFT JOIN content_question_videos qv ON qv.video_asset_id = va.id
    WHERE va.provider_id = ANY($1::text[])
    GROUP BY va.id
  `, [duplicateProviderIds]);
  if (duplicates.some((row) => row.mappings !== 0)) {
    throw new Error('Safety stop: a duplicate candidate now has a question mapping');
  }

  for (const providerId of duplicateProviderIds) {
    try {
      await axios.delete(`https://api.vimeo.com/videos/${providerId}`, {
        headers: { Authorization: `Bearer ${token}` },
        validateStatus: (status) => status === 204 || status === 404,
      });
      console.log({ provider_id: providerId, vimeo: 'deleted_or_already_absent' });
    } catch (error) {
      throw new Error(`Vimeo deletion failed for ${providerId}: ${error.message}`);
    }
  }

  const { rows: removed } = await client.query(`
    DELETE FROM content_video_assets va
    WHERE va.provider_id = ANY($1::text[])
      AND NOT EXISTS (
        SELECT 1 FROM content_question_videos qv WHERE qv.video_asset_id = va.id
      )
    RETURNING provider_id, original_name, sha256
  `, [duplicateProviderIds]);

  console.log({ success: true, removed_database_rows: removed });
} finally {
  await client.end();
}
