const ACTIVE_RESPONSE_STATUSES = new Set(["queued", "in_progress"]);

function boundedNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(parsed)));
}

function responseStatus(response = {}) {
  return String(response.status || "").trim().toLowerCase();
}

function responseError(response = {}, fallback = "OpenAI background response failed") {
  const status = responseStatus(response) || "unknown";
  const message = String(
    response.error?.message
      || response.incomplete_details?.reason
      || response.cancelled_details?.reason
      || fallback,
  ).trim();
  const error = new Error(message);
  error.statusCode = 502;
  error.openAIResponseId = String(response.id || "");
  error.openAIResponseStatus = status;
  error.openAIResponseTerminal = true;
  return error;
}

function requestError(error, responseId = "") {
  if (error?.openAIResponseTerminal) return error;
  const statusCode = Number(error?.response?.status || error?.statusCode || 0);
  const wrapped = new Error(
    error?.response?.data?.error?.message
      || error?.response?.data?.message
      || error?.message
      || "OpenAI background response request failed",
  );
  wrapped.statusCode = statusCode || 500;
  wrapped.openAIResponseId = String(responseId || error?.openAIResponseId || "");
  wrapped.openAIResponseStatus = String(error?.openAIResponseStatus || "");
  wrapped.openAIResponseTerminal = Boolean(
    responseId
      && [400, 404, 410].includes(statusCode),
  );
  return wrapped;
}

async function notify(onUpdate, response, details = {}) {
  if (typeof onUpdate !== "function") return;
  try {
    await onUpdate(response, details);
  } catch (error) {
    error.openAIResponseId ||= String(response?.id || "");
    error.openAIResponseStatus ||= responseStatus(response);
    error.openAIResponseTerminal ||= false;
    throw error;
  }
}

export function openAIBackgroundResponseActive(response = {}) {
  return ACTIVE_RESPONSE_STATUSES.has(responseStatus(response));
}

export async function runOpenAIBackgroundResponse({
  httpClient,
  url = "https://api.openai.com/v1/responses",
  headers = {},
  payload = {},
  responseId = "",
  createTimeoutMs = 30_000,
  requestTimeoutMs = 30_000,
  pollIntervalMs = 5_000,
  maximumWaitMs = 30 * 60 * 1000,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now = () => Date.now(),
  onUpdate = null,
} = {}) {
  if (!httpClient?.post || !httpClient?.get) {
    throw new TypeError("An HTTP client with post and get methods is required");
  }
  const interval = boundedNumber(pollIntervalMs, 5_000, 250, 60_000);
  const maximumWait = boundedNumber(maximumWaitMs, 30 * 60 * 1000, 1_000, 60 * 60 * 1000);
  const requestTimeout = boundedNumber(requestTimeoutMs, 30_000, 1_000, 120_000);
  const startedAt = now();
  let response;
  let polls = 0;
  let currentResponseId = String(responseId || "").trim();

  try {
    if (currentResponseId) {
      const retrieved = await httpClient.get(
        `${url}/${encodeURIComponent(currentResponseId)}`,
        { headers, timeout: requestTimeout },
      );
      response = retrieved.data || {};
    } else {
      const created = await httpClient.post(
        url,
        {
          ...payload,
          background: true,
          store: payload.store === true,
        },
        {
          headers,
          timeout: boundedNumber(createTimeoutMs, 30_000, 1_000, 120_000),
        },
      );
      response = created.data || {};
      currentResponseId = String(response.id || "").trim();
      if (!currentResponseId) {
        throw Object.assign(new Error("OpenAI did not return a background response ID"), {
          statusCode: 502,
        });
      }
    }
  } catch (error) {
    throw requestError(error, currentResponseId);
  }

  await notify(onUpdate, response, {
    phase: currentResponseId === String(responseId || "").trim() && responseId ? "resumed" : "created",
    polls,
    elapsedMs: Math.max(0, now() - startedAt),
  });

  while (openAIBackgroundResponseActive(response)) {
    if (now() - startedAt >= maximumWait) {
      try {
        await httpClient.post(
          `${url}/${encodeURIComponent(currentResponseId)}/cancel`,
          {},
          { headers, timeout: requestTimeout },
        );
      } catch {
        // The timeout remains terminal for this local attempt even if cancellation races completion.
      }
      const error = new Error(`OpenAI background response exceeded ${maximumWait}ms and was cancelled`);
      error.statusCode = 504;
      error.openAIResponseId = currentResponseId;
      error.openAIResponseStatus = "cancelled_after_timeout";
      error.openAIResponseTerminal = true;
      throw error;
    }

    await sleep(interval);
    polls += 1;
    try {
      const retrieved = await httpClient.get(
        `${url}/${encodeURIComponent(currentResponseId)}`,
        { headers, timeout: requestTimeout },
      );
      response = retrieved.data || {};
    } catch (error) {
      throw requestError(error, currentResponseId);
    }
    await notify(onUpdate, response, {
      phase: "polled",
      polls,
      elapsedMs: Math.max(0, now() - startedAt),
    });
  }

  if (responseStatus(response) !== "completed") {
    throw responseError(response);
  }
  return response;
}
