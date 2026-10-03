import type { ReactNode } from 'react';
import { formatPace, HR_ZONES, WORKOUT_META } from '../lib/format';
import type { WorkoutType } from '../lib/types';

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(' ');
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-3 mt-7 flex items-end justify-between px-1">
      <h2 className="text-[13px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{children}</h2>
      {action}
    </div>
  );
}

export function WorkoutBadge({ type, className }: { type: WorkoutType; className?: string }) {
  const m = WORKOUT_META[type];
  return (
    <span className={cx('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold', m.chip, className)}>
      <span className={cx('size-1.5 rounded-full', m.dot)} />
      {m.label}
    </span>
  );
}

/** "6:45–7:15" — always rendered LTR so it reads correctly inside RTL text. */
export function PaceRange({ fast, slow, className }: { fast: number | null; slow: number | null; className?: string }) {
  if (fast == null && slow == null) return <span className={className}>–</span>;
  return (
    <span className={cx('num whitespace-nowrap', className)}>
      {formatPace(fast)}
      {slow != null && fast !== slow && <>–{formatPace(slow)}</>}
    </span>
  );
}

/** Progress ring. value 0..100 */
export function Ring({
  value,
  size = 120,
  stroke = 12,
  className,
  trackClass = 'stroke-slate-200 dark:stroke-white/10',
  gradient = ['#3399ff', '#0054b4'],
  children,
}: {
  value: number;
  size?: number;
  stroke?: number;
  className?: string;
  trackClass?: string;
  gradient?: [string, string];
  children?: ReactNode;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, value));
  const id = `ring-${gradient.join('').replace(/#/g, '')}`;
  return (
    <div className={cx('relative inline-grid place-items-center', className)} style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor={gradient[0]} />
            <stop offset="1" stopColor={gradient[1]} />
          </linearGradient>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className={trackClass} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={`url(#${id})`}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - pct / 100)}
          style={{ transition: 'stroke-dashoffset 900ms cubic-bezier(0.22,1,0.36,1)' }}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">{children}</div>
    </div>
  );
}

/** 5-segment HR zone indicator. */
export function ZoneBar({ zone, light = false }: { zone: number | null; light?: boolean }) {
  return (
    <div className="flex items-end gap-1" aria-label={zone ? `אזור דופק ${zone}` : 'ללא אזור דופק'}>
      {HR_ZONES.map((z) => (
        <span
          key={z.zone}
          className={cx(
            'w-2.5 rounded-full transition-all',
            zone === z.zone
              ? light
                ? 'bg-white'
                : z.color
              : light
                ? 'bg-white/25'
                : 'bg-slate-200 dark:bg-white/10',
          )}
          style={{ height: 6 + z.zone * 4 }}
        />
      ))}
    </div>
  );
}

export function Stat({
  label,
  value,
  unit,
  icon,
  className,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx('min-w-0', className)}>
      <div className="flex items-center gap-1 text-[11px] font-medium text-slate-500 dark:text-slate-400">
        {icon}
        {label}
      </div>
      <div className="mt-0.5 flex items-baseline gap-1">
        <span className="num text-lg font-bold leading-tight">{value}</span>
        {unit && <span className="text-[11px] text-slate-500 dark:text-slate-400">{unit}</span>}
      </div>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cx(
        'animate-shimmer rounded-3xl bg-[linear-gradient(90deg,var(--color-slate-200)_0%,var(--color-slate-100)_50%,var(--color-slate-200)_100%)] bg-[length:200%_100%] dark:bg-[linear-gradient(90deg,var(--color-ink-800)_0%,var(--color-ink-700)_50%,var(--color-ink-800)_100%)]',
        className,
      )}
    />
  );
}

export function ErrorCard({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <div className="card p-5 text-sm">
      <p className="font-semibold text-rose-600 dark:text-rose-400">משהו השתבש</p>
      <p className="mt-1 text-slate-500 dark:text-slate-400">{error.message}</p>
      {onRetry && (
        <button onClick={onRetry} className="mt-3 rounded-full bg-slate-900 px-4 py-2 text-xs font-semibold text-white dark:bg-white dark:text-slate-900">
          נסו שוב
        </button>
      )}
    </div>
  );
}
