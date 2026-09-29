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
  const verified = video.status === "available" && transcodeStatus === "complete" &&
    vimeoDurationMatches(video.duration, transfer.zoom_duration_seconds);
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
