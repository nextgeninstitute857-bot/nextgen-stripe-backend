import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const block = source.slice(
  source.indexOf('const NG_CLASS_WINDOW_MIN_RECORDING_MINUTES'),
  source.indexOf('async function ngAlertClassWindowRecordingMatch'),
);

function load() {
  const context = vm.createContext({
    DEFAULT_TIMEZONE: 'America/New_York',
    // Sessions in these tests store their UTC start directly.
    getSessionStartUtc: (date, time) => new Date(`${date}T${time}:00Z`),
    ngZoomRecordingSessionEligible: (db, session) => session.status !== 'holiday',
  });
  vm.runInContext(`${block}\nthis.match = ngResolveClassWindowSessionForZoomRecording;`, context);
  return context.match;
}

const session = (id, date, extra = {}) => ({ id, course_id: 'c1', scheduled_date: date, scheduled_time: '16:00', ...extra });
const db = (sessions, recordings = {}) => ({ liveSessions: Object.fromEntries(sessions.map((s) => [s.id, s])), recordings });

test('a full-length recording in another meeting links to the only class at that time', () => {
  const match = load();
  const result = match(db([session('oct6', '2026-10-06'), session('oct8', '2026-10-08')]), { id: '3894929704', uuid: 'u1', start_time: '2026-10-06T17:12:30Z', duration: 49 });
  assert.equal(result.exact, true);
  assert.equal(result.session.id, 'oct6');
  assert.equal(result.reason, 'class_time_window');
  assert.equal(result.time_difference_minutes, 73);
});

test('short fragments, recordings outside class time and holidays are not linked', () => {
  const match = load();
  const classes = db([session('oct6', '2026-10-06'), session('oct7', '2026-10-07', { status: 'holiday' })]);
  assert.equal(match(classes, { start_time: '2026-10-06T16:05:00Z', duration: 8 }).reason, 'class_window_recording_too_short');
  assert.equal(match(classes, { start_time: '2026-10-06T20:30:00Z', duration: 60 }).reason, 'class_window_no_class');
  assert.equal(match(classes, { start_time: '2026-10-07T16:05:00Z', duration: 60 }).reason, 'class_window_no_class');
});

test('two classes in the same window are ambiguous', () => {
  const match = load();
  const result = match(db([session('a', '2026-10-06'), session('b', '2026-10-06', { scheduled_time: '17:00' })]), { start_time: '2026-10-06T16:30:00Z', duration: 60 });
  assert.equal(result.exact, false);
  assert.equal(result.reason, 'class_window_ambiguous');
});

test('a class that already has a real recording is not given a second one', () => {
  const match = load();
  const classes = db([session('oct6', '2026-10-06')], {
    real: { session_id: 'oct6', uuid: 'other', duration: 70 },
    placeholder: { session_id: 'oct6', notes_status: 'preparing' },
  });
  assert.equal(match(classes, { uuid: 'mine', start_time: '2026-10-06T16:02:00Z', duration: 60 }).reason, 'class_window_session_already_recorded');
  // The same recording being re-imported still matches its own class.
  assert.equal(match(classes, { uuid: 'other', start_time: '2026-10-06T16:02:00Z', duration: 70 }).exact, true);
  // A placeholder alone does not count as a recording.
  assert.equal(match(db([session('oct6', '2026-10-06')], { placeholder: { session_id: 'oct6' } }), { uuid: 'x', start_time: '2026-10-06T16:02:00Z', duration: 60 }).exact, true);
});
