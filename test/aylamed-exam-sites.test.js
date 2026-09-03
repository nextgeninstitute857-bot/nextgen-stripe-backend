import assert from "node:assert/strict";
import test from "node:test";
import {
  AYLA_EXAM_SITES,
  AYLA_EXAM_SITE_BRANDING,
  AYLA_EXAM_WEBSITES,
  aylaConfiguredExamOrigins,
  aylaExamLoginUrl,
  aylaExamSiteRequestTrack,
  listAylaExamSites,
  listAylaExamWebsites,
  resolveAylaExamSite,
} from "../lib/aylamed-exam-sites.js";

test("access email login URLs follow the student's assigned exam website", () => {
  assert.equal(aylaExamLoginUrl("mccqe", {}), "https://mccqe.aylamedapp.com/login");
  assert.equal(aylaExamLoginUrl("usmle_step_1", {}), "https://aylamedapp.com/login");
  assert.equal(
    aylaExamLoginUrl("mccqe", { AYLA_MCCQE_PUBLIC_URL: "https://mccqe.example.com/" }),
    "https://mccqe.example.com/login",
  );
});

const env = {
  AYLA_USMLE_PUBLIC_URL: "https://usmle.example.test",
  AYLA_AMC_PUBLIC_URL: "https://amc.example.test/",
  AYLA_MCCQE_PUBLIC_URL: "https://mccqe.example.test",
  AYLA_NCLEX_PUBLIC_URL: "https://nclex.example.test",
  AYLA_PLAB_PUBLIC_URL: "https://www.plab.example.test",
};

test("every supported exam has a distinct state namespace while USMLE Steps share one website", () => {
  const sites = Object.values(AYLA_EXAM_SITES);
  assert.deepEqual(sites.map((site) => site.exam_track_id), [
    "usmle_step_1",
    "usmle_step_2_ck",
    "usmle_step_3",
    "plab",
    "amc",
    "mccqe",
    "nclex",
  ]);
  for (const namespaceKey of ["content", "progress", "entitlement", "assessment", "analytics"]) {
    assert.equal(new Set(sites.map((site) => site.namespaces[namespaceKey])).size, sites.length);
  }
  assert.equal(sites.every((site) => site.route_base === `/app/exams/${site.exam_track_id}`), true);
  assert.equal(AYLA_EXAM_WEBSITES.usmle.exam_track_ids.length, 3);
  assert.equal(AYLA_EXAM_SITES.usmle_step_1.site_id, "usmle");
  assert.equal(AYLA_EXAM_SITES.usmle_step_2_ck.site_id, "usmle");
  assert.equal(AYLA_EXAM_SITES.usmle_step_3.site_id, "usmle");
  assert.equal(new Set([
    AYLA_EXAM_SITES.usmle_step_1.domain_env,
    AYLA_EXAM_SITES.usmle_step_2_ck.domain_env,
    AYLA_EXAM_SITES.usmle_step_3.domain_env,
  ]).size, 1);
});

test("USMLE shares one website while launch-ready non-USMLE domains bind to one exam", () => {
  const usmle = resolveAylaExamSite("https://usmle.example.test/login", env);
  assert.equal(usmle.mode, "shared_exam_family");
  assert.equal(usmle.exam_track_id, null);
  assert.deepEqual(usmle.allowed_exam_track_ids, [
    "usmle_step_1",
    "usmle_step_2_ck",
    "usmle_step_3",
  ]);
  assert.equal(resolveAylaExamSite("https://amc.example.test/login", env).exam_track_id, "amc");
  assert.equal(resolveAylaExamSite("www.plab.example.test", env).exam_track_id, "plab");
  assert.deepEqual(aylaConfiguredExamOrigins(env), [
    "https://usmle.example.test",
    "https://www.plab.example.test",
    "https://amc.example.test",
    "https://mccqe.example.test",
    "https://nclex.example.test",
  ]);
  assert.equal(listAylaExamWebsites(env).length, 5);
});

test("each website exposes exam-specific landing and tablet terminology", () => {
  assert.match(AYLA_EXAM_SITE_BRANDING.amc.headline, /AMC/);
  assert.equal(AYLA_EXAM_SITE_BRANDING.amc.tabs.qbank, "AMC QBank");
  assert.equal(AYLA_EXAM_SITE_BRANDING.mccqe.tabs.diagnostic, "MCCQE Readiness");
  assert.equal(AYLA_EXAM_SITE_BRANDING.nclex.tabs.diagnostic, "Clinical Judgment Diagnostic");
  assert.equal(AYLA_EXAM_SITE_BRANDING.plab.tabs.roadmap, "PLAB Roadmap");
  assert.deepEqual(AYLA_EXAM_SITE_BRANDING.usmle.exam_labels, [
    "USMLE Step 1", "USMLE Step 2 CK", "USMLE Step 3",
  ]);
  assert.equal(listAylaExamWebsites(env).every((site) => site.launch_state === "ready_for_domain_and_publication"), true);
});

test("the shared USMLE website accepts Steps 1, 2 CK and 3 but rejects other exams", () => {
  const usmle = resolveAylaExamSite("usmle.example.test", env);
  assert.equal(aylaExamSiteRequestTrack(usmle, "USMLE Step 1"), "usmle_step_1");
  assert.equal(aylaExamSiteRequestTrack(usmle, "USMLE Step 2 CK"), "usmle_step_2_ck");
  assert.equal(aylaExamSiteRequestTrack(usmle, "USMLE Step 3"), "usmle_step_3");
  assert.equal(aylaExamSiteRequestTrack(usmle), null);
  assert.throws(
    () => aylaExamSiteRequestTrack(usmle, "AMC"),
    (error) => error.code === "EXAM_DOMAIN_SCOPE_MISMATCH" && error.statusCode === 403,
  );
});

test("an exam domain forces its own track and rejects cross-exam requests", () => {
  const amc = resolveAylaExamSite("amc.example.test", env);
  assert.equal(aylaExamSiteRequestTrack(amc), "amc");
  assert.equal(aylaExamSiteRequestTrack(amc, "AMC"), "amc");
  assert.throws(
    () => aylaExamSiteRequestTrack(amc, "PLAB"),
    (error) => error.code === "EXAM_DOMAIN_SCOPE_MISMATCH" && error.statusCode === 403,
  );
});

test("PLAB, AMC, MCCQE and NCLEX carry their own current blueprint identities", () => {
  assert.equal(AYLA_EXAM_SITES.plab.blueprint.id, "gmc_mla_content_map");
  assert.equal(AYLA_EXAM_SITES.amc.blueprint.id, "amc_cat_mcq_examination_specifications");
  assert.equal(AYLA_EXAM_SITES.mccqe.blueprint.axes.includes("physician_activity"), true);
  assert.equal(AYLA_EXAM_SITES.nclex.blueprint.version, "2026-04_to_2029-03");
  assert.equal(listAylaExamSites(env).find((site) => site.exam_track_id === "usmle_step_3").domain_status, "configured");
});

test("canonical AylaMed production subdomains resolve without optional environment settings", () => {
  assert.equal(resolveAylaExamSite("https://aylamedapp.com", {}).site_id, "usmle");
  assert.equal(resolveAylaExamSite("https://mccqe.aylamedapp.com", {}).exam_track_id, "mccqe");
  assert.equal(resolveAylaExamSite("https://amc.aylamedapp.com", {}).exam_track_id, "amc");
  assert.equal(resolveAylaExamSite("https://nclex.aylamedapp.com", {}).exam_track_id, "nclex");
  assert.equal(resolveAylaExamSite("https://plab.aylamedapp.com", {}).exam_track_id, "plab");
  assert.deepEqual(aylaConfiguredExamOrigins({}), [
    "https://aylamedapp.com",
    "https://plab.aylamedapp.com",
    "https://amc.aylamedapp.com",
    "https://mccqe.aylamedapp.com",
    "https://nclex.aylamedapp.com",
  ]);
});
