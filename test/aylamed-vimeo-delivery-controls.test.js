import test from "node:test";
import assert from "node:assert/strict";
import {
  applyAylaVimeoPermanentRemoval,
  aylaVimeoAllowedFor,
  normalizeAylaVimeoDeliveryControl,
  previewAylaVimeoPermanentRemoval,
  resolveAylaVimeoDelivery,
  summarizeAylaVimeoDeliveryControls,
} from "../lib/aylamed-vimeo-delivery-controls.js";

const video = {
  id: "vimeo-library-123456",
  type: "vimeo_video",
  examTrackId: "usmle_step_1",
  vimeoId: "123456",
  catalogSourceId: "AYLA-VIMEO-SOURCE-usmle-step-1-29973623",
  sourceNamespace: "vimeo_folder:29973623",
  sourceData: { folder_id: "29973623" },
};

test("Vimeo delivery defaults to both student destinations", () => {
  assert.deepEqual(resolveAylaVimeoDelivery(video, []), {
    content_hub_enabled: true,
    roadmap_enabled: true,
    content_hub_source: { control_id: null, scope: "default", target: null },
    roadmap_source: { control_id: null, scope: "default", target: null },
    mode: "active",
  });
});

test("Content Hub can be hidden while exact-day Roadmap playback remains available", () => {
  const control = normalizeAylaVimeoDeliveryControl({
    scope: "folder",
    folder_id: "29973623",
    content_hub_enabled: false,
    roadmap_enabled: true,
  });
  const resolved = resolveAylaVimeoDelivery(video, [control]);
  assert.equal(resolved.mode, "hidden_from_content_hub");
  assert.equal(aylaVimeoAllowedFor(video, [control], "content_hub"), false);
  assert.equal(aylaVimeoAllowedFor(video, [control], "roadmap"), true);
  assert.equal(aylaVimeoAllowedFor(video, [control], "notes"), true);
});

test("single-video controls override folder and type controls independently", () => {
  const controls = [
    normalizeAylaVimeoDeliveryControl({
      scope: "type",
      exam_track: "usmle_step_1",
      content_hub_enabled: false,
      roadmap_enabled: false,
    }),
    normalizeAylaVimeoDeliveryControl({
      scope: "folder",
      target: "AYLA-VIMEO-SOURCE-usmle-step-1-29973623",
      content_hub_enabled: true,
      roadmap_enabled: null,
    }),
    normalizeAylaVimeoDeliveryControl({
      scope: "video",
      video_id: "123456",
      content_hub_enabled: null,
      roadmap_enabled: true,
    }),
  ];
  const resolved = resolveAylaVimeoDelivery(video, controls);
  assert.equal(resolved.content_hub_enabled, true);
  assert.equal(resolved.content_hub_source.scope, "folder");
  assert.equal(resolved.roadmap_enabled, true);
  assert.equal(resolved.roadmap_source.scope, "video");
});

test("null destination values inherit from a broader control", () => {
  const controls = [
    normalizeAylaVimeoDeliveryControl({
      scope: "type",
      exam_track: "usmle_step_1",
      content_hub_enabled: false,
      roadmap_enabled: true,
    }),
    normalizeAylaVimeoDeliveryControl({
      scope: "video",
      video_id: "123456",
      content_hub_enabled: null,
      roadmap_enabled: false,
    }),
  ];
  const resolved = resolveAylaVimeoDelivery(video, controls);
  assert.equal(resolved.content_hub_enabled, false);
  assert.equal(resolved.content_hub_source.scope, "type");
  assert.equal(resolved.roadmap_enabled, false);
  assert.equal(resolved.roadmap_source.scope, "video");
  assert.equal(resolved.mode, "disabled_everywhere");
});

test("controls are exam-scoped and summarize admin impact", () => {
  const stepOne = normalizeAylaVimeoDeliveryControl({
    scope: "type",
    exam_track: "usmle_step_1",
    content_hub_enabled: false,
    roadmap_enabled: true,
  });
  const amc = normalizeAylaVimeoDeliveryControl({
    scope: "type",
    exam_track: "amc",
    content_hub_enabled: false,
    roadmap_enabled: false,
  });
  assert.equal(resolveAylaVimeoDelivery(video, [amc]).mode, "active");
  assert.deepEqual(summarizeAylaVimeoDeliveryControls([stepOne, amc]), {
    total: 2,
    by_scope: { type: 2 },
    content_hub_off: 2,
    roadmap_off: 1,
  });
});

test("invalid or unsafe delivery control scopes fail closed", () => {
  assert.throws(
    () => normalizeAylaVimeoDeliveryControl({ scope: "all_data", target: "*" }),
    /scope must be type, folder, or video/,
  );
  assert.throws(
    () => normalizeAylaVimeoDeliveryControl({ scope: "video" }),
    /video_id is required/,
  );
});

test("permanent removal previews and removes only the exact AylaMed video footprint", () => {
  const db = {
    aylaResources: {
      video: { ...video },
      other: { id: "reading-1", type: "reading" },
    },
    aylaVimeoCatalogDrafts: {
      draft: {
        id: "draft-1",
        vimeoId: "123456",
        approvedResourceId: "vimeo-library-123456",
        folderId: "29973623",
      },
    },
    aylaVimeoDeliveryControls: {
      control: normalizeAylaVimeoDeliveryControl({
        scope: "video",
        video_id: "123456",
        content_hub_enabled: false,
      }),
    },
    aylaVideoProgress: {
      matching: { id: "progress-1", resourceId: "vimeo-library-123456" },
      other: { id: "progress-2", resourceId: "other-video" },
    },
    aylaResourceAssignments: {
      mixed: {
        id: "assignment-1",
        resourceIds: ["vimeo-library-123456", "other-video"],
        items: [{ resourceId: "vimeo-library-123456" }, { resourceId: "other-video" }],
      },
    },
    aylaNotebooks: {
      note: {
        id: "note-1",
        blocks: [
          { id: "block-1", source: { kind: "content_video", resourceId: "vimeo-library-123456" } },
          { id: "block-2", type: "text", text: "Keep me" },
        ],
      },
    },
    aylaNotebookVersions: {
      version: {
        id: "version-1",
        blocks: [{ id: "block-1", source: { providerVideoId: "123456" } }],
      },
    },
    aylaDailyPlans: {},
  };
  const preview = previewAylaVimeoPermanentRemoval(db, "123456");
  assert.equal(preview.active_resources, 1);
  assert.equal(preview.catalog_drafts, 1);
  assert.equal(preview.notebook_blocks, 1);
  assert.equal(preview.vimeo_asset_deleted, false);

  const result = applyAylaVimeoPermanentRemoval(db, "123456");
  assert.equal(result.removed.active_resources, 1);
  assert.equal(result.removed.catalog_drafts, 1);
  assert.equal(result.removed.video_progress_rows, 1);
  assert.deepEqual(db.aylaResourceAssignments.mixed.resourceIds, ["other-video"]);
  assert.deepEqual(db.aylaNotebooks.note.blocks.map((block) => block.id), ["block-2"]);
  assert.equal(db.aylaResources.other.id, "reading-1");
  assert.equal(db.aylaVideoProgress.other.id, "progress-2");
});
