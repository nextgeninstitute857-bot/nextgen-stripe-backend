import React from 'react';
import { examExperience } from '@/config/examExperience';

export default function ExamLandingPage({ siteId, onStart, onLogin }) {
  const experience = examExperience(siteId);
  return (
    <main className={`exam-landing exam-landing--${experience.siteId}`} data-exam-site={experience.siteId}>
      <section className="mx-auto grid min-h-[76vh] max-w-7xl items-center gap-10 px-6 py-16 lg:grid-cols-[1.05fr_.95fr]">
        <div>
          <p className="mb-4 text-sm font-semibold uppercase tracking-[.18em] text-teal-700">{experience.eyebrow}</p>
          <h1 className="max-w-3xl text-4xl font-semibold tracking-tight text-slate-950 sm:text-6xl">{experience.headline}</h1>
          <p className="mt-6 max-w-2xl text-lg leading-8 text-slate-600">{experience.subheadline}</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <button type="button" className="medical-button-primary" onClick={() => onStart?.(experience.examTrackIds[0])}>Start preparing</button>
            <button type="button" className="medical-button-secondary" onClick={onLogin}>Sign in</button>
          </div>
        </div>
        <div className="rounded-[2rem] border border-slate-200 bg-white p-5 shadow-xl shadow-slate-200/50">
          <p className="mb-4 text-sm font-semibold text-slate-500">{experience.examSelectorLabel}</p>
          {experience.examLabels.map((label, index) => (
            <button
              type="button"
              key={experience.examTrackIds[index]}
              onClick={() => onStart?.(experience.examTrackIds[index])}
              className="mb-3 flex w-full items-center justify-between rounded-2xl border border-slate-200 px-5 py-4 text-left font-semibold text-slate-900 hover:border-teal-500 hover:bg-teal-50"
            >
              <span>{label}</span><span aria-hidden="true">→</span>
            </button>
          ))}
          <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
            {Object.values(experience.tabs).map((label) => <div key={label} className="rounded-xl bg-slate-50 px-3 py-3 text-slate-700">{label}</div>)}
          </div>
        </div>
      </section>
    </main>
  );
}
