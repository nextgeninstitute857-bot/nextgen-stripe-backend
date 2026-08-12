# AylaMed frontend merge patch

The full frontend repository is not present in this workspace. These source files are merge-ready additions for that repository:

- `src/config/examExperience.js` — USMLE shared-site and standalone MCCQE, AMC, NCLEX and PLAB terminology.
- `src/components/ExamLandingPage.jsx` — domain-driven landing hero and exam/tablet selector.
- `src/components/admin/ExamPublicationPanel.jsx` — master exam and per-resource publication switches.
- `src/lib/publicationControls.js` — API client for the publication control routes.

After copying these paths into the frontend repository:

1. Resolve the active site from `GET /api/ayla/exam-sites` or `GET /api/ayla/public-config`.
2. Render `ExamLandingPage` with `siteId` from that response.
3. Mount `ExamPublicationPanel` in the authenticated Control Center and provide the save handlers from `publicationControls.js`.
4. Keep USMLE on one host with its three-track selector. The other four hosts remain pinned to their single exam.

No production route, host or resource is published by this patch.
