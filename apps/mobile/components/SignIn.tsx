import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { supabase } from '@/lib/supabase';

/**
 * Password sign-in. Everything the app does afterwards depends on the JWT this
 * produces: PostgREST maps it to the `authenticated` role and exposes its `sub`
 * claim as auth.uid(), which is the value every RLS policy compares against.
 */
export function SignIn() {
  const [email, setEmail] = useState('dev@path.test');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function signIn() {
    setBusy(true);
    setError('');
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    if (signInError) setError(signInError.message);
    // On success the onAuthStateChange listener swaps the screen out, so there
    // is nothing to do here and no state to clear on an unmounted component.
    setBusy(false);
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Path AI</Text>
      <Text style={styles.subtitle}>Sign in to your local Supabase stack</Text>

      <TextInput
        style={styles.input}
        value={email}
        onChangeText={setEmail}
        placeholder="Email"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        inputMode="email"
      />
      <TextInput
        style={styles.input}
        value={password}
        onChangeText={setPassword}
        placeholder="Password"
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        onSubmitEditing={signIn}
      />

      <Pressable
        style={({ pressed }) => [styles.button, (pressed || busy) && styles.buttonPressed]}
        onPress={signIn}
        disabled={busy}
      >
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Sign in</Text>}
      </Pressable>

      {error !== '' && <Text style={styles.error}>{error}</Text>}

      <Text style={styles.hint}>The seeded dev account is dev@path.test / path-dev-password.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: 24, gap: 12, backgroundColor: '#fff' },
  title: { fontSize: 28, fontWeight: '700' },
  subtitle: { fontSize: 14, color: '#666', marginBottom: 12 },
  input: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  button: {
    backgroundColor: '#3D7EE5',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 4,
  },
  buttonPressed: { opacity: 0.7 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  error: { color: '#E5533D', fontSize: 13 },
  hint: { color: '#999', fontSize: 12, marginTop: 8 },
});
