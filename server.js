import express from "express";
import {
  flashcardCapabilities,
  flashcardTextOnlyHtml,
  scheduleFlashcardReview,
  validateFlashcardContent,
} from "./lib/flashcard-engine.js";
import { contentDeliveryPolicySnapshot } from "./lib/content-delivery-priority.js";
import {
  flashcardMatchesCurrentSystem,
  flashcardPriorityRank,
} from "./lib/flashcard-queue-policy.js";
import {
  flashcardPostgresStatus,
  shadowWriteFlashcardReview,
} from "./lib/flashcard-postgres.js";
import { planCrmDeliveryLockRetention } from "./lib/crm-delivery-lock-retention.js";
import {
  auditContentMediaLinks,
  auditContentVideoAliasMappings,
  auditContentVideoMappings,
  applyAylaOriginalMcqRepair,
  applyGuardedUworldCleanup,
  contentRegistryStatus,
  claimContentImportDraft,
  createContentBackgroundJobStore,
  createExternalQbankDeliverySession,
  createContentMediaImportJob,
  createContentVideoImportJob,
  createContentImportJob,
  finishContentMediaImportJob,
  finishContentVideoImportJob,
  finishContentImportPreview,
  findContentVideoAssetsByOriginalNames,
  findReusableContentVideos,
  getContentMediaImportJob,
  getContentMediaReferences,
  getContentNbmeCollectionQuestions,
  getContentCdmCase,
  getContentVideoImportJob,
  getContentImportJob,
  getContentGlobalQbankPublicationState,
  getContentQbankCatalog,
  getContentQbankPresentationPolicy,
  getContentQbankQuestions,
  getContentRegistryFlashcardQuestion,
  getContentTaxonomyProviderPairEvidence,
  getContentTaxonomyCoverage,
  getExternalQbankDeliverySession,
  importContentQuestionBatch,
  listContentHubVideos,
  listContentBackgroundJobsByDomainIds,
  listContentOperationalJobs,
  listContentMediaImportAssets,
  listContentMediaImportAssetsForParent,
  listContentNbmeCollections,
  listExternalQbankAuditEvents,
  listExternalQbankDeliverySessions,
  listContentQbankQuestions,
  listContentRegistryFlashcardQuestions,
  listContentCollections,
  listContentCdmCases,
  listContentTaxonomyAuditEvents,
  listContentTaxonomyReviewQueue,
  normalizeContentSourceProfile,
  previewAylaOriginalMcqRepair,
  previewStep1CollectionTaxonomyRepair,
  previewGuardedUworldCleanup,
  removeContentQuestionTaxonomyOverride,
  recordExternalQbankAuditEvent,
  recordExternalQbankDeliveryAnswer,
  resolveContentQbankStudentSourceProfile,
  reviewContentTaxonomyMapping,
  repairStep1CollectionTaxonomy,
  saveContentMediaMatchBatch,
  saveContentVideoAsset,
  saveContentVideoLinksBatch,
  setContentImportJobStatus,
  stageContentMediaImportAssets,
  submitExternalQbankDeliverySession,
  updateContentCollectionControls,
  upsertContentQbankPresentationPolicy,
  upsertContentQuestionTaxonomyOverride,
  upsertContentTaxonomyMapping,
} from "./lib/content-registry-postgres.js";
import {
  CONTENT_TAXONOMY_EXAM_TRACKS,
  normalizeContentTaxonomyExamTrack,
  normalizeContentTaxonomyReviewAction,
  normalizeContentTaxonomyReviewState,
} from "./lib/content-taxonomy-control.js";
import {
  buildContentTaxonomyProviderPairRequest,
  contentTaxonomyClassifierMaxOutputTokens,
  normalizeContentTaxonomyProviderPairClassification,
} from "./lib/content-taxonomy-classifier.js";
import {
  AYLA_QBANK_STATE_COLLECTIONS,
  canRevealAylaQbankAnswer,
  canSubmitAylaQbankRoadmapSession,
  createAylaQbankSession,
  finalizeAylaQbankSession,
  mergeConcurrentAylaQbankCollection,
  normalizeAylaQbankExamTrack,
  normalizeAylaQbankFilters,
  normalizeAylaQbankMode,
  normalizeAylaQbankPurpose,
  qbankSessionHistoryRow,
  qbankSessionQuestion,
  qbankRoadmapAssignmentQuestionIds,
  qbankRoadmapSessionMatchesAssignment,
  recordAylaQbankAnswer,
  requireAylaQbankEntitlement,
  sanitizeAylaQbankQuestion,
  sanitizeAylaQbankSession,
  setAylaQbankQuestionMark,
} from "./lib/aylamed-qbank.js";
import {
  AYLA_DIAGNOSTIC_BLUEPRINT_VERSION,
  applyDiagnosticSystemOverride,
  auditDiagnosticQuestionMedia,
  buildStep1DiagnosticSelection,
  canonicalStep1DiagnosticSystem,
  classifyStep1DiagnosticQuestion,
  diagnosticSessionUsesCurrentBlueprint,
} from "./lib/aylamed-diagnostic.js";
import {
  buildAylaCarryContext,
  buildAylaEngagementMessages,
  buildAylaExamHandoffState,
  createAylaExamHandoff,
  normalizeAylaContinuityExamTrack,
  normalizeAylaEngagementPreferences,
  suggestAylaNextExam,
} from "./lib/aylamed-exam-continuity.js";
import {
  AYLA_CDM_STATE_COLLECTIONS,
  cdmRoadmapAssignmentCaseId,
  cdmRoadmapAssignmentEligible,
  cdmRoadmapSessionMatchesAssignment,
  cdmSessionHistoryRow,
  createAylaCdmSession,
  finalizeAylaCdmSession,
  recordAylaCdmResponse,
  recordAylaCdmSelfReview,
  sanitizeAylaCdmSession,
} from "./lib/aylamed-cdm.js";
import {
  AYLA_ONBOARDING_PRESETS,
  buildAylaStartingReadinessReport,
  buildAylaVerifiedDiagnosticBaseline,
  normalizeAylaOnboardingSubmission,
  reconcileAylaRoadmapOutline,
} from "./lib/aylamed-onboarding.js";
import {
  DEFAULT_AYLA_MARKETING_SETTINGS,
  aylaAttributionWindowOpen,
  aylaCampaignIsActive,
  aylaMarketingAdminOptions,
  aylaMarketingMetrics,
  aylaReferralSelfCheck,
  aylaRewardDefinitionsForMilestone,
  aylaRewardReadyAt,
  aylaRewardReleaseEligible,
  buildAylaPublicReadinessSnapshot,
  buildAylaReadinessShareCopy,
  normalizeAylaAttributionStatus,
  normalizeAylaCampaign,
  normalizeAylaMarketingSettings,
  normalizeAylaReferralCode,
  normalizeAylaRewardStatus,
  publicAylaMarketingSettings,
  renderAylaReadinessCardSvg,
} from "./lib/aylamed-marketing-referrals.js";
import {
  AYLA_STUDENT_FEATURES,
  aylaScopedEnrollmentKey,
  aylaShellEnrollmentActive,
  normalizeAylaRegistryExamTrack,
  normalizeAylaShellExamTrack,
  resolveAylaExamFeatureEntitlement,
  resolveAylaStudentShell,
} from "./lib/aylamed-student-shell.js";
import {
  AYLA_EXAM_SITES,
  aylaConfiguredExamOrigins,
  aylaExamSiteRequestTrack,
  listAylaExamSites,
  listAylaExamWebsites,
  resolveAylaExamSite,
} from "./lib/aylamed-exam-sites.js";
import {
  buildAylaPublicationControlPanel,
  normalizeAylaExamPublicationControl,
  normalizeAylaResourcePublicationControl,
  resolveAylaExamPublication,
} from "./lib/aylamed-exam-publication.js";
import { listAylaExamSupplements } from "./lib/aylamed-exam-supplements.js";
import {
  aylaPilotContentScope,
  aylaPilotContentVisibleToStudent,
} from "./lib/aylamed-pilot-content.js";
import {
  aylaContentHubAssignmentProgress,
  aylaContentHubTaxonomyDefinition,
  aylaContentHubVideoMatchesId,
  buildAylaContentHubCatalog,
  mergeAylaContentHubProgress,
  mergeAylaContentHubProgressCollection,
  normalizeAylaContentHubVideos,
  sanitizeAylaContentHubVideo,
  selectAylaRoadmapVideo,
} from "./lib/aylamed-content-hub.js";
import {
  applyAylaVimeoPermanentRemoval,
  aylaVimeoAllowedFor,
  normalizeAylaVimeoDeliveryControl,
  previewAylaVimeoPermanentRemoval,
  resolveAylaVimeoDelivery,
  summarizeAylaVimeoDeliveryControls,
} from "./lib/aylamed-vimeo-delivery-controls.js";
import { canonicalAylaVimeoSystem } from "./lib/aylamed-vimeo-system-normalization.js";
import {
  aylaLibraryStudentTitle,
  aylaLibraryStudentPageRange,
  aylaLibraryAssignmentProgress,
  aylaLibraryResourceMatchesId,
  buildAylaLibraryCatalog,
  buildAylaLibraryPage,
  buildAylaLibraryReader,
  findAylaLibraryPage,
  hydrateAylaLibraryResourceFromCrm,
  combineAylaLibraryProgressRows,
  mergeAylaLibraryProgress,
  mergeAylaLibraryProgressCollection,
  normalizeAylaLibraryResource,
  normalizeAylaLibraryResources,
  sanitizeAylaHiddenSourceText,
  searchAylaLibraryPages,
  selectAylaRoadmapReading,
} from "./lib/aylamed-library.js";
import {
  aylaNotebookSourceFingerprint,
  aylaNotebookTimestampSeconds,
  createAylaNotebookCaptureBlocks,
  mergeConcurrentAylaNotebookCollection,
  normalizeAylaNotebookSourceKind,
  sanitizeAylaNotebook,
  selectAylaNotebookSourceExcerpt,
} from "./lib/aylamed-dynamic-notebook.js";
import {
  AYLA_PERSONAL_TUTOR_ENGINE,
  buildAylaPersonalTutorDecision,
  formatAylaPersonalTutorAnswer,
  isAylaPersonalTutorPlanningIntent,
  validateAylaPersonalTutorPlanCommand,
} from "./lib/aylamed-personal-tutor.js";
import {
  AYLA_NBME_CENTER_BUILD,
  AYLA_NBME_STEP1_REVIEWED_RELEASE_FORM_IDS,
  assertAylaNbmeExamPlacement,
  assertAylaNbmeReviewedReleaseForm,
  aylaNbmeAttemptQuestion,
  aylaNbmeHistoryRow,
  buildAylaNbmeFormRecord,
  buildAylaNbmeReadinessSnapshot,
  createAylaNbmeAttempt,
  finalizeAylaNbmeAttempt,
  normalizeAylaNbmeExamTrack,
  normalizeAylaNbmeManifest,
  parseAylaNbmeCollectionKey,
  recordAylaNbmeAnswer,
  sanitizeAylaNbmeAttempt,
  validateAylaNbmeStudentEnable,
} from "./lib/aylamed-nbme-center.js";
import {
  aylaAdaptiveEvidenceMatchesStudent,
  aylaAdaptiveSystemsForStudent,
  buildAylaMistakeFlashcard,
  mergeAylaMistakeFlashcard,
} from "./lib/aylamed-adaptive-core.js";
import {
  aylaOriginalOverdueAssignment,
  aylaOverdueTitle,
} from "./lib/aylamed-overdue.js";
import {
  applyAylaPlanFeaturePatch,
  aylaPlanFeatureMatrixRow,
  normalizeAylaPlanFeatures,
  publicAylaPlanFeatureCatalog,
} from "./lib/aylamed-plan-controls.js";
import {
  aylaSuccessStoryMaterialFingerprint,
  normalizeAylaSuccessStoryDraft,
  reviewAylaSuccessStory,
  sanitizeAylaSuccessStoryForAdmin,
  selectAylaSuccessStoryStrategies,
} from "./lib/aylamed-success-story-training.js";
import {
  AYLA_STEP1_PILOT,
  advanceAylaPilotStudyDate,
  alignAylaPilotStudyDateToRealDate,
  aylaPilotStudyDate,
  buildAylaMateActivityFeed,
  buildAylaStep1PilotScenarios,
} from "./lib/aylamed-pilot.js";
import {
  AYLA_PILOT_FLOW_REPAIR_VERSION,
  buildAylaPilotFlowRepairPlan,
} from "./lib/aylamed-pilot-repair.js";
import {
  compareAylaExamPathways,
  estimateAylaExamPathway,
} from "./lib/aylamed-pathway-estimator.js";
import {
  EXTERNAL_QBANK_API_VERSION,
  ExternalQbankRateLimiter,
  authenticateExternalQbankClient,
  externalQbankConfigStatus,
  externalQbankOriginAllowed,
  issueExternalQbankEntitlementToken,
  normalizeExternalQbankSessionRequest,
  sanitizeExternalQbankQuestion,
  sanitizeExternalQbankSession,
  verifyExternalQbankEntitlementToken,
} from "./lib/external-qbank-delivery.js";
import {
  buildCrossSystemWeakAreaSummary,
  calculateLearningPartnerCompatibility,
  computeLearningStreak,
  learningDateKey,
  rankLearningLeaderboard,
  resolveStrictLmsIdentity,
  sanitizeLearningPartnerProfile,
} from "./lib/learning-progress-services.js";
import {
  STUDENT_PROFILE_CONTRACT_VERSION,
  applyStudentProfilePatch,
  normalizeStudentProfilePhone,
  normalizeStudentProfileRecord,
  sanitizeStudentProfileForOwner,
  studentProfilePolicy,
} from "./lib/student-profile-governance.js";
import {
  contentRegistryFlashcardId,
  contentRegistryQuestionId,
  normalizeCourseExamTrack,
  registryQuestionToFlashcard,
} from "./lib/content-registry-flashcards.js";
import {
  cleanupContentImportFiles,
  extractSafeZipInventory,
  importUniversalQuestionZip,
  previewUniversalQuestionZip,
  receiveContentZip,
} from "./lib/content-zip-import.js";
import { SafeBackgroundQueue } from "./lib/safe-background-jobs.js";
import { contentJobMonitoring } from "./lib/content-job-monitoring.js";
import { ResumableContentUploadStore } from "./lib/resumable-content-upload.js";
import { CloudContentUploadStore } from "./lib/cloud-content-upload.js";
import { contentZipSourceExists } from "./lib/content-zip-source.js";
import { inspectGuardedUworldArchives } from "./lib/guarded-uworld-archive.js";
import { deleteContentR2Object, ensureContentR2BrowserCors, headContentR2Object } from "./lib/content-r2-storage.js";
import { storagePerformanceSnapshot } from "./lib/operations-monitoring.js";
import {
  contentMediaStatus,
  createPrivateMediaUrl,
  deleteR2Object,
  inspectMediaZip,
  matchMediaReferences,
  uploadMediaZipToR2,
} from "./lib/content-media-r2.js";
import {
  buildMediaFinalizationCheckpoint,
  buildMediaCheckpoint,
  finalizeMediaInBatches,
  mediaFinalizationCacheKey,
  mediaFinalizationConfig,
  mediaInventoryCacheKey,
  resolveMediaFinalizationCheckpoint,
  resolveMediaInventoryCheckpoint,
} from "./lib/media-ingestion-accelerator.js";
import {
  contentVideoStatus,
  ensureVimeoEmbedDomains,
  extractReferencedVideos,
  inspectContentVideoEntries,
  matchVideoReferences,
  matchVideoReferencesByVerifiedAliases,
  normalizeVimeoEmbedDomains,
  normalizeVerifiedVideoAliases,
  openReferencedVideoStream,
  uploadVideoToVimeo,
} from "./lib/content-video-vimeo.js";
import {
  contentPathMatchesEdition,
  filterContentAssetsByEdition,
  filterContentReferencesByEdition,
  normalizeContentEdition,
} from "./lib/content-edition-scope.js";
import {
  DEFAULT_VIMEO_MEDICAL_SOURCE_DOMAINS,
  VIMEO_LIBRARY_CATALOG_BUILD,
  approveVimeoCatalogDraft,
  buildVimeoLibraryManifest,
  buildVimeoTopicClassificationRequest,
  extractVimeoWebSearchEvidence,
  fetchVimeoLectureEvidence,
  fetchVimeoFolder,
  fetchVimeoFolders,
  fetchVimeoLibrary,
  normalizeVimeoFolderId,
  normalizeVimeoTopicClassification,
  rejectVimeoCatalogDraft,
  upsertVimeoCatalogDraft,
  vimeoClassifierMaxOutputTokens,
  vimeoCatalogSummary,
} from "./lib/vimeo-library-manifest.js";
import {
  applyAylaVimeoMappings,
  validateAylaVimeoMappingImport,
} from "./lib/aylamed-vimeo-mapping-import.js";
import {
  AdaptiveCapacityGate,
  MULTI_QBANK_INGESTION_BUILD,
  buildQbankIngestionDashboard,
  isProviderRateLimit,
  multiQbankIngestionConfig,
} from "./lib/multi-qbank-ingestion.js";
import { runOpenAIBackgroundResponse } from "./lib/openai-background-responses.js";
import {
  bulkQbankMediaAliasFingerprint,
  normalizeBulkQbankMediaAliases,
  normalizeContentRightsStatus,
} from "./lib/qbank-bulk-ingestion.js";
import {
  CONTENT_CDM_INTERACTION_FORMAT,
  normalizeExamTrack,
  slug as contentSlug,
} from "./lib/content-import-adapter.js";
import {
  aylaPilotLoginFragmentPath,
  consumeAylaPilotLoginGrant,
  createAylaPilotLoginGrant,
} from "./lib/aylamed-pilot-login.js";
import {
  appendAylaQbankJournalRecord,
  applyAylaQbankJournalRecords,
  clearAylaQbankJournal,
  createAylaDiagnosticJournalRecord,
  readAylaQbankJournalRecords,
} from "./lib/aylamed-qbank-journal.js";
import {
  LMS_FULL_TEACHING_PLAN_DAYS,
  LMS_TEACHING_ACCESS_MODE,
  lmsPlanUsesTeachingSchedule,
  reconcileConfirmedTeachingPlanAccess,
  resolveTeachingPlanExpiry,
} from "./lib/lms-teaching-access.js";
import {
  LMS_SESSION_NOTES_BUILD,
  lmsApplySessionNotePublicationState,
  lmsAutoPublishSessionNotesEnabled,
  lmsSynchronizeSessionNoteContent,
  reconcileLmsSessionNoteInvariants,
} from "./lib/lms-session-notes.js";
import {
  LMS_RECORDING_LABEL_CORRECTIONS_BUILD,
  reconcileKnownMissedHolidayRecordingLabels,
} from "./lib/lms-recording-label-corrections.js";
import {
  LMS_KNOWN_MSK_NOTES_CATCHUP_BUILD,
  NEXTGEN_KNOWN_MSK_TRANSCRIPT_NOTE_TARGETS,
  applyKnownMskTranscriptNoteCandidate,
  inspectKnownMskTranscriptNoteTarget,
} from "./lib/lms-known-msk-notes-catchup.js";
import { mutateJsonCopyOnWrite } from "./lib/json-copy-on-write.js";
import cors from "cors";
import dotenv from "dotenv";
import Stripe from "stripe";
import axios from "axios";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import fs from "fs/promises";
import fsSync from "node:fs";
import path from "path";
import { PassThrough } from "node:stream";
import { pipeline as pipelineStreams } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { getHeapStatistics } from "node:v8";

dotenv.config();

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "");

const NEXTGEN_BACKEND_BUILD = "v219-safe-shared-student-profile";
const LMS_TEACHING_ACCESS_BUILD = "v255-course-teaching-day-access";
const CONTENT_INGESTION_BUILD = MULTI_QBANK_INGESTION_BUILD;
const CONTENT_TAXONOMY_BUILD = "v209-content-taxonomy-governance";
const ROADMAP_EXTENSION_BUILD = "v221-system-aware-roadmap-extension";
const ROADMAP_RETROSPECTIVE_REVISION_BUILD = "v262-recorded-revision-attendance-preserve";
const RECORDING_ASSIGNMENT_BUILD = "v222-safe-recording-detach";
const RECORDING_DUPLICATE_CLEANUP_BUILD = "v223-safe-recording-duplicate-cleanup";
const RECORDING_LABEL_CORRECTIONS_BUILD = LMS_RECORDING_LABEL_CORRECTIONS_BUILD;
const LMS_KNOWN_SCHEDULE_REPAIR_BUILD = "v260-known-missed-holiday-transactional-recovery";
const STUDENT_NOTES_RESOLVER_BUILD = "v225-course-system-day-notes-resolver";
const LMS_ASSESSMENT_NOTES_SCOPE_BUILD = "v257-assessment-notes-scopes";
const AYLA_ADAPTIVE_CORE_BUILD = "v227-verified-adaptive-loop";
const AYLA_STARTING_READINESS_BUILD = "v229-starting-readiness-loop";
const AYLA_SINGLE_ROADMAP_BUILD = "v230-single-roadmap-execution";
const AYLA_MARKETING_BUILD = "v231-readiness-sharing-referrals";
const AYLA_VIMEO_CATALOG_BUILD = VIMEO_LIBRARY_CATALOG_BUILD;
const AYLA_PRIVATE_PILOT_BUILD = "v251-live-pilot-flow-recovery";
const AYLA_STEP1_PILOT_DESTINATION_SCOPE = "private_step1_pilot";
const AYLA_STUDENT_CATALOG_SCOPE_PREFIX = "student:";
const AYLA_STEP1_PILOT_VIMEO_FOLDER_ID = "29973623";
const AYLA_STEP1_PILOT_VIMEO_SOURCE_ID = "AYLA-VIMEO-SOURCE-usmle-step-1-29973623";
const AYLA_STEP1_VIMEO_PUBLICATION_BUILD = "v254-step1-vimeo-memory-circuit-breaker";
const AYLA_STEP1_OWNER_CONTENT_AUTHORIZATION = Object.freeze({
  status: "authorized",
  actorId: "owner:nextgeninstitute8578",
  attestedAt: "2026-07-28",
  scope: "user_uploaded_or_pasted_aylamed_content",
});

const NEXTGEN_MSK_2026_07_29_SCHEDULE_REPAIR = Object.freeze({
  course_id: "6cacc0bf-7ca2-401e-aeff-a0b67e3ffb1c",
  holiday_date: "2026-07-29",
  holiday_day_id: "6cacc0bf-7ca2-401e-aeff-a0b67e3ffb1c:day:16:76a0bbf1-6e31-4647-9a7f-0f68604679ab",
  holiday_session_id: "b4bffbe7-33f9-4e0c-a795-02c4bbb1e199",
  taught_date: "2026-07-30",
  taught_day_id_before_repair: "6cacc0bf-7ca2-401e-aeff-a0b67e3ffb1c:day:17:4f6cccff-d9b7-4232-ab25-5f94dad1f887",
  taught_session_id: "dd2943e0-16cc-4e65-9296-918414715d33",
  current_date: "2026-07-31",
  current_day_id_before_repair: "6cacc0bf-7ca2-401e-aeff-a0b67e3ffb1c:day:18:de2a716f-0b6f-4ff0-8e01-d1b696326408",
  current_session_id: "ae8b6eb9-e930-4a83-af64-537253fe42fa",
  recording_key: String(process.env.NEXTGEN_MSK_2026_07_30_RECORDING_KEY || "").trim(),
  moved_day_id: "6cacc0bf-7ca2-401e-aeff-a0b67e3ffb1c:day:pushed:68d50440-edb7-4f8b-ab2d-b8bc6fc97e2a",
  prefix_rows: Object.freeze([
    { day_id: "6cacc0bf-7ca2-401e-aeff-a0b67e3ffb1c:day:1:ee429d9f-1a2a-463f-89f4-fbfd4fe2a0fc", date: "2026-07-01", holiday: true },
    { day_id: "6cacc0bf-7ca2-401e-aeff-a0b67e3ffb1c:day:pushed:b29be8d1-fd7e-4798-bf85-ffcb9ca8d597", date: "2026-07-02", session_id: "e80489ce-70e6-4af3-bc11-4ca1f7b25d8e" },
    { day_id: "6cacc0bf-7ca2-401e-aeff-a0b67e3ffb1c:day:2:2f21d999-81cf-4e3b-b5bd-b0c86d2790da", date: "2026-07-03", session_id: "ca2137f4-db8a-48db-9ec6-8029ae83b663" },
    { day_id: "6cacc0bf-7ca2-401e-aeff-a0b67e3ffb1c:day:3:7d582022-4e15-489e-b1c1-d534a2d7dea1", date: "2026-07-04", holiday: true },
    { day_id: "6cacc0bf-7ca2-401e-aeff-a0b67e3ffb1c:day:pushed:7a580580-a19e-4409-a82f-c2795245aa94", date: "2026-07-06", session_id: "ea3bd579-bac1-4527-909d-a40a39ca5067" },
    { day_id: "6cacc0bf-7ca2-401e-aeff-a0b67e3ffb1c:day:4:a84aa85e-cd4b-4059-9ae6-ff8f27816bbf", date: "2026-07-07", session_id: "8501ec50-fee8-49c2-b306-e252c09c08da" },
    { day_id: "6cacc0bf-7ca2-401e-aeff-a0b67e3ffb1c:day:5:acb6339b-b076-48a1-85b5-35617e9ff637", date: "2026-07-08", session_id: "5dcd27e3-1614-4c70-8122-117a80ac0bbf" },
    { day_id: "6cacc0bf-7ca2-401e-aeff-a0b67e3ffb1c:day:6:aecd0949-8504-4df7-b259-bdf0887fa092", date: "2026-07-09", holiday: true },
    { day_id: "6cacc0bf-7ca2-401e-aeff-a0b67e3ffb1c:day:pushed:105ba9e7-ca58-4091-804a-16fc2247aaac", date: "2026-07-10", holiday: true },
    { day_id: "6cacc0bf-7ca2-401e-aeff-a0b67e3ffb1c:day:pushed:4ec9308c-f20b-4c52-a2f5-89ead3d40e9a", date: "2026-07-11", session_id: "17426ec5-286a-4919-91c7-3a4d3f9f26f9" },
    { day_id: "6cacc0bf-7ca2-401e-aeff-a0b67e3ffb1c:day:7:f4219a4b-909b-4cf5-bf33-2fa1fb62620e", date: "2026-07-12", session_id: "c4abcae2-79d3-4f85-bfc7-7f91552dd5f1" },
    { day_id: "6cacc0bf-7ca2-401e-aeff-a0b67e3ffb1c:day:8:e34cd84e-5790-460e-9c70-a41e4079594c", date: "2026-07-13", session_id: "bd6cc888-cbf8-4c84-ba94-340315c41e87" },
    { day_id: "6cacc0bf-7ca2-401e-aeff-a0b67e3ffb1c:day:9:981a97a6-f01e-4e2c-86f9-4bb3603886e5", date: "2026-07-14", holiday: true },
    { day_id: "6cacc0bf-7ca2-401e-aeff-a0b67e3ffb1c:day:pushed:826f104d-8222-48f9-a672-13f354e58b55", date: "2026-07-15", session_id: "f756c0fc-3812-421f-880f-d294a60e73a2" },
    { day_id: "6cacc0bf-7ca2-401e-aeff-a0b67e3ffb1c:day:10:7ef39da5-f2c8-4ad6-929f-e9bfd5590f46", date: "2026-07-16", session_id: "5d0efb1f-6e13-4740-979a-a58df41dc582" },
    { day_id: "6cacc0bf-7ca2-401e-aeff-a0b67e3ffb1c:day:11:012176c3-19c9-4689-9b0b-fac81e96dd47", date: "2026-07-17", session_id: "09176f22-28ce-4aef-b2cc-18307b43a65f" },
    { day_id: "6cacc0bf-7ca2-401e-aeff-a0b67e3ffb1c:day:12:0d222da1-867e-4bad-a6ae-435f0966ab4a", date: "2026-07-18", holiday: true },
    { day_id: "6cacc0bf-7ca2-401e-aeff-a0b67e3ffb1c:day:pushed:b00ddfe0-5936-4e8e-926e-41bbe813ca07", date: "2026-07-20", session_id: "3a0969e3-3c85-4bd4-a728-d0c474a8014b" },
    { day_id: "6cacc0bf-7ca2-401e-aeff-a0b67e3ffb1c:day:13:badb20b2-ff97-475d-a37d-c8731be4bc66", date: "2026-07-21", session_id: "d699e77e-9201-4f5f-b5fd-eaba05a080b9" },
    { day_id: "6cacc0bf-7ca2-401e-aeff-a0b67e3ffb1c:day:14:c03675d0-2869-46e3-8b28-a789b88daa08", date: "2026-07-22", session_id: "6ddc8cbd-da24-4211-9f4a-4d2ef3bab87a" },
    { day_id: "6cacc0bf-7ca2-401e-aeff-a0b67e3ffb1c:day:extension:58f938f8-45c9-44c2-b285-f8101407fac5", date: "2026-07-23", session_id: "0140b2ed-18d2-4a71-93dd-8839566d3ce5" },
    { day_id: "6cacc0bf-7ca2-401e-aeff-a0b67e3ffb1c:day:extension:07f85cf7-eadd-4f13-a504-9afba29dd1ca", date: "2026-07-24", session_id: "338a387b-ea6c-4c64-b1b6-8f92ec359222" },
  ]),
  msk_rows: Object.freeze([
    { day_id: "6cacc0bf-7ca2-401e-aeff-a0b67e3ffb1c:day:displaced:f481a1e9-b047-436c-8d8e-4aad8e28f088", date: "2026-07-25", system_day: 1, pages: "449-452", session_id: "5c5bf79b-6744-48a6-a4c2-021824357073" },
    { day_id: "6cacc0bf-7ca2-401e-aeff-a0b67e3ffb1c:day:displaced:037a3971-4f27-425a-8fa1-33a8d81ba39c", date: "2026-07-27", system_day: 2, pages: "453-456", session_id: "4184f0c1-a396-44c5-96b9-c00244ee66bc" },
    { day_id: "6cacc0bf-7ca2-401e-aeff-a0b67e3ffb1c:day:15:99fd55b6-d102-434e-a647-d7f0a400db71", date: "2026-07-28", system_day: 3, pages: "457-460", session_id: "78f27b9f-9547-42ea-990b-3c0ba272f39e" },
    { day_id: "6cacc0bf-7ca2-401e-aeff-a0b67e3ffb1c:day:pushed:68d50440-edb7-4f8b-ab2d-b8bc6fc97e2a", date: "2026-07-30", system_day: 4, pages: "461-464", session_id: "dd2943e0-16cc-4e65-9296-918414715d33" },
    { day_id: "6cacc0bf-7ca2-401e-aeff-a0b67e3ffb1c:day:17:4f6cccff-d9b7-4232-ab25-5f94dad1f887", date: "2026-07-31", system_day: 5, pages: "465-468", session_id: "ae8b6eb9-e930-4a83-af64-537253fe42fa" },
    { day_id: "6cacc0bf-7ca2-401e-aeff-a0b67e3ffb1c:day:18:de2a716f-0b6f-4ff0-8e01-d1b696326408", date: "2026-08-01", system_day: 6, pages: "469-472" },
    { day_id: "6cacc0bf-7ca2-401e-aeff-a0b67e3ffb1c:day:19:de11e51b-0980-4ce7-9106-7840f7babb8f", date: "2026-08-03", system_day: 7, pages: "473-476" },
    { day_id: "6cacc0bf-7ca2-401e-aeff-a0b67e3ffb1c:day:20:3346870c-d855-4241-a912-e9aa221fad1b", date: "2026-08-04", system_day: 8, pages: "477-480" },
    { day_id: "6cacc0bf-7ca2-401e-aeff-a0b67e3ffb1c:day:21:07904631-4c17-4140-9406-00a4981a7822", date: "2026-08-05", system_day: 9, pages: "481-484" },
    { day_id: "6cacc0bf-7ca2-401e-aeff-a0b67e3ffb1c:day:22:5cfd0e46-a058-4dd3-bea7-68c7867129c0", date: "2026-08-06", system_day: 10, pages: "485-488" },
    { day_id: "6cacc0bf-7ca2-401e-aeff-a0b67e3ffb1c:day:23:d347b0ca-c928-460f-8801-2eed937bf21f", date: "2026-08-07", system_day: 11, pages: "489-492" },
    { day_id: "6cacc0bf-7ca2-401e-aeff-a0b67e3ffb1c:day:24:518211d2-a979-4a33-acfe-916353171060", date: "2026-08-08", system_day: 12, pages: "493-495" },
    { day_id: "6cacc0bf-7ca2-401e-aeff-a0b67e3ffb1c:day:25:452872c2-6d1e-4985-9cbb-d1442b42b46f", date: "2026-08-10", system_day: 13, pages: "496-498" },
  ]),
});
const aylaPrivatePilotContentActivationState = {
  running: false,
  lastStartedAt: null,
  lastFinishedAt: null,
  lastSuccessAt: null,
  lastError: null,
  lastResult: null,
};
const ngTeachingAccessReconciliationState = {
  build: LMS_TEACHING_ACCESS_BUILD,
  running: false,
  last_started_at: null,
  last_finished_at: null,
  last_success_at: null,
  last_error: null,
  last_result: null,
  last_material_result: null,
};

function aylaStep1PilotDestinationScope(student = {}) {
  if (student.pilotTest !== true && student.pilot_test !== true) return "";
  const examTrack = normalizeAylaRegistryExamTrack(
    student.examTrackId
      || student.exam_track_id
      || student.examTrack
      || student.exam_track
      || student.exam,
  );
  return examTrack === "usmle-step-1" ? AYLA_STEP1_PILOT_DESTINATION_SCOPE : "";
}

function aylaStudentCatalogDestinationScope(student = {}) {
  const pilotScope = aylaStep1PilotDestinationScope(student);
  if (pilotScope) return pilotScope;
  const studentId = String(student.id || student.student_id || student.studentId || "").trim().toLowerCase();
  return /^(?:[0-9a-f]{8}-[0-9a-f-]{27}|dx-[0-9]{6}-[0-9a-f]{8})$/i.test(studentId)
    ? `${AYLA_STUDENT_CATALOG_SCOPE_PREFIX}${studentId}`
    : "";
}

function aylaStep1PilotVimeoSourceMatches(row = {}) {
  const catalogSourceId = String(
    row.catalogSourceId
      || row.catalog_source_id
      || row.sourceData?.catalog_source_id
      || row.source_data?.catalog_source_id
      || "",
  ).trim();
  const folderId = normalizeVimeoFolderId(
    row.folderId
      || row.folder_id
      || row.sourceData?.folder_id
      || row.source_data?.folder_id
      || row.sourceNamespace
      || row.source_namespace
      || "",
  );
  const sourceNamespace = String(row.sourceNamespace || row.source_namespace || "").trim();
  return catalogSourceId === AYLA_STEP1_PILOT_VIMEO_SOURCE_ID
    || folderId === AYLA_STEP1_PILOT_VIMEO_FOLDER_ID
    || sourceNamespace === `vimeo_folder:${AYLA_STEP1_PILOT_VIMEO_FOLDER_ID}`;
}

function aylaStep1PilotVimeoVisibleToStudent(resource = {}, student = {}) {
  const ownerStudentId = String(resource.ownerStudentId || resource.owner_student_id || "").trim();
  const studentId = String(student.id || student.studentId || student.student_id || "").trim();
  if (ownerStudentId) return Boolean(studentId && ownerStudentId === studentId);
  if (!aylaStep1PilotDestinationScope(student)) return true;
  const type = String(resource.type || resource.resourceType || resource.resource_type || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  const isVimeo = Boolean(resource.vimeoId || resource.vimeo_id)
    || ["vimeo_video", "video_transcript"].includes(type);
  const globalStudentPublication = resource.globalStudentPublication === true
    || resource.global_student_publication === true
    || resource.sourceData?.global_student_publication === true
    || resource.source_data?.global_student_publication === true;
  return !isVimeo || globalStudentPublication || aylaStep1PilotVimeoSourceMatches(resource);
}

const AYLA_INTERNAL_REVIEW_EMAIL_HASH = "94ce0e4a551d49fa9686aea4be5c5ee93d1cd6870ff28bc309d01bfce708ff65";
const AYLA_MANUAL_VIMEO_FOLDER_PUBLICATION = Object.freeze({
  "30014230": Object.freeze({ label: "Pathoma Step 1", expected: 112 }),
  "30032209": Object.freeze({ label: "Pixorize Biochemistry 2023", expected: 198 }),
  "30032227": Object.freeze({ label: "Pixorize Immunology 2023", expected: 88 }),
  "30036714": Object.freeze({ label: "Pixorize Microbiology 2023", expected: 195 }),
  "30043950": Object.freeze({ label: "Pixorize Pharmacology 2023", expected: 252 }),
});

function aylaInternalReviewStudent(db) {
  const user = aylaValues(db, "aylaUsers").find((row) =>
    crypto.createHash("sha256").update(aylaNormalizeEmail(row.email || "")).digest("hex") === AYLA_INTERNAL_REVIEW_EMAIL_HASH);
  if (!user?.id) return null;
  const student = aylaValues(db, "aylaStudents").find((row) =>
    String(row.ayla_user_id || row.aylaUserId || row.user_id || row.userId || "") === String(user.id)
    && aylaCanonicalExamTrack(row.examTrackId || row.exam_track_id || row.exam) === "usmle_step_1");
  return student ? { user, student } : null;
}

function aylaVimeoDraftHierarchyComplete(draft = {}) {
  const classification = draft.classification || {};
  return Boolean(
    String(classification.medicalSystem || "").trim()
    && String(classification.medicalSubsystem || classification.qbankTopic?.subsystemKey || "").trim()
    && String(classification.canonicalTopic || classification.qbankTopic?.topicKey || "").trim()
    && String(classification.subtopic || classification.qbankTopic?.subtopicKey || "").trim()
  );
}
const MEMORY_STABILITY_BUILD = "v254-step1-vimeo-memory-circuit-breaker";
const allowedOrigins = [
  "https://live.nextgenusmlelms.com",
  "https://www.live.nextgenusmlelms.com",
  "https://lms.nextgenusmlelms.com",
  "https://www.lms.nextgenusmlelms.com",
  "https://mediumslateblue-otter-394719.hostingersite.com",
  "https://paleturquoise-quail-255896.hostingersite.com",
  "https://aylamedapp.com",
  "https://www.aylamedapp.com",
  ...aylaConfiguredExamOrigins(process.env),
  ...String(process.env.NEXTGEN_CORS_ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim().replace(/\/$/, ""))
    .filter(Boolean),
];

function isNextGenAllowedOrigin(origin = "", req = null) {
  const clean = String(origin || "").trim().replace(/\/$/, "");
  if (!clean) return false;
  if (allowedOrigins.includes(clean)) return true;
  const requestPath = String(req?.originalUrl || req?.url || "").split("?")[0];
  return requestPath.startsWith("/api/external-qbank/") && externalQbankOriginAllowed(clean);
}

function getCorsRequestHeaders(req) {
  const requested = String(req.headers["access-control-request-headers"] || "").trim();
  const defaults = [
    "Content-Type",
    "Authorization",
    "x-requested-with",
    "X-Requested-With",
    "Accept",
    "Origin",
    "Cache-Control",
    "Pragma",
    "x-nextgen-admin",
    "x-nextgen-auth",
    "x-nextgen-source",
  ];

  if (!requested) return defaults.join(", ");

  const merged = new Set([
    ...requested.split(",").map((item) => item.trim()).filter(Boolean),
    ...defaults,
  ]);

  return Array.from(merged).join(", ");
}

function applyNextGenCors(req, res) {
  const origin = String(req.headers.origin || "").trim().replace(/\/$/, "");

  // Strong browser fix: for browser calls, reflect the valid origin so Authorization headers work.
  // For server-to-server/curl/Render health checks, use wildcard.
  if (origin) {
    if (isNextGenAllowedOrigin(origin, req)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    res.setHeader("Vary", "Origin, Access-Control-Request-Headers, Access-Control-Request-Method");
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD");
  res.setHeader("Access-Control-Allow-Headers", getCorsRequestHeaders(req));
  res.setHeader("Access-Control-Expose-Headers", "Content-Type, Authorization, X-NextGen-Backend-Build, X-Request-Id");
  res.setHeader("Access-Control-Max-Age", "86400");
  res.setHeader("X-NextGen-Backend-Build", NEXTGEN_BACKEND_BUILD);
}

// Hard CORS/preflight guard. This must remain before all routes and before body parsing.
app.use((req, res, next) => {
  applyNextGenCors(req, res);
  const origin = String(req.headers.origin || "").trim().replace(/\/$/, "");
  if (origin && !isNextGenAllowedOrigin(origin, req)) {
    return res.status(403).json({ success: false, error: "This website origin is not allowed." });
  }
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  return next();
});

// Keep cors(), but make it non-blocking. The manual guard above is the source of truth.
const corsOptions = {
  origin(origin, callback) {
    if (!origin || isNextGenAllowedOrigin(origin)) return callback(null, true);
    return callback(new Error("This website origin is not allowed."));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "x-requested-with",
    "X-Requested-With",
    "Accept",
    "Origin",
    "Cache-Control",
    "Pragma",
    "x-nextgen-admin",
    "x-nextgen-auth",
    "x-nextgen-source",
  ],
  exposedHeaders: ["Content-Type", "Authorization", "X-NextGen-Backend-Build", "X-Request-Id"],
  optionsSuccessStatus: 204,
};

app.use((req, res, next) => {
  applyNextGenCors(req, res);
  const requestCorsOptions = {
    ...corsOptions,
    origin(origin, callback) {
      if (!origin || isNextGenAllowedOrigin(origin, req)) return callback(null, true);
      return callback(new Error("This website origin is not allowed."));
    },
  };
  return cors(requestCorsOptions)(req, res, (error) => {
    if (error) {
      console.warn("Non-blocking CORS warning:", error.message);
      applyNextGenCors(req, res);
    }
    return next();
  });
});

app.options(/.*/, (req, res) => {
  applyNextGenCors(req, res);
  return res.status(204).end();
});

// Stripe webhooks must use the raw request body and must remain BEFORE express.json().
// Browser GET is only a health check; Stripe sends POST events here.
app.get("/stripe/webhook", (req, res) => {
  res.json({
    success: true,
    endpoint: "/stripe/webhook",
    method_required: "POST",
    build: NEXTGEN_BACKEND_BUILD,
    stripe_secret_configured: Boolean(process.env.STRIPE_SECRET_KEY),
    stripe_webhook_secret_configured: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
    message: "Stripe webhook endpoint is online. Create a Stripe event destination to POST checkout.session.completed, checkout.session.expired, invoice.paid, invoice.payment_failed, customer.subscription.deleted, payment_intent.payment_failed, charge.refunded, refund.created, and refund.updated here.",
  });
});

app.post("/stripe/webhook", express.raw({ type: "application/json", limit: "10mb" }), async (req, res) => {
  const signature = req.headers["stripe-signature"];
  const webhookSecret = String(process.env.STRIPE_WEBHOOK_SECRET || "").trim();

  if (!webhookSecret) {
    return res.status(400).json({
      success: false,
      error: "STRIPE_WEBHOOK_SECRET is not configured in Render. Create the Stripe webhook destination, copy whsec_..., add it to Render, then redeploy.",
    });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, webhookSecret);
  } catch (error) {
    console.error("Stripe webhook signature verification failed:", error.message);
    return res.status(400).json({ success: false, error: `Webhook signature verification failed: ${error.message}` });
  }

  try {
    const result = await ngHandleStripeWebhookEvent(event, req);
    return res.json({ success: true, received: true, event_id: event.id, event_type: event.type, result });
  } catch (error) {
    console.error("Stripe webhook processing error:", error.message);
    return res.status(error.statusCode || 500).json({ success: false, received: true, event_id: event.id, event_type: event.type, error: error.message });
  }
});

// AI-training PDFs are sent as base64 JSON, which is larger than the original PDF.
// A 300 MB global parser can temporarily allocate multiple copies of one request
// (raw body, decoded string, Buffer, OCR payload) and terminate a 2 GB Render
// instance. Keep the default bounded; operators can override it deliberately.
function ngBoundedJsonBodyLimit(value = "40mb") {
  const clean = String(value || "40mb").trim().toLowerCase();
  const match = clean.match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/);
  if (!match) return "40mb";
  const amount = Number(match[1]);
  const unit = match[2] || "b";
  const multiplier = unit === "gb" ? 1024 ** 3 : unit === "mb" ? 1024 ** 2 : unit === "kb" ? 1024 : 1;
  const requestedBytes = amount * multiplier;
  const minimumBytes = 1024 * 1024;
  const maximumBytes = 64 * 1024 * 1024;
  return `${Math.round(Math.max(minimumBytes, Math.min(maximumBytes, requestedBytes)))}b`;
}

const NEXTGEN_JSON_BODY_LIMIT = ngBoundedJsonBodyLimit(process.env.JSON_BODY_LIMIT || "40mb");
app.use(express.json({
  limit: NEXTGEN_JSON_BODY_LIMIT,
  verify: (req, _res, buffer) => {
    // Zoom signs the exact raw request bytes. Retain only this webhook body so
    // signature verification remains possible without changing other routes.
    if (String(req.originalUrl || req.url || "").split("?")[0] === "/zoom/webhook") {
      req.zoomRawBody = Buffer.from(buffer || "");
    }
  },
}));
app.use(express.urlencoded({ extended: true, limit: NEXTGEN_JSON_BODY_LIMIT }));

const META_CAPI_ALLOWED_EVENTS = new Set(["Lead"]);
const metaCapiRateBuckets = new Map();
const metaCapiAcceptedEventIds = new Map();

function ngMetaCapiConfig() {
  return {
    token: String(process.env.META_CAPI_TOKEN || "").trim(),
    pixelId: String(process.env.META_PIXEL_ID || "").trim(),
    graphVersion: String(process.env.META_GRAPH_VERSION || "v25.0").trim().replace(/^\/+|\/+$/g, "") || "v25.0",
    testEventCode: String(process.env.META_TEST_EVENT_CODE || "").trim(),
  };
}

function ngMetaCapiAllowedOrigin(origin = "") {
  const clean = String(origin || "").trim().replace(/\/$/, "");
  if (!clean) return true;
  if (isNextGenAllowedOrigin(clean)) return true;
  const configured = String(process.env.META_CAPI_ALLOWED_ORIGINS || "")
    .split(",")
    .map((item) => item.trim().replace(/\/$/, ""))
    .filter(Boolean);
  return configured.includes(clean);
}

function ngMetaCapiClientIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || req.ip || "")
    .split(",")[0]
    .trim()
    .slice(0, 80);
}

function ngMetaCapiRateAllowed(req, nowMs = Date.now()) {
  const key = ngMetaCapiClientIp(req) || "unknown";
  const windowMs = 10 * 60 * 1000;
  const maxRequests = 30;
  const previous = metaCapiRateBuckets.get(key);
  const bucket = !previous || nowMs - previous.startedAt >= windowMs
    ? { startedAt: nowMs, count: 0 }
    : previous;
  bucket.count += 1;
  metaCapiRateBuckets.set(key, bucket);

  if (metaCapiRateBuckets.size > 2000) {
    for (const [bucketKey, value] of metaCapiRateBuckets.entries()) {
      if (nowMs - Number(value.startedAt || 0) >= windowMs) metaCapiRateBuckets.delete(bucketKey);
    }
  }

  return bucket.count <= maxRequests;
}

function ngMetaCapiHash(value = "") {
  const clean = String(value || "").trim().toLowerCase();
  return clean ? crypto.createHash("sha256").update(clean).digest("hex") : "";
}

function ngMetaCapiCookie(req, name) {
  const raw = String(req.headers.cookie || "");
  for (const pair of raw.split(";")) {
    const index = pair.indexOf("=");
    if (index < 0) continue;
    if (pair.slice(0, index).trim() !== name) continue;
    try {
      return decodeURIComponent(pair.slice(index + 1).trim()).slice(0, 240);
    } catch {
      return pair.slice(index + 1).trim().slice(0, 240);
    }
  }
  return "";
}

function ngMetaCapiSourceUrl(value = "") {
  const clean = String(value || "").trim().slice(0, 1000);
  if (!clean) return "";
  try {
    const url = new URL(clean);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    if (!ngMetaCapiAllowedOrigin(url.origin)) return "";
    return url.toString();
  } catch {
    return "";
  }
}

function ngMetaCapiEventWasAccepted(eventId, nowMs = Date.now()) {
  const ttlMs = 48 * 60 * 60 * 1000;
  const acceptedAt = Number(metaCapiAcceptedEventIds.get(eventId) || 0);
  if (acceptedAt && nowMs - acceptedAt < ttlMs) return true;
  if (metaCapiAcceptedEventIds.size > 5000) {
    for (const [id, timestamp] of metaCapiAcceptedEventIds.entries()) {
      if (nowMs - Number(timestamp || 0) >= ttlMs) metaCapiAcceptedEventIds.delete(id);
    }
  }
  return false;
}

app.get("/api/capi-event/health", (_req, res) => {
  const config = ngMetaCapiConfig();
  res.json({
    success: true,
    configured: Boolean(config.token && config.pixelId),
    pixel_id: config.pixelId || null,
    graph_version: config.graphVersion,
    test_mode: Boolean(config.testEventCode),
    accepted_events: Array.from(META_CAPI_ALLOWED_EVENTS),
  });
});

app.post("/api/capi-event", async (req, res) => {
  const origin = String(req.headers.origin || "").trim();
  if (!ngMetaCapiAllowedOrigin(origin)) {
    return res.status(403).json({ success: false, error: "This website origin is not allowed." });
  }
  if (!ngMetaCapiRateAllowed(req)) {
    return res.status(429).json({ success: false, error: "Too many conversion requests. Please retry later." });
  }

  const config = ngMetaCapiConfig();
  if (!config.token || !config.pixelId) {
    return res.status(503).json({ success: false, error: "Meta Conversions API is not configured yet." });
  }

  const eventName = String(req.body?.eventName || req.body?.event_name || "").trim();
  const eventId = String(req.body?.eventId || req.body?.event_id || "").trim();
  const email = String(req.body?.email || "").trim().toLowerCase().slice(0, 320);
  const phone = String(req.body?.phone || "").replace(/\D/g, "").slice(0, 24);
  const sourceUrl = ngMetaCapiSourceUrl(req.body?.sourceUrl || req.body?.source_url || "");

  if (!META_CAPI_ALLOWED_EVENTS.has(eventName)) {
    return res.status(400).json({ success: false, error: "Unsupported conversion event." });
  }
  if (!/^[A-Za-z0-9._:-]{8,160}$/.test(eventId)) {
    return res.status(400).json({ success: false, error: "A valid eventId is required for deduplication." });
  }
  if (!email && !phone) {
    return res.status(400).json({ success: false, error: "Email or phone is required." });
  }
  if (!sourceUrl) {
    return res.status(400).json({ success: false, error: "A valid NextGen sourceUrl is required." });
  }
  if (ngMetaCapiEventWasAccepted(eventId)) {
    return res.json({ success: true, duplicate: true, event_id: eventId, events_received: 1 });
  }

  const fbp = String(req.body?.fbp || ngMetaCapiCookie(req, "_fbp") || "").trim().slice(0, 240);
  const fbc = String(req.body?.fbc || ngMetaCapiCookie(req, "_fbc") || "").trim().slice(0, 240);
  const userData = {
    client_ip_address: ngMetaCapiClientIp(req) || undefined,
    client_user_agent: String(req.headers["user-agent"] || "").slice(0, 500) || undefined,
    em: email ? [ngMetaCapiHash(email)] : undefined,
    ph: phone ? [ngMetaCapiHash(phone)] : undefined,
    fbp: fbp || undefined,
    fbc: fbc || undefined,
  };

  const payload = {
    data: [{
      event_name: eventName,
      event_time: Math.floor(Date.now() / 1000),
      action_source: "website",
      event_id: eventId,
      event_source_url: sourceUrl,
      user_data: userData,
    }],
    ...(config.testEventCode ? { test_event_code: config.testEventCode } : {}),
  };

  try {
    const response = await axios.post(
      `https://graph.facebook.com/${encodeURIComponent(config.graphVersion)}/${encodeURIComponent(config.pixelId)}/events`,
      payload,
      {
        params: { access_token: config.token },
        headers: { "Content-Type": "application/json" },
        timeout: 12000,
      }
    );
    metaCapiAcceptedEventIds.set(eventId, Date.now());
    return res.json({
      success: true,
      event_id: eventId,
      events_received: Number(response.data?.events_received || 0),
      messages: response.data?.messages || [],
      fbtrace_id: response.data?.fbtrace_id || null,
      test_mode: Boolean(config.testEventCode),
    });
  } catch (error) {
    const status = Number(error.response?.status || 502);
    console.error("Meta CAPI request failed:", {
      status,
      code: error.response?.data?.error?.code || null,
      message: error.response?.data?.error?.message || error.message,
    });
    return res.status(status >= 400 && status < 600 ? status : 502).json({
      success: false,
      error: "Meta conversion delivery failed.",
      meta_error_code: error.response?.data?.error?.code || null,
    });
  }
});

app.get("/admin/debug/cors-check", (req, res) => {
  res.json({
    success: true,
    build: NEXTGEN_BACKEND_BUILD,
    origin: req.headers.origin || null,
    now: new Date().toISOString(),
  });
});

function ngDbSectionCount(db, key) {
  const value = db?.[key];
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") return Object.keys(value).length;
  return 0;
}

async function ngBuildDbSafetySnapshot() {
  const db = await readLiveDb();
  let fileStat = null;
  try {
    const stat = await fs.stat(LIVE_DB_PATH);
    fileStat = {
      path: LIVE_DB_PATH,
      size_bytes: stat.size,
      modified_at: stat.mtime?.toISOString?.() || null,
    };
  } catch (error) {
    fileStat = { path: LIVE_DB_PATH, missing: true, error: error.message };
  }

  const sections = [
    "users", "courses", "enrollments", "payments", "plans",
    "roadmaps", "roadmapProgress", "liveSessions", "recordings", "notes",
    "attendance", "leaderboard", "assessments", "assessmentAttempts",
    "flashcards", "flashcardProgress", "flashcardReviewEvents", "dailyTaskProgress", "weakConceptLogs",
    "weakAreaProfiles", "weakAreaHistory", "adaptiveAssignments", "adaptiveFlashcardQueues",
    "pointEvents", "communityMessages", "globalCommunityPosts", "studyPartnerProfiles"
  ];

  return {
    success: true,
    build: NEXTGEN_BACKEND_BUILD,
    data_dir: DATA_DIR,
    live_db_path: LIVE_DB_PATH,
    persistent_disk_warning: String(DATA_DIR || "").startsWith("/tmp"),
    file: fileStat,
    updatedAt: db.updatedAt || null,
    counts: sections.reduce((acc, key) => {
      acc[key] = ngDbSectionCount(db, key);
      return acc;
    }, {}),
    now: new Date().toISOString(),
  };
}

app.get("/admin/debug/db-safety-check", async (req, res) => {
  try {
    await requireAdminOrInstructor(req);
    const snapshot = await ngBuildDbSafetySnapshot();
    res.json(snapshot);
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.post("/admin/debug/backup-live-db", async (req, res) => {
  try {
    await requireAdminOrInstructor(req);
    await ensureDataDir();
    const backupDir = path.join(DATA_DIR, "backups");
    await fs.mkdir(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(backupDir, `live-session-db-${stamp}.json`);
    try {
      await fs.copyFile(LIVE_DB_PATH, backupPath);
    } catch (error) {
      if (error.code === "ENOENT") {
        await fs.writeFile(backupPath, JSON.stringify({ ...DEFAULT_LIVE_DB, updatedAt: new Date().toISOString() }, null, 2), "utf8");
      } else {
        throw error;
      }
    }
    const stat = await fs.stat(backupPath);
    const snapshot = await ngBuildDbSafetySnapshot();
    res.json({
      success: true,
      backup_path: backupPath,
      size_bytes: stat.size,
      created_at: new Date().toISOString(),
      safety_snapshot: snapshot,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.get("/admin/debug/export-live-db", async (req, res) => {
  try {
    await requireAdminOrInstructor(req);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=nextgen-live-db-${stamp}.json`);
    try {
      await fs.access(LIVE_DB_PATH);
      return res.sendFile(LIVE_DB_PATH);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return res.json({ ...DEFAULT_LIVE_DB, updatedAt: new Date().toISOString() });
    }
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

const POCKETBASE_URL = process.env.POCKETBASE_URL;
const DATA_DIR = process.env.DATA_DIR || "/tmp";
const MEDIA_DIR = path.join(DATA_DIR, "media");
const LIVE_DB_PATH = path.join(DATA_DIR, "live-session-db.json");
const NG_CONTENT_OPERATIONS_ROOT = path.join(DATA_DIR, "content-operations");
const ngMultiQbankConfig = multiQbankIngestionConfig();
const NG_CONTENT_JOB_RECOVERY_HISTORY_LIMIT = Math.max(
  25,
  Math.min(
    250,
    Number(process.env.NEXTGEN_CONTENT_JOB_RECOVERY_HISTORY_LIMIT || 100) || 100,
  ),
);
const NG_CONTENT_JOB_MANIFEST_READ_MAX_BYTES = Math.max(
  1024 * 1024,
  Math.min(
    64 * 1024 * 1024,
    Number(process.env.NEXTGEN_CONTENT_JOB_MANIFEST_READ_MAX_BYTES || 16 * 1024 * 1024)
      || 16 * 1024 * 1024,
  ),
);
const ngContentJobStore = contentRegistryStatus().configured
  ? createContentBackgroundJobStore({
      ownerId: `content-web-${process.pid}-${crypto.randomUUID()}`,
      leaseMs: ngMultiQbankConfig.job_lease_ms,
      recoveryHistoryLimit: NG_CONTENT_JOB_RECOVERY_HISTORY_LIMIT,
    })
  : null;
const ngMediaTransferGate = new AdaptiveCapacityGate({
  name: "r2_media_transfers",
  minimum: ngMultiQbankConfig.media_min_transfer_limit,
  normal: ngMultiQbankConfig.media_global_transfer_limit,
  maximum: ngMultiQbankConfig.media_global_transfer_limit,
  memorySoftPercent: ngMultiQbankConfig.memory_soft_percent,
  memoryHardPercent: ngMultiQbankConfig.memory_hard_percent,
  memoryProvider: () => ngMemoryStatus(),
});
const ngMediaFinalizerGate = new AdaptiveCapacityGate({
  name: "postgres_media_finalizer",
  minimum: 1,
  normal: ngMultiQbankConfig.postgres_finalizers,
  maximum: ngMultiQbankConfig.postgres_finalizers,
  memorySoftPercent: ngMultiQbankConfig.memory_soft_percent,
  memoryHardPercent: ngMultiQbankConfig.memory_hard_percent,
  memoryProvider: () => ngMemoryStatus(),
});
const ngVimeoUploadGate = new AdaptiveCapacityGate({
  name: "vimeo_uploads",
  minimum: 1,
  normal: ngMultiQbankConfig.vimeo_uploads,
  maximum: ngMultiQbankConfig.vimeo_uploads,
  memorySoftPercent: ngMultiQbankConfig.memory_soft_percent,
  memoryHardPercent: ngMultiQbankConfig.memory_hard_percent,
  memoryProvider: () => ngMemoryStatus(),
});
const ngInFlightVimeoUploads = new Map();
const ngContentBackgroundQueue = new SafeBackgroundQueue({
  directory: path.join(NG_CONTENT_OPERATIONS_ROOT, "jobs"),
  maxConcurrency: ngMultiQbankConfig.max_active_jobs,
  laneConcurrency: ngMultiQbankConfig.lane_concurrency,
  retryBaseMs: Math.max(1_000, Number(process.env.NEXTGEN_CONTENT_JOB_RETRY_BASE_MS || 15_000) || 15_000),
  memoryRetryMs: Math.max(5_000, Number(process.env.NEXTGEN_CONTENT_JOB_MEMORY_RETRY_MS || 30_000) || 30_000),
  memoryGate: (job) => ngBackgroundMemoryIsHigh(
    ["ayla_vimeo_ai", "ayla_taxonomy_ai"].includes(job?.lane)
      ? `${job.lane}_queue`
      : "content_operations_queue",
    {
      heapSoftPercent: ["ayla_vimeo_ai", "ayla_taxonomy_ai"].includes(job?.lane)
        ? NEXTGEN_AYLA_VIMEO_HEAP_SOFT_PERCENT
        : NEXTGEN_BACKGROUND_HEAP_SOFT_PERCENT,
    },
  ),
  persistentStore: ngContentJobStore,
  leaseRetryMs: Math.max(5_000, Math.floor(ngMultiQbankConfig.job_lease_ms / 4)),
  maxRetainedTerminalJobs: NG_CONTENT_JOB_RECOVERY_HISTORY_LIMIT,
  maxManifestReadBytes: NG_CONTENT_JOB_MANIFEST_READ_MAX_BYTES,
});
const ngContentUploadStore = contentMediaStatus().configured
  ? new CloudContentUploadStore({
    directory: path.join(NG_CONTENT_OPERATIONS_ROOT, "cloud-uploads"),
    maxUploadBytes: Math.max(1024 * 1024, Number(process.env.NEXTGEN_CONTENT_DIRECT_MAX_ZIP_BYTES || 50 * 1024 ** 3)),
    partSize: Math.max(5 * 1024 ** 2, Number(process.env.NEXTGEN_CONTENT_UPLOAD_PART_BYTES || 64 * 1024 ** 2)),
    sessionTtlMs: Math.max(60 * 60 * 1000, Number(process.env.NEXTGEN_CONTENT_UPLOAD_TTL_MS || 72 * 60 * 60 * 1000)),
  })
  : new ResumableContentUploadStore({
    directory: path.join(NG_CONTENT_OPERATIONS_ROOT, "uploads"),
    maxUploadBytes: Math.max(1024 * 1024, Number(process.env.NEXTGEN_CONTENT_MAX_ZIP_BYTES || 5 * 1024 ** 3)),
    chunkSize: Math.max(256 * 1024, Number(process.env.NEXTGEN_CONTENT_UPLOAD_CHUNK_BYTES || 8 * 1024 ** 2)),
    maxChunkBytes: Math.max(1024 * 1024, Number(process.env.NEXTGEN_CONTENT_UPLOAD_MAX_CHUNK_BYTES || 16 * 1024 ** 2)),
    sessionTtlMs: Math.max(60 * 60 * 1000, Number(process.env.NEXTGEN_CONTENT_UPLOAD_TTL_MS || 48 * 60 * 60 * 1000)),
  });
app.use("/media", express.static(MEDIA_DIR, { maxAge: "30d", fallthrough: true }));
const DEFAULT_TIMEZONE = "America/New_York";
const DEFAULT_ZOOM_DURATION_MINUTES = 120;
const NEXTGEN_CLASSROOM_OPEN_MINUTES_BEFORE = 5;
const NEXTGEN_LIVE_SESSION_AUTO_COMPLETE_MINUTES = 60;
const PENDING_ZOOM_PREFIX = "PENDING_ZOOM_";


function getNextGenConfiguredLiveSessionLink() {
  return String(
    process.env.NEXTGEN_LIVE_SESSION_LINK ||
    process.env.NEXTGEN_ZOOM_LINK ||
    process.env.NEXTGEN_DAILY_LIVE_LINK ||
    process.env.LIVE_SESSION_LINK ||
    ""
  ).trim();
}


const NEXTGEN_STEP1_ROADMAP_SYSTEM_SEQUENCE = [
  "Cardiology",
  "MSK",
  "Central Nervous System",
  "Reproductive",
  "Endocrinology",
  "GIT",
  "Renal",
  "Pulmonology",
  "Immunology",
  "Hematology",
  "Psychiatry",
];

// v104: User-confirmed final July 1 Marathon sequence. Do not move MSK before Cardiology.
function ngRoadmapSystemSequenceText() {
  return NEXTGEN_STEP1_ROADMAP_SYSTEM_SEQUENCE.join(" → ");
}

const DEFAULT_FEATURE_CATALOG = {
  video_library: { key: "video_library", name: "Video Library", description: "Access to recorded video lessons", is_active: true, free_for_all: false },
  live_classes: { key: "live_classes", name: "Live Classes", description: "Access to scheduled Zoom live classes", is_active: true, free_for_all: false },
  recordings: { key: "recordings", name: "Class Recordings", description: "Access to published class recordings", is_active: true, free_for_all: false },
  community: { key: "community", name: "Community Messages", description: "Access to session community discussion", is_active: true, free_for_all: false },
  assessments: { key: "assessments", name: "Assessments", description: "Access to tutor-created assessments", is_active: true, free_for_all: false },
  notes_transcripts: { key: "notes_transcripts", name: "Notes & Transcripts", description: "Access to class notes and transcript links", is_active: true, free_for_all: false },
  leaderboard: { key: "leaderboard", name: "Leaderboard", description: "Access to attendance, assessment, and task leaderboard", is_active: true, free_for_all: false },
  flashcards: { key: "flashcards", name: "Daily Flashcards", description: "Access to daily topic-based flashcards", is_active: true, free_for_all: false },
  roadmap: { key: "roadmap", name: "Roadmap", description: "Access to course roadmap", is_active: true, free_for_all: true },
  global_community: { key: "global_community", name: "Global LMS Community", description: "Access to the overall LMS community discussions", is_active: true, free_for_all: false },
  study_partner: { key: "study_partner", name: "Study Partner", description: "Find and connect with compatible study partners", is_active: true, free_for_all: false },
  support: { key: "support", name: "Student Support", description: "Access to support and announcements", is_active: true, free_for_all: false },
};

const DEFAULT_DEMO_SETTINGS = {
  enabled: true,
  duration_days: 7,
  allow_live_classes: true,
  allow_roadmap: true,
  allow_community: true,
  allow_global_community: true,
  allow_study_partner: true,
  allow_assessments: true,
  allow_leaderboard: true,
  allow_flashcards: true,
  allow_recordings: true,
  allow_notes_transcripts: true,
  allow_video_library: true,
  max_live_sessions: null,
  updated_at: null,
};

const DEFAULT_EMAIL_SETTINGS = {
  email_notifications_enabled: true,
  admin_email: "nextgenacademy89@gmail.com",
  sender_name: "NextGen USMLE",
  reply_to: "support@nextgenusmlelms.com",
  live_class_reminder_minutes: 60,
  demo_expiring_days: 1,
  bulk_send_limit: 250,
  updated_at: null,
};

const DEFAULT_EMAIL_TEMPLATES = {
  password_reset: {
    key: "password_reset",
    name: "Password Reset",
    category: "Account & Security",
    description: "Sent when a registered student requests a secure password-reset link.",
    enabled: true,
    subject: "Secure your NextGen USMLE account — reset your password",
    body: `Hi {{student_name}},

We received a request to reset your NextGen USMLE LMS password.

Reset your password securely:
{{reset_url}}

For your security, this link expires in 1 hour. If you did not request this change, you can safely ignore this email.

Warm regards,
NextGen USMLE Student Success Team`,
    variables: ["student_name", "student_email", "reset_url", "support_email"],
  },
  new_account_welcome: {
    key: "new_account_welcome",
    name: "New Account Welcome",
    category: "Account & Security",
    description: "Sent immediately after a student creates a new LMS account.",
    enabled: true,
    subject: "Welcome to NextGen USMLE — your learning account is ready",
    body: `Hi {{student_name}},

Welcome to NextGen USMLE. Your secure LMS account has been created successfully.

Sign in here:
{{login_url}}

Creating an account does not automatically activate a free demo or paid plan. Return to the plan you selected to complete checkout, or choose Try Demo separately.

We look forward to supporting your USMLE journey.

Warm regards,
NextGen USMLE Student Success Team`,
    variables: ["student_name", "student_email", "login_url", "plans_url", "support_email"],
  },
  lms_credentials_access: {
    key: "lms_credentials_access",
    name: "LMS Credentials / Access",
    category: "Enrollment & Access",
    description: "Sent by admin credential actions or when LMS access details must be delivered.",
    enabled: true,
    subject: "Your NextGen USMLE LMS access is ready",
    body: `Hi {{student_name}},

Your NextGen USMLE LMS access is ready{{course_phrase}}.

Login email:
{{student_email}}

{{access_instructions}}

Open your dashboard:
{{dashboard_url}}

Please keep your credentials private. Our support team is available if you need assistance.

Warm regards,
NextGen USMLE Student Success Team`,
    variables: ["student_name", "student_email", "course_name", "course_phrase", "access_instructions", "dashboard_url", "login_url", "reset_url", "temporary_password", "support_email"],
  },
  demo_activated: {
    key: "demo_activated",
    name: "Demo Activated",
    category: "Demo Lifecycle",
    description: "Sent when a student explicitly activates the free LMS demo.",
    enabled: true,
    subject: "Your NextGen USMLE LMS demo is now active",
    body: `Hi {{student_name}},

Your NextGen USMLE LMS demo is now active{{course_phrase}}.

Demo access ends on:
{{expiry_date}}

Open your student dashboard:
{{dashboard_url}}

Use this time to explore the roadmap, live-class flow, assessments, flashcards, recordings, notes, and progress tools included in your demo settings.

Warm regards,
NextGen USMLE Student Success Team`,
    variables: ["student_name", "course_name", "course_phrase", "expiry_date", "dashboard_url", "plans_url", "support_email"],
  },
  demo_expiring: {
    key: "demo_expiring",
    name: "Demo Expiring",
    category: "Demo Lifecycle",
    description: "Sent before an active demo reaches its expiry date.",
    enabled: true,
    subject: "Your NextGen USMLE demo ends soon",
    body: `Hi {{student_name}},

Your NextGen USMLE LMS demo{{course_phrase}} ends in {{days_remaining}} day{{days_suffix}} on {{expiry_date}}.

Continue learning without interruption:
{{plans_url}}

Your account and existing learning records will remain secure. A paid plan is required to continue using locked LMS features after the demo ends.

Warm regards,
NextGen USMLE Student Success Team`,
    variables: ["student_name", "course_name", "course_phrase", "days_remaining", "days_suffix", "expiry_date", "plans_url", "support_email"],
  },
  demo_expired: {
    key: "demo_expired",
    name: "Demo Expired",
    category: "Demo Lifecycle",
    description: "Sent once when a student's demo has expired.",
    enabled: true,
    subject: "Your NextGen USMLE demo has ended — continue with a plan",
    body: `Hi {{student_name}},

Your NextGen USMLE LMS demo{{course_phrase}} has ended.

Choose a plan to restore full access:
{{plans_url}}

Your account remains available, and your existing LMS records are not deleted when the demo expires.

Warm regards,
NextGen USMLE Student Success Team`,
    variables: ["student_name", "course_name", "course_phrase", "expiry_date", "plans_url", "support_email"],
  },
  payment_successful: {
    key: "payment_successful",
    name: "Payment Successful",
    category: "Payment & Subscription",
    description: "Sent after Stripe, free checkout, or a valid 100% coupon completes successfully.",
    enabled: true,
    subject: "Payment confirmed — NextGen USMLE",
    body: `Hi {{student_name}},

Your NextGen USMLE checkout has been completed successfully.

Plan: {{plan_name}}
Amount: {{amount}}
Payment reference: {{payment_reference}}
Payment date: {{payment_date}}

Your payment and enrollment records are now connected to your LMS account.

Warm regards,
NextGen USMLE Student Success Team`,
    variables: ["student_name", "plan_name", "amount", "payment_reference", "payment_date", "course_name", "support_email"],
  },
  paid_enrollment_confirmed: {
    key: "paid_enrollment_confirmed",
    name: "Paid Enrollment Confirmed",
    category: "Enrollment & Access",
    description: "Sent when paid or scholarship access is successfully granted.",
    enabled: true,
    subject: "Enrollment confirmed — your NextGen USMLE access is active",
    body: `Hi {{student_name}},

Your enrollment has been confirmed{{course_phrase}}.

Plan: {{plan_name}}
Access expiry: {{access_expiry}}

Open your dashboard:
{{dashboard_url}}

You can now use the LMS features included in your plan.

Warm regards,
NextGen USMLE Student Success Team`,
    variables: ["student_name", "course_name", "course_phrase", "plan_name", "access_expiry", "dashboard_url", "login_url", "support_email"],
  },
  subscription_expiring: {
    key: "subscription_expiring",
    name: "Subscription Expiring",
    category: "Payment & Subscription",
    description: "Sent 7, 3, and 1 day before paid access expires.",
    enabled: true,
    subject: "Your NextGen USMLE access expires in {{days_remaining}} day{{days_suffix}}",
    body: `Hi {{student_name}},

Your NextGen USMLE access{{course_phrase}} expires in {{days_remaining}} day{{days_suffix}} on {{expiry_date}}.

Renew before expiry to avoid interruption:
{{plans_url}}

Your account and learning history remain protected.

Warm regards,
NextGen USMLE Student Success Team`,
    variables: ["student_name", "course_name", "course_phrase", "days_remaining", "days_suffix", "expiry_date", "plans_url", "support_email"],
  },
  subscription_expired: {
    key: "subscription_expired",
    name: "Subscription Expired",
    category: "Payment & Subscription",
    description: "Sent when paid access expires.",
    enabled: true,
    subject: "Your NextGen USMLE access has expired",
    body: `Hi {{student_name}},

Your paid NextGen USMLE access{{course_phrase}} has expired.

Renew your access here:
{{plans_url}}

Your LMS account and existing learning records remain secure.

Warm regards,
NextGen USMLE Student Success Team`,
    variables: ["student_name", "course_name", "course_phrase", "expiry_date", "plans_url", "support_email"],
  },
  live_class_reminder: {
    key: "live_class_reminder",
    name: "Live Class Reminder",
    category: "Learning Updates",
    description: "Sent before a scheduled live class according to the reminder-minute setting.",
    enabled: true,
    subject: "Live class reminder — {{class_title}} at {{class_time}}",
    body: `Hi {{student_name}},

Your NextGen USMLE live class is coming up soon.

Class: {{class_title}}
Course: {{course_name}}
Date: {{class_date}}
Time: {{class_time}}

Join from the LMS:
{{live_class_url}}

Please enter a few minutes early so you are ready when the session begins.

Warm regards,
NextGen USMLE Student Success Team`,
    variables: ["student_name", "class_title", "course_name", "class_date", "class_time", "live_class_url", "support_email"],
  },
  new_recording_published: {
    key: "new_recording_published",
    name: "New Recording Published",
    category: "Learning Updates",
    description: "Queued for active course students when a recording is publis