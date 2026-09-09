import fs from "node:fs";
import path from "node:path";
import process from "node:process";

export const ROOT = process.cwd();
export const RESEARCH_ROOT = path.join(ROOT, "research", "usmle-step1-2026");
export const PILOT_ROOT = path.join(RESEARCH_ROOT, "pilot-100");
export const CONFIG_PATH = path.join(PILOT_ROOT, "config.json");
export const QUEUE_PATH = path.join(RESEARCH_ROOT, "coverage", "media-priority-queue-batch-001.json");
export const EXISTING_DRAFTS_ROOT = path.join(RESEARCH_ROOT, "drafts");
const RESPONSES_URL = "https://api.openai.com/v1/responses";

export function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, "utf8"));
}

export function writeJson(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, filename);
}

export function filesUnder(directory, suffix = ".json") {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(absolute, suffix) : entry.name.endsWith(suffix) ? [absolute] : [];
  }).sort();
}

export function isoRunId() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function extractOutputText(response) {
  if (typeof response?.output_text === "string" && response.output_text.trim()) return response.output_text;
  const texts = [];
  for (const item of response?.output || []) {
    if (item?.type !== "message") continue;
    for (const content of item.content || []) {
      if (content?.type === "output_text" && content.text) texts.push(content.text);
    }
  }
  return texts.join("\n").trim();
}

function modelFor(config, role) {
  const roleEnv = config.models?.[`${role}_env`];
  const fallbackEnv = config.models?.fallback_env;
  const value = String(process.env[roleEnv] || process.env[fallbackEnv] || "").trim();
  if (!value) throw new Error(`Missing model for ${role}; set ${roleEnv} or ${fallbackEnv}.`);
  return value;
}

export class Budget {
  constructor(config) {
    this.config = config;
    this.requests = 0;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.inputPrice = Number(process.env.AYLA_INPUT_USD_PER_MILLION);
    this.outputPrice = Number(process.env.AYLA_OUTPUT_USD_PER_MILLION);
  }

  estimatedCost() {
    if (!Number.isFinite(this.inputPrice) || !Number.isFinite(this.outputPrice)) return null;
    return (this.inputTokens / 1_000_000) * this.inputPrice + (this.outputTokens / 1_000_000) * this.outputPrice;
  }

  assertCanRequest() {
    const limits = this.config.limits;
    if (this.requests >= limits.maximum_api_requests) throw new Error("Pilot request ceiling reached.");
    if (this.inputTokens >= limits.maximum_total_input_tokens) throw new Error("Pilot input-token ceiling reached.");
    if (this.outputTokens >= limits.maximum_total_output_tokens) throw new Error("Pilot output-token ceiling reached.");
    const cost = this.estimatedCost();
    if (cost !== null && cost >= limits.maximum_estimated_cost_usd) throw new Error("Pilot estimated-dollar ceiling reached.");
  }

  record(response) {
    this.requests += 1;
    this.inputTokens += Number(response?.usage?.input_tokens || 0);
    this.outputTokens += Number(response?.usage?.output_tokens || 0);
    const limits = this.config.limits;
    if (this.inputTokens > limits.maximum_total_input_tokens) throw new Error("Pilot exceeded input-token ceiling.");
    if (this.outputTokens > limits.maximum_total_output_tokens) throw new Error("Pilot exceeded output-token ceiling.");
    const cost = this.estimatedCost();
    if (cost !== null && cost > limits.maximum_estimated_cost_usd) throw new Error("Pilot exceeded estimated-dollar ceiling.");
  }

  snapshot() {
    return {
      requests: this.requests,
      input_tokens: this.inputTokens,
      output_tokens: this.outputTokens,
      estimated_cost_usd: this.estimatedCost(),
    };
  }
}

export async function callResponses({ config, budget, role, instructions, input, schemaName, schema }) {
  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is required for execution.");
  budget.assertCanRequest();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.limits.request_timeout_ms);
  try {
    const response = await fetch(RESPONSES_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelFor(config, role),
        instructions,
        input,
        tools: [{
          type: "web_search",
          search_context_size: "medium",
          filters: { allowed_domains: config.research.allowed_domains },
        }],
        tool_choice: "auto",
        text: { format: { type: "json_schema", name: schemaName, strict: true, schema } },
        max_output_tokens: role === "planner" ? 12000 : 9000,
        store: false,
      }),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`OpenAI ${role} request failed (${response.status}): ${data?.error?.message || response.statusText}`);
    budget.record(data);
    const text = extractOutputText(data);
    if (!text) throw new Error(`OpenAI ${role} response contained no output text.`);
    return { data: JSON.parse(text), responseId: data.id, usage: data.usage || {} };
  } finally {
    clearTimeout(timeout);
  }
}
