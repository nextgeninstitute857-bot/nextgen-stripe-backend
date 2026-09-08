// A request-local lookup preserves source order and the legacy exact-match
// precedence. Callers still enforce current student/publication eligibility.
export function createAylaResourceMappingIndex(resources, { examTrack, resourceType, mappingKey }) {
  const exams = new Map();
  const first = (map, key, value) => { if (!map.has(key)) map.set(key, value); };
  const topicKey = (system, topic, subsystem = "") => JSON.stringify([system, topic, subsystem]);
  for (const row of resources) {
    if (row.approved === false || row.status === "quarantined"
      || ["disabled", "deleted", "rejected", "archived"].includes(String(row.status || "").toLowerCase())) continue;
    const exam = examTrack(row.examTrackId || row.examTrack || row.exam_track || row.exam);
    if (!exams.has(exam)) exams.set(exam, { ids: new Map(), books: new Map(), videos: new Map() });
    const bucket = exams.get(exam);
    first(bucket.ids, String(row.id), row);
    const type = resourceType(row.type);
    const target = ["book", "reading", "revision_sheet"].includes(type) ? bucket.books
      : ["vimeo_video", "video_transcript"].includes(type) ? bucket.videos : null;
    if (!target) continue;
    const system = mappingKey(row.system);
    const topic = mappingKey(row.topic);
    const subsystem = mappingKey(row.subsystem);
    first(target, topicKey(system, topic), row);
    if (subsystem) first(target, topicKey(system, topic, subsystem), row);
  }
  return {
    resolve(resource) {
      const bucket = exams.get(examTrack(resource.examTrackId || resource.examTrack || resource.exam_track || resource.exam));
      if (!bucket) return { book: null, video: null };
      const topic = mappingKey(resource.topic);
      const key = topicKey(mappingKey(resource.system), topic, mappingKey(resource.subsystem));
      return {
        book: (resource.mappedBookResourceId && bucket.ids.get(String(resource.mappedBookResourceId)))
          || (topic && bucket.books.get(key)) || null,
        video: (resource.mappedVideoResourceId && bucket.ids.get(String(resource.mappedVideoResourceId)))
          || (topic && bucket.videos.get(key)) || null,
      };
    },
  };
}
