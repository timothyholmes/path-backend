import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { supabase } from '@/lib/supabase';

type ConnectionStatus = 'checking' | 'connected' | 'error';

export default function HomeScreen() {
  const [status, setStatus] = useState<ConnectionStatus>('checking');
  const [detail, setDetail] = useState('');

  useEffect(() => {
    supabase.auth
      .getSession()
      .then(({ error }) => {
        if (error) throw error;
        setStatus('connected');
      })
      .catch((err: Error) => {
        setStatus('error');
        setDetail(err.message);
      });
  }, []);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Path AI</Text>
      <Text style={styles.status}>
        {status === 'checking' && 'Checking Supabase connection…'}
        {status === 'connected' && 'Connected to Supabase ✓'}
        {status === 'error' && `Connection error: ${detail}`}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#fff',
  },
  title: {
    fontSize: 24,
    fontWeight: '600',
  },
  status: {
    fontSize: 14,
    color: '#555',
  },
});
