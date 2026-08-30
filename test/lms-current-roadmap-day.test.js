import test from "node:test";
import assert from "node:assert/strict";

import { selectStudentCurrentRoadmapDay } from "../lib/lms-current-roadmap-day.js";

const cardiologyDay1 = {
  id: "cardiology-day-1",
  date: "2026-07-02",
  title: "Cardiology — Day 1",
  system: "Cardiology",
};

const saturdayHoliday = {
  id: "holiday-aug-29",
  date: "2026-08-29",
  title: "Holiday / No Live Class",
  status: "holiday",
};

const cnsDay7 = {
  id: "cns-day-7",
  date: "2026-08-31",
  title: "Central Nervous System — Day 7",
  system: "Central Nervous System",
  system_day: 7,
};

const cnsDay8 = {
  id: "cns-day-8",
  date: "2026-09-01",
  title: "Central Nervous System — Day 8",
  system: "Central Nervous System",
  system_day: 8,
};

const days = [cardiologyDay1, saturdayHoliday, cnsDay7, cnsDay8];
const teachingDays = [cardiologyDay1, cnsDay7, cnsDay8];

test("an exact holiday remains today's dashboard focus", () => {
  assert.equal(selectStudentCurrentRoadmapDay({ days, teachingDays, today: "2026-08-29" }), saturdayHoliday);
});

test("an unscheduled Sunday advances a new demo to the next CNS class", () => {
  assert.equal(selectStudentCurrentRoadmapDay({ days, teachingDays, today: "2026-08-30" }), cnsDay7);
});

test("a new demo never falls back to historical Cardiology Day 1 when future teaching exists", () => {
  const selected = selectStudentCurrentRoadmapDay({ days, teachingDays, today: "2026-08-30" });
  assert.equal(selected.title, "Central Nervous System — Day 7");
  assert.notEqual(selected.id, cardiologyDay1.id);
});

test("an exact teaching date wins", () => {
  assert.equal(selectStudentCurrentRoadmapDay({ days, teachingDays, today: "2026-09-01" }), cnsDay8);
});

test("after the published schedule ends the most recent class is retained", () => {
  assert.equal(selectStudentCurrentRoadmapDay({ days, teachingDays, today: "2026-09-10" }), cnsDay8);
});

