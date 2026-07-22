import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import axios from "axios";
import { mediaMatchKeys } from "./content-import-adapter.js";
import { openContentZip, openContentZipEntry, openNamedContentZipEntry } from "./content-zip-source.js";

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".webm"]);
const MAX_VIDEO_BYTES = Math.max(1024 ** 2, Number(process.env.NEXTGEN_CONTENT_MAX_VIDEO_BYTES || 5 * 1024 ** 3));
const MAX_ENTRIES = Math.max(100, Number(process.env.NEXTGEN_CONTENT_MAX_MEDIA_ENTRIES || 100000));

function env(name, source = process.env) { return String(source?.[name] || "").trim(); }

export function contentVideoStatus(source = process.env) {
  const token = env("VIMEO_ACCESS_TOKEN", source) || env("VIMEO_TOKEN", source);
  return { configured: Boolean(token), provider: "vimeo", privacy: "unlisted", embedded_playback: true };
}

export function isVideoMediaRef(value) {
  const clean = String(value || "").split(/[?#]/, 1)[0];
  return VIDEO_EXTENSIONS.has(path.extname(clean).toLowerCase());
}

export function safeVideoEntryName(value) {
  const raw = String(value || "").replace(/\\/g, "/");
  if (raw.startsWith("/") || /^[a-z]:\//i.test(raw) || raw.split("/").includes("..") || raw.endsWith("/")) return null;
  return isVideoMediaRef(raw) ? raw : null;
}

export async function extractReferencedVideos({ zipFile, zipSource = zipFile, references = [] }) {
  const keys = new Set(references.flatMap((reference) => mediaMatchKeys(reference.mediaRef)));
  const videos = [];
  const zip = await openContentZip(zipSource);
  let entries = 0;
  await new Promise((resolve, reject) => {
    zip.on("entry", async (entry) => {
      try {
        entries += 1;
        if (entries > MAX_ENTRIES) throw Object.assign(new Error("Video ZIP has too many entries"), { statusCode: 413 });
        const originalName = safeVideoEntryName(entry.fileName);
        if (!originalName || !mediaMatchKeys(originalName).some((key) => keys.has(key))) { zip.readEntry(); return; }
        if ((entry.generalPurposeBitFlag & 0x1) !== 0) throw Object.assign(new Error("Encrypted video ZIP entries are not supported"), { statusCode: 400 });
        const expected = Number(entry.uncompressedSize || 0);
        if (expected > MAX_VIDEO_BYTES) throw Object.assign(new Error(`Video exceeds limit: ${originalName}`), { statusCode: 413 });
        const input = await openContentZipEntry(zip, entry);
        const hash = crypto.createHash("sha256");
        let bytes = 0;
        for await (const chunk of input) {
          bytes += chunk.length;
          if (bytes > MAX_VIDEO_BYTES) throw Object.assign(new Error(`Video exceeds limit: ${originalName}`), { statusCode: 413 });
          hash.update(chunk);
        }
        if (expected && bytes !== expected) throw Object.assign(new Error(`Video size mismatch: ${originalName}`), { statusCode: 400 });
        videos.push({ originalName, entryName: String(entry.fileName), zipSource, sizeBytes: bytes, sha256: hash.digest("hex") });
        zip.readEntry();
      } catch (error) { zip.close(); reject(error); }
    });
    zip.on("end", resolve); zip.on("error", reject); zip.readEntry();
  });
  return { videos, entries };
}

export function openReferencedVideoStream(video) {
  if (video?.localFile) return Promise.resolve(fs.createReadStream(video.localFile));
  return openNamedContentZipEntry(video?.zipSource, video?.entryName || video?.originalName);
}

function exactMediaPath(value) {
  return String(value || "").trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "").toLowerCase();
}

export function matchVideoReferences(references = [], videos = []) {
  const byKey = new Map();
  const byExact = new Map();
  const byPath = new Map();
  for (const video of videos) for (const key of mediaMatchKeys(video.originalName)) {
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(video);
  }
  for (const video of videos) {
    const exact = path.basename(String(video.originalName || "")).toLowerCase();
    if (!byExact.has(exact)) byExact.set(exact, []);
    byExact.get(exact).push(video);
    const fullPath = exactMediaPath(video.originalName);
    if (!byPath.has(fullPath)) byPath.set(fullPath, []);
    byPath.get(fullPath).push(video);
  }
  const matches = [], missing = [], ambiguous = [], used = new Set();
  for (const reference of references) {
    const candidates = new Map();
    const referencePath = exactMediaPath(reference.mediaRef);
    const pathMatches = referencePath.includes("/") ? (byPath.get(referencePath) || []) : [];
    const exact = pathMatches.length ? pathMatches : (byExact.get(path.basename(String(reference.mediaRef || "")).toLowerCase()) || []);
    if (exact.length) exact.forEach((video) => candidates.set(video.sha256, video));
    else for (const key of mediaMatchKeys(reference.mediaRef)) for (const video of byKey.get(key) || []) candidates.set(video.sha256, video);
    if (candidates.size === 1) { const video = [...candidates.values()][0]; used.add(video.sha256); matches.push({ ...reference, video }); }
    else if (!candidates.size) missing.push(reference);
    else ambiguous.push({ ...reference, candidates: [...candidates.values()].map((video) => video.originalName) });
  }
  return { matches, missing, ambiguous, unreferenced: videos.filter((video) => !used.has(video.sha256)) };
}

export async function uploadVideoToVimeo({ file, stream, sizeBytes, name, description = "" }) {
  const token = env("VIMEO_ACCESS_TOKEN") || env("VIMEO_TOKEN");
  if (!token) throw Object.assign(new Error("Vimeo access token is not configured"), { statusCode: 503 });
  const api = axios.create({ baseURL: "https://api.vimeo.com", headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.vimeo.*+json;version=3.4" }, maxBodyLength: Infinity, maxContentLength: Infinity });
  const created = await api.post("/me/videos", {
    upload: { approach: "tus", size: String(sizeBytes) }, name, description,
    privacy: { view: "unlisted", embed: "whitelist", download: false, add: false, comments: "nobody" },
  });
  const uploadLink = created.data?.upload?.upload_link;
  const uri = created.data?.uri;
  if (!uploadLink || !uri) throw new Error("Vimeo did not return an upload link and video URI");
  const body = stream || (file ? fs.createReadStream(file) : null);
  if (!body) throw new Error("A video stream is required for Vimeo upload");
  await axios.patch(uploadLink, body, { headers: {
    "Tus-Resumable": "1.0.0", "Upload-Offset": "0", "Content-Type": "application/offset+octet-stream", "Content-Length": String(sizeBytes),
  }, maxBodyLength: Infinity, maxContentLength: Infinity });
  const id = String(uri).split("/").filter(Boolean).pop();
  return { provider: "vimeo", providerUri: uri, providerId: id, embedUrl: `https://player.vimeo.com/video/${encodeURIComponent(id)}`, status: "transcoding" };
}
