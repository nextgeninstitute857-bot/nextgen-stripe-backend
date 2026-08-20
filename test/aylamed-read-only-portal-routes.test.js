import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");

function route(method, path, nextPath) {
  const start = server.indexOf(`app.${method}("${path}"`);
  const end = server.indexOf(nextPath, start);
  assert.ok(start >= 0 && end > start, `${method.toUpperCase()} ${path} route must exist`);
  return server.slice(start, end);
}

test("student profile GET is read-only", () => {
  const source = route("get", "/api/ayla/profile", '\napp.put("/api/ayla/profile"');
  assert.match(source, /aylaV189CommunityProfile\(db, user, student, \{ persist: false \}\)/);
  assert.doesNotMatch(source, /writeAylaDb|mutateAylaDb/);
});

test("community GET routes never serialize the database", () => {
  const profile = route("get", "/api/ayla/community/profile", '\napp.get("/api/ayla/community/messages"');
  const messages = route("get", "/api/ayla/community/messages", '\napp.post("/api/ayla/community/messages"');
  assert.match(profile, /persist: false/);
  assert.doesNotMatch(profile, /writeAylaDb|mutateAylaDb/);
  assert.doesNotMatch(messages, /aylaV189CommunityProfile|writeAylaDb|mutateAylaDb/);
});

test("read-only community profiles are detached from the shared database cache", () => {
  const start = server.indexOf("function aylaV189CommunityProfile");
  const end = server.indexOf("\nfunction aylaV189Leaderboard", start);
  const source = server.slice(start, end);
  assert.match(source, /storedProfile && !persist \? \{ \.\.\.storedProfile \} : storedProfile/);
  assert.match(source, /if \(persist\) aylaSetItem/);
});
