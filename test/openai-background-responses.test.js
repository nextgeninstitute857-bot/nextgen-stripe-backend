import test from "node:test";
import assert from "node:assert/strict";
import {
  openAIBackgroundResponseActive,
  runOpenAIBackgroundResponse,
} from "../lib/openai-background-responses.js";

test("background responses are created, polled, and returned after completion", async () => {
  const posts = [];
  const gets = [];
  const updates = [];
  const pollResults = [
    { id: "resp_1", status: "in_progress" },
    { id: "resp_1", status: "completed", output: [{ type: "message" }] },
  ];
  const httpClient = {
    async post(url, payload, options) {
      posts.push({ url, payload, options });
      return { data: { id: "resp_1", status: "queued" } };
    },
    async get(url, options) {
      gets.push({ url, options });
      return { data: pollResults.shift() };
    },
  };

  const result = await runOpenAIBackgroundResponse({
    httpClient,
    headers: { Authorization: "Bearer test" },
    payload: { model: "gpt-test", input: "classify" },
    pollIntervalMs: 250,
    sleep: async () => {},
    onUpdate: async (response, details) => {
      updates.push({ status: response.status, phase: details.phase });
    },
  });

  assert.equal(result.status, "completed");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].payload.background, true);
  assert.equal(posts[0].payload.store, false);
  assert.equal(gets.length, 2);
  assert.deepEqual(
    updates.map((row) => row.status),
    ["queued", "in_progress", "completed"],
  );
  assert.equal(openAIBackgroundResponseActive({ status: "queued" }), true);
  assert.equal(openAIBackgroundResponseActive({ status: "completed" }), false);
});

test("an existing response ID resumes without creating a duplicate response", async () => {
  let posts = 0;
  const httpClient = {
    async post() {
      posts += 1;
      throw new Error("create should not run");
    },
    async get(url) {
      assert.match(url, /\/responses\/resp_existing$/);
      return { data: { id: "resp_existing", status: "completed", output: [] } };
    },
  };

  const result = await runOpenAIBackgroundResponse({
    httpClient,
    responseId: "resp_existing",
  });
  assert.equal(result.id, "resp_existing");
  assert.equal(posts, 0);
});

test("terminal provider failures are marked so a queue retry can create a new response", async () => {
  const httpClient = {
    async post() {
      return { data: { id: "resp_failed", status: "failed", error: { message: "search failed" } } };
    },
    async get() {
      throw new Error("poll should not run");
    },
  };

  await assert.rejects(
    runOpenAIBackgroundResponse({ httpClient }),
    (error) => {
      assert.equal(error.message, "search failed");
      assert.equal(error.openAIResponseId, "resp_failed");
      assert.equal(error.openAIResponseStatus, "failed");
      assert.equal(error.openAIResponseTerminal, true);
      return true;
    },
  );
});

test("a response that exceeds the local safety window is cancelled", async () => {
  let currentTime = 0;
  const posts = [];
  const httpClient = {
    async post(url) {
      posts.push(url);
      if (url.endsWith("/cancel")) {
        return { data: { id: "resp_slow", status: "cancelled" } };
      }
      return { data: { id: "resp_slow", status: "queued" } };
    },
    async get() {
      return { data: { id: "resp_slow", status: "in_progress" } };
    },
  };

  await assert.rejects(
    runOpenAIBackgroundResponse({
      httpClient,
      pollIntervalMs: 250,
      maximumWaitMs: 1_000,
      now: () => currentTime,
      sleep: async (milliseconds) => {
        currentTime += milliseconds;
      },
    }),
    (error) => {
      assert.equal(error.statusCode, 504);
      assert.equal(error.openAIResponseId, "resp_slow");
      assert.equal(error.openAIResponseTerminal, true);
      return true;
    },
  );
  assert.ok(posts.some((url) => url.endsWith("/responses/resp_slow/cancel")));
});
