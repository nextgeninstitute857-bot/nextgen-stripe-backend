// Moves LMS class recordings from Zoom cloud storage to Vimeo.
// Vimeo pulls each MP4 straight from Zoom (server to server), so nothing is
// streamed through this backend. A transfer is only "verified" once Vimeo has
// finished transcoding and the Vimeo duration matches the Zoom file duration;
// only verified recordings may be moved to the Zoom trash.

export const LMS_RECORDING_VIMEO_TRANSFER_BUILD = "v1-zoom-pull-to-vimeo";
export const LMS_RECORDING_EMBED_DOMAINS = ["nextgenusmle.live", "www.nextgenusmle.live"];

// Zoom requires a double-encoded meeting UUID when it starts with "/" or contains "//".
export function zoomMeetingUuidPath(uuid = "") {
  const value = String(uuid || "").trim();
  if (!value) return "";
  return value.startsWith("/") || value.includes("//")
    ? encodeURIComponent(encodeURIComponent(value))
    : encodeURIComponent(value);
}

export function zoomFileDurationSeconds(file = {}) {
  const start = Date.parse(file.recording_start || "");
  const end = Date.parse(file.recording_end || "");
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return Math.round((end - start) / 1000);
}

export function zoomDownloadLinkWithToken(downloadUrl = "", accessToken = "") {
  const url = new URL(String(downloadUrl));
  url.searchParams.set("access_token", String(accessToken));
  return url.toString();
}

export function vimeoVideoIdFromUri(uri = "") {
  return String(uri || "").split("/").filter(Boolean).pop() || "";
}

// Embed URL for an in-page player; keeps the privacy hash of unlisted videos.
export function vimeoPlayerUrl(video = {}) {
  const embed = String(video.player_embed_url || "").trim();
  if (embed) return embed;
  const id = vimeoVideoIdFromUri(video.uri);
  if (!id) return "";
  const hash = String(video.link || "").match(/vimeo\.com\/\d+\/([a-z0-9]+)/i)?.[1] || "";
  return `https://player.vimeo.com/video/${id}${hash ? `?h=${hash}` : ""}`;
}

// Vimeo and Zoom durations of the same file may differ by a few seconds.
export function vimeoDurationMatches(vimeoSeconds, zoomSeconds) {
  const vimeo = Number(vimeoSeconds || 0);
  const zoom = Number(zoomSeconds || 0);
  if (!vimeo || !zoom) return false;
  return Math.abs(vimeo - zoom) <= Math.max(60, zoom * 0.02);
}

// Zoom's recording_start/end include paused time that is not in the MP4, so a
// complete copy of a paused class is shorter. An admin may accept such a copy
// after review when Vimeo finished processing and it is at least half as long.
export function reviewedCopyAcceptable(check = {}, transfer = {}) {
  const vimeo = Number(check.vimeo_duration_seconds || 0);
  const zoom = Number(transfer.zoom_duration_seconds || 0);
  return check.vimeo_status === "available" && check.vimeo_transcode_status === "complete" && !check.error &&
    vimeo >= 60 && zoom > 0 && vimeo >= zoom * 0.5 && vimeo <= zoom + 60;
}

// Start/end (seconds) of the spoken part of a WebVTT transcript.
export function vttSpeechBounds(vtt = "") {
  const toSeconds = (value) => {
    const parts = value.split(":").map(Number);
    return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
  };
  const cues = [...String(vtt).matchAll(/(\d{1,2}:\d{2}(?::\d{2})?\.\d{3})\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?\.\d{3})/g)];
  if (!cues.length) return { cues: 0, first_cue_start_seconds: null, last_cue_end_seconds: null };
  return {
    cues: cues.length,
    first_cue_start_seconds: Math.floor(toSeconds(cues[0][1])),
    last_cue_end_seconds: Math.ceil(Math.max(...cues.map((cue) => toSeconds(cue[2])))),
  };
}

export const ZOOM_FRAGMENT_MAX_SECONDS = 25 * 60;

// Why a Zoom recording may be trashed without a verified copy: an unpublished
// test/rejoin fragment, or a file whose Vimeo copy shows it holds under a minute
// of video. Returns "" when it is a real class that must be copied first.
export function zoomFragmentReason({ videoFile = null, recording = {}, transfer = {} } = {}) {
  const vimeoSeconds = Number(transfer.vimeo_duration_seconds || 0);
  if (transfer.vimeo_status === "available" && vimeoSeconds > 0 && vimeoSeconds < 60) return "empty_recording";
  if (recording.published === true) return "";
  if (!videoFile) return "no_video_file";
  const seconds = zoomFileDurationSeconds(videoFile);
  if (seconds !== null && seconds < ZOOM_FRAGMENT_MAX_SECONDS) return "short_fragment";
  return "";
}

export const AUTO_TRANSFER_MAX_AGE_DAYS = 14;
export const RUNAWAY_RECORDING_SECONDS = 3 * 60 * 60;

// Published LMS recordings (from the existing auto-publish flow) that still
// play from Zoom and have no Vimeo transfer yet. Oldest first.
export function selectAutoTransferCandidates(db = {}, { now = Date.now(), maxAgeDays = AUTO_TRANSFER_MAX_AGE_DAYS, limit = 5 } = {}) {
  const transfers = db.recordingVimeoTransfers || {};
  const oldest = now - maxAgeDays * 86400000;
  return Object.entries(db.recordings || {})
    .filter(([key, recording]) => {
      if (!recording || recording.published !== true || recording.hidden_from_recordings === true) return false;
      if (!recording.course_id || !recording.uuid || recording.vimeo_player_url) return false;
      if (transfers[key]) return false;
      const started = Date.parse(recording.start_time || "");
      return Number.isFinite(started) && started >= oldest && started <= now;
    })
    .sort(([, a], [, b]) => String(a.start_time).localeCompare(String(b.start_time)))
    .slice(0, limit)
    .map(([key, recording]) => ({ recording_key: key, uuid: recording.uuid }));
}

// Verified Vimeo copies whose Zoom recording can go to the Zoom trash:
// old enough, transcript saved (or no transcript expected), not yet trashed.
export function selectAutoZoomTrashCandidates(db = {}, { now = Date.now(), minAgeDays = 7, limit = 10 } = {}) {
  const cutoff = now - minAgeDays * 86400000;
  return Object.entries(db.recordingVimeoTransfers || {})
    .filter(([key, transfer]) => {
      if (transfer?.verified !== true || transfer.zoom_trashed_at || !transfer.uuid) return false;
      const recording = db.recordings?.[key] || {};
      if (recording.transcript_imported !== true && recording.transcript_expected !== false) return false;
      const started = Date.parse(transfer.start_time || recording.start_time || "");
      return Number.isFinite(started) && started <= cutoff;
    })
    .slice(0, limit)
    .map(([key, transfer]) => ({ recording_key: key, uuid: transfer.uuid }));
}

export function transferState(transfer = {}) {
  if (transfer.zoom_trashed_at) return "zoom_trashed";
  if (transfer.verified === true) return "verified";
  if (transfer.error) return "failed";
  if (transfer.vimeo_video_id) return "transferring";
  return "not_started";
}

export async function startVimeoPullFromZoom({ vimeoApi, zoomAccessToken, videoFile, name, description = "" }) {
  const size = Number(videoFile?.file_size || 0);
  if (!videoFile?.download_url || !size) {
    throw Object.assign(new Error("Zoom recording has no downloadable MP4 file"), { statusCode: 409 });
  }
  const created = await vimeoApi.post("/me/videos", {
    upload: {
      approach: "pull",
      size: String(size),
      link: zoomDownloadLinkWithToken(videoFile.download_url, zoomAccessToken),
    },
    name,
    description,
    privacy: { view: "unlisted", embed: "whitelist", download: false, add: false, comments: "nobody" },
  });
  const uri = created.data?.uri;
  if (!uri) throw new Error("Vimeo did not return a video URI");
  return {
    vimeo_video_id: vimeoVideoIdFromUri(uri),
    vimeo_uri: uri,
    vimeo_link: created.data?.link || null,
    vimeo_player_url: vimeoPlayerUrl(created.data || {}),
  };
}

// Reads Vimeo's processing state and decides whether the copy is verified.
export async function checkVimeoTransfer({ vimeoApi, transfer }) {
  const response = await vimeoApi.get(`/videos/${transfer.vimeo_video_id}`, {
    params: { fields: "uri,link,player_embed_url,duration,status,upload.status,transcode.status" },
  });
  const video = response.data || {};
  const transcodeStatus = video.transcode?.status || null;
  const uploadStatus = video.upload?.status || null;
  const processed = video.status === "available" && transcodeStatus === "complete";
  // Some Zoom files report no start/end time, so there is no length to compare.
  // Vimeo only finishes processing a pull once it has the whole file, so a
  // fully processed copy of at least a minute is accepted in that case.
  const zoomLengthUnknown = !Number(transfer.zoom_duration_seconds || 0);
  const verified = processed && (zoomLengthUnknown
    ? Number(video.duration || 0) >= 60
    : vimeoDurationMatches(video.duration, transfer.zoom_duration_seconds));
  const failed = ["error", "quota_exceeded", "total_cap_exceeded"].includes(String(video.status || "")) ||
    transcodeStatus === "error" || uploadStatus === "error";
  return {
    vimeo_status: video.status || null,
    vimeo_upload_status: uploadStatus,
    vimeo_transcode_status: transcodeStatus,
    vimeo_duration_seconds: Number(video.duration || 0) || null,
    vimeo_link: video.link || transfer.vimeo_link || null,
    vimeo_player_url: vimeoPlayerUrl(video) || transfer.vimeo_player_url || null,
    verified,
    error: failed ? `Vimeo processing failed (${video.status || transcodeStatus || uploadStatus})` : null,
  };
}

// Points an LMS recording (and its session/notes) at the verified Vimeo copy,
// keeping the original Zoom link for reference.
export function attachVimeoToRecording(db, recordingKey, transfer, now = new Date().toISOString()) {
  const recording = db.recordings?.[recordingKey];
  if (!recording) return false;
  db.recordings[recordingKey] = {
    ...recording,
    zoom_recording_url: recording.zoom_recording_url || recording.recording_url || null,
    vimeo_video_id: transfer.vimeo_video_id,
    vimeo_link: transfer.vimeo_link,
    vimeo_player_url: transfer.vimeo_player_url,
    playback_provider: "vimeo",
    vimeo_verified_at: transfer.verified_at || now,
    updated_at: now,
  };
  const sessionId = String(recording.session_id || "").trim();
  if (sessionId && db.liveSessions?.[sessionId]) {
    db.liveSessions[sessionId] = {
      ...db.liveSessions[sessionId],
      recording_url: transfer.vimeo_link || db.liveSessions[sessionId].recording_url,
      vimeo_player_url: transfer.vimeo_player_url,
      updated_at: now,
    };
  }
  if (sessionId && db.notes?.[sessionId]) {
    db.notes[sessionId] = {
      ...db.notes[sessionId],
      recording_url: transfer.vimeo_link || db.notes[sessionId].recording_url,
      updated_at: now,
    };
  }
  return true;
}
