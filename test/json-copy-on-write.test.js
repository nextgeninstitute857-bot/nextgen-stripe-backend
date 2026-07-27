import test from "node:test";
import assert from "node:assert/strict";

import { mutateJsonCopyOnWrite } from "../lib/json-copy-on-write.js";

test("copy-on-write mutation preserves untouched branches", async () => {
  const source = {
    students: {
      one: { id: "one", progress: { answered: 1 } },
      two: { id: "two", progress: { answered: 4 } },
    },
    resources: {
      large: Array.from({ length: 10_000 }, (_, index) => ({ id: index, text: `resource-${index}` })),
    },
  };

  const mutation = await mutateJsonCopyOnWrite(source, async (draft) => {
    draft.students.one.progress.answered += 1;
    draft.students.one.status = "active";
    return { student: draft.students.one };
  });

  assert.equal(source.students.one.progress.answered, 1);
  assert.equal(source.students.one.status, undefined);
  assert.equal(mutation.value.students.one.progress.answered, 2);
  assert.equal(mutation.value.students.one.status, "active");
  assert.equal(mutation.result.student, mutation.value.students.one);
  assert.equal(mutation.value.resources, source.resources);
  assert.equal(mutation.value.resources.large, source.resources.large);
  assert.ok(mutation.stats.cloned_nodes < 8);
});

test("copy-on-write mutation supports arrays, deletion and object enumeration", async () => {
  const source = {
    queue: [{ id: "a" }, { id: "b" }],
    records: { a: { id: "a", state: "queued" }, b: { id: "b", state: "queued" } },
  };

  const mutation = await mutateJsonCopyOnWrite(source, (draft) => {
    assert.deepEqual(Object.values(draft.records).map((row) => row.id), ["a", "b"]);
    draft.queue.push({ id: "c" });
    draft.queue.splice(0, 1);
    delete draft.records.a;
    draft.records.b.state = "complete";
    return draft.records.b;
  });

  assert.deepEqual(source.queue.map((row) => row.id), ["a", "b"]);
  assert.deepEqual(mutation.value.queue.map((row) => row.id), ["b", "c"]);
  assert.deepEqual(Object.keys(mutation.value.records), ["b"]);
  assert.equal(source.records.b.state, "queued");
  assert.equal(mutation.value.records.b.state, "complete");
  assert.equal(mutation.result, mutation.value.records.b);
});

test("copy-on-write mutation leaves the source unchanged when the mutator fails", async () => {
  const source = { nested: { value: 1 }, rows: [{ id: 1 }] };

  await assert.rejects(
    mutateJsonCopyOnWrite(source, (draft) => {
      draft.nested.value = 2;
      draft.rows.push({ id: 2 });
      throw new Error("stop");
    }),
    /stop/,
  );

  assert.deepEqual(source, { nested: { value: 1 }, rows: [{ id: 1 }] });
});
