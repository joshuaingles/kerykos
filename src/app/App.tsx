import { ThemeProvider } from '@/theme/ThemeProvider';
import { RootNavigator } from './navigation';

export default function App() {
  return (
    <ThemeProvider>
      <RootNavigator />
    </ThemeProvider>
  );
}
