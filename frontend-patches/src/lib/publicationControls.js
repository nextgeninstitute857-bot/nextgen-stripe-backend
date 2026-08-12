async function request(apiBase, path, options = {}) {
  const response = await fetch(`${String(apiBase || '').replace(/\/$/, '')}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Publication request failed (${response.status})`);
  return payload;
}

export function loadExamPublicationControls(apiBase) {
  return request(apiBase, '/api/ayla/admin/publication-controls');
}

export function saveExamPublication(apiBase, examTrackId, enabled) {
  return request(apiBase, `/api/ayla/admin/publication-controls/exams/${encodeURIComponent(examTrackId)}`, {
    method: 'PUT',
    body: JSON.stringify({ enabled }),
  });
}

export function saveResourcePublication(apiBase, resource, patch) {
  return request(apiBase, `/api/ayla/admin/publication-controls/resources/${encodeURIComponent(resource.resourceType)}/${encodeURIComponent(resource.resourceId)}`, {
    method: 'PUT',
    body: JSON.stringify({ examTrackId: resource.examTrackId, ...patch }),
  });
}
