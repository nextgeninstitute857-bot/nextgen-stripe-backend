const optionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "text_html"],
  properties: {
    id: { type: "integer", minimum: 1, maximum: 5 },
    text_html: { type: "string" },
  },
};

export const objectiveSchema = {
  type: "object",
  additionalProperties: false,
  required: ["objectives"],
  properties: {
    objectives: {
      type: "array",
      minItems: 20,
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "seed_id", "system", "subsystem", "topic", "subtopic",
          "learning_objective", "difficulty", "media_required", "media_type", "research_queries",
        ],
        properties: {
          seed_id: { type: "string" },
          system: { type: "string" },
          subsystem: { type: "string" },
          topic: { type: "string" },
          subtopic: { type: "string" },
          learning_objective: { type: "string" },
          difficulty: { type: "string", enum: ["easy", "moderate", "hard"] },
          media_required: { type: "boolean" },
          media_type: { type: "string" },
          research_queries: { type: "array", minItems: 1, maxItems: 4, items: { type: "string" } },
        },
      },
    },
  },
};

export const questionSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "draft_id", "exam_track", "taxonomy", "difficulty", "stem_html", "options",
    "correct_option_id", "explanation_html", "wrong_choice_explanations",
    "educational_objective", "media_spec", "references",
  ],
  properties: {
    draft_id: { type: "string" },
    exam_track: { type: "string", enum: ["usmle-step-1"] },
    taxonomy: {
      type: "object",
      additionalProperties: false,
      required: ["system", "subsystem", "topic", "subtopic"],
      properties: {
        system: { type: "string" },
        subsystem: { type: "string" },
        topic: { type: "string" },
        subtopic: { type: "string" },
      },
    },
    difficulty: { type: "string", enum: ["easy", "moderate", "hard"] },
    stem_html: { type: "string" },
    options: { type: "array", minItems: 5, maxItems: 5, items: optionSchema },
    correct_option_id: { type: "integer", minimum: 1, maximum: 5 },
    explanation_html: { type: "string" },
    wrong_choice_explanations: {
      type: "array",
      minItems: 4,
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["option_id", "explanation"],
        properties: {
          option_id: { type: "integer", minimum: 1, maximum: 5 },
          explanation: { type: "string" },
        },
      },
    },
    educational_objective: { type: "string" },
    media_spec: {
      type: "object",
      additionalProperties: false,
      required: ["required", "type", "description", "ownership_requirement"],
      properties: {
        required: { type: "boolean" },
        type: { type: "string" },
        description: { type: "string" },
        ownership_requirement: {
          type: "string",
          enum: ["AylaMed original or verified licensed/public-domain"],
        },
      },
    },
    references: {
      type: "array",
      minItems: 2,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["citation", "url", "source_type"],
        properties: {
          citation: { type: "string" },
          url: { type: "string" },
          source_type: { type: "string" },
        },
      },
    },
  },
};

export const reviewSchema = {
  type: "object",
  additionalProperties: false,
  required: ["decision", "scores", "risk_flags", "review_notes", "final_question"],
  properties: {
    decision: { type: "string", enum: ["accept", "revise", "reject"] },
    scores: {
      type: "object",
      additionalProperties: false,
      required: [
        "medical_accuracy", "single_best_answer", "distractor_quality",
        "explanation_quality", "citation_support", "originality",
      ],
      properties: {
        medical_accuracy: { type: "integer", minimum: 1, maximum: 5 },
        single_best_answer: { type: "integer", minimum: 1, maximum: 5 },
        distractor_quality: { type: "integer", minimum: 1, maximum: 5 },
        explanation_quality: { type: "integer", minimum: 1, maximum: 5 },
        citation_support: { type: "integer", minimum: 1, maximum: 5 },
        originality: { type: "integer", minimum: 1, maximum: 5 },
      },
    },
    risk_flags: { type: "array", items: { type: "string" } },
    review_notes: { type: "string" },
    final_question: questionSchema,
  },
};
