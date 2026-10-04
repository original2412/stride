import type { Session } from '@supabase/supabase-js';
import { useEffect, useRef, useState } from 'react';
import { TABS, type TabId } from './components/BottomNav';
import Layout from './components/Layout';
import { ToastProvider, useToast } from './components/Toast';
import { completeStravaAuth } from './lib/api';
import { supabase } from './lib/supabase';
import GoalsView from './views/GoalsView';
import HistoryView from './views/HistoryView';
import LoginView from './views/LoginView';
import PlanView from './views/PlanView';
import SettingsView from './views/SettingsView';
import TodayView from './views/TodayView';

function readHash(): TabId {
  const h = window.location.hash.slice(1);
  return TABS.some((t) => t.id === h) ? (h as TabId) : 'today';
}

function useSession() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(Boolean(supabase));
  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);
  return { session, loading };
}

/** Finishes the Strava OAuth round-trip (Strava redirects back with ?code&state&scope). */
function StravaCallback() {
  const toast = useToast();
  const done = useRef(false);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const state = q.get('state');
    if (done.current || !state || !(q.has('code') || q.has('error'))) return;
    done.current = true;
    // Drop the OAuth params from the address bar and land on Settings.
    window.history.replaceState(null, '', `${window.location.pathname}#settings`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    if (q.get('error')) {
      toast('החיבור ל-Strava בוטל', 'error');
      return;
    }
    toast('מחבר את Strava ומושך ריצות…');
    completeStravaAuth(q.get('code')!, state, q.get('scope') ?? '')
      .then((r) => {
        toast(`Strava חובר! נמשכו ${r.upserted} ריצות 🎉`);
        window.dispatchEvent(new Event('stride:strava-linked'));
      })
      .catch((e: Error) => toast(e.message, 'error'));
  }, [toast]);
  return null;
}

export default function App() {
  const { session, loading } = useSession();
  const [tab, setTab] = useState<TabId>(readHash);

  useEffect(() => {
    const onHash = () => {
      setTab(readHash());
      window.scrollTo({ top: 0 });
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  if (supabase && loading) {
    return (
      <div className="grid min-h-dvh place-items-center bg-brand-600">
        <img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" className="size-20 animate-pulse rounded-3xl" />
      </div>
    );
  }

  return (
    <ToastProvider>
      {supabase && !session ? (
        <LoginView />
      ) : (
        <Layout tab={tab} onTabChange={(t) => (window.location.hash = t)}>
          {supabase && <StravaCallback />}
          {tab === 'today' && <TodayView />}
          {tab === 'history' && <HistoryView />}
          {tab === 'plan' && <PlanView />}
          {tab === 'goals' && <GoalsView />}
          {tab === 'settings' && <SettingsView />}
        </Layout>
      )}
    </ToastProvider>
  );
}
