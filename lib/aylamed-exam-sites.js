import {
  normalizeAylaRegistryExamTrack,
  normalizeAylaShellExamTrack,
} from "./aylamed-student-shell.js";

const EXAM_WEBSITE_ROWS = [
  {
    site_id: "usmle",
    label: "USMLE",
    domain_env: "AYLA_USMLE_PUBLIC_URL",
    legacy_domain_envs: ["AYLA_PUBLIC_URL"],
    default_public_url: "https://aylamedapp.com",
    mode: "shared_exam_family",
    exam_track_ids: ["usmle_step_1", "usmle_step_2_ck", "usmle_step_3"],
  },
  {
    site_id: "plab",
    label: "PLAB",
    domain_env: "AYLA_PLAB_PUBLIC_URL",
    default_public_url: "https://plab.aylamedapp.com",
    mode: "standalone_exam",
    exam_track_ids: ["plab"],
  },
  {
    site_id: "amc",
    label: "AMC",
    domain_env: "AYLA_AMC_PUBLIC_URL",
    default_public_url: "https://amc.aylamedapp.com",
    mode: "standalone_exam",
    exam_track_ids: ["amc"],
  },
  {
    site_id: "mccqe",
    label: "MCCQE",
    domain_env: "AYLA_MCCQE_PUBLIC_URL",
    default_public_url: "https://mccqe.aylamedapp.com",
    mode: "standalone_exam",
    exam_track_ids: ["mccqe"],
  },
  {
    site_id: "nclex",
    label: "NCLEX",
    domain_env: "AYLA_NCLEX_PUBLIC_URL",
    default_public_url: "https://nclex.aylamedapp.com",
    mode: "standalone_exam",
    exam_track_ids: ["nclex"],
  },
];

const EXAM_SITE_ROWS = [
  {
    exam_track_id: "usmle_step_1",
    label: "USMLE Step 1",
    site_id: "usmle",
    blueprint: { id: "aylamed_usmle_step_1_curriculum", version: "2026.1", axes: ["organ_system", "discipline"] },
  },
  {
    exam_track_id: "usmle_step_2_ck",
    label: "USMLE Step 2 CK",
    site_id: "usmle",
    blueprint: { id: "aylamed_usmle_step_2_ck_curriculum", version: "2026.1", axes: ["clinical_discipline", "organ_system"] },
  },
  {
    exam_track_id: "usmle_step_3",
    label: "USMLE Step 3",
    site_id: "usmle",
    blueprint: { id: "aylamed_usmle_step_3_curriculum", version: "2026.1", axes: ["clinical_discipline", "physician_task", "ccs_case"] },
  },
  {
    exam_track_id: "plab",
    label: "PLAB",
    site_id: "plab",
    blueprint: { id: "gmc_mla_content_map", version: "2026-09", axes: ["clinical_practice", "professional_knowledge", "capability", "presentation_or_condition"] },
  },
  {
    exam_track_id: "amc",
    label: "AMC",
    site_id: "amc",
    blueprint: { id: "amc_cat_mcq_examination_specifications", version: "2026.1", axes: ["patient_group", "clinical_discipline", "clinical_task"] },
  },
  {
    exam_track_id: "mccqe",
    label: "MCCQE",
    site_id: "mccqe",
    blueprint: { id: "mccqe_part_i_blueprint", version: "2026.1", axes: ["dimension_of_care", "physician_activity", "clinical_discipline"] },
  },
  {
    exam_track_id: "nclex",
    label: "NCLEX",
    site_id: "nclex",
    blueprint: { id: "nclex_rn_test_plan", version: "2026-04_to_2029-03", axes: ["client_need", "clinical_judgment", "integrated_process"] },
  },
];

export const AYLA_EXAM_SITE_BRANDING = Object.freeze({
  usmle: Object.freeze({
    eyebrow: "USMLE preparation",
    headline: "Your USMLE preparation has got a brain.",
    subheadline: "One adaptive AylaMed account for Step 1, Step 2 CK and Step 3.",
    exam_selector_label: "Choose your USMLE exam",
    exam_labels: Object.freeze(["USMLE Step 1", "USMLE Step 2 CK", "USMLE Step 3"]),
    tabs: Object.freeze({ diagnostic: "USMLE Readiness", qbank: "USMLE QBank", roadmap: "USMLE Roadmap", tutor: "Personal Tutor" }),
  }),
  mccqe: Object.freeze({
    eyebrow: "MCCQE preparation",
    headline: "Your MCCQE preparation has got a brain.",
    subheadline: "Canadian clinical decisions, physician activities and dimensions of care—adapted daily.",
    exam_selector_label: "MCCQE",
    exam_labels: Object.freeze(["MCCQE"]),
    tabs: Object.freeze({ diagnostic: "MCCQE Readiness", qbank: "MCCQE QBank", roadmap: "MCCQE Roadmap", tutor: "Personal Tutor" }),
  }),
  amc: Object.freeze({
    eyebrow: "AMC preparation",
    headline: "Your AMC preparation has got a brain.",
    subheadline: "Australian clinical reasoning across patient groups, disciplines and clinical tasks.",
    exam_selector_label: "AMC",
    exam_labels: Object.freeze(["AMC"]),
    tabs: Object.freeze({ diagnostic: "AMC Readiness", qbank: "AMC QBank", roadmap: "AMC Roadmap", tutor: "Personal Tutor" }),
  }),
  nclex: Object.freeze({
    eyebrow: "NCLEX preparation",
    headline: "Your NCLEX preparation has got a brain.",
    subheadline: "Clinical judgment, priority, safety and delegation—adapted to every study day.",
    exam_selector_label: "NCLEX",
    exam_labels: Object.freeze(["NCLEX"]),
    tabs: Object.freeze({ diagnostic: "Clinical Judgment Diagnostic", qbank: "NCLEX QBank", roadmap: "NCLEX Study Plan", tutor: "Personal Tutor" }),
  }),
  plab: Object.freeze({
    eyebrow: "PLAB preparation",
    headline: "Your PLAB preparation has got a brain.",
    subheadline: "UK practice, communication and safe clinical decisions—adapted daily.",
    exam_selector_label: "PLAB",
    exam_labels: Object.freeze(["PLAB"]),
    tabs: Object.freeze({ diagnostic: "PLAB Readiness", qbank: "PLAB QBank", roadmap: "PLAB Roadmap", tutor: "Personal Tutor" }),
  }),
});

function cleanString(value = "", maximum = 500) {
  return String(value || "").replace(/\u0000/g, "").trim().slice(0, maximum);
}

function cleanPublicUrl(value = "") {
  const raw = cleanString(value).replace(/\/$/, "");
  if (!raw) return null;
  try {
    const parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
    if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname) return null;
    return `${parsed.protocol}//${parsed.host}`.replace(/\/$/, "");
  } catch {
    return null;
  }
}

function cleanHostname(value = "") {
  const raw = cleanString(value).split(",")[0].trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
    return parsed.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return raw.toLowerCase().split(":")[0].replace(/^www\./, "");
  }
}

function namespaces(examTrackId) {
  return Object.freeze({
    content: `exam:${examTrackId}:content`,
    progress: `exam:${examTrackId}:progress`,
    entitlement: `exam:${examTrackId}:entitlement`,
    assessment: `exam:${examTrackId}:assessment`,
    analytics: `exam:${examTrackId}:analytics`,
  });
}

export const AYLA_EXAM_WEBSITES = Object.freeze(Object.fromEntries(EXAM_WEBSITE_ROWS.map((row) => [
  row.site_id,
  Object.freeze({
    ...row,
    legacy_domain_envs: Object.freeze([...(row.legacy_domain_envs || [])]),
    exam_track_ids: Object.freeze([...row.exam_track_ids]),
  }),
])));

function websitePublicUrl(website, env = process.env) {
  const configured = env?.[website.domain_env]
    || website.legacy_domain_envs.map((name) => env?.[name]).find(Boolean)
    || website.default_public_url
    || "";
  return cleanPublicUrl(configured);
}

export const AYLA_EXAM_SITES = Object.freeze(Object.fromEntries(EXAM_SITE_ROWS.map((row) => {
  const registryExamTrack = normalizeAylaRegistryExamTrack(row.exam_track_id);
  const website = AYLA_EXAM_WEBSITES[row.site_id];
  return [row.exam_track_id, Object.freeze({
    ...row,
    domain_env: website.domain_env,
    website_mode: website.mode,
    website_exam_track_ids: website.exam_track_ids,
    shared_website: website.exam_track_ids.length > 1,
    registry_exam_track: registryExamTrack,
    route_base: `/app/exams/${row.exam_track_id}`,
    api_scope: `/api/ayla/exams/${row.exam_track_id}`,
    namespaces: namespaces(row.exam_track_id),
    blueprint: Object.freeze({ ...row.blueprint, axes: Object.freeze([...row.blueprint.axes]) }),
  })];
})));

export function listAylaExamSites(env = process.env) {
  return Object.values(AYLA_EXAM_SITES).map((site) => {
    const website = AYLA_EXAM_WEBSITES[site.site_id];
    const publicUrl = websitePublicUrl(website, env);
    return {
      ...site,
      public_url: publicUrl,
      hostname: cleanHostname(publicUrl),
      domain_status: publicUrl ? "configured" : "awaiting_domain",
    };
  });
}

export function aylaExamLoginUrl(examTrackId = "", env = process.env) {
  const normalizedExamTrackId = normalizeAylaShellExamTrack(examTrackId);
  const examSite = listAylaExamSites(env).find((site) => site.exam_track_id === normalizedExamTrackId);
  const fallbackSite = listAylaExamSites(env).find((site) => site.site_id === "usmle");
  const publicUrl = examSite?.public_url || fallbackSite?.public_url || "https://aylamedapp.com";
  return `${publicUrl.replace(/\/$/, "")}/login`;
}

export function listAylaExamWebsites(env = process.env) {
  return Object.values(AYLA_EXAM_WEBSITES).map((website) => {
    const publicUrl = websitePublicUrl(website, env);
    return {
      ...website,
      launch_state: "ready_for_domain_and_publication",
      branding: AYLA_EXAM_SITE_BRANDING[website.site_id],
      public_url: publicUrl,
      hostname: cleanHostname(publicUrl),
      domain_status: publicUrl ? "configured" : "awaiting_domain",
    };
  });
}

export function aylaConfiguredExamOrigins(env = process.env) {
  return [...new Set(listAylaExamWebsites(env).map((site) => site.public_url).filter(Boolean))];
}

export function resolveAylaExamSite(value = "", env = process.env) {
  const hostname = cleanHostname(value);
  const matched = hostname
    ? listAylaExamWebsites(env).find((site) => site.hostname === hostname)
    : null;
  if (matched) {
    const exactExamTrackId = matched.exam_track_ids.length === 1
      ? matched.exam_track_ids[0]
      : null;
    return {
      mode: matched.mode,
      hostname,
      site_id: matched.site_id,
      exam_track_id: exactExamTrackId,
      allowed_exam_track_ids: [...matched.exam_track_ids],
      registry_exam_track: exactExamTrackId
        ? normalizeAylaRegistryExamTrack(exactExamTrackId)
        : null,
      site: matched,
      branding: AYLA_EXAM_SITE_BRANDING[matched.site_id],
    };
  }
  return {
    mode: "multi_exam_platform",
    hostname,
    site_id: null,
    exam_track_id: null,
    allowed_exam_track_ids: [],
    registry_exam_track: null,
    site: null,
    branding: null,
  };
}

export function aylaExamSiteRequestTrack(siteContext = {}, requestedExamTrack = "") {
  const requested = requestedExamTrack
    ? normalizeAylaShellExamTrack(requestedExamTrack)
    : null;
  if (requestedExamTrack && !requested) {
    const error = new Error("A supported AylaMed exam track is required");
    error.statusCode = 400;
    error.code = "INVALID_EXAM_TRACK";
    throw error;
  }
  const bound = normalizeAylaShellExamTrack(siteContext.exam_track_id || "");
  const allowed = new Set((siteContext.allowed_exam_track_ids || [])
    .map(normalizeAylaShellExamTrack)
    .filter(Boolean));
  if ((bound && requested && requested !== bound)
    || (requested && allowed.size && !allowed.has(requested))) {
    const error = new Error("This exam website cannot access another exam system");
    error.statusCode = 403;
    error.code = "EXAM_DOMAIN_SCOPE_MISMATCH";
    error.exam_track_id = bound;
    throw error;
  }
  return bound || requested;
}
