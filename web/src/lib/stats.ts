import { addDays, parseISODate, toISODate } from './format';
import type { Activity } from './types';

/** Sunday-based week start (Israeli week). */
export function weekStart(d: Date): Date {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  out.setDate(out.getDate() - out.getDay());
  return out;
}

export interface WeekVolume {
  start: string;
  km: number;
  runs: number;
  seconds: number;
}

export function weeklyVolume(activities: Activity[], weeks = 8, now = new Date()): WeekVolume[] {
  const current = weekStart(now);
  const buckets: WeekVolume[] = Array.from({ length: weeks }, (_, i) => ({
    start: toISODate(addDays(current, -7 * (weeks - 1 - i))),
    km: 0,
    runs: 0,
    seconds: 0,
  }));
  for (const a of activities) {
    const ws = toISODate(weekStart(new Date(a.start_time)));
    const b = buckets.find((x) => x.start === ws);
    if (!b) continue;
    b.km += a.distance_m / 1000;
    b.runs++;
    b.seconds += a.duration_s;
  }
  return buckets.map((b) => ({ ...b, km: Math.round(b.km * 10) / 10 }));
}

/** Consecutive weeks (incl. current, if it already has a run) with ≥ minRuns runs. */
export function weekStreak(activities: Activity[], minRuns = 3, now = new Date()): number {
  const vols = weeklyVolume(activities, 52, now).reverse();
  let streak = 0;
  for (let i = 0; i < vols.length; i++) {
    const ok = vols[i].runs >= minRuns;
    if (i === 0 && !ok) continue; // current week still in progress
    if (!ok) break;
    streak++;
  }
  return streak;
}

export function runsOnDate(activities: Activity[], iso: string): Activity[] {
  return activities.filter((a) => toISODate(new Date(a.start_time)) === iso);
}

export function sameISO(a: string, b: Date) {
  return parseISODate(a).getTime() === new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
}
