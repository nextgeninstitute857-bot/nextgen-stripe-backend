// NextGen USMLE Hub (hub.nextgenusmle.live) published content: the study plan
// and announcements every Hub visitor sees. The Hub admin panel has no sign-in,
// so publishing is guarded by a shared publish key (HUB_PUBLISH_KEY) and every
// field is re-validated here before it is stored.
import crypto from "node:crypto";

export const HUB_CONTENT_LIMITS = Object.freeze({
  maxBytes: 2_000_000,
  systems: 60,
  daysPerSystem: 200,
  topicsPerDay: 60,
  qidsPerTopic: 200,
  announcements: 50,
  history: 5,
});

const str = (value, max) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

function list(value, max) {
  return Array.isArray(value) ? value.slice(0, max) : [];
}

function cleanQids(value) {
  const seen = new Set();
  const out = [];
  for (const item of list(value, HUB_CONTENT_LIMITS.qidsPerTopic * 2)) {
    const qid = String(item ?? "").trim();
    if (/^\d{1,9}$/.test(qid) && !seen.has(qid)) {
      seen.add(qid);
      out.push(qid);
    }
    if (out.length >= HUB_CONTENT_LIMITS.qidsPerTopic) break;
  }
  return out;
}

function cleanTopic(t = {}, i) {
  return {
    id: str(t.id, 120) || `t${i + 1}`,
    topic: str(t.topic, 200) || "Topic",
    chapter: str(t.chapter, 120),
    subjects: list(t.subjects, 12).map((s) => str(s, 60)).filter(Boolean),
    qids: cleanQids(t.qids),
    difficulty: ["easy", "medium", "hard"].includes(t.difficulty) ? t.difficulty : "",
  };
}

function cleanDay(d = {}, i, systemName) {
  return {
    id: str(d.id, 120) || `${systemName}-d${i + 1}`,
    system: systemName,
    systemDay: i + 1,
    title: str(d.title, 200) || `${systemName} Day ${i + 1}`,
    subtitle: str(d.subtitle, 300),
    firstAidPages: str(d.firstAidPages, 40),
    lecture: str(d.lecture, 200),
    lectureIds: list(d.lectureIds, 5).map((id) => String(id ?? "").trim()).filter((id) => /^\d{5,12}$/.test(id)),
    assessment: d.assessment === true,
    topics: list(d.topics, HUB_CONTENT_LIMITS.topicsPerDay).map(cleanTopic),
  };
}

export function validateHubBundle(input) {
  if (!input || typeof input !== "object") throw Object.assign(new Error("Content must be a JSON object"), { statusCode: 400 });
  const size = Buffer.byteLength(JSON.stringify(input));
  if (size > HUB_CONTENT_LIMITS.maxBytes) throw Object.assign(new Error("Content is larger than 2 MB"), { statusCode: 413 });
  const plan = input.plan;
  if (!plan || !Array.isArray(plan.systems)) throw Object.assign(new Error("Content needs plan.systems"), { statusCode: 400 });
  const systems = list(plan.systems, HUB_CONTENT_LIMITS.systems).map((s = {}) => {
    const name = str(s.name, 80) || "General";
    return { name, days: list(s.days, HUB_CONTENT_LIMITS.daysPerSystem).map((d, i) => cleanDay(d, i, name)) };
  });
  const announcements = list(input.announcements, HUB_CONTENT_LIMITS.announcements).map((a = {}, i) => ({
    id: str(a.id, 60) || `a${i + 1}`,
    title: str(a.title, 160),
    text: str(a.text, 1000),
    tone: a.tone === "warn" ? "warn" : "info",
    createdAt: Number.isNaN(Date.parse(a.createdAt)) ? new Date().toISOString() : new Date(a.createdAt).toISOString(),
  })).filter((a) => a.title);
  return {
    version: 1,
    plan: { name: str(plan.name, 160) || "Step 1 Master Map", demo: plan.demo === true, systems },
    announcements,
  };
}

// Constant-time comparison; publishing stays off until a key of 16+ characters is configured.
export function hubPublishKeyMatches(provided, configured) {
  const want = String(configured || "");
  const got = String(provided || "");
  if (want.length < 16 || !got) return false;
  const a = crypto.createHash("sha256").update(got).digest();
  const b = crypto.createHash("sha256").update(want).digest();
  return crypto.timingSafeEqual(a, b);
}

export function applyHubPublish(db, bundle, now = new Date()) {
  const previous = db.hubContent || null;
  const revision = Number(previous?.revision || 0) + 1;
  const next = { ...bundle, revision, publishedAt: now.toISOString() };
  db.hubContentHistory = [previous, ...(Array.isArray(db.hubContentHistory) ? db.hubContentHistory : [])]
    .filter(Boolean)
    .slice(0, HUB_CONTENT_LIMITS.history);
  db.hubContent = next;
  return { revision, publishedAt: next.publishedAt };
}
