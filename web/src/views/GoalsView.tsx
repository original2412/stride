import { Flag, FlaskConical, Medal, Plus, Timer, Trash2, Trophy, Zap } from 'lucide-react';
import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { PageHeader } from '../components/Layout';
import { cx, ErrorCard, PaceRange, Ring, SectionTitle, Skeleton } from '../components/ui';
import { useAsync } from '../hooks/useAsync';
import { addRace, deleteRace, fetchActivities, fetchLatestAssessment, fetchProfile, fetchRaces } from '../lib/api';
import { useToast } from '../components/Toast';
import { daysUntil, fmt, formatDuration, formatPace, parseISODate, toISODate } from '../lib/format';
import { estimateVdot, marathonShape, predictRaceTime, trainingPaces, vdotFromPerformance, type PaceZones } from '../lib/science';
import { weeklyVolume } from '../lib/stats';
import type { Activity, CoachAssessment, Profile, Race } from '../lib/types';

const PHASE_LABEL: Record<string, string> = {
  base: 'בניית בסיס',
  build: 'בנייה',
  specific: 'ספציפי למרוץ',
  taper: 'טייפר',
  race_week: 'שבוע מרוץ',
};

const ZONES: { key: keyof PaceZones; label: string; desc: string; color: string }[] = [
  { key: 'recovery', label: 'התאוששות', desc: 'אחרי אימון קשה', color: 'bg-slate-400' },
  { key: 'easy', label: 'קל (E)', desc: 'רוב הריצות וארוכות — בונה בסיס אירובי', color: 'bg-emerald-500' },
  { key: 'marathon', label: 'מרתון (M)', desc: 'קצב המרתון החזוי שלך', color: 'bg-brand-500' },
  { key: 'threshold', label: 'סף (T)', desc: 'טמפו — משפר סף לקטט', color: 'bg-amber-500' },
  { key: 'interval', label: 'אינטרוולים (I)', desc: '3–5 דק׳ — מפתח VO2max', color: 'bg-orange-500' },
  { key: 'repetition', label: 'חזרות (R)', desc: '200–400 מ׳ — מהירות וכלכליות', color: 'bg-red-500' },
];

/** Fitness model: prefer the server's latest assessment, else compute locally from runs. */
function useFitness(activities: Activity[], races: Race[], profile: Profile, assessment: CoachAssessment | null) {
  return useMemo(() => {
    const goal = races.find((r) => r.priority === 'A' && r.target_time_s) ?? races.find((r) => r.target_time_s);
    const fallback = goal ? vdotFromPerformance(goal.distance_km * 1000, goal.target_time_s!) - 2 : 40;
    const local = estimateVdot(activities, profile.hr_max, profile.hr_rest, toISODate(new Date()), null, fallback);
    const vdot = assessment?.vdot ?? local.vdot;
    const source = assessment?.vdot_source ?? local.source;
    const paces = (assessment?.training_paces as PaceZones | null | undefined) ?? trainingPaces(vdot);

    const cutoff = Date.now() - 28 * 86_400_000;
    const last28 = activities.filter((a) => Date.parse(a.start_time) >= cutoff);
    const longest = Math.max(0, ...last28.map((a) => a.distance_m / 1000));
    const avgWeekly = last28.reduce((s, a) => s + a.distance_m / 1000, 0) / 4;
    const marathon = races.find((r) => r.distance_km > 40);
    const required = marathon?.target_time_s ? vdotFromPerformance(42195, marathon.target_time_s) : vdot;

    return {
      vdot,
      source,
      paces,
      phase: assessment?.phase ?? null,
      shape: assessment?.marathon_shape_pct ?? marathonShape(vdot, marathon?.target_time_s ?? null, longest, avgWeekly),
      fitnessPct: Math.round(Math.min(100, (vdot / required) * 100)),
      longRunPct: Math.round(Math.min(100, (longest / 32) * 100)),
      volumePct: Math.round(Math.min(100, (avgWeekly / 65) * 100)),
      predictions: races.map((r) => ({ race: r, predicted: predictRaceTime(vdot, r.distance_km * 1000) })),
    };
  }, [activities, races, profile, assessment]);
}

export default function GoalsView() {
  const data = useAsync(async () => {
    const [races, activities, assessment, profile] = await Promise.all([
      fetchRaces(),
      fetchActivities(70),
      fetchLatestAssessment(),
      fetchProfile(),
    ]);
    return { races, activities, assessment, profile };
  });

  if (data.error) return <ErrorCard error={data.error} onRetry={data.reload} />;
  if (!data.data)
    return (
      <div className="space-y-4 pt-16">
        <Skeleton className="h-44" />
        <Skeleton className="h-44" />
        <Skeleton className="h-60" />
      </div>
    );

  return <GoalsContent {...data.data} onChanged={data.reload} />;
}

function GoalsContent({
  races,
  activities,
  assessment,
  profile,
  onChanged,
}: {
  races: Race[];
  activities: Activity[];
  assessment: CoachAssessment | null;
  profile: Profile;
  onChanged: () => void;
}) {
  const f = useFitness(activities, races, profile, assessment);
  const toast = useToast();

  async function remove(race: Race) {
    if (!confirm(`למחוק את ${race.name}?`)) return;
    try {
      await deleteRace(race.id);
      onChanged();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }

  return (
    <div>
      <PageHeader eyebrow="הדרך לקו הסיום" title="יעדים וסטטיסטיקה" />

      <div className="space-y-3">
        {races.map((r, i) => <RaceCard key={r.id} race={r} featured={i === 0} onDelete={() => remove(r)} />)}
        <AddRace onAdded={onChanged} />
      </div>

      <SectionTitle>כושר נוכחי</SectionTitle>
      <section className="card flex items-center gap-5 p-5">
        <Ring value={f.shape} size={128} stroke={13} gradient={['#ff9a3d', '#0a84ff']}>
          <div>
            <div className="num text-[34px] font-black leading-none">
              {f.shape}
              <span className="text-lg">%</span>
            </div>
            <div className="mt-1 text-[10px] font-semibold text-slate-500 dark:text-slate-400">כושר מרתון</div>
          </div>
        </Ring>
        <div className="min-w-0 flex-1 space-y-3">
          <ShapeRow label="כושר מול היעד" value={f.fitnessPct} />
          <ShapeRow label="ריצה ארוכה (מ-32 ק״מ)" value={f.longRunPct} />
          <ShapeRow label="נפח שבועי (מ-65 ק״מ)" value={f.volumePct} />
        </div>
      </section>

      <FitnessScience f={f} />

      <VolumeChart activities={activities} />
      <Records activities={activities} />
    </div>
  );
}

function FitnessScience({ f }: { f: ReturnType<typeof useFitness> }) {
  const sourceLabel =
    f.source === 'default'
      ? 'הערכה ראשונית לפי היעד — תתעדכן אחרי סנכרון Garmin'
      : f.source === 'blended'
        ? 'לפי קצב + דופק מהריצות שלך'
        : 'לפי הביצועים בריצות שלך';
  return (
    <>
      <SectionTitle>המדע מאחורי התוכנית</SectionTitle>
      <section className="card overflow-hidden">
        <div className="flex items-center gap-4 bg-gradient-to-l from-brand-500/10 to-transparent p-5">
          <div className="grid size-16 shrink-0 place-items-center rounded-2xl bg-brand-500 text-white shadow-lg shadow-brand-500/30">
            <FlaskConical className="size-7" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="text-sm font-semibold text-slate-500 dark:text-slate-400">VDOT</span>
              <span className="num text-[34px] font-black leading-none">{f.vdot.toFixed(1)}</span>
              {f.phase && (
                <span className="ms-auto rounded-full bg-brand-500/15 px-2.5 py-1 text-xs font-bold text-brand-700 dark:text-brand-300">
                  {PHASE_LABEL[f.phase] ?? f.phase}
                </span>
              )}
            </div>
            <p className="mt-1 text-[12px] text-slate-500 dark:text-slate-400">{sourceLabel}</p>
          </div>
        </div>

        {f.predictions.length > 0 && (
          <div className="border-t border-slate-100 p-5 dark:border-white/5">
            <p className="mb-3 text-[12px] font-semibold text-slate-500 dark:text-slate-400">תחזית לפי הכושר הנוכחי</p>
            <ul className="space-y-2.5">
              {f.predictions.map(({ race, predicted }) => {
                const onTrack = race.target_time_s ? predicted <= race.target_time_s : null;
                return (
                  <li key={race.id} className="flex items-center justify-between gap-3">
                    <span className="truncate text-sm font-semibold">{race.name}</span>
                    <span className="flex shrink-0 items-center gap-2">
                      <span className="num text-[17px] font-black">{formatDuration(predicted)}</span>
                      {onTrack !== null && (
                        <span
                          className={cx(
                            'rounded-full px-2 py-0.5 text-[11px] font-bold',
                            onTrack
                              ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                              : 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
                          )}
                        >
                          {onTrack ? 'בדרך ליעד' : `יעד ${formatDuration(race.target_time_s!)}`}
                        </span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <div className="border-t border-slate-100 p-5 dark:border-white/5">
          <p className="mb-3 text-[12px] font-semibold text-slate-500 dark:text-slate-400">אזורי הקצב שלך (שיטת ג׳ק דניאלס)</p>
          <ul className="space-y-3">
            {ZONES.map((z) => (
              <li key={z.key} className="flex items-center gap-3">
                <span className={cx('h-9 w-1.5 shrink-0 rounded-full', z.color)} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold">{z.label}</p>
                  <p className="truncate text-[11px] text-slate-500 dark:text-slate-400">{z.desc}</p>
                </div>
                <PaceRange fast={f.paces[z.key].fast} slow={f.paces[z.key].slow} className="text-[15px] font-black" />
              </li>
            ))}
          </ul>
          <p className="mt-4 text-[11px] leading-relaxed text-slate-400">
            ככל שהכושר משתפר (VDOT עולה), כל הקצבים מתעדכנים אוטומטית — כך כל אימון מאתגר בדיוק במידה הנכונה.
          </p>
        </div>
      </section>
    </>
  );
}

function RaceCard({ race, featured, onDelete }: { race: Race; featured: boolean; onDelete: () => void }) {
  const days = daysUntil(race.race_date);
  const weeks = Math.floor(days / 7);
  const isFull = race.distance_km > 40;
  const targetPace = race.target_time_s ? race.target_time_s / race.distance_km : null;
  // Rough "journey" progress: assume a 20-week build (full) / 12-week build (half).
  const buildDays = (isFull ? 20 : 12) * 7;
  const progress = Math.max(0, Math.min(100, ((buildDays - days) / buildDays) * 100));

  return (
    <section
      className={cx(
        'relative isolate overflow-hidden rounded-[28px] p-5',
        featured
          ? 'bg-gradient-to-br from-brand-500 via-brand-600 to-brand-800 text-white shadow-xl shadow-brand-700/25'
          : 'bg-gradient-to-br from-ink-800 via-ink-900 to-ink-950 text-white shadow-xl',
      )}
    >
      <svg className="absolute -bottom-24 -start-20 -z-10 size-72 opacity-15" viewBox="0 0 200 200" aria-hidden>
        {[30, 50, 70, 90].map((r) => (
          <circle key={r} cx="100" cy="100" r={r} fill="none" stroke="white" strokeWidth="1.5" strokeDasharray="3 5" />
        ))}
      </svg>

      <div className="flex items-start justify-between">
        <div>
          <span className="inline-flex items-center gap-1 rounded-full bg-white/15 px-2.5 py-1 text-[11px] font-bold">
            {isFull ? <Trophy className="size-3.5" /> : <Medal className="size-3.5" />}
            מרוץ {race.priority} · <span className="num">{race.distance_km.toFixed(1)}</span> ק״מ
          </span>
          <h2 className="mt-3 text-xl font-extrabold">{race.name}</h2>
          <p className="flex items-center gap-2 text-[13px] text-white/70">
            {fmt.weekday(parseISODate(race.race_date))}, {fmt.date(parseISODate(race.race_date))}
            <button onClick={onDelete} aria-label={`מחיקת ${race.name}`} className="rounded-full p-1 text-white/50 hover:bg-white/10 hover:text-white">
              <Trash2 className="size-3.5" />
            </button>
          </p>
        </div>
        <div className="text-center">
          <div className="num text-[48px] font-black leading-none tracking-tight">{days}</div>
          <div className="text-[11px] font-semibold text-white/70">ימים</div>
        </div>
      </div>

      <div className="mt-5">
        <div className="mb-1.5 flex justify-between text-[11px] font-medium text-white/70">
          <span>{weeks} שבועות לזינוק</span>
          {race.target_time_s && (
            <span className="flex items-center gap-1">
              <Flag className="size-3" />
              יעד <span className="num font-bold text-white">{formatDuration(race.target_time_s)}</span>
              {targetPace && <span>· <span className="num">{formatPace(targetPace)}</span> לק״מ</span>}
            </span>
          )}
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-white/15">
          <div className={cx('h-full rounded-full', featured ? 'bg-white' : 'bg-ember-500')} style={{ width: `${progress}%` }} />
        </div>
      </div>
    </section>
  );
}

function ShapeRow({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="mb-1 flex justify-between text-[12px]">
        <span className="font-medium text-slate-600 dark:text-slate-300">{label}</span>
        <span className="num font-bold">{value}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-white/10">
        <div className="h-full rounded-full bg-gradient-to-l from-ember-400 to-brand-500" style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}

function VolumeChart({ activities }: { activities: Activity[] }) {
  const weeks = useMemo(() => weeklyVolume(activities, 8), [activities]);
  const max = Math.max(10, ...weeks.map((w) => w.km));
  const avg = weeks.slice(0, -1).reduce((s, w) => s + w.km, 0) / Math.max(1, weeks.length - 1);

  return (
    <>
      <SectionTitle>נפח שבועי</SectionTitle>
      <section className="card p-5">
        <div className="flex items-end justify-between">
          <div>
            <span className="num text-[30px] font-black leading-none">{avg.toFixed(1)}</span>
            <span className="ms-1 text-sm font-semibold text-slate-500">ק״מ ממוצע</span>
          </div>
          <span className="text-xs text-slate-500 dark:text-slate-400">8 שבועות אחרונים</span>
        </div>
        {/* bars read right→left (oldest on the right) to match RTL reading order */}
        <div className="relative mt-5 flex h-40 items-end gap-2" role="img" aria-label="גרף נפח שבועי">
          <div
            className="pointer-events-none absolute inset-x-0 border-t border-dashed border-slate-300 dark:border-white/15"
            style={{ bottom: `${(avg / max) * 100}%` }}
          />
          {weeks.map((w, i) => {
            const isCurrent = i === weeks.length - 1;
            return (
              <div key={w.start} className="group flex h-full flex-1 flex-col items-center justify-end gap-1.5">
                <span className={cx('num text-[10px] font-bold', isCurrent ? 'text-brand-600 dark:text-brand-300' : 'text-slate-400 opacity-0 transition group-hover:opacity-100')}>
                  {w.km.toFixed(0)}
                </span>
                <div
                  className={cx(
                    'w-full rounded-t-lg rounded-b-sm transition-all duration-700',
                    isCurrent ? 'bg-gradient-to-t from-brand-600 to-brand-400' : 'bg-brand-500/25 group-hover:bg-brand-500/45 dark:bg-brand-400/25',
                  )}
                  style={{ height: `${Math.max(4, (w.km / max) * 100)}%` }}
                />
              </div>
            );
          })}
        </div>
        <div className="mt-2 flex gap-2">
          {weeks.map((w) => (
            <span key={w.start} className="num flex-1 text-center text-[10px] text-slate-400">
              {parseISODate(w.start).getDate()}/{parseISODate(w.start).getMonth() + 1}
            </span>
          ))}
        </div>
      </section>
    </>
  );
}

function Records({ activities }: { activities: Activity[] }) {
  if (!activities.length) return null;
  const longest = activities.reduce((a, b) => (b.distance_m > a.distance_m ? b : a));
  const fastest = activities
    .filter((a) => a.distance_m >= 5000 && a.avg_pace_sec_per_km)
    .reduce<Activity | null>((a, b) => (!a || b.avg_pace_sec_per_km! < a.avg_pace_sec_per_km! ? b : a), null);
  const climb = activities.reduce((a, b) => ((b.elevation_gain_m ?? 0) > (a.elevation_gain_m ?? 0) ? b : a));

  return (
    <>
      <SectionTitle>שיאים אחרונים</SectionTitle>
      <section className="grid grid-cols-3 gap-2.5">
        <RecordTile icon={<Trophy className="size-5" />} color="text-amber-500 bg-amber-500/10" label="הארוכה ביותר" value={(longest.distance_m / 1000).toFixed(1)} unit="ק״מ" />
        <RecordTile icon={<Zap className="size-5" />} color="text-brand-500 bg-brand-500/10" label="הקצב המהיר" value={formatPace(fastest?.avg_pace_sec_per_km)} unit="/ק״מ" />
        <RecordTile icon={<Timer className="size-5" />} color="text-emerald-500 bg-emerald-500/10" label="טיפוס מקסימלי" value={String(Math.round(climb.elevation_gain_m ?? 0))} unit="מ׳" />
      </section>
    </>
  );
}

function RecordTile({ icon, color, label, value, unit }: { icon: ReactNode; color: string; label: string; value: string; unit: string }) {
  return (
    <div className="card p-3.5">
      <span className={cx('grid size-9 place-items-center rounded-xl', color)}>{icon}</span>
      <div className="mt-3 flex items-baseline gap-0.5">
        <span className="num text-xl font-black">{value}</span>
        <span className="text-[10px] text-slate-500">{unit}</span>
      </div>
      <p className="text-[11px] font-medium text-slate-500 dark:text-slate-400">{label}</p>
    </div>
  );
}

const DISTANCES = [
  { label: '5K', km: 5 },
  { label: '10K', km: 10 },
  { label: 'חצי מרתון', km: 21.0975 },
  { label: 'מרתון', km: 42.195 },
];

function parseTime(v: string): number | null {
  const parts = v.trim().split(':').map(Number);
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return null;
  const s = parts.reduce((acc, n) => acc * 60 + n, 0);
  return s > 0 ? Math.round(parts.length === 2 && parts[0] < 10 ? s * 60 : s) : null; // "3:45" → h:mm
}

function AddRace({ onAdded }: { onAdded: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [date, setDate] = useState('');
  const [km, setKm] = useState(21.0975);
  const [target, setTarget] = useState('');
  const [priority, setPriority] = useState<Race['priority']>('A');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await addRace({ name: name.trim(), race_date: date, distance_km: km, target_time_s: parseTime(target), priority });
      setOpen(false);
      setName('');
      setDate('');
      setTarget('');
      onAdded();
      toast('המרוץ נוסף — לחצו "כיול מחדש" כדי שהתוכנית תתאים אליו');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex w-full items-center justify-center gap-2 rounded-[28px] border-2 border-dashed border-slate-300 py-4 text-sm font-bold text-slate-500 transition hover:border-brand-400 hover:text-brand-600 dark:border-white/10 dark:text-slate-400"
      >
        <Plus className="size-4" /> הוספת מרוץ יעד
      </button>
    );
  }

  const inputCls = 'w-full rounded-2xl bg-slate-100 px-4 py-3 text-sm outline-none ring-brand-500 focus:ring-2 dark:bg-white/5';
  return (
    <form onSubmit={submit} className="card space-y-3 p-5">
      <p className="font-bold">מרוץ חדש</p>
      <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="שם המרוץ (למשל: מרתון תל אביב)" className={inputCls} />
      <input required type="date" value={date} min={toISODate(new Date())} onChange={(e) => setDate(e.target.value)} className={inputCls} aria-label="תאריך המרוץ" />
      <div className="grid grid-cols-4 gap-1 rounded-2xl bg-slate-100 p-1 dark:bg-white/5" role="radiogroup" aria-label="מרחק">
        {DISTANCES.map((d) => (
          <button
            type="button"
            key={d.km}
            role="radio"
            aria-checked={km === d.km}
            onClick={() => setKm(d.km)}
            className={cx('rounded-xl py-2 text-xs font-bold', km === d.km ? 'bg-white shadow-sm dark:bg-ink-600' : 'text-slate-500')}
          >
            {d.label}
          </button>
        ))}
      </div>
      <input
        dir="ltr"
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        placeholder="זמן יעד, למשל 1:45:00 (לא חובה)"
        className={inputCls}
        aria-label="זמן יעד"
      />
      <div className="flex items-center gap-2 text-sm">
        <span className="text-slate-500">עדיפות:</span>
        {(['A', 'B', 'C'] as const).map((p) => (
          <button
            type="button"
            key={p}
            onClick={() => setPriority(p)}
            className={cx('size-9 rounded-full font-bold', priority === p ? 'bg-brand-500 text-white' : 'bg-slate-100 dark:bg-white/5')}
          >
            {p}
          </button>
        ))}
        <span className="text-[11px] text-slate-400">A = המרוץ המרכזי</span>
      </div>
      <div className="flex gap-2">
        <button disabled={busy} className="flex-1 rounded-2xl bg-brand-500 py-3 text-sm font-bold text-white disabled:opacity-60">
          הוספה
        </button>
        <button type="button" onClick={() => setOpen(false)} className="rounded-2xl px-4 text-sm font-semibold text-slate-500">
          ביטול
        </button>
      </div>
    </form>
  );
}
