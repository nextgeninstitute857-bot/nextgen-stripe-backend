import React from 'react';

function Toggle({ checked, disabled, onChange, label }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-3">
      <input type="checkbox" className="sr-only" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span className={`relative h-6 w-11 rounded-full transition ${checked ? 'bg-teal-600' : 'bg-slate-300'} ${disabled ? 'opacity-50' : ''}`}>
        <span className={`absolute top-1 h-4 w-4 rounded-full bg-white transition ${checked ? 'left-6' : 'left-1'}`} />
      </span>
      <span className="text-sm font-medium text-slate-700">{label}</span>
    </label>
  );
}

export default function ExamPublicationPanel({ panel, onExamChange, onResourceChange, savingId = '' }) {
  return (
    <div className="space-y-5">
      {(panel?.exams || []).map((exam) => {
        const controls = (panel?.resources || []).filter((resource) => resource.examTrackId === exam.examTrackId);
        const controlByKey = new Map(controls.map((resource) => [`${resource.resourceType}:${resource.resourceId}`, resource]));
        const available = (panel?.available_resources || []).filter((resource) => resource.exam_track_id === exam.examTrackId);
        const availableKeys = new Set(available.map((resource) => `${resource.type}:${resource.id}`));
        const resources = [
          ...available.map((resource) => {
            const control = controlByKey.get(`${resource.type}:${resource.id}`);
            return {
              ...(control || {}),
              id: control?.id || `${exam.examTrackId}:${resource.type}:${resource.id}`,
              examTrackId: exam.examTrackId,
              resourceType: resource.type,
              resourceId: resource.id,
              enabled: control?.enabled !== false,
              inherited: !control,
              title: resource.title || resource.id,
              status: resource.status || 'active',
            };
          }),
          ...controls.filter((resource) => !availableKeys.has(`${resource.resourceType}:${resource.resourceId}`)),
        ];
        return (
          <section key={exam.id} className="rounded-2xl border border-slate-200 bg-white p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div><h3 className="font-semibold text-slate-950">{exam.examTrackId.replaceAll('_', ' ').toUpperCase()}</h3><p className="text-sm text-slate-500">Master publication switch</p></div>
              <Toggle checked={exam.enabled} disabled={savingId === exam.id} label={exam.enabled ? 'Published' : 'Unpublished'} onChange={(enabled) => onExamChange?.(exam, enabled)} />
            </div>
            <div className="mt-4 divide-y divide-slate-100 border-t border-slate-100">
              {resources.map((resource) => (
                <div key={resource.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div><p className="text-sm font-medium text-slate-800">{resource.title || resource.resourceId}</p><p className="text-xs text-slate-500">{resource.resourceType.replaceAll('_', ' ')}{resource.inherited ? ' · follows exam default' : ''}</p></div>
                  <Toggle checked={resource.enabled} disabled={savingId === resource.id} label={resource.enabled ? 'Available' : 'Hidden'} onChange={(enabled) => onResourceChange?.(resource, enabled)} />
                </div>
              ))}
              {!resources.length && <p className="py-4 text-sm text-slate-500">No approved resources are available for this exam yet.</p>}
            </div>
          </section>
        );
      })}
      <p className="text-sm text-slate-500">Turning an exam off preserves student progress, history and every saved resource setting.</p>
    </div>
  );
}
