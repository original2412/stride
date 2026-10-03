import { CalendarDays, Footprints, History, Settings, Trophy, type LucideIcon } from 'lucide-react';
import { cx } from './ui';

export type TabId = 'today' | 'history' | 'plan' | 'goals' | 'settings';

export const TABS: { id: TabId; label: string; icon: LucideIcon }[] = [
  { id: 'today', label: 'היום', icon: Footprints },
  { id: 'history', label: 'היסטוריה', icon: History },
  { id: 'plan', label: 'תוכנית', icon: CalendarDays },
  { id: 'goals', label: 'יעדים', icon: Trophy },
  { id: 'settings', label: 'הגדרות', icon: Settings },
];

export default function BottomNav({ active, onChange }: { active: TabId; onChange: (t: TabId) => void }) {
  return (
    <nav
      aria-label="ניווט ראשי"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-900/5 bg-white/85 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl dark:border-white/5 dark:bg-ink-900/85"
    >
      <ul className="mx-auto grid max-w-lg grid-cols-5 px-2">
        {TABS.map(({ id, label, icon: Icon }) => {
          const isActive = id === active;
          return (
            <li key={id}>
              <button
                type="button"
                onClick={() => onChange(id)}
                aria-current={isActive ? 'page' : undefined}
                className="group flex w-full flex-col items-center gap-1 pb-2 pt-2.5 outline-none"
              >
                <span
                  className={cx(
                    'grid h-8 w-14 place-items-center rounded-full transition-all duration-300',
                    isActive
                      ? 'bg-brand-500 text-white shadow-lg shadow-brand-500/30'
                      : 'text-slate-400 group-hover:text-slate-600 dark:text-slate-500 dark:group-hover:text-slate-300',
                  )}
                >
                  <Icon className="size-[19px]" strokeWidth={isActive ? 2.5 : 2} />
                </span>
                <span
                  className={cx(
                    'text-[11px] transition-colors',
                    isActive ? 'font-semibold text-brand-600 dark:text-brand-300' : 'font-medium text-slate-500 dark:text-slate-400',
                  )}
                >
                  {label}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
