import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { Home } from '@/components/Home';
import { SignIn } from '@/components/SignIn';
import { useSession } from '@/lib/useSession';

export default function IndexScreen() {
  const { session, loading } = useSession();

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator />
      </View>
    );
  }

  return session ? <Home session={session} /> : <SignIn />;
}

const styles = StyleSheet.create({
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff' },
});
