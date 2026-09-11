import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';

import { supabase } from '@/lib/supabase';

export interface SessionState {
  session: Session | null;
  loading: boolean;
}

/**
 * Tracks the signed-in session.
 *
 * getSession() resolves from AsyncStorage, so the first render after a cold
 * start would otherwise flash the sign-in screen at an already-signed-in user;
 * `loading` covers that gap. onAuthStateChange then keeps the value current
 * through token refreshes and sign-out.
 */
export function useSession(): SessionState {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      setLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      setLoading(false);
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  return { session, loading };
}
