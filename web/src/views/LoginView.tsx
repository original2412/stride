import { ArrowLeft, Loader2, MailCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';

export default function LoginView() {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [error, setError] = useState('');
  const [password, setPassword] = useState('');
  const [signup, setSignup] = useState(false);
  const [sentText, setSentText] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!supabase) return;
    setState('sending');
    if (signup) {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: window.location.origin + import.meta.env.BASE_URL },
      });
      if (error) {
        setError(error.message.includes('Password') ? 'הסיסמה צריכה להיות לפחות 6 תווים' : error.message);
        setState('error');
      } else if (!data.session) {
        // Email confirmation is on: the session arrives after clicking the link.
        setSentText('שלחנו מייל לאישור החשבון. לחצו על הקישור, ואחר כך היכנסו עם המייל והסיסמה.');
        setState('sent');
      }
      return;
    }
    if (password) {
      // Password sign-in — no email involved, so no mail rate limits.
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        setError('מייל או סיסמה שגויים');
        setState('error');
      }
      return; // on success App swaps this screen out via onAuthStateChange
    }
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin + import.meta.env.BASE_URL },
    });
    if (error) {
      setError(error.message);
      setState('error');
    } else {
      setSentText('');
      setState('sent');
    }
  }

  return (
    <div className="relative isolate flex min-h-dvh flex-col overflow-hidden bg-gradient-to-b from-brand-500 via-brand-700 to-ink-950 px-6 pb-[max(env(safe-area-inset-bottom),2rem)] pt-[max(env(safe-area-inset-top),3rem)] text-white">
      <svg className="absolute -top-20 start-1/2 -z-10 w-[640px] -translate-x-1/2 opacity-20" viewBox="0 0 200 200" aria-hidden>
        {[20, 40, 60, 80, 100].map((r) => (
          <circle key={r} cx="100" cy="100" r={r} fill="none" stroke="white" strokeWidth="0.6" strokeDasharray="2 3" />
        ))}
      </svg>

      <img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" className="size-16 rounded-2xl shadow-2xl" />
      <h1 className="mt-8 text-[44px] font-black leading-[1] tracking-tight">
        כל ריצה.
        <br />
        <span className="text-brand-200">מאמן אחד.</span>
      </h1>
      <p className="mt-4 max-w-[30ch] text-[15px] leading-relaxed text-white/80">
        Stride מנתח את הריצות שלך מ-Garmin ובונה לך אימון חכם לכל יום, בעזרת Gemini.
      </p>

      <div className="mt-auto">
        {state === 'sent' ? (
          <div className="space-y-3">
            <div className="flex items-start gap-3 rounded-3xl bg-white/10 p-5 ring-1 ring-white/15 backdrop-blur">
              <MailCheck className="size-6 shrink-0 text-emerald-300" />
              <div>
                <p className="font-bold">בדקו את תיבת המייל</p>
                <p className="text-sm text-white/75">
                  {sentText || (
                    <>
                      שלחנו קישור התחברות ל-<span dir="ltr">{email}</span>. הקישור נפתח בדפדפן ברירת המחדל, ושם תהיו מחוברים.
                    </>
                  )}
                </p>
              </div>
            </div>
            <button onClick={() => setState('idle')} className="w-full py-2 text-sm font-medium text-white/70">
              שליחה מחדש
            </button>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            <input
              type="email"
              required
              dir="ltr"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
              className="w-full rounded-2xl bg-white/10 px-5 py-4 text-[16px] text-white outline-none ring-1 ring-white/20 placeholder:text-white/40 focus:ring-2 focus:ring-white"
              aria-label="כתובת מייל"
            />
            <input
              type="password"
              dir="ltr"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required={signup}
              minLength={signup ? 6 : undefined}
              placeholder={signup ? 'בחרו סיסמה (6 תווים לפחות)' : 'סיסמה (לא חובה)'}
              autoComplete={signup ? 'new-password' : 'current-password'}
              className="w-full rounded-2xl bg-white/10 px-5 py-4 text-[16px] text-white outline-none ring-1 ring-white/20 placeholder:text-white/40 focus:ring-2 focus:ring-white"
              aria-label="סיסמה"
            />
            <button
              disabled={state === 'sending'}
              className="flex w-full items-center justify-center gap-2 rounded-2xl bg-white py-4 text-[16px] font-bold text-brand-700 shadow-xl transition active:scale-[0.99]"
            >
              {state === 'sending' ? <Loader2 className="size-5 animate-spin" /> : null}
              {signup ? 'יצירת חשבון' : password ? 'כניסה' : 'קבלת קישור התחברות'}
              <ArrowLeft className="size-5" />
            </button>
            <button
              type="button"
              onClick={() => {
                setSignup((v) => !v);
                setState('idle');
              }}
              className="w-full py-1 text-sm font-medium text-white/75"
            >
              {signup ? 'כבר יש לי חשבון — כניסה' : 'משתמש חדש? יצירת חשבון'}
            </button>
            {state === 'error' && (
              <p className="text-center text-sm text-rose-200">
                {error.includes('rate limit') ? 'נשלחו יותר מדי מיילים. נסו שוב בעוד שעה, או היכנסו עם סיסמה.' : error}
              </p>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
