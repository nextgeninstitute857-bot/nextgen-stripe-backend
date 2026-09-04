const EXAM_TRACK_PATTERNS = [
  ["mccqe", /\b(?:mccqe(?:\s*(?:part|p)?\s*1)?|medical council of canada qualifying examination)\b/i],
  ["usmle_step3", /\b(?:usmle\s*)?(?:step\s*3|step3|ccs)\b/i],
  ["usmle_step2_ck", /\b(?:usmle\s*)?(?:step\s*2(?:\s*ck)?|step2(?:ck)?|2\s*ck)\b/i],
  ["usmle_step1", /\b(?:usmle\s*)?(?:step\s*1|step1)\b|\busmle\b/i],
  ["plab", /\b(?:plab(?:\s*[12])?|ukmla)\b/i],
  ["nclex", /\bnclex(?:[-\s]*rn)?\b/i],
  ["amc", /\b(?:amc\s*(?:exam|clinical)?|australian medical council)\b/i],
];

const IRRELEVANT_SOLICITATION_RULES = [
  {
    reason: "seo_sales",
    pattern: /\b(?:seo|search engine optimi[sz]ation|backlinks?|google ranking|rank (?:your|the) website|website traffic service)\b/i,
  },
  {
    reason: "design_sales",
    pattern: /\b(?:graphic design(?:er|ing)?|logo design|website redesign|web design services?|creative design services?|i (?:can|will) design (?:your|a) (?:logo|website|poster|flyer))\b/i,
  },
  {
    reason: "job_request",
    pattern: /\b(?:are you hiring|any (?:job|vacanc(?:y|ies))|job (?:opening|opportunit(?:y|ies))|looking for (?:a )?(?:job|work)|seeking (?:a )?(?:job|employment)|hire me|work for (?:you|your company)|internship|cv attached|resume attached)\b/i,
  },
  {
    reason: "partnership_request",
    pattern: /\b(?:business partnership|partnership proposal|collaboration proposal|affiliate partnership|sponsorship proposal|brand collaboration|partner with (?:you|your company))\b/i,
  },
  {
    reason: "marketing_sales",
    pattern: /\b(?:digital marketing services?|social media marketing|lead generation services?|marketing agency|manage your (?:meta |facebook |instagram )?ads|grow your (?:business|page|followers)|increase your sales)\b/i,
  },
];

const STRONG_STUDENT_INTENT = [
  /\b(?:i am|i'm|im|i’m|myself as)\b.{0,45}\b(?:candidate|aspirant|preparing|studying)\b/i,
  /\b(?:i am|i'm|im|i’m)\b.{0,25}\b(?:doctor|physician|medical student|med student|graduate|img)\b.{0,55}\b(?:preparing|studying|candidate|aspirant|exam|course|demo|trial|qbank|question bank)\b/i,
  /\b(?:i|we)\b.{0,35}\b(?:want|need|would like|plan|hope)\b.{0,40}\b(?:prepare|study|join|enrol|enroll|access|demo|trial|course|qbank|question bank|lecture|flashcards?|diagnostic)\b/i,
  /\b(?:preparing|studying|sitting|appearing)\b.{0,30}\b(?:mccqe|usmle|step\s*[123]|plab|nclex|amc)\b/i,
];

const STUDENT_INTEREST = /\b(?:mccqe|usmle|step\s*[123]|plab|ukmla|nclex|amc|medical exam|exam prep|question bank|qbank|baseline diagnostic|flashcards?|lectures?|course|demo|trial|price|pricing|fees?|enrol|enroll|subscription|study plan)\b/i;

function routingText(parts = []) {
  return parts
    .flatMap((part) => (part == null ? [] : [String(part)]))
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" \n ");
}

export function inferLeadExamTrack(input = {}) {
  const explicit = String(input.exam_track || input.examTrack || input.track || "").trim().toLowerCase();
  if (["mccqe", "usmle_step1", "usmle_step2_ck", "usmle_step3", "plab", "nclex", "amc"].includes(explicit)) {
    return explicit;
  }

  const text = routingText([
    input.meta_ad_headline,
    input.meta_ad_body,
    input.ad_name,
    input.campaign_name,
    input.source_campaign,
    input.source_text,
    input.last_message,
    input.message,
    input.text,
    input.exam_type,
  ]);

  for (const [track, pattern] of EXAM_TRACK_PATTERNS) {
    if (pattern.test(text)) return track;
  }
  return "";
}

export function classifyInboundLead({ text = "", lead = {} } = {}) {
  const inboundText = String(text || "").trim();
  const directExamTrack = inferLeadExamTrack({ source_text: inboundText });
  const contextText = routingText([
    lead.meta_ad_headline,
    lead.meta_ad_body,
    lead.ad_name,
    lead.campaign_name,
    lead.source_campaign,
    inboundText,
  ]);
  const examTrack = inferLeadExamTrack({
    meta_ad_headline: lead.meta_ad_headline,
    meta_ad_body: lead.meta_ad_body,
    ad_name: lead.ad_name,
    campaign_name: lead.campaign_name,
    source_campaign: lead.source_campaign,
    source_text: inboundText,
  }) || inferLeadExamTrack(lead);
  const hasStrongStudentIntent = STRONG_STUDENT_INTENT.some((pattern) => pattern.test(inboundText));

  for (const rule of IRRELEVANT_SOLICITATION_RULES) {
    const examRelatedCareerQuestion = rule.reason === "job_request" && Boolean(directExamTrack);
    if (rule.pattern.test(inboundText) && !hasStrongStudentIntent && !examRelatedCareerQuestion) {
      return {
        relevance: "irrelevant",
        reason: rule.reason,
        suppress_ai: true,
        exam_track: examTrack,
        direct_exam_intent: Boolean(directExamTrack || hasStrongStudentIntent),
      };
    }
  }

  if (examTrack || STUDENT_INTEREST.test(contextText)) {
    return { relevance: "exam_lead", reason: "exam_interest", suppress_ai: false, exam_track: examTrack, direct_exam_intent: Boolean(directExamTrack || hasStrongStudentIntent) };
  }

  return { relevance: "unknown", reason: "needs_qualification", suppress_ai: false, exam_track: examTrack, direct_exam_intent: Boolean(directExamTrack || hasStrongStudentIntent) };
}

export function applyLeadInboxRouting(lead = {}, { text = "", at = new Date().toISOString() } = {}) {
  const classification = classifyInboundLead({ text, lead });
  const existingTrack = inferLeadExamTrack({ exam_track: lead.exam_track || lead.examTrack || lead.track || "" });
  const examTrack = classification.exam_track || existingTrack;

  if (examTrack) {
    lead.exam_track = examTrack;
  }

  if (classification.suppress_ai) {
    lead.inbox_bucket = "filtered";
    lead.lead_relevance = "irrelevant";
    lead.irrelevant_reason = classification.reason;
    lead.irrelevant_filter_active = true;
    lead.ai_suppressed = true;
    lead.ai_suppressed_reason = "deterministic_irrelevant_filter";
    lead.filtered_at = at;
    lead.filtered_last_message = String(text || "").trim().slice(0, 500);
    return classification;
  }

  // A later genuine exam message restores a previously filtered contact.
  const filteredByThisRouter = lead.irrelevant_filter_active === true || lead.ai_suppressed_reason === "deterministic_irrelevant_filter";
  const mayRestoreFilteredLead = !filteredByThisRouter || classification.direct_exam_intent === true;
  if (classification.relevance === "exam_lead" && mayRestoreFilteredLead) {
    lead.lead_relevance = "exam_lead";
    lead.irrelevant_reason = null;
    lead.irrelevant_filter_active = false;
    const independentlyStopped = Boolean(lead.suppressed || lead.stop_requested || lead.do_not_contact || lead.opted_out || lead.opt_out || lead.unsubscribed);
    if (lead.ai_suppressed_reason === "deterministic_irrelevant_filter" && !independentlyStopped) {
      lead.ai_suppressed = false;
      lead.ai_suppressed_reason = null;
    } else if (lead.ai_suppressed !== true) {
      lead.ai_suppressed = false;
    }
    lead.filtered_at = null;
    lead.filtered_last_message = null;
  } else if (!lead.lead_relevance) {
    lead.lead_relevance = "unknown";
  }

  if (filteredByThisRouter && classification.direct_exam_intent !== true) {
    lead.inbox_bucket = "filtered";
    return classification;
  }

  lead.inbox_bucket = examTrack ? `exam:${examTrack}` : "unassigned";
  return classification;
}
