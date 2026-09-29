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
