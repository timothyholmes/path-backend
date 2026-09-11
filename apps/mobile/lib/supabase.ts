import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

// The schema types are generated at the repo root by `npm run db:types`. This
// is a type-only import, so it is erased before Metro ever sees it and the
// bundler never has to resolve a path outside the app directory. Importing the
// generated file directly rather than copying it keeps one source of truth:
// a copy would silently drift the first time a migration lands.
import type { Database } from '../../../db/types.generated';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY. Copy .env.example to .env.local and fill them in (run `npm run db:start` in the backend, then `npx supabase status` for the local values).',
  );
}

// The generic is what makes RLS-as-boundary workable day to day: every
// .from()/.rpc() call below is checked against the real schema, so a typo in a
// column name is a compile error rather than a runtime PostgREST 400.
export const supabase = createClient<Database>(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

export type Tables = Database['public']['Tables'];
export type Profile = Tables['profiles']['Row'];
export type Virtue = Tables['virtues']['Row'];
export type XpLedgerEntry = Tables['xp_ledger']['Row'];
