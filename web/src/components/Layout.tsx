import type { ReactNode } from 'react';
import { isDemo } from '../lib/api';
import BottomNav, { type TabId } from './BottomNav';

export default function Layout({
  tab,
  onTabChange,
  children,
}: {
  tab: TabId;
  onTabChange: (t: TabId) => void;
  children: ReactNode;
}) {
  return (
    <div className="min-h-dvh">
      {isDemo && (
        <div className="bg-ember-500 px-4 pb-1.5 pt-[max(env(safe-area-inset-top),0.375rem)] text-center text-[11px] font-semibold text-white">
          מצב הדגמה · נתונים לדוגמה
        </div>
      )}
      {/* key remounts the view on tab change so the entry animation replays */}
      <main key={tab} className="mx-auto max-w-lg animate-rise px-4 pb-32 pt-[max(env(safe-area-inset-top),1rem)]">
        {children}
      </main>
      <BottomNav active={tab} onChange={onTabChange} />
    </div>
  );
}

export function PageHeader({ eyebrow, title, action }: { eyebrow?: string; title: string; action?: ReactNode }) {
  return (
    <header className="mb-5 mt-2 flex items-end justify-between gap-3">
      <div>
        {eyebrow && <p className="text-sm font-medium text-slate-500 dark:text-slate-400">{eyebrow}</p>}
        <h1 className="text-[28px] font-extrabold leading-tight tracking-tight">{title}</h1>
      </div>
      {action}
    </header>
  );
}
