import {
  Activity as ActivityIcon,
  Check,
  ChevronLeft,
  Clock,
  Flame,
  HeartPulse,
  Loader2,
  MoonStar,
  Mountain,
  Route,
  Sparkles,
  TrendingDown,
  TrendingUp,
  X,
} from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useToast } from '../components/Toast';
import { cx, ErrorCard, PaceRange, Ring, SectionTitle, Skeleton, Stat, ZoneBar } from '../components/ui';
import { useAsync } from '../hooks/useAsync';
import {
  fetchActivities,
  fetchLatestAssessment,
  fetchPlan,
  fetchProfile,
  recalibratePlan,
  updatePlanStatus,
} from '../lib/api';
import {
  addDays,
  fmt,
  formatDuration,
  formatKm,
  formatPace,
  greeting,
  HR_ZONES,
  parseISODate,
  toISODate,
  WORKOUT_META,
  zoneBpm,
} from '../lib/format';
import { weekStart, weeklyVolume, weekStreak } from '../lib/stats';
import type { Activity, CoachAssessment, CoachingPlan, PlanStatus, Profile } from '../lib/types';

const FATIGUE = {
  low: { label: 'רענן/ה', cls: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' },
  moderate: { label: 'עייפות בינונית', cls: 'bg-amber-500/15 text-amber-700 dark:text-amber-300' },
  high: { label: 'עייפות גבוהה', cls: 'bg-rose-500/15 text-rose-700 dark:text-rose-300' },
} as const;

export default function TodayView() {
  const toast = useToast();
  const now = new Date();
  const todayISO = toISODate(now);
  const wStart = weekStart(now);

  const data = useAsync(async () => {
    const [profile, plan, activities, assessment] = await Promise.all([
      fetchProfile(),
      fetchPlan(toISODate(wStart), toISODate(addDays(wStart, 6))),
      fetchActivities(70),
      fetchLatestAssessment(),
    ]);
    return { profile, plan, activities, assessment };
  });

  const [recalibrating, setRecalibrating] = useState(false);

  async function handleRecalibrate() {
    setRecalibrating(true);
    try {
      await recalibratePlan();
      await data.reload();
      toast('התוכנית עודכנה לפי הנתונים האחרונים');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setRecalibrating(false);
    }
  }

  async function handleStatus(plan: CoachingPlan, status: PlanStatus) {
    if (!data.data) return;
    const next = plan.status === status ? 'planned' : status;
    data.setData({
      ...data.data,
      plan: data.data.plan.map((p) => (p.id === plan.id ? { ...p, status: next } : p)),
    });
    try {
      await updatePlanStatus(plan.id, next);
      if (next === 'completed') toast('כל הכבוד! עוד אימון בכיס 💪');
    } catch (e) {
      toast((e as Error).message, 'error');
      data.reload();
    }
  }

  if (data.error) return <ErrorCard error={data.error} onRetry={data.reload} />;
  if (!data.data) return <TodaySkeleton />;

  const { profile, plan, activities, assessment } = data.data;
  const today = plan.find((p) => p.plan_date === todayISO);

  return (
    <div>
      <Greeting profile={profile} activities={activities} now={now} />

      {today ? (
        <HeroWorkout plan={today} profile={profile} onStatus={handleStatus} />
      ) : (
        <EmptyHero />
      )}

      <RecalibrateButton loading={recalibrating} onClick={handleRecalibrate} assessment={assessment} />

      {assessment && <ReadinessCard assessment={assessment} />}

      {today && today.workout_type !== 'rest' && today.description && <StructureCard plan={today} />}

      <WeekStrip plan={plan} activities={activities} weekStartDate={wStart} todayISO={todayISO} target={profile.weekly_km_target} />

      <LastRun activities={activities} />
    </div>
  );
}

// ------------------------------------------------------------------ //

function Greeting({ profile, activities, now }: { profile: Profile; activities: Activity[]; now: Date }) {
  const streak = useMemo(() => weekStreak(activities), [activities]);
  return (
    <header className="mb-5 mt-2 flex items-start justify-between gap-3">
      <div>
        <p className="text-sm font-medium text-slate-500 dark:text-slate-400">
          {fmt.weekday(now)}, {fmt.date(now)}
        </p>
        <h1 className="text-[28px] font-extrabold leading-tight tracking-tight">
          {greeting(now)}
          {profile.display_name ? `, ${profile.display_name}` : ''}
        </h1>
      </div>
      {streak > 0 && (
        <div
          className="flex shrink-0 items-center gap-1.5 rounded-full bg-gradient-to-l from-ember-500 to-amber-400 py-1.5 pe-3 ps-2 text-white shadow-lg shadow-ember-500/30"
          title="שבועות רצופים עם 3+ ריצות"
        >
          <Flame className="size-4 fill-white/30" />
          <span className="num text-sm font-extrabold">{streak}</span>
          <span className="text-[11px] font-semibold">שבועות</span>
        </div>
      )}
    </header>
  );
}

function HeroWorkout({
  plan,
  profile,
  onStatus,
}: {
  plan: CoachingPlan;
  profile: Profile;
  onStatus: (p: CoachingPlan, s: PlanStatus) => void;
}) {
  const meta = WORKOUT_META[plan.workout_type];
  const isRest = plan.workout_type === 'rest';
  const bpm = plan.hr_zone ? zoneBpm(plan.hr_zone, profile.hr_max, profile.hr_rest) : null;
  const done = plan.status === 'completed';
  const skipped = plan.status === 'skipped';

  return (
    <section
      className={cx(
        'relative isolate overflow-hidden rounded-[28px] bg-gradient-to-br p-5 text-white shadow-xl shadow-brand-900/20',
        meta.gradient,
      )}
    >
      <HeroArt />

      <div className="flex items-center justify-between">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-white/20 px-3 py-1 text-xs font-semibold backdrop-blur">
          {isRest ? <MoonStar className="size-3.5" /> : <ActivityIcon className="size-3.5" />}
          {meta.label}
        </span>
        <span className="text-xs font-medium text-white/80">האימון של היום</span>
      </div>

      <h2 className="mt-4 text-[34px] font-black leading-[1.05] tracking-tight">{plan.title}</h2>

      {isRest ? (
        <p className="mt-3 max-w-[30ch] text-[15px] leading-relaxed text-white/90">{plan.description ?? plan.rationale}</p>
      ) : (
        <>
          <div className="mt-5">
            <p className="text-xs font-medium text-white/75">טווח קצב יעד</p>
            <div className="flex items-baseline gap-2">
              <PaceRange
                fast={plan.target_pace_fast_sec_km}
                slow={plan.target_pace_slow_sec_km}
                className="text-[44px] font-black leading-none tracking-tight"
              />
              <span className="text-sm font-semibold text-white/80">דק׳/ק״מ</span>
            </div>
          </div>

          <div className="mt-5 grid grid-cols-3 gap-2 rounded-2xl bg-white/12 p-3 ring-1 ring-white/15 backdrop-blur-md">
            <HeroStat icon={<Clock className="size-3.5" />} label="משך" value={plan.duration_min ?? '–'} unit="דק׳" />
            <HeroStat icon={<Route className="size-3.5" />} label="מרחק" value={plan.distance_km ?? '–'} unit="ק״מ" />
            <div>
              <div className="flex items-center gap-1 text-[11px] font-medium text-white/75">
                <HeartPulse className="size-3.5" />
                אזור {plan.hr_zone ?? '–'}
              </div>
              <div className="mt-1 flex items-end gap-2">
                <ZoneBar zone={plan.hr_zone} light />
              </div>
              {bpm && <p className="num mt-1 text-[11px] font-semibold text-white/85">{bpm[0]}–{bpm[1]}</p>}
            </div>
          </div>
        </>
      )}

      {plan.adaptation_note && (
        <div className="mt-3 flex items-start gap-2.5 rounded-2xl bg-ink-950/25 p-3 text-[13px] leading-snug ring-1 ring-white/10 backdrop-blur">
          <span className="grid size-7 shrink-0 place-items-center rounded-full bg-ember-500 shadow-md shadow-ember-600/40">
            {plan.adjustment_sec > 0 ? <TrendingDown className="size-4" /> : <TrendingUp className="size-4" />}
          </span>
          <div className="min-w-0">
            <p className="font-semibold">התאמה דינמית</p>
            <p className="text-white/85">{plan.adaptation_note}</p>
          </div>
          {plan.adjustment_sec !== 0 && (
            <span className="num ms-auto shrink-0 rounded-full bg-white/20 px-2 py-0.5 text-xs font-bold">
              {plan.adjustment_sec > 0 ? '+' : ''}
              {plan.adjustment_sec}s
            </span>
          )}
        </div>
      )}

      <p className="mt-4 text-[13px] leading-relaxed text-white/85">
        <Sparkles className="mb-0.5 me-1 inline size-3.5" />
        {plan.rationale}
      </p>

      {!isRest && (
        <div className="mt-5 flex gap-2">
          <button
            onClick={() => onStatus(plan, 'completed')}
            className={cx(
              'flex flex-1 items-center justify-center gap-2 rounded-2xl py-3.5 text-[15px] font-bold transition active:scale-[0.98]',
              done ? 'bg-emerald-400 text-emerald-950' : 'bg-white text-slate-900 shadow-lg shadow-black/10',
            )}
          >
            <Check className="size-5" strokeWidth={3} />
            {done ? 'הושלם!' : 'סיימתי'}
          </button>
          <button
            onClick={() => onStatus(plan, 'skipped')}
            aria-label="דילגתי על האימון"
            className={cx(
              'grid w-14 place-items-center rounded-2xl transition active:scale-[0.98]',
              skipped ? 'bg-ink-950/50 text-white' : 'bg-white/15 text-white ring-1 ring-white/20',
            )}
          >
            <X className="size-5" />
          </button>
        </div>
      )}
    </section>
  );
}

function HeroStat({ icon, label, value, unit }: { icon: ReactNode; label: string; value: ReactNode; unit: string }) {
  return (
    <div>
      <div className="flex items-center gap-1 text-[11px] font-medium text-white/75">
        {icon}
        {label}
      </div>
      <div className="mt-0.5 flex items-baseline gap-1">
        <span className="num text-2xl font-extrabold leading-none">{value}</span>
        <span className="text-[11px] font-medium text-white/75">{unit}</span>
      </div>
    </div>
  );
}

/** Decorative route + topo rings behind the hero content. */
function HeroArt() {
  return (
    <svg className="pointer-events-none absolute -end-16 -top-10 -z-10 h-72 w-72 opacity-25" viewBox="0 0 200 200" aria-hidden>
      {[30, 50, 70, 90].map((r) => (
        <circle key={r} cx="100" cy="100" r={r} fill="none" stroke="white" strokeWidth="1.2" strokeDasharray="3 5" />
      ))}
      <path d="M20 170 C 60 160, 70 110, 100 100 S 150 40, 185 30" fill="none" stroke="white" strokeWidth="5" strokeLinecap="round" />
      <circle cx="185" cy="30" r="7" fill="white" />
    </svg>
  );
}

function EmptyHero() {
  return (
    <section className="card grid place-items-center gap-2 p-8 text-center">
      <div className="grid size-14 place-items-center rounded-full bg-brand-500/10 text-brand-600 dark:text-brand-300">
        <Sparkles className="size-7" />
      </div>
      <h2 className="text-lg font-bold">אין עדיין אימון להיום</h2>
      <p className="max-w-[28ch] text-sm text-slate-500 dark:text-slate-400">
        סנכרנו ריצות מ-Garmin ולחצו על “עדכון התוכנית” כדי לקבל תוכנית מבוססת מחקר.
      </p>
    </section>
  );
}

function RecalibrateButton({
  loading,
  onClick,
  assessment,
}: {
  loading: boolean;
  onClick: () => void;
  assessment: CoachAssessment | null;
}) {
  return (
    <div className="mt-4">
      <button
        onClick={onClick}
        disabled={loading}
        className="group relative w-full overflow-hidden rounded-2xl bg-[linear-gradient(110deg,#0a84ff,45%,#7c5cff,55%,#0a84ff)] bg-[length:200%_100%] p-[1.5px] shadow-lg shadow-brand-500/25 transition active:scale-[0.99] disabled:opacity-90 data-[loading=true]:animate-shimmer"
        data-loading={loading}
      >
        <span className="flex items-center justify-center gap-2.5 rounded-[14px] bg-white px-4 py-4 text-[15px] font-bold text-brand-600 transition group-hover:bg-brand-50 dark:bg-ink-800 dark:text-brand-300 dark:group-hover:bg-ink-700">
          {loading ? <Loader2 className="size-5 animate-spin" /> : <Sparkles className="size-5" />}
          {loading ? 'מחשב את התוכנית לפי הנתונים שלך…' : 'עדכון התוכנית לפי הנתונים'}
        </span>
      </button>
      {assessment && !loading && (
        <p className="mt-2 text-center text-[11px] text-slate-500 dark:text-slate-400">
          כיול אחרון: {relativeTime(new Date(assessment.assessed_at))}
        </p>
      )}
    </div>
  );
}

function ReadinessCard({ assessment }: { assessment: CoachAssessment }) {
  const f = FATIGUE[assessment.fatigue_level];
  const color: [string, string] =
    assessment.readiness_score >= 70 ? ['#34d399', '#0a84ff'] : assessment.readiness_score >= 45 ? ['#fbbf24', '#ff7a1a'] : ['#fb7185', '#e11d48'];
  return (
    <>
      <SectionTitle>מוכנות לאימון</SectionTitle>
      <section className="card flex items-center gap-5 p-5">
        <Ring value={assessment.readiness_score} size={104} stroke={11} gradient={color}>
          <div>
            <div className="num text-[30px] font-black leading-none">{assessment.readiness_score}</div>
            <div className="mt-0.5 text-[10px] font-semibold text-slate-500 dark:text-slate-400">מתוך 100</div>
          </div>
        </Ring>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cx('rounded-full px-2.5 py-1 text-xs font-semibold', f.cls)}>{f.label}</span>
            {assessment.acwr != null && (
              <span
                className="num rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600 dark:bg-white/5 dark:text-slate-300"
                title="יחס עומס חריף/כרוני"
              >
                ACWR {assessment.acwr.toFixed(2)}
              </span>
            )}
          </div>
          <p className="mt-2 text-[13px] leading-relaxed text-slate-600 dark:text-slate-300">{assessment.summary}</p>
        </div>
      </section>
    </>
  );
}

function StructureCard({ plan }: { plan: CoachingPlan }) {
  const steps = (plan.description ?? '').split('·').map((s) => s.trim()).filter(Boolean);
  const zone = plan.hr_zone ? HR_ZONES[plan.hr_zone - 1] : null;
  return (
    <>
      <SectionTitle>מבנה האימון</SectionTitle>
      <section className="card p-5">
        <ol className="relative space-y-4">
          {steps.map((s, i) => (
            <li key={i} className="relative flex gap-3">
              {i < steps.length - 1 && <span className="absolute start-[13px] top-7 h-[calc(100%-4px)] w-0.5 bg-slate-200 dark:bg-white/10" />}
              <span
                className={cx(
                  'grid size-7 shrink-0 place-items-center rounded-full text-xs font-bold',
                  i === 0 || i === steps.length - 1
                    ? 'bg-slate-100 text-slate-600 dark:bg-white/10 dark:text-slate-300'
                    : 'bg-brand-500 text-white',
                )}
              >
                {i + 1}
              </span>
              <p className="pt-1 text-[14px] leading-snug">{s}</p>
            </li>
          ))}
        </ol>
        {zone && (
          <div className="mt-4 flex items-center gap-2 rounded-2xl bg-slate-50 p-3 text-xs dark:bg-white/5">
            <HeartPulse className="size-4 text-rose-500" />
            <span className="text-slate-600 dark:text-slate-300">
              אזור {zone.zone} — {zone.label}
            </span>
          </div>
        )}
      </section>
    </>
  );
}

function WeekStrip({
  plan,
  activities,
  weekStartDate,
  todayISO,
  target,
}: {
  plan: CoachingPlan[];
  activities: Activity[];
  weekStartDate: Date;
  todayISO: string;
  target: number | null;
}) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStartDate, i));
  const thisWeek = weeklyVolume(activities, 1)[0];
  const plannedKm = plan.reduce((s, p) => s + (p.distance_km ?? 0), 0);
  const goal = target ?? Math.round(plannedKm);
  const pct = goal ? Math.min(100, (thisWeek.km / goal) * 100) : 0;

  return (
    <>
      <SectionTitle>השבוע שלך</SectionTitle>
      <section className="card p-5">
        <div className="flex items-end justify-between">
          <div>
            <span className="num text-[34px] font-black leading-none">{thisWeek.km.toFixed(1)}</span>
            <span className="ms-1 text-sm font-semibold text-slate-500 dark:text-slate-400">/ {goal} ק״מ</span>
          </div>
          <span className="text-xs font-medium text-slate-500 dark:text-slate-400">{thisWeek.runs} ריצות</span>
        </div>
        <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-slate-100 dark:bg-white/10">
          <div
            className="h-full rounded-full bg-gradient-to-l from-brand-400 to-brand-600 transition-[width] duration-1000"
            style={{ width: `${pct}%` }}
          />
        </div>

        <ul className="mt-5 grid grid-cols-7 gap-1 text-center">
          {days.map((d) => {
            const iso = toISODate(d);
            const p = plan.find((x) => x.plan_date === iso);
            const isToday = iso === todayISO;
            const isPast = iso < todayISO;
            const meta = p ? WORKOUT_META[p.workout_type] : null;
            return (
              <li key={iso} className="flex flex-col items-center gap-1.5">
                <span className={cx('text-[11px] font-semibold', isToday ? 'text-brand-600 dark:text-brand-300' : 'text-slate-400')}>
                  {fmt.weekdayNarrow(d)}
                </span>
                <span
                  className={cx(
                    'grid size-9 place-items-center rounded-full text-[13px] font-bold transition',
                    p?.status === 'completed'
                      ? 'bg-emerald-500 text-white'
                      : p?.status === 'skipped'
                        ? 'bg-slate-100 text-slate-400 line-through dark:bg-white/5'
                        : isToday
                          ? 'bg-brand-500 text-white shadow-md shadow-brand-500/40 ring-4 ring-brand-500/15'
                          : isPast
                            ? 'bg-slate-100 text-slate-400 dark:bg-white/5'
                            : 'bg-slate-100 text-slate-700 dark:bg-white/5 dark:text-slate-200',
                  )}
                >
                  {p?.status === 'completed' ? <Check className="size-4" strokeWidth={3} /> : d.getDate()}
                </span>
                <span className={cx('size-1.5 rounded-full', meta ? meta.dot : 'bg-transparent')} />
              </li>
            );
          })}
        </ul>
      </section>
    </>
  );
}

function LastRun({ activities }: { activities: Activity[] }) {
  const last = activities[0];
  if (!last) return null;
  const d = new Date(last.start_time);
  return (
    <>
      <SectionTitle action={<a href="#history" className="flex items-center text-xs font-semibold text-brand-600 dark:text-brand-300">לכל הריצות<ChevronLeft className="size-4" /></a>}>
        הריצה האחרונה
      </SectionTitle>
      <a href="#history" className="card block p-5 transition active:scale-[0.99]">
        <div className="flex items-center justify-between">
          <div>
            <p className="font-bold">{last.name ?? 'ריצה'}</p>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {fmt.weekday(d)} · {fmt.dateShort(parseISODate(toISODate(d)))}
            </p>
          </div>
          <div className="text-end">
            <span className="num text-[28px] font-black leading-none text-brand-600 dark:text-brand-300">{formatKm(last.distance_m)}</span>
            <span className="ms-1 text-xs font-semibold text-slate-500">ק״מ</span>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-4 gap-2 border-t border-slate-100 pt-4 dark:border-white/5">
          <Stat label="זמן" value={formatDuration(last.duration_s)} />
          <Stat label="קצב" value={formatPace(last.avg_pace_sec_per_km)} />
          <Stat label="דופק" value={last.avg_hr ?? '–'} icon={<HeartPulse className="size-3 text-rose-500" />} />
          <Stat label="טיפוס" value={Math.round(last.elevation_gain_m ?? 0)} unit="מ׳" icon={<Mountain className="size-3" />} />
        </div>
      </a>
    </>
  );
}

function TodaySkeleton() {
  return (
    <div className="space-y-4 pt-2">
      <Skeleton className="h-14 w-2/3 rounded-2xl" />
      <Skeleton className="h-[380px]" />
      <Skeleton className="h-14 rounded-2xl" />
      <Skeleton className="h-36" />
    </div>
  );
}

function relativeTime(d: Date): string {
  const diff = (Date.now() - d.getTime()) / 1000;
  const rtf = new Intl.RelativeTimeFormat('he', { numeric: 'auto' });
  if (diff < 60) return 'עכשיו';
  if (diff < 3600) return rtf.format(-Math.round(diff / 60), 'minute');
  if (diff < 86400) return rtf.format(-Math.round(diff / 3600), 'hour');
  return rtf.format(-Math.round(diff / 86400), 'day');
}
