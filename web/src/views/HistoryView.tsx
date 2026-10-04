import { HeartPulse, Mountain, RefreshCw, TrendingUp, Watch } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { PageHeader } from '../components/Layout';
import { useToast } from '../components/Toast';
import { cx, ErrorCard, Skeleton } from '../components/ui';
import { useAsync } from '../hooks/useAsync';
import { fetchActivities, fetchStravaLink, isDemo, syncGarmin, syncStrava } from '../lib/api';
import { addDays, fmt, formatDuration, formatKm, formatPace, toISODate } from '../lib/format';
import { weekStart } from '../lib/stats';
import type { Activity } from '../lib/types';

export default function HistoryView() {
  const toast = useToast();
  const acts = useAsync(() => fetchActivities(90));
  const [syncing, setSyncing] = useState(false);

  async function handleSync() {
    setSyncing(true);
    try {
      // Prefer the official Strava link (immediate); fall back to the queued Garmin worker.
      const strava = isDemo ? null : await fetchStravaLink();
      if (strava) {
        const r = await syncStrava();
        await acts.reload();
        toast(`סונכרנו ${r.upserted} ריצות מ-Strava`);
      } else {
        await syncGarmin();
        await acts.reload();
        toast(isDemo ? 'סונכרנו 3 ריצות' : 'הבקשה נשלחה — הריצות יופיעו תוך כחצי שעה');
      }
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSyncing(false);
    }
  }

  const groups = useMemo(() => groupByWeek(acts.data ?? []), [acts.data]);
  const month = useMemo(() => summarize((acts.data ?? []).filter((a) => Date.now() - Date.parse(a.start_time) < 30 * 86_400_000)), [acts.data]);

  return (
    <div>
      <PageHeader eyebrow="Strava · Garmin" title="היסטוריית ריצות" />

      <button
        onClick={handleSync}
        disabled={syncing}
        className="flex w-full items-center justify-center gap-2 rounded-2xl bg-brand-500 py-3.5 text-[15px] font-bold text-white shadow-lg shadow-brand-500/30 transition hover:bg-brand-600 active:scale-[0.99] disabled:opacity-80"
      >
        <RefreshCw className={cx('size-5', syncing && 'animate-spin')} />
        {syncing ? 'מסנכרן…' : 'סנכרון ריצות'}
      </button>

      {/* 30-day summary */}
      <section className="mt-4 grid grid-cols-3 overflow-hidden rounded-3xl bg-ink-900 text-white shadow-xl dark:bg-ink-800 dark:ring-1 dark:ring-white/5">
        <Summary label="ק״מ ב-30 יום" value={month.km.toFixed(0)} accent />
        <Summary label="ריצות" value={String(month.runs)} />
        <Summary label="זמן כולל" value={`${Math.floor(month.seconds / 3600)}h`} />
      </section>

      {acts.error && <div className="mt-4"><ErrorCard error={acts.error} onRetry={acts.reload} /></div>}

      {!acts.data && !acts.error && (
        <div className="mt-6 space-y-3">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-32" />)}
        </div>
      )}

      {acts.data && acts.data.length === 0 && (
        <div className="card mt-6 grid place-items-center gap-2 p-8 text-center">
          <Watch className="size-10 text-brand-500" />
          <p className="font-bold">עדיין אין ריצות</p>
          <p className="text-sm text-slate-500">לחצו על “סנכרון עם Garmin” כדי למשוך את הריצות האחרונות.</p>
        </div>
      )}

      {groups.map((g) => (
        <section key={g.start} className="mt-7">
          <div className="mb-2.5 flex items-baseline justify-between px-1">
            <h2 className="text-[13px] font-semibold text-slate-500 dark:text-slate-400">{g.label}</h2>
            <span className="num text-xs font-bold text-slate-500 dark:text-slate-400">{g.km.toFixed(1)} ק״מ</span>
          </div>
          <ul className="space-y-3">
            {g.items.map((a) => <RunCard key={a.id} a={a} />)}
          </ul>
        </section>
      ))}
    </div>
  );
}

function Summary({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="border-e border-white/10 p-4 text-center last:border-e-0">
      <div className={cx('num text-[26px] font-black leading-none', accent && 'text-brand-300')}>{value}</div>
      <div className="mt-1.5 text-[11px] font-medium text-white/60">{label}</div>
    </div>
  );
}

function RunCard({ a }: { a: Activity }) {
  const d = new Date(a.start_time);
  const gapFaster = a.gap_sec_per_km != null && a.avg_pace_sec_per_km != null && a.avg_pace_sec_per_km - a.gap_sec_per_km >= 3;
  return (
    <li className="card overflow-hidden">
      <div className="flex items-stretch">
        <div className="flex w-[84px] shrink-0 flex-col items-center justify-center bg-brand-500/[0.07] py-4 dark:bg-brand-500/10">
          <span className="num text-[26px] font-black leading-none text-brand-600 dark:text-brand-300">{formatKm(a.distance_m, 1)}</span>
          <span className="mt-1 text-[11px] font-semibold text-brand-600/70 dark:text-brand-300/70">ק״מ</span>
        </div>
        <div className="min-w-0 flex-1 p-4">
          <div className="flex items-start justify-between gap-2">
            <p className="truncate font-bold">{a.name ?? 'ריצה'}</p>
            <span className="shrink-0 text-[11px] text-slate-500 dark:text-slate-400">
              {fmt.weekday(d)} · <span className="num">{fmt.time(d)}</span>
            </span>
          </div>
          <dl className="mt-3 grid grid-cols-4 gap-x-2 gap-y-2 text-[11px]">
            <Metric label="זמן" value={formatDuration(a.duration_s)} />
            <Metric label="קצב" value={formatPace(a.avg_pace_sec_per_km)} />
            <Metric
              label="GAP"
              value={formatPace(a.gap_sec_per_km)}
              icon={gapFaster ? <TrendingUp className="size-3 text-emerald-500" /> : undefined}
            />
            <Metric label="דופק" value={a.avg_hr ?? '–'} icon={<HeartPulse className="size-3 text-rose-500" />} />
          </dl>
          {a.elevation_gain_m != null && a.elevation_gain_m > 0 && (
            <div className="mt-3 flex items-center gap-1.5 text-[11px] font-medium text-slate-500 dark:text-slate-400">
              <Mountain className="size-3.5" />
              <span className="num">+{Math.round(a.elevation_gain_m)}</span> מ׳ טיפוס
              {a.training_load != null && (
                <span className="ms-auto rounded-full bg-slate-100 px-2 py-0.5 font-semibold dark:bg-white/5">
                  עומס <span className="num">{Math.round(a.training_load)}</span>
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

function Metric({ label, value, icon }: { label: string; value: ReactNode; icon?: ReactNode }) {
  return (
    <div>
      <dt className="flex items-center gap-0.5 text-slate-500 dark:text-slate-400">
        {label}
        {icon}
      </dt>
      <dd className="num text-[15px] font-bold leading-tight">{value}</dd>
    </div>
  );
}

function summarize(list: Activity[]) {
  return list.reduce(
    (s, a) => ({ km: s.km + a.distance_m / 1000, runs: s.runs + 1, seconds: s.seconds + a.duration_s }),
    { km: 0, runs: 0, seconds: 0 },
  );
}

function groupByWeek(list: Activity[]) {
  const thisWeek = toISODate(weekStart(new Date()));
  const lastWeek = toISODate(addDays(weekStart(new Date()), -7));
  const map = new Map<string, Activity[]>();
  for (const a of list) {
    const k = toISODate(weekStart(new Date(a.start_time)));
    map.set(k, [...(map.get(k) ?? []), a]);
  }
  return [...map.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([start, items]) => {
      const s = new Date(start);
      const label =
        start === thisWeek ? 'השבוע' : start === lastWeek ? 'שבוע שעבר' : `${fmt.dateShort(s)} – ${fmt.dateShort(addDays(s, 6))}`;
      return { start, label, items, km: items.reduce((x, a) => x + a.distance_m / 1000, 0) };
    });
}
