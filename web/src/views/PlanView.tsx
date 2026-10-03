import { ChevronLeft, ChevronRight, Clock, HeartPulse, Route, Sparkles, TrendingDown, TrendingUp, Wand2 } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { PageHeader } from '../components/Layout';
import { cx, ErrorCard, PaceRange, Skeleton, WorkoutBadge } from '../components/ui';
import { useAsync } from '../hooks/useAsync';
import { fetchPlan } from '../lib/api';
import { addDays, fmt, parseISODate, toISODate, WORKOUT_META } from '../lib/format';
import { weekStart } from '../lib/stats';
import type { CoachingPlan } from '../lib/types';

const WEEKDAYS = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];

export default function PlanView() {
  const todayISO = toISODate(new Date());
  const [weekOffset, setWeekOffset] = useState(0);
  const [selected, setSelected] = useState(todayISO);

  // 3 weeks window starting at the visible week
  const start = addDays(weekStart(new Date()), weekOffset * 7);
  const end = addDays(start, 20);
  const plan = useAsync(() => fetchPlan(toISODate(start), toISODate(end)), [weekOffset]);

  const byDate = useMemo(() => new Map((plan.data ?? []).map((p) => [p.plan_date, p])), [plan.data]);
  const days = Array.from({ length: 21 }, (_, i) => addDays(start, i));
  const sel = byDate.get(selected);
  const adaptations = (plan.data ?? []).filter((p) => p.adaptation_note && p.plan_date >= todayISO);

  return (
    <div>
      <PageHeader eyebrow="מתעדכן אוטומטית ע״י Gemini" title="תוכנית אימונים" />

      <section className="card p-4">
        <div className="mb-3 flex items-center justify-between">
          <button onClick={() => setWeekOffset((w) => w - 1)} className="grid size-9 place-items-center rounded-full hover:bg-slate-100 dark:hover:bg-white/5" aria-label="שבוע קודם">
            <ChevronRight className="size-5" />
          </button>
          <p className="text-sm font-bold">
            {fmt.dateShort(start)} – {fmt.dateShort(end)}
          </p>
          <button onClick={() => setWeekOffset((w) => w + 1)} className="grid size-9 place-items-center rounded-full hover:bg-slate-100 dark:hover:bg-white/5" aria-label="שבוע הבא">
            <ChevronLeft className="size-5" />
          </button>
        </div>

        <div className="grid grid-cols-7 gap-1 text-center">
          {WEEKDAYS.map((d) => (
            <span key={d} className="pb-1 text-[11px] font-semibold text-slate-400">{d}</span>
          ))}
          {days.map((d) => {
            const iso = toISODate(d);
            const p = byDate.get(iso);
            const meta = p ? WORKOUT_META[p.workout_type] : null;
            const isSel = iso === selected;
            const isToday = iso === todayISO;
            return (
              <button
                key={iso}
                onClick={() => setSelected(iso)}
                className={cx(
                  'relative flex aspect-[4/5] flex-col items-center justify-center gap-1 rounded-2xl text-[13px] font-bold transition',
                  isSel
                    ? 'bg-brand-500 text-white shadow-lg shadow-brand-500/30'
                    : isToday
                      ? 'bg-brand-500/10 text-brand-700 dark:text-brand-300'
                      : iso < todayISO
                        ? 'text-slate-400'
                        : 'hover:bg-slate-100 dark:hover:bg-white/5',
                )}
                aria-label={`${fmt.date(d)}${p ? ` — ${p.title}` : ''}`}
              >
                <span className="num">{d.getDate()}</span>
                <span className={cx('size-1.5 rounded-full', meta ? (isSel ? 'bg-white' : meta.dot) : 'bg-transparent')} />
                {p?.adaptation_note && (
                  <span className="absolute end-1 top-1 size-2 rounded-full bg-ember-500 ring-2 ring-white dark:ring-ink-800" />
                )}
                {p?.status === 'completed' && !isSel && (
                  <span className="absolute inset-x-2 bottom-1 h-0.5 rounded-full bg-emerald-500" />
                )}
              </button>
            );
          })}
        </div>

        <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 border-t border-slate-100 pt-3 text-[11px] text-slate-500 dark:border-white/5 dark:text-slate-400">
          {(['easy', 'long', 'tempo', 'intervals', 'rest'] as const).map((t) => (
            <span key={t} className="flex items-center gap-1">
              <span className={cx('size-1.5 rounded-full', WORKOUT_META[t].dot)} />
              {WORKOUT_META[t].label}
            </span>
          ))}
          <span className="flex items-center gap-1">
            <span className="size-2 rounded-full bg-ember-500" />
            הותאם
          </span>
        </div>
      </section>

      {plan.error && <div className="mt-4"><ErrorCard error={plan.error} onRetry={plan.reload} /></div>}
      {plan.loading && !plan.data ? (
        <Skeleton className="mt-4 h-56" />
      ) : (
        <DayDetail iso={selected} plan={sel} />
      )}

      {adaptations.length > 0 && (
        <>
          <h2 className="mb-3 mt-7 px-1 text-[13px] font-semibold text-slate-500 dark:text-slate-400">התאמות דינמיות</h2>
          <ul className="space-y-2.5">
            {adaptations.map((p) => (
              <li key={p.id}>
                <button
                  onClick={() => setSelected(p.plan_date)}
                  className="card flex w-full items-center gap-3 p-4 text-start transition active:scale-[0.99]"
                >
                  <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-ember-500/15 text-ember-600 dark:text-ember-400">
                    {p.adjustment_sec > 0 ? <TrendingDown className="size-5" /> : p.adjustment_sec < 0 ? <TrendingUp className="size-5" /> : <Wand2 className="size-5" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-bold">
                      {fmt.weekday(parseISODate(p.plan_date))} · {p.title}
                    </p>
                    <p className="truncate text-xs text-slate-500 dark:text-slate-400">{p.adaptation_note}</p>
                  </div>
                  {p.adjustment_sec !== 0 && (
                    <span className="num shrink-0 rounded-full bg-ember-500 px-2 py-0.5 text-xs font-bold text-white">
                      {p.adjustment_sec > 0 ? '+' : ''}
                      {p.adjustment_sec}s
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function DayDetail({ iso, plan }: { iso: string; plan?: CoachingPlan }) {
  const d = parseISODate(iso);
  if (!plan) {
    return (
      <section className="card mt-4 p-6 text-center">
        <p className="font-bold">{fmt.weekday(d)}, {fmt.date(d)}</p>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">עדיין לא נקבע אימון ליום הזה.</p>
      </section>
    );
  }
  const isRest = plan.workout_type === 'rest';
  return (
    <section key={iso} className="card mt-4 animate-pop overflow-hidden">
      <div className={cx('h-1.5 bg-gradient-to-l', WORKOUT_META[plan.workout_type].gradient)} />
      <div className="p-5">
        <div className="flex items-center justify-between">
          <WorkoutBadge type={plan.workout_type} />
          <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
            {fmt.weekday(d)}, {fmt.date(d)}
          </span>
        </div>
        <h3 className="mt-3 text-[22px] font-extrabold leading-tight">{plan.title}</h3>

        {!isRest && (
          <div className="mt-4 grid grid-cols-3 gap-2">
            <Box icon={<Sparkles className="size-3.5" />} label="קצב">
              <PaceRange fast={plan.target_pace_fast_sec_km} slow={plan.target_pace_slow_sec_km} />
            </Box>
            <Box icon={<Clock className="size-3.5" />} label="משך">
              <span className="num">{plan.duration_min ?? '–'}</span>
              <span className="ms-0.5 text-[11px] font-medium text-slate-500">דק׳</span>
            </Box>
            <Box icon={plan.distance_km ? <Route className="size-3.5" /> : <HeartPulse className="size-3.5" />} label={plan.distance_km ? 'מרחק' : 'אזור'}>
              <span className="num">{plan.distance_km ?? plan.hr_zone ?? '–'}</span>
              {plan.distance_km && <span className="ms-0.5 text-[11px] font-medium text-slate-500">ק״מ</span>}
            </Box>
          </div>
        )}

        {plan.adaptation_note && (
          <div className="mt-4 flex items-start gap-2 rounded-2xl bg-ember-500/10 p-3 text-[13px] text-ember-600 ring-1 ring-ember-500/20 dark:text-ember-400">
            <Wand2 className="mt-0.5 size-4 shrink-0" />
            <span className="font-semibold">{plan.adaptation_note}</span>
          </div>
        )}

        {plan.description && <p className="mt-4 text-[14px] leading-relaxed">{plan.description}</p>}
        <p className="mt-3 text-[13px] leading-relaxed text-slate-500 dark:text-slate-400">{plan.rationale}</p>
      </div>
    </section>
  );
}

function Box({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl bg-slate-50 p-3 dark:bg-white/5">
      <div className="flex items-center gap-1 text-[11px] font-medium text-slate-500 dark:text-slate-400">
        {icon}
        {label}
      </div>
      <div className="mt-1 text-[17px] font-extrabold leading-tight">{children}</div>
    </div>
  );
}
