import test from "node:test";
import assert from "node:assert/strict";
import {
  attachVimeoToRecording,
  checkVimeoTransfer,
  startVimeoPullFromZoom,
  transferState,
  vimeoDurationMatches,
  vimeoPlayerUrl,
  zoomFileDurationSeconds,
  zoomMeetingUuidPath,
} from "../lib/lms-recording-vimeo-transfer.js";

test("Zoom meeting UUIDs with slashes are double-encoded", () => {
  assert.equal(zoomMeetingUuidPath("abc=="), "abc%3D%3D");
  assert.equal(zoomMeetingUuidPath("/ab//c=="), encodeURIComponent(encodeURIComponent("/ab//c==")));
});

test("Zoom file duration comes from recording start and end", () => {
  assert.equal(zoomFileDurationSeconds({ recording_start: "2026-09-28T16:00:00Z", recording_end: "2026-09-28T17:19:30Z" }), 4770);
  assert.equal(zoomFileDurationSeconds({}), null);
});

test("Vimeo pull upload links the Zoom file with an access token and keeps the video private", async () => {
  const calls = [];
  const vimeoApi = { post: async (path, body) => { calls.push({ path, body }); return { data: { uri: "/videos/123", link: "https://vimeo.com/123/abc9" } }; } };
  const result = await startVimeoPullFromZoom({
    vimeoApi,
    zoomAccessToken: "zoom-token",
    videoFile: { download_url: "https://zoom.us/rec/download/xyz", file_size: 5000 },
    name: "Immunology — Day 2",
  });
  assert.equal(calls[0].path, "/me/videos");
  assert.equal(calls[0].body.upload.approach, "pull");
  assert.equal(calls[0].body.upload.size, "5000");
  assert.equal(calls[0].body.upload.link, "https://zoom.us/rec/download/xyz?access_token=zoom-token");
  assert.equal(calls[0].body.privacy.embed, "whitelist");
  assert.equal(calls[0].body.privacy.download, false);
  assert.deepEqual(result, {
    vimeo_video_id: "123",
    vimeo_uri: "/videos/123",
    vimeo_link: "https://vimeo.com/123/abc9",
    vimeo_player_url: "https://player.vimeo.com/video/123?h=abc9",
  });
  await assert.rejects(() => startVimeoPullFromZoom({ vimeoApi, zoomAccessToken: "t", videoFile: {}, name: "x" }), /no downloadable MP4/);
});

test("a transfer is verified only after transcoding completes with a matching duration", async () => {
  const video = (overrides) => ({ get: async () => ({ data: { uri: "/videos/9", link: "https://vimeo.com/9", player_embed_url: "https://player.vimeo.com/video/9", duration: 4770, status: "available", transcode: { status: "complete" }, upload: { status: "complete" }, ...overrides } }) });
  const transfer = { vimeo_video_id: "9", zoom_duration_seconds: 4775 };
  assert.equal((await checkVimeoTransfer({ vimeoApi: video({}), transfer })).verified, true);
  assert.equal((await checkVimeoTransfer({ vimeoApi: video({ status: "transcoding", transcode: { status: "in_progress" } }), transfer })).verified, false);
  assert.equal((await checkVimeoTransfer({ vimeoApi: video({ duration: 1200 }), transfer })).verified, false, "truncated copy is not verified");
  assert.match((await checkVimeoTransfer({ vimeoApi: video({ status: "quota_exceeded" }), transfer })).error, /quota_exceeded/);
  assert.equal((await checkVimeoTransfer({ vimeoApi: video({}), transfer: { ...transfer, zoom_duration_seconds: null } })).verified, true, "processed copy accepted when Zoom gives no length");
  assert.equal((await checkVimeoTransfer({ vimeoApi: video({ status: "transcoding", transcode: { status: "in_progress" } }), transfer: { ...transfer, zoom_duration_seconds: null } })).verified, false);
  assert.equal(vimeoDurationMatches(82000, 82100), true);
  assert.equal(vimeoPlayerUrl({ uri: "/videos/5" }), "https://player.vimeo.com/video/5");
});

test("transfer states and attaching a verified copy keep the Zoom link for reference", () => {
  assert.equal(transferState({}), "not_started");
  assert.equal(transferState({ vimeo_video_id: "1" }), "transferring");
  assert.equal(transferState({ vimeo_video_id: "1", error: "x" }), "failed");
  assert.equal(transferState({ vimeo_video_id: "1", verified: true }), "verified");
  assert.equal(transferState({ vimeo_video_id: "1", verified: true, zoom_trashed_at: "t" }), "zoom_trashed");

  const db = {
    recordings: { k1: { id: "k1", session_id: "s1", recording_url: "https://zoom.us/rec/play/1", published: true } },
    liveSessions: { s1: { id: "s1", recording_url: "https://zoom.us/rec/play/1" } },
    notes: { s1: { session_id: "s1", recording_url: "https://zoom.us/rec/play/1" } },
  };
  const transfer = { vimeo_video_id: "9", vimeo_link: "https://vimeo.com/9/h", vimeo_player_url: "https://player.vimeo.com/video/9?h=h" };
  assert.equal(attachVimeoToRecording(db, "k1", transfer, "now"), true);
  assert.equal(db.recordings.k1.zoom_recording_url, "https://zoom.us/rec/play/1");
  assert.equal(db.recordings.k1.vimeo_player_url, "https://player.vimeo.com/video/9?h=h");
  assert.equal(db.recordings.k1.playback_provider, "vimeo");
  assert.equal(db.recordings.k1.published, true);
  assert.equal(db.liveSessions.s1.recording_url, "https://vimeo.com/9/h");
  assert.equal(db.notes.s1.recording_url, "https://vimeo.com/9/h");
  assert.equal(attachVimeoToRecording(db, "missing", transfer), false);
});

test("an admin may accept a complete copy of a paused recording, but not an empty or oversized one", async () => {
  const { reviewedCopyAcceptable } = await import("../lib/lms-recording-vimeo-transfer.js");
  const done = { vimeo_status: "available", vimeo_transcode_status: "complete", error: null };
  assert.equal(reviewedCopyAcceptable({ ...done, vimeo_duration_seconds: 3000 }, { zoom_duration_seconds: 3720 }), true, "12 minutes of pauses");
  assert.equal(reviewedCopyAcceptable({ ...done, vimeo_duration_seconds: 5 }, { zoom_duration_seconds: 4600 }), false, "near-empty file");
  assert.equal(reviewedCopyAcceptable({ ...done, vimeo_duration_seconds: 1500 }, { zoom_duration_seconds: 3720 }), false, "less than half");
  assert.equal(reviewedCopyAcceptable({ ...done, vimeo_duration_seconds: 4000 }, { zoom_duration_seconds: 3720 }), false, "longer than Zoom");
  assert.equal(reviewedCopyAcceptable({ vimeo_status: "transcoding", vimeo_transcode_status: "in_progress", vimeo_duration_seconds: 3000 }, { zoom_duration_seconds: 3720 }), false, "still processing");
});

test("only unpublished short fragments or empty recordings can skip the Vimeo copy", async () => {
  const { zoomFragmentReason } = await import("../lib/lms-recording-vimeo-transfer.js");
  const file = (minutes) => ({ recording_start: "2026-07-14T16:56:00Z", recording_end: new Date(Date.parse("2026-07-14T16:56:00Z") + minutes * 60000).toISOString() });
  assert.equal(zoomFragmentReason({ videoFile: file(22) }), "short_fragment");
  assert.equal(zoomFragmentReason({ videoFile: null }), "no_video_file");
  assert.equal(zoomFragmentReason({ videoFile: file(60) }), "", "a full-length class is never a fragment");
  assert.equal(zoomFragmentReason({ videoFile: file(22), recording: { published: true } }), "", "published recordings are never fragments");
  assert.equal(zoomFragmentReason({ videoFile: file(55), recording: { published: true }, transfer: { vimeo_status: "available", vimeo_duration_seconds: 2 } }), "empty_recording");
});

test("speech bounds come from the first and last WebVTT cues", async () => {
  const { vttSpeechBounds } = await import("../lib/lms-recording-vimeo-transfer.js");
  const vtt = "WEBVTT\n\n1\n00:00:05.200 --> 00:00:09.000\nHello\n\n2\n01:12:30.000 --> 01:12:41.400\nSee you tomorrow\n";
  assert.deepEqual(vttSpeechBounds(vtt), { cues: 2, first_cue_start_seconds: 5, last_cue_end_seconds: 4362 });
  assert.equal(vttSpeechBounds("").last_cue_end_seconds, null);
});

test("automatic transfers pick only recent published recordings without a Vimeo copy", async () => {
  const { selectAutoTransferCandidates } = await import("../lib/lms-recording-vimeo-transfer.js");
  const now = Date.parse("2026-09-30T00:00:00Z");
  const base = { published: true, course_id: "c1", uuid: "u", start_time: "2026-09-29T16:00:00Z" };
  const db = {
    recordings: {
      fresh: { ...base, uuid: "u-fresh" },
      older: { ...base, uuid: "u-older", start_time: "2026-09-28T16:00:00Z" },
      unpublished: { ...base, published: false },
      hidden: { ...base, hidden_from_recordings: true },
      alreadyVimeo: { ...base, vimeo_player_url: "https://player.vimeo.com/video/1" },
      transferring: { ...base },
      tooOld: { ...base, start_time: "2026-08-01T16:00:00Z" },
      noCourse: { ...base, course_id: "" },
    },
    recordingVimeoTransfers: { transferring: { vimeo_video_id: "2" } },
  };
  assert.deepEqual(selectAutoTransferCandidates(db, { now }), [
    { recording_key: "older", uuid: "u-older" },
    { recording_key: "fresh", uuid: "u-fresh" },
  ]);
  assert.equal(selectAutoTransferCandidates(db, { now, limit: 1 }).length, 1);
});

test("automatic Zoom cleanup waits for a verified copy, a saved transcript and the safety delay", async () => {
  const { selectAutoZoomTrashCandidates } = await import("../lib/lms-recording-vimeo-transfer.js");
  const now = Date.parse("2026-10-10T00:00:00Z");
  const transfer = { verified: true, uuid: "u", start_time: "2026-09-29T16:00:00Z" };
  const db = {
    recordings: { ok: { transcript_imported: true }, noTranscript: {}, recent: { transcript_imported: true }, unverified: { transcript_imported: true }, trashed: { transcript_imported: true } },
    recordingVimeoTransfers: {
      ok: { ...transfer, uuid: "u-ok" },
      noTranscript: { ...transfer },
      recent: { ...transfer, start_time: "2026-10-08T16:00:00Z" },
      unverified: { ...transfer, verified: false },
      trashed: { ...transfer, zoom_trashed_at: "t" },
    },
  };
  assert.deepEqual(selectAutoZoomTrashCandidates(db, { now }), [{ recording_key: "ok", uuid: "u-ok" }]);
});
