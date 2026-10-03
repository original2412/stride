import type { WorkoutType } from './types';

export function formatPace(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return '–';
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

export function formatKm(meters: number, digits = 2): string {
  return (meters / 1000).toFixed(digits);
}

/** Local-date YYYY-MM-DD (not UTC) — the athlete's "today". */
export function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

export function parseISODate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function daysUntil(iso: string, from = new Date()): number {
  const a = parseISODate(toISODate(from)).getTime();
  const b = parseISODate(iso).getTime();
  return Math.round((b - a) / 86_400_000);
}

const heDay = new Intl.DateTimeFormat('he-IL', { weekday: 'long' });
const heShortDay = new Intl.DateTimeFormat('he-IL', { weekday: 'narrow' });
const heDate = new Intl.DateTimeFormat('he-IL', { day: 'numeric', month: 'long' });
const heDateShort = new Intl.DateTimeFormat('he-IL', { day: 'numeric', month: 'short' });
const heTime = new Intl.DateTimeFormat('he-IL', { hour: '2-digit', minute: '2-digit' });

export const fmt = {
  weekday: (d: Date) => heDay.format(d),
  weekdayNarrow: (d: Date) => heShortDay.format(d),
  date: (d: Date) => heDate.format(d),
  dateShort: (d: Date) => heDateShort.format(d),
  time: (d: Date) => heTime.format(d),
};

export function greeting(date = new Date()): string {
  const h = date.getHours();
  if (h < 5) return 'לילה טוב';
  if (h < 12) return 'בוקר טוב';
  if (h < 17) return 'צהריים טובים';
  if (h < 21) return 'ערב טוב';
  return 'לילה טוב';
}

export interface WorkoutMeta {
  label: string;
  /** Tailwind classes for chips/badges */
  chip: string;
  /** solid dot color */
  dot: string;
  /** gradient for hero card */
  gradient: string;
}

export const WORKOUT_META: Record<WorkoutType, WorkoutMeta> = {
  easy: {
    label: 'ריצה קלה',
    chip: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
    dot: 'bg-emerald-500',
    gradient: 'from-brand-500 via-brand-600 to-brand-800',
  },
  recovery: {
    label: 'התאוששות',
    chip: 'bg-teal-500/15 text-teal-700 dark:text-teal-300',
    dot: 'bg-teal-500',
    gradient: 'from-teal-400 via-brand-500 to-brand-700',
  },
  long: {
    label: 'ריצה ארוכה',
    chip: 'bg-violet-500/15 text-violet-700 dark:text-violet-300',
    dot: 'bg-violet-500',
    gradient: 'from-brand-500 via-indigo-600 to-violet-700',
  },
  tempo: {
    label: 'טמפו',
    chip: 'bg-orange-500/15 text-orange-700 dark:text-orange-300',
    dot: 'bg-orange-500',
    gradient: 'from-orange-400 via-ember-500 to-rose-600',
  },
  threshold: {
    label: 'סף',
    chip: 'bg-rose-500/15 text-rose-700 dark:text-rose-300',
    dot: 'bg-rose-500',
    gradient: 'from-ember-500 via-rose-500 to-fuchsia-700',
  },
  intervals: {
    label: 'אינטרוולים',
    chip: 'bg-red-500/15 text-red-700 dark:text-red-300',
    dot: 'bg-red-500',
    gradient: 'from-rose-500 via-red-600 to-red-800',
  },
  progression: {
    label: 'ריצה מתגברת',
    chip: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
    dot: 'bg-amber-500',
    gradient: 'from-amber-400 via-ember-500 to-brand-700',
  },
  rest: {
    label: 'מנוחה',
    chip: 'bg-slate-500/15 text-slate-600 dark:text-slate-300',
    dot: 'bg-slate-400',
    gradient: 'from-slate-500 via-slate-600 to-slate-800',
  },
  race: {
    label: 'מרוץ',
    chip: 'bg-yellow-400/20 text-yellow-700 dark:text-yellow-300',
    dot: 'bg-yellow-400',
    gradient: 'from-yellow-400 via-ember-500 to-rose-600',
  },
};

export const HR_ZONES = [
  { zone: 1, label: 'התאוששות', from: 0.5, to: 0.6, color: 'bg-slate-400' },
  { zone: 2, label: 'אירובי קל', from: 0.6, to: 0.7, color: 'bg-emerald-500' },
  { zone: 3, label: 'אירובי', from: 0.7, to: 0.8, color: 'bg-amber-400' },
  { zone: 4, label: 'סף', from: 0.8, to: 0.9, color: 'bg-orange-500' },
  { zone: 5, label: 'מקסימלי', from: 0.9, to: 1.0, color: 'bg-red-500' },
] as const;

export function zoneBpm(zone: number, hrMax: number, hrRest: number): [number, number] {
  const z = HR_ZONES[zone - 1];
  // Karvonen (heart-rate reserve)
  const reserve = hrMax - hrRest;
  return [Math.round(hrRest + reserve * z.from), Math.round(hrRest + reserve * z.to)];
}
