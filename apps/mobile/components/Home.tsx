import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { Session } from '@supabase/supabase-js';

import { supabase, type Profile, type Virtue } from '@/lib/supabase';

interface LedgerEntry {
  id: string;
  source_type: string;
  final_xp: number;
  created_at: string;
}

interface Snapshot {
  profile: Profile;
  virtues: Virtue[];
  ledger: LedgerEntry[];
}

/**
 * The first screen that actually exercises the design's central bet: the client
 * queries PostgREST directly and RLS is what keeps one user's rows away from
 * another's. Note that none of the three queries below filters on user_id — the
 * policies do that, and a filter here would only hide the fact that they work.
 */
export function Home({ session }: { session: Session }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [awarding, setAwarding] = useState(false);

  const load = useCallback(async () => {
    setError('');

    const [profile, virtues, ledger] = await Promise.all([
      supabase.from('profiles').select('*').single(),
      supabase.from('virtues').select('*').order('display_order'),
      supabase
        .from('xp_ledger')
        .select('id,source_type,final_xp,created_at')
        .order('created_at', { ascending: false })
        .limit(10),
    ]);

    // PostgREST returns `data: null` alongside an error, and the generated types
    // model that as a union, so each result is narrowed rather than asserted.
    if (profile.error) return setError(profile.error.message);
    if (virtues.error) return setError(virtues.error.message);
    if (ledger.error) return setError(ledger.error.message);

    setSnapshot({
      profile: profile.data,
      virtues: virtues.data,
      ledger: ledger.data,
    });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  /**
   * XP is never computed client-side: the multiplier and streak math live in
   * calculate_and_award_xp() so a completion is one transaction, and the
   * function re-checks auth.uid() itself because SECURITY DEFINER bypasses RLS.
   */
  async function awardXp() {
    setAwarding(true);
    setError('');
    const { error: rpcError } = await supabase.rpc('calculate_and_award_xp', {
      p_user_id: session.user.id,
      p_source_type: 'bonus',
      // A 'bonus' award has no originating row, and the column is nullable, but
      // p_source_id is the one parameter in the signature without a SQL default
      // so the generated type makes it a required non-null string. Passing null
      // works at runtime; dropping the cast needs `p_source_id uuid default
      // null` in a migration. See the note in the README.
      p_source_id: null as unknown as string,
      p_base_xp: 10,
      p_virtue_ids: snapshot?.virtues.slice(0, 1).map((virtue) => virtue.id) ?? [],
      p_description: 'Hello from the client',
    });
    if (rpcError) setError(rpcError.message);
    else await load();
    setAwarding(false);
  }

  if (!snapshot && error === '') {
    return (
      <View style={styles.centered}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <ScrollView
      contentContainerStyle={styles.container}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
    >
      {error !== '' && <Text style={styles.error}>{error}</Text>}

      {snapshot && (
        <>
          <Text style={styles.title}>{snapshot.profile.display_name ?? session.user.email}</Text>
          <Text style={styles.subtitle}>
            Level {snapshot.profile.global_level} · {snapshot.profile.global_xp} XP ·{' '}
            {snapshot.profile.current_streak}-day streak (×
            {snapshot.profile.streak_multiplier})
          </Text>

          <Text style={styles.heading}>Virtues</Text>
          {snapshot.virtues.map((virtue) => (
            <View key={virtue.id} style={styles.row}>
              <View style={[styles.swatch, { backgroundColor: virtue.color ?? '#ccc' }]} />
              <Text style={styles.rowLabel}>{virtue.name}</Text>
              <Text style={styles.rowValue}>
                Lv {virtue.level} · {virtue.xp} XP
              </Text>
            </View>
          ))}

          <Text style={styles.heading}>Recent XP</Text>
          {snapshot.ledger.length === 0 ? (
            <Text style={styles.empty}>No XP yet — award some below.</Text>
          ) : (
            snapshot.ledger.map((entry) => (
              <View key={entry.id} style={styles.row}>
                <Text style={styles.rowLabel}>{entry.source_type}</Text>
                <Text style={styles.rowValue}>
                  {entry.final_xp > 0 ? '+' : ''}
                  {entry.final_xp} XP
                </Text>
              </View>
            ))
          )}

          <Pressable
            style={({ pressed }) => [styles.button, (pressed || awarding) && styles.buttonPressed]}
            onPress={awardXp}
            disabled={awarding}
          >
            {awarding ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>Award 10 XP (RPC)</Text>
            )}
          </Pressable>
        </>
      )}

      <Pressable style={styles.signOut} onPress={() => void supabase.auth.signOut()}>
        <Text style={styles.signOutText}>Sign out</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  container: { padding: 24, paddingTop: 72, gap: 6, backgroundColor: '#fff', flexGrow: 1 },
  title: { fontSize: 26, fontWeight: '700' },
  subtitle: { fontSize: 14, color: '#666' },
  heading: { fontSize: 13, fontWeight: '700', color: '#999', marginTop: 24, letterSpacing: 0.6 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#eee',
  },
  swatch: { width: 10, height: 10, borderRadius: 5 },
  rowLabel: { flex: 1, fontSize: 15 },
  rowValue: { fontSize: 13, color: '#666' },
  empty: { fontSize: 13, color: '#999', paddingVertical: 10 },
  button: {
    backgroundColor: '#3D7EE5',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 24,
  },
  buttonPressed: { opacity: 0.7 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  error: { color: '#E5533D', fontSize: 13, marginBottom: 8 },
  signOut: { marginTop: 'auto', paddingTop: 24, alignItems: 'center' },
  signOutText: { color: '#666', fontSize: 14 },
});
