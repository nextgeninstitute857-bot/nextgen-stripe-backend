import { normalizeAylaShellExamTrack } from './aylamed-student-shell.js';

const clean = (value, max = 500) => String(value || '').replace(/\u0000/g, '').trim().slice(0, max);
const verifiedRights = new Set(['licensed', 'authorized', 'admin_verified', 'owned']);
const blocked = /(?:^|_)(?:denied|not|pending|rejected|revoked|unapproved|unverified)(?:_|$)/;

// This first release only supports the reviewed publisher/book. It never fetches
// an arbitrary URL, proxies its content, or exposes a private storage object.
export function safeOpenReadingSourceUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.hostname !== 'wtcs.pressbooks.pub'
      || url.username || url.password || url.port || url.search
      || !/^\/nursingfundamentals(?:\/|$)/.test(url.pathname)) return null;
    return url.toString();
  } catch { return null; }
}

export function normalizeAylaOpenReading(input = {}, { examTrack, requireApproval = true } = {}) {
  if (!input || input.type !== 'external_reading') return null;
  const exam = normalizeAylaShellExamTrack(input.examTrackId || input.exam_track_id || input.examTrack || input.exam_track);
  const requestedExam = normalizeAylaShellExamTrack(examTrack);
  if (!exam || !requestedExam || exam !== requestedExam) return null;
  const verification = clean(input.verificationStatus || input.verification_status, 120).toLowerCase().replace(/[^a-z0-9]+/g, '_');
  if (!verifiedRights.has(clean(input.authorizationStatus || input.authorization_status, 80).toLowerCase())) return null;
  if (requireApproval && (input.approved !== true || input.status !== 'active'
    || blocked.test(verification) || !/(?:^|_)(?:approved|verified)(?:_|$)/.test(verification))) return null;
  if (input.sourceAccessMode !== 'open' || input.sourceLabelVisible !== true) return null;
  const source = input.openReading || input.open_reading || {};
  const url = safeOpenReadingSourceUrl(input.sourceUrl || input.source_url);
  const licenseUrl = clean(source.license_url, 200);
  const editors = Array.isArray(source.editors) ? source.editors.map((value) => clean(value, 160)).filter(Boolean) : [];
  if (!url || source.license_id !== 'CC-BY-4.0' || licenseUrl !== 'https://creativecommons.org/licenses/by/4.0/' || !editors.length) return null;
  for (const value of [input.id, input.title, input.bookTitle, input.edition, input.sourceLabel, input.system, source.publisher, source.copyright, source.attribution, source.context_note]) {
    if (!clean(value)) return null;
  }
  const chapterInputs = Array.isArray(source.chapters) ? source.chapters : [];
  if (chapterInputs.length > 50) return null;
  const chapters = chapterInputs.map((chapter) => ({ title: clean(chapter?.title, 180), url: safeOpenReadingSourceUrl(chapter?.url) }));
  if (chapters.some((chapter) => !chapter.title || !chapter.url)) return null;
  return {
    id: clean(input.id, 180), type: 'external_reading', exam_track_id: exam,
    title: clean(input.title, 240), book_title: clean(input.bookTitle, 240), edition: clean(input.edition, 100),
    system: clean(input.system, 120), topic: clean(input.topic || input.bookTitle, 180),
    description: clean(input.description, 1000), source_label: clean(input.sourceLabel, 180),
    reader: { mode: 'external_open_reading', source_url: url },
    open_reading: { publisher: clean(source.publisher, 180), editors, copyright: clean(source.copyright, 300),
      license_id: 'CC-BY-4.0', license_url: licenseUrl, attribution: clean(source.attribution, 1500),
      context_note: clean(source.context_note, 1500), changes: clean(source.changes, 500),
      license_exceptions: clean(source.license_exceptions, 1000), free_access: true, chapters },
  };
}

export function buildAylaOpenReadingCatalog(resources = [], { examTrack, filters = {} } = {}) {
  const normalizeKey = (value) => clean(value, 180).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const system = normalizeKey(filters.system || filters.system_key);
  const topic = normalizeKey(filters.topic || filters.topic_key);
  const search = clean(filters.search || filters.q, 180).toLowerCase();
  const available = resources.map((row) => normalizeAylaOpenReading(row, { examTrack })).filter(Boolean);
  return { systems: [...new Set(available.map((row) => row.system))].sort(), resources: available.filter((row) => {
    if (system && normalizeKey(row.system) !== system || topic && normalizeKey(row.topic) !== topic) return false;
    return !search || [row.title, row.book_title, row.description, row.system, row.topic,
      row.open_reading.editors.join(' '), ...row.open_reading.chapters.map((chapter) => chapter.title)].join(' ').toLowerCase().includes(search);
  }) };
}
