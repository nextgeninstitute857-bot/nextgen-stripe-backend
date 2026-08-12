const EXPERIENCE = Object.freeze({
  usmle: {
    siteId: 'usmle',
    examTrackIds: ['usmle_step_1', 'usmle_step_2_ck', 'usmle_step_3'],
    eyebrow: 'USMLE preparation',
    headline: 'Your USMLE preparation has got a brain.',
    subheadline: 'One adaptive AylaMed account for Step 1, Step 2 CK and Step 3.',
    examSelectorLabel: 'Choose your USMLE exam',
    examLabels: ['USMLE Step 1', 'USMLE Step 2 CK', 'USMLE Step 3'],
    tabs: { diagnostic: 'USMLE Readiness', qbank: 'USMLE QBank', roadmap: 'USMLE Roadmap', tutor: 'Personal Tutor' },
  },
  mccqe: {
    siteId: 'mccqe', examTrackIds: ['mccqe'], eyebrow: 'MCCQE preparation',
    headline: 'Your MCCQE preparation has got a brain.',
    subheadline: 'Canadian clinical decisions, physician activities and dimensions of care—adapted daily.',
    examSelectorLabel: 'MCCQE', examLabels: ['MCCQE'],
    tabs: { diagnostic: 'MCCQE Readiness', qbank: 'MCCQE QBank', roadmap: 'MCCQE Roadmap', tutor: 'Personal Tutor' },
  },
  amc: {
    siteId: 'amc', examTrackIds: ['amc'], eyebrow: 'AMC preparation',
    headline: 'Your AMC preparation has got a brain.',
    subheadline: 'Australian clinical reasoning across patient groups, disciplines and clinical tasks.',
    examSelectorLabel: 'AMC', examLabels: ['AMC'],
    tabs: { diagnostic: 'AMC Readiness', qbank: 'AMC QBank', roadmap: 'AMC Roadmap', tutor: 'Personal Tutor' },
  },
  nclex: {
    siteId: 'nclex', examTrackIds: ['nclex'], eyebrow: 'NCLEX preparation',
    headline: 'Your NCLEX preparation has got a brain.',
    subheadline: 'Clinical judgment, priority, safety and delegation—adapted to every study day.',
    examSelectorLabel: 'NCLEX', examLabels: ['NCLEX'],
    tabs: { diagnostic: 'Clinical Judgment Diagnostic', qbank: 'NCLEX QBank', roadmap: 'NCLEX Study Plan', tutor: 'Personal Tutor' },
  },
  plab: {
    siteId: 'plab', examTrackIds: ['plab'], eyebrow: 'PLAB preparation',
    headline: 'Your PLAB preparation has got a brain.',
    subheadline: 'UK practice, communication and safe clinical decisions—adapted daily.',
    examSelectorLabel: 'PLAB', examLabels: ['PLAB'],
    tabs: { diagnostic: 'PLAB Readiness', qbank: 'PLAB QBank', roadmap: 'PLAB Roadmap', tutor: 'Personal Tutor' },
  },
});

export function examExperience(siteId = 'usmle') {
  return EXPERIENCE[String(siteId || '').toLowerCase()] || EXPERIENCE.usmle;
}

export function examExperienceFromConfig(config = {}) {
  const site = config.site || config;
  return site.branding
    ? { ...examExperience(site.id), ...site.branding, siteId: site.id }
    : examExperience(site.id || config.active_site_id);
}

export { EXPERIENCE as EXAM_EXPERIENCES };
