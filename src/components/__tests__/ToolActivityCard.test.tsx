/**
 * §3.4 ToolActivityCard — KR-15: state labels, collapse/expand, default collapsed.
 */
import { fireEvent, act } from '@testing-library/react-native';
import { renderThemeProvider } from '@/test/helpers';
import { ToolActivityCard } from '@/components/ToolActivityCard';
import type { ToolCall } from '@/store/chat';

type Screen = Awaited<ReturnType<typeof renderThemeProvider>>;

describe('§3.4 ToolActivityCard', () => {
  const renderTool = async (tool: ToolCall): Promise<Screen> =>
    renderThemeProvider(<ToolActivityCard tool={tool} />);

  it.each<ToolCall['state']>(['running', 'failed', 'completed'])(
    'state label rendered for %s (§3.4 test 1)',
    async (state) => {
      const expected = state === 'completed' ? 'done' : state;
      const screen = await renderTool({ id: 't1', name: 'bash', state, collapsed: false });

      expect(screen.getByText(expected)).toBeTruthy();
      // Body visible when expanded: "{name} — completed|failed"
      expect(screen.getByText(/bash — (completed|failed)/)).toBeTruthy();
    },
  );

  it('failed tool → failed wording in the body; ActivityIndicator for running/not-failed', async () => {
    const failedScreen = await renderTool({ id: 't1', name: 'bash', state: 'failed', collapsed: false });
    expect(failedScreen.getByText('failed')).toBeTruthy();
    expect(failedScreen.getByText('bash — failed')).toBeTruthy();

    const runningScreen = await renderTool({ id: 't1', name: 'bash', state: 'running', collapsed: false });
    expect(runningScreen.getByText('running')).toBeTruthy();
    expect(runningScreen.getByText('bash — completed')).toBeTruthy();
  });

  it('press toggles expanded body (§3.4 test 2)', async () => {
    const screen = await renderTool({ id: 't1', name: 'bash', state: 'completed', collapsed: false });

    // Initially expanded (collapsed: false → expanded)
    expect(screen.getByText('bash — completed')).toBeTruthy();

    await act(async () => {
      await fireEvent.press(screen.getByText('bash'));
    });
    expect(screen.queryByText('bash — completed')).toBeNull();

    // Toggle back open
    await act(async () => {
      await fireEvent.press(screen.getByText('bash'));
    });
    expect(screen.getByText('bash — completed')).toBeTruthy();
  });

  it('default collapsed comes from tool.collapsed (§3.4 test 3)', async () => {
    const collapsed = await renderTool({ id: 't1', name: 'bash', state: 'running', collapsed: true });
    expect(collapsed.queryByText(/bash — (completed|failed)/)).toBeNull();
    expect(collapsed.getByText('▼')).toBeTruthy();

    const expanded = await renderTool({ id: 't1', name: 'bash', state: 'running', collapsed: false });
    expect(expanded.getByText(/bash — completed/)).toBeTruthy();
    expect(expanded.getByText('▲')).toBeTruthy();
  });
});
