export const manilaDay = (date = new Date()) => new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0,10);
export function periods(day: string) {
  const date = new Date(`${day}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0,10) !== day) throw new Error('Invalid QOTD date.');
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  const week = date.toISOString().slice(0,10);
  date.setUTCDate(date.getUTCDate() + 6);
  return { month: day.slice(0,7), week, weekEnd: date.toISOString().slice(0,10) };
}
export function dayTimes(day: string) {
  periods(day);
  return { opensAt: Date.parse(`${day}T08:00:00+08:00`), closesAt: Date.parse(`${day}T21:59:59+08:00`), revealAt: Date.parse(`${day}T22:00:00+08:00`) };
}
