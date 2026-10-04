import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Eye,
  EyeOff,
  HeartPulse,
  KeyRound,
  Loader2,
  LogOut,
  Monitor,
  Moon,
  RefreshCw,
  ShieldCheck,
  Sun,
  Unlink,
  Watch,
} from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { PageHeader } from '../components/Layout';
import { useToast } from '../components/Toast';
import { cx, Skeleton } from '../components/ui';
import { useAsync } from '../hooks/useAsync';
import { useTheme, type ThemePref } from '../hooks/useTheme';
import {
  connectStrava,
  disconnectStrava,
  fetchGarminLink,
  fetchStravaLink,
  syncStrava,
  type StravaLink,
  fetchProfile,
  hasGeminiKey,
  isDemo,
  removeGarminCredentials,
  saveGarminCredentials,
  saveGeminiKey,
  signOut,
  syncGarmin,
  updateProfile,
  type GarminLink,
} from '../lib/api';
import { fmt } from '../lib/format';

export default function SettingsView() {
  const toast = useToast();
  const { theme, setTheme } = useTheme();
  const data = useAsync(async () => {
    const [profile, keySet] = await Promise.all([fetchProfile(), hasGeminiKey()]);
    return { profile, keySet };
  });

  const [name, setName] = useState('');
  const [hrMax, setHrMax] = useState('');
  const [hrRest, setHrRest] = useState('');
  const [weekly, setWeekly] = useState('');
  const [key, setKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [savingKey, setSavingKey] = useState(false);

  useEffect(() => {
    const p = data.data?.profile;
    if (!p) return;
    setName(p.display_name ?? '');
    setHrMax(String(p.hr_max));
    setHrRest(String(p.hr_rest));
    setWeekly(p.weekly_km_target ? String(p.weekly_km_target) : '');
  }, [data.data?.profile]);

  async function saveProfile() {
    try {
      await updateProfile({
        display_name: name.trim() || null,
        hr_max: Number(hrMax) || 185,
        hr_rest: Number(hrRest) || 55,
        weekly_km_target: weekly ? Number(weekly) : null,
      });
      toast('הפרופיל נשמר');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }

  async function handleSaveKey() {
    setSavingKey(true);
    try {
      await saveGeminiKey(key);
      setKey('');
      await data.reload();
      toast(key.trim() ? 'מפתח Gemini נשמר בצורה מאובטחת' : 'המפתח הוסר');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSavingKey(false);
    }
  }

  if (!data.data) return <div className="space-y-4 pt-16"><Skeleton className="h-48" /><Skeleton className="h-32" /></div>;
  const { keySet } = data.data;

  return (
    <div>
      <PageHeader title="הגדרות" />

      {/* Profile */}
      <div className="card mb-6 flex items-center gap-4 p-5">
        <div className="grid size-16 shrink-0 place-items-center rounded-full bg-gradient-to-br from-brand-400 to-brand-700 text-2xl font-black text-white shadow-lg shadow-brand-500/30">
          {(name || 'R').slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={saveProfile}
            placeholder="השם שלך"
            className="w-full bg-transparent text-lg font-bold outline-none placeholder:text-slate-400"
            aria-label="שם תצוגה"
          />
          <p className="text-xs text-slate-500 dark:text-slate-400">{isDemo ? 'משתמש הדגמה' : 'מחובר/ת דרך Supabase'}</p>
        </div>
      </div>

      <Group title="פרופיל רץ">
        <Row icon={<HeartPulse className="size-4" />} iconBg="bg-rose-500" label="דופק מקסימלי">
          <NumberInput value={hrMax} onChange={setHrMax} onBlur={saveProfile} suffix="bpm" />
        </Row>
        <Row icon={<HeartPulse className="size-4" />} iconBg="bg-pink-400" label="דופק במנוחה">
          <NumberInput value={hrRest} onChange={setHrRest} onBlur={saveProfile} suffix="bpm" />
        </Row>
        <Row icon={<Watch className="size-4" />} iconBg="bg-brand-500" label="יעד שבועי">
          <NumberInput value={weekly} onChange={setWeekly} onBlur={saveProfile} suffix="ק״מ" />
        </Row>
      </Group>

      <Group title="תצוגה">
        <div className="p-2">
          <div className="grid grid-cols-3 gap-1 rounded-2xl bg-slate-100 p-1 dark:bg-white/5" role="radiogroup" aria-label="ערכת נושא">
            {(
              [
                { id: 'light', label: 'בהיר', icon: Sun },
                { id: 'dark', label: 'כהה', icon: Moon },
                { id: 'system', label: 'מערכת', icon: Monitor },
              ] as { id: ThemePref; label: string; icon: typeof Sun }[]
            ).map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                role="radio"
                aria-checked={theme === id}
                onClick={() => setTheme(id)}
                className={cx(
                  'flex items-center justify-center gap-1.5 rounded-xl py-2.5 text-sm font-semibold transition',
                  theme === id ? 'bg-white text-slate-900 shadow-sm dark:bg-ink-600 dark:text-white' : 'text-slate-500',
                )}
              >
                <Icon className="size-4" />
                {label}
              </button>
            ))}
          </div>
        </div>
      </Group>

      <StravaSection />

      <GarminSection />

      <Group title="Google Gemini (אופציונלי)">
        <div className="space-y-3 p-4">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-sm font-semibold">
              <span className="grid size-7 place-items-center rounded-lg bg-gradient-to-br from-brand-500 to-violet-500 text-white">
                <KeyRound className="size-4" />
              </span>
              מפתח API
            </span>
            <span className={cx('rounded-full px-2.5 py-0.5 text-xs font-semibold', keySet ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' : 'bg-slate-100 text-slate-500 dark:bg-white/5')}>
              {keySet ? 'מוגדר' : 'לא מוגדר'}
            </span>
          </div>
          <div className="relative">
            <input
              type={showKey ? 'text' : 'password'}
              dir="ltr"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={keySet ? '••••••••••••  (הזינו מפתח חדש להחלפה)' : 'AIza…'}
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded-2xl bg-slate-100 py-3 pe-4 ps-11 text-sm outline-none ring-brand-500 focus:ring-2 dark:bg-white/5"
              aria-label="מפתח Gemini API"
            />
            <button
              type="button"
              onClick={() => setShowKey((s) => !s)}
              className="absolute inset-y-0 left-0 grid w-11 place-items-center text-slate-400"
              aria-label={showKey ? 'הסתר מפתח' : 'הצג מפתח'}
            >
              {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
          <button
            onClick={handleSaveKey}
            disabled={savingKey || (!key && !keySet)}
            className="w-full rounded-2xl bg-slate-900 py-3 text-sm font-bold text-white transition active:scale-[0.99] disabled:opacity-40 dark:bg-white dark:text-slate-900"
          >
            {savingKey ? 'שומר…' : key ? 'שמירת מפתח' : keySet ? 'הסרת המפתח' : 'שמירת מפתח'}
          </button>
          <p className="text-[12px] leading-relaxed text-slate-500 dark:text-slate-400">
            התוכנית נבנית לפי כללי המחקר גם בלי מפתח. Gemini רק מנסח את הערת המאמן בשפה טבעית. המפתח נשמר בשרת בלבד ואינו נקרא חזרה לדפדפן.
          </p>
        </div>
      </Group>

      {!isDemo && (
        <button
          onClick={() => signOut().then(() => location.reload())}
          className="card flex w-full items-center justify-center gap-2 p-4 text-sm font-bold text-rose-600 dark:text-rose-400"
        >
          <LogOut className="size-4" /> התנתקות
        </button>
      )}
      <p className="mt-6 text-center text-[11px] text-slate-400">Stride · גרסה 0.1.0</p>
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-6">
      <h2 className="mb-2 px-1 text-[13px] font-semibold text-slate-500 dark:text-slate-400">{title}</h2>
      <div className="card divide-y divide-slate-100 overflow-hidden dark:divide-white/5">{children}</div>
    </section>
  );
}

function Row({ icon, iconBg, label, children }: { icon?: ReactNode; iconBg?: string; label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-14 items-center gap-3 px-4 py-2.5">
      {icon && <span className={cx('grid size-7 place-items-center rounded-lg text-white', iconBg)}>{icon}</span>}
      <span className="flex-1 text-sm font-medium">{label}</span>
      {children}
    </div>
  );
}

function NumberInput({ value, onChange, onBlur, suffix }: { value: string; onChange: (v: string) => void; onBlur: () => void; suffix: string }) {
  return (
    <label className="flex items-center gap-1.5 rounded-xl bg-slate-100 px-3 py-1.5 dark:bg-white/5">
      <input
        inputMode="numeric"
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/[^\d.]/g, ''))}
        onBlur={onBlur}
        className="num w-12 bg-transparent text-center text-sm font-bold outline-none"
      />
      <span className="text-[11px] text-slate-500">{suffix}</span>
    </label>
  );
}

const GARMIN_STATUS: Record<GarminLink['status'], { label: string; cls: string; icon: typeof CheckCircle2 }> = {
  ok: { label: 'מחובר', cls: 'text-emerald-600 dark:text-emerald-400', icon: CheckCircle2 },
  pending: { label: 'ממתין לסנכרון ראשון', cls: 'text-amber-600 dark:text-amber-400', icon: Clock },
  auth_error: { label: 'שגיאת התחברות', cls: 'text-rose-600 dark:text-rose-400', icon: AlertTriangle },
  mfa_required: { label: 'נדרש אימות דו-שלבי', cls: 'text-rose-600 dark:text-rose-400', icon: AlertTriangle },
  error: { label: 'שגיאה בסנכרון', cls: 'text-rose-600 dark:text-rose-400', icon: AlertTriangle },
};

function GarminSection() {
  const toast = useToast();
  const link = useAsync(fetchGarminLink);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  async function connect(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await saveGarminCredentials(email.trim(), password);
      setPassword('');
      setEditing(false);
      await link.reload();
      toast('Garmin חובר — הריצות יופיעו תוך כחצי שעה');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function syncNow() {
    setBusy(true);
    try {
      await syncGarmin();
      await link.reload();
      toast('הבקשה נשלחה — הסנכרון ירוץ תוך כחצי שעה');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    if (!confirm('לנתק את Garmin ולמחוק את פרטי ההתחברות השמורים?')) return;
    setBusy(true);
    try {
      await removeGarminCredentials();
      await link.reload();
      toast('Garmin נותק והפרטים נמחקו');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  if (link.loading && !link.data) return <Skeleton className="mb-6 h-40" />;
  const l = link.data ?? null;
  const st = l ? GARMIN_STATUS[l.status] : null;
  const lastSync = l?.last_sync_at ? new Date(l.last_sync_at) : null;
  const pendingRequest = l?.sync_requested_at && (!l.last_sync_at || l.sync_requested_at > l.last_sync_at);

  const inputCls =
    'w-full rounded-2xl bg-slate-100 px-4 py-3 text-sm outline-none ring-brand-500 focus:ring-2 dark:bg-white/5';

  return (
    <Group title="Garmin Connect ישיר (לא מומלץ כרגע — Garmin חוסמים)">
      {l && !editing ? (
        <>
          <Row icon={<Watch className="size-4" />} iconBg="bg-slate-800 dark:bg-slate-600" label="חשבון">
            <span dir="ltr" className="max-w-[55%] truncate text-sm text-slate-500 dark:text-slate-400">
              {l.garmin_email}
            </span>
          </Row>
          <Row label="סטטוס">
            {st && (
              <span className={cx('flex items-center gap-1 text-sm font-semibold', st.cls)}>
                <st.icon className="size-4" /> {st.label}
              </span>
            )}
          </Row>
          <Row label="סנכרון אחרון">
            <span className="text-sm text-slate-500 dark:text-slate-400">
              {lastSync ? `${fmt.dateShort(lastSync)} · ${fmt.time(lastSync)}` : '—'}
            </span>
          </Row>
          {l.last_error && l.status !== 'ok' && (
            <p className="mx-4 mb-1 rounded-xl bg-rose-500/10 p-3 text-[12px] text-rose-700 dark:text-rose-300">
              {l.status === 'auth_error'
                ? 'Garmin דחה את פרטי ההתחברות. בדקו את המייל והסיסמה ועדכנו אותם.'
                : l.status === 'mfa_required'
                  ? 'בחשבון מופעל אימות דו-שלבי. הסנכרון האוטומטי לא יכול לענות עליו — כבו אותו בהגדרות Garmin.'
                  : l.last_error}
            </p>
          )}
          <div className="flex gap-2 p-4">
            <button
              onClick={syncNow}
              disabled={busy || Boolean(pendingRequest)}
              className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-brand-500 py-3 text-sm font-bold text-white transition active:scale-[0.99] disabled:opacity-60"
            >
              <RefreshCw className={cx('size-4', busy && 'animate-spin')} />
              {pendingRequest ? 'סנכרון בתור…' : 'סנכרן עכשיו'}
            </button>
            <button
              onClick={() => {
                setEmail(l.garmin_email);
                setEditing(true);
              }}
              className="rounded-2xl bg-slate-100 px-4 text-sm font-semibold dark:bg-white/5"
            >
              עדכון
            </button>
            <button
              onClick={disconnect}
              disabled={busy}
              aria-label="ניתוק Garmin"
              className="grid w-12 place-items-center rounded-2xl bg-rose-500/10 text-rose-600 dark:text-rose-400"
            >
              <Unlink className="size-4" />
            </button>
          </div>
        </>
      ) : (
        <form onSubmit={connect} className="space-y-3 p-4">
          <p className="text-sm font-semibold">{l ? 'עדכון פרטי Garmin' : 'חיבור חשבון Garmin Connect'}</p>
          <input
            type="email"
            required
            dir="ltr"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="המייל שלך ב-Garmin"
            autoComplete="username"
            className={inputCls}
            aria-label="מייל Garmin"
          />
          <input
            type="password"
            required
            dir="ltr"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="הסיסמה שלך ב-Garmin"
            autoComplete="current-password"
            className={inputCls}
            aria-label="סיסמת Garmin"
          />
          <div className="flex gap-2">
            <button
              disabled={busy}
              className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-slate-900 py-3 text-sm font-bold text-white transition active:scale-[0.99] disabled:opacity-60 dark:bg-white dark:text-slate-900"
            >
              {busy && <Loader2 className="size-4 animate-spin" />}
              {l ? 'שמירה' : 'חיבור Garmin'}
            </button>
            {editing && (
              <button type="button" onClick={() => setEditing(false)} className="rounded-2xl px-4 text-sm font-semibold text-slate-500">
                ביטול
              </button>
            )}
          </div>
          <p className="flex gap-2 text-[12px] leading-relaxed text-slate-500 dark:text-slate-400">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-500" />
            הסיסמה נשמרת מוצפנת (Supabase Vault), לא נקראת חזרה לדפדפן, ומשמשת רק את שירות הסנכרון. אפשר לנתק ולמחוק בכל רגע.
          </p>
        </form>
      )}
    </Group>
  );
}

const STRAVA_STATUS: Record<StravaLink['status'], { label: string; cls: string }> = {
  ok: { label: 'מחובר', cls: 'text-emerald-600 dark:text-emerald-400' },
  pending: { label: 'ממתין לאישור', cls: 'text-amber-600 dark:text-amber-400' },
  error: { label: 'שגיאה בסנכרון', cls: 'text-rose-600 dark:text-rose-400' },
  revoked: { label: 'הגישה בוטלה', cls: 'text-rose-600 dark:text-rose-400' },
};

function StravaSection() {
  const toast = useToast();
  const link = useAsync(fetchStravaLink);
  const [busy, setBusy] = useState<'connect' | 'sync' | 'disconnect' | null>(null);

  // Refresh after the OAuth callback finishes linking.
  useEffect(() => {
    const on = () => link.reload();
    window.addEventListener('stride:strava-linked', on);
    return () => window.removeEventListener('stride:strava-linked', on);
  }, [link]);

  async function run(kind: 'connect' | 'sync' | 'disconnect', fn: () => Promise<unknown>, okMsg?: (r: unknown) => string) {
    setBusy(kind);
    try {
      const r = await fn();
      if (okMsg) toast(okMsg(r));
      await link.reload();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  }

  if (link.loading && !link.data) return <Skeleton className="mb-6 h-36" />;
  const l = link.data ?? null;
  const lastSync = l?.last_sync_at ? new Date(l.last_sync_at) : null;
  const st = l ? STRAVA_STATUS[l.status] : null;

  return (
    <Group title="Strava (מומלץ)">
      {l ? (
        <>
          <Row icon={<Watch className="size-4" />} iconBg="bg-[#fc4c02]" label="חשבון">
            <span className="max-w-[55%] truncate text-sm text-slate-500 dark:text-slate-400">{l.athlete_name ?? '—'}</span>
          </Row>
          <Row label="סטטוס">
            {st && <span className={cx('flex items-center gap-1 text-sm font-semibold', st.cls)}>{st.label}</span>}
          </Row>
          <Row label="סנכרון אחרון">
            <span className="text-sm text-slate-500 dark:text-slate-400">
              {lastSync ? `${fmt.dateShort(lastSync)} · ${fmt.time(lastSync)}` : '—'}
            </span>
          </Row>
          {l.last_error && l.status !== 'ok' && (
            <p className="mx-4 mb-1 rounded-xl bg-rose-500/10 p-3 text-[12px] text-rose-700 dark:text-rose-300">{l.last_error}</p>
          )}
          <div className="flex gap-2 p-4">
            <button
              onClick={() => run('sync', syncStrava, (r) => `סונכרנו ${(r as { upserted: number }).upserted} ריצות`)}
              disabled={busy !== null}
              className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-[#fc4c02] py-3 text-sm font-bold text-white transition active:scale-[0.99] disabled:opacity-60"
            >
              <RefreshCw className={cx('size-4', busy === 'sync' && 'animate-spin')} />
              {busy === 'sync' ? 'מסנכרן…' : 'סנכרן עכשיו'}
            </button>
            <button
              onClick={() => {
                if (confirm('לנתק את Strava? הריצות שכבר נשמרו יישארו.')) run('disconnect', disconnectStrava, () => 'Strava נותק');
              }}
              disabled={busy !== null}
              aria-label="ניתוק Strava"
              className="grid w-12 place-items-center rounded-2xl bg-rose-500/10 text-rose-600 dark:text-rose-400"
            >
              <Unlink className="size-4" />
            </button>
          </div>
        </>
      ) : (
        <div className="space-y-3 p-4">
          <p className="text-sm leading-relaxed text-slate-600 dark:text-slate-300">
            חיבור רשמי ובטוח. ודאו שבאפליקציית Garmin Connect מופעל שיתוף אוטומטי ל-Strava — ומשם כל ריצה תגיע לכאן.
          </p>
          <button
            onClick={() => run('connect', connectStrava)}
            disabled={busy !== null}
            className="flex w-full items-center justify-center gap-2 rounded-2xl bg-[#fc4c02] py-3.5 text-sm font-bold text-white shadow-lg shadow-orange-600/25 transition active:scale-[0.99] disabled:opacity-60"
          >
            {busy === 'connect' && <Loader2 className="size-4 animate-spin" />}
            התחברות עם Strava
          </button>
          <p className="flex gap-2 text-[12px] leading-relaxed text-slate-500 dark:text-slate-400">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-500" />
            אין צורך בסיסמה — Strava נותנים הרשאת קריאה בלבד לפעילויות, ואפשר לבטל אותה בכל רגע.
          </p>
        </div>
      )}
    </Group>
  );
}
