import { ThemeProvider } from '@/theme/ThemeProvider';
import { ServicesProvider } from './composition';
import { RootNavigator } from './navigation';

export default function App() {
  return (
    <ThemeProvider>
      <ServicesProvider>
        <RootNavigator />
      </ServicesProvider>
    </ThemeProvider>
  );
}
