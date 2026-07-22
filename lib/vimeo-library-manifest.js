import axios from "axios";

const SYSTEM_RULES = Object.freeze([
  ["Cardiology", /\b(cardio(?:logy)?|cardiovascular|heart|arrhythm|ecg|ekg)\b/i],
  ["Renal", /\b(renal|kidney|nephro|glomerul)\b/i],
  ["Respiratory", /\b(respiratory|pulmonary|lung|airway|asthma|copd)\b/i],
  ["Gastrointestinal", /\b(gastro(?:intestinal)?|gi|liver|hepatic|hepatology|bowel|pancrea)\b/i],
  ["Neurology", /\b(neuro(?:logy)?|brain|cns|stroke|seizure|neuromuscular)\b/i],
  ["Endocrine", /\b(endocrine|diabetes|thyroid|adrenal|pituitary)\b/i],
  ["Reproductive", /\b(reproductive|obgyn|ob\/gyn|obstetric|gyne|pregnan|uter|ovari|testicular)\b/i],
  ["Hematology", /\b(hematology|haematology|anemia|anaemia|coagulation|leukemia|lymphoma)\b/i],
  ["Immunology", /\b(immunology|immune|allergy|hypersensitiv|autoimmune)\b/i],
  ["Musculoskeletal", /\b(musculoskeletal|orthopedic|orthopaedic|rheumat|bone|joint|muscle)\b/i],
  ["Behavioral Science", /\b(behavioral|behavioural|psychiatr|psychology|ethics|biostat|epidemiology)\b/i],
]);

function clean(value, maximum = 1000) { return String(value || "").replace(/\u0000/g, "").trim().slice(0, maximum); }

function aylaExamTrack(value) {
  const key = clean(value, 80).toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (key.includes("step1")) return "usmle_step_1";
  if (key.includes("step2")) return "usmle_step_2_ck";
  if (key.includes("step3")) return "usmle_step_3";
  if (key.includes("nclex")) return "nclex";
  if (key.includes("mcc")) return "mccqe";
  if (key.includes("plab")) return "plab";
  if (key === "amc" || key.includes("australia")) return "amc";
  return "";
}

function metadata(video = {}) {
  const output = {};
  const tags = (Array.isArray(video.tags) ? video.tags : []).map((tag) => clean(tag?.tag || tag?.name || tag, 180)).filter(Boolean);
  const text = [clean(video.name, 500), clean(video.description, 5000), ...tags].join("\n");
  for (const key of ["exam", "system", "topic", "subtopic", "playlist"]) {
    const pattern = new RegExp(`(?:^|[\\n\\s\\[])${key}\\s*[:=]\\s*([^\\]\\n;|]+)`, "i");
    const match = text.match(pattern);
    if (match?.[1]) output[key] = clean(match[1], 180);
    const tag = tags.find((value) => value.toLowerCase().startsWith(`${key}:`));
    if (tag) output[key] = clean(tag.slice(tag.indexOf(":") + 1), 180);
  }
  return { ...output, tags, text };
}

function inferSystem(value) {
  return SYSTEM_RULES.find(([, pattern]) => pattern.test(value))?.[0] || "";
}

function vimeoId(video = {}) {
  return clean(video.uri, 120).match(/\/videos\/(\d+)/)?.[1]
    || clean(video.link, 500).match(/vimeo\.com\/(?:video\/)?(\d+)/i)?.[1]
    || "";
}

function privacyHash(video = {}) {
  const candidates = [video.player_embed_url, video.link];
  for (const candidate of candidates) {
    try {
      const url = new URL(clean(candidate, 1000));
      const query = clean(url.searchParams.get("h"), 120);
      if (query) return query;
      const match = url.pathname.match(/\/\d+\/([a-z0-9_-]+)/i);
      if (match?.[1]) return match[1];
    } catch { /* Ignore malformed provider URLs. */ }
  }
  return "";
}

export function buildVimeoLibraryManifest(videos = [], { examTrack = "", defaultPlaylist = "" } = {}) {
  return videos.map((video) => {
    const id = vimeoId(video);
    const data = metadata(video);
    const titleParts = clean(video.name, 500).split("|").map((part) => part.trim()).filter(Boolean);
    const explicitExam = aylaExamTrack(data.exam);
    const resolvedExam = explicitExam || aylaExamTrack(examTrack);
    const explicitSystem = clean(data.system, 100);
    const resolvedSystem = explicitSystem || inferSystem(`${data.text}\n${titleParts.join(" ")}`);
    const topic = clean(data.topic || (titleParts.length >= 2 ? titleParts[titleParts.length - 2] : "") || video.name, 180);
    const playlist = clean(data.playlist || defaultPlaylist || resolvedSystem, 180);
    const missing = [];
    if (!id) missing.push("vimeo_id");
    if (!resolvedExam) missing.push("exam_track");
    if (!resolvedSystem) missing.push("system");
    if (!topic) missing.push("topic");
    const hash = privacyHash(video);
    return {
      ready: missing.length === 0,
      missing,
      confidence: data.system ? "explicit_metadata" : resolvedSystem ? "controlled_title_or_tag_inference" : "unmapped",
      resource: {
        id: id ? `vimeo-library-${id}` : undefined,
        type: "vimeo_video",
        title: clean(video.name, 240) || "Vimeo lecture",
        description: clean(video.description, 2000),
        provider: "Vimeo",
        examTrackId: resolvedExam,
        system: resolvedSystem || "General",
        topic: topic || "Unmapped Vimeo lecture",
        subtopics: data.subtopic ? [data.subtopic] : [],
        playlistKey: playlist.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""),
        playlistTitle: playlist,
        vimeoId: id,
        vimeoUrl: clean(video.link, 1000),
        vimeoPrivacyHash: hash,
        vimeoEmbedUrl: id ? `https://player.vimeo.com/video/${id}${hash ? `?h=${encodeURIComponent(hash)}` : ""}` : "",
        durationSeconds: Math.max(0, Number(video.duration || 0)),
        estimatedMinutes: Math.max(1, Math.ceil(Number(video.duration || 0) / 60) || 20),
        authorizationStatus: "owned",
        sourceAccessMode: "protected",
        verificationStatus: "vimeo_account_sync",
        mappingStatus: data.system ? "vimeo_metadata_exact" : resolvedSystem ? "vimeo_controlled_inference" : "pending_metadata",
        approved: missing.length === 0,
        status: missing.length === 0 ? "active" : "quarantined",
        deliveryDestinations: ["aylamed_content_hub", "aylamed_roadmap"],
        sourceData: { vimeo_uri: clean(video.uri, 160), tags: data.tags, created_time: video.created_time || null, modified_time: video.modified_time || null },
      },
    };
  });
}

export async function fetchVimeoLibrary({ token = process.env.VIMEO_ACCESS_TOKEN || process.env.VIMEO_TOKEN, maximum = 5000 } = {}) {
  const accessToken = clean(token, 1000);
  if (!accessToken) throw Object.assign(new Error("Vimeo access token is not configured"), { statusCode: 503 });
  const api = axios.create({
    baseURL: "https://api.vimeo.com",
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/vnd.vimeo.*+json;version=3.4" },
  });
  const videos = [];
  let page = 1;
  while (videos.length < maximum) {
    const response = await api.get("/me/videos", { params: {
      page, per_page: 100, sort: "date", direction: "desc",
      fields: "uri,name,description,duration,link,player_embed_url,privacy,tags,created_time,modified_time",
    } });
    videos.push(...(Array.isArray(response.data?.data) ? response.data.data : []));
    if (!response.data?.paging?.next) break;
    page += 1;
  }
  return videos.slice(0, maximum);
}
