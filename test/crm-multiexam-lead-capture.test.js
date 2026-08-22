import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const server = fs.readFileSync(path.join(here, "..", "server.js"), "utf8");

test("community marketing routing covers all seven launch exams", () => {
  for (const track of [
    "usmle_step1",
    "usmle_step2_ck",
    "usmle_step3",
    "plab",
    "amc",
    "mccqe",
    "nclex",
  ]) {
    assert.match(server, new RegExp(track + ": \\{"));
  }

  assert.match(server, /TELEGRAM_STEP3_CHAT_ID/);
  assert.match(server, /DISCORD_STEP3_WEBHOOK_URL/);
  assert.match(server, /TELEGRAM_PLAB_CHAT_ID/);
  assert.match(server, /DISCORD_PLAB_WEBHOOK_URL/);
  assert.match(server, /usmle_step3_prompt_v1/);
  assert.match(server, /plab_prompt_v1/);
  assert.match(server, /obj\.detected_text/);
  assert.match(server, /obj\.last_message/);
});

test("community opportunities become traceable exam-specific leads", () => {
  const route = server.slice(
    server.indexOf('app.post("/admin/crm/community-intelligence/opportunities/:id/create-lead"'),
    server.indexOf("// -----------------------------------------------------------------------------\n// Community Intelligence Pipeline Patch"),
  );

  assert.match(route, /ngInferExamTrackFromObject/);
  assert.match(route, /source_community_id/);
  assert.match(route, /source_opportunity_id/);
  assert.match(route, /lead_source: \[sourcePlatform, "community"\]\.join\("_"\)/);
  assert.match(route, /follow_up_status: "needs_first_response"/);
  assert.match(route, /next_follow_up_at: req\.body\?\.next_follow_up_at \|\| nowIso\(\)/);
  assert.match(route, /next_action: "review_and_reply"/);
});

test("lead normalization preserves source, exam qualification, and follow-up state", () => {
  const normalization = server.slice(
    server.indexOf('if (collection === "leads")'),
    server.indexOf('if (collection === "communities")'),
  );

  assert.match(normalization, /source_detail/);
  assert.match(normalization, /exam_qualification_status/);
  assert.match(normalization, /needs_qualification/);
  assert.match(normalization, /next_action/);
  assert.match(normalization, /follow_up_status/);
  assert.match(normalization, /next_follow_up_at/);
});
