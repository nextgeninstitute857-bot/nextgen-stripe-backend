function dateKey(value) {
  const clean = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}/.test(clean) ? clean.slice(0, 10) : "";
}

function byScheduleDateThenOrder(left, right) {
  const dateCompare = dateKey(left?.date || left?.scheduled_date)
    .localeCompare(dateKey(right?.date || right?.scheduled_date));
  if (dateCompare) return dateCompare;
  return Number(left?.schedule_slot_number || left?.order || left?.day_number || 0)
    - Number(right?.schedule_slot_number || right?.order || right?.day_number || 0);
}

/**
 * Select the roadmap entry that the student dashboard should present as the
 * current focus. Exact calendar entries (including holidays) win. On an
 * unscheduled day, such as Sunday, the next teaching day wins instead of the
 * first unfinished historical lesson.
 */
export function selectStudentCurrentRoadmapDay({
  days = [],
  teachingDays = [],
  today = "",
} = {}) {
  const cleanToday = dateKey(today);
  const publishedDays = Array.isArray(days) ? days.filter(Boolean) : [];
  const publishedTeachingDays = (Array.isArray(teachingDays) ? teachingDays : [])
    .filter(Boolean)
    .slice()
    .sort(byScheduleDateThenOrder);

  const exactDay = publishedDays.find((day) => dateKey(day.date || day.scheduled_date) === cleanToday);
  if (exactDay) return exactDay;

  const nextTeachingDay = publishedTeachingDays.find((day) => {
    const scheduled = dateKey(day.date || day.scheduled_date);
    return scheduled && cleanToday && scheduled > cleanToday;
  });
  if (nextTeachingDay) return nextTeachingDay;

  const mostRecentTeachingDay = publishedTeachingDays
    .filter((day) => {
      const scheduled = dateKey(day.date || day.scheduled_date);
      return scheduled && (!cleanToday || scheduled <= cleanToday);
    })
    .at(-1);
  if (mostRecentTeachingDay) return mostRecentTeachingDay;

  return publishedTeachingDays[0] || publishedDays[0] || null;
}

