/**
 * Builds a doctor's bookable slots for one calendar day (server local time).
 *
 * Slots exist only on the doctor's working days, between startHour and
 * endHour, every slotMinutes. Past slots and slots beyond the hospital's
 * booking window are excluded.
 *
 * @param {{days:number[], startHour:number, endHour:number, slotMinutes:number}} availability
 * @param {string} dateString 'YYYY-MM-DD'
 * @param {number} maxAdvanceDays
 * @param {Date} [now]
 * @returns {{start: Date, end: Date}[]}
 */
function buildDaySlots(availability, dateString, maxAdvanceDays, now = new Date()) {
  const [year, month, day] = dateString.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  if (Number.isNaN(date.getTime())) return [];

  const latest = new Date(now);
  latest.setDate(latest.getDate() + maxAdvanceDays);
  if (date > latest) return [];
  if (!availability.days.includes(date.getDay())) return [];

  const slots = [];
  const stepMs = availability.slotMinutes * 60 * 1000;
  const dayEnd = new Date(year, month - 1, day, availability.endHour, 0, 0, 0);
  for (let t = new Date(year, month - 1, day, availability.startHour, 0, 0, 0); t.getTime() + stepMs <= dayEnd.getTime(); t = new Date(t.getTime() + stepMs)) {
    if (t > now) slots.push({ start: t, end: new Date(t.getTime() + stepMs) });
  }
  return slots;
}

/** True when `start` is exactly one of the doctor's slot boundaries. */
function isValidSlot(availability, start, maxAdvanceDays, now = new Date()) {
  const dateString = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
  return buildDaySlots(availability, dateString, maxAdvanceDays, now).some((s) => s.start.getTime() === start.getTime());
}

module.exports = { buildDaySlots, isValidSlot };
