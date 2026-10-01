/**
 * §3.2 SessionRowItem — all KR-8 fields rendered from a derived SessionRow.
 */
import { fireEvent, act } from '@testing-library/react-native';
import { renderThemeProvider, makeSession } from '@/test/helpers';
import { SessionRow } from '@/components/SessionRow';
import type { SessionRow as SessionRowData } from '@/store/sessions';
import { deriveSessionRow } from '@/store/sessions';
import { lightBase } from '@/theme/tokens';
import type { SessionResponse } from '@/services/gateway-api';

type Screen = Awaited<ReturnType<typeof renderThemeProvider>>;

describe('§3.2 SessionRow', () => {
  const rowOf = (overrides: Partial<SessionResponse> = {}): SessionRowData =>
    deriveSessionRow(makeSession(overrides));

  const renderRow = async (session: SessionRowData): Promise<Screen> =>
    renderThemeProvider(<SessionRow session={session} onPress={onPress} onLongPress={onLongPress} />);

  let onPress: jest.Mock;
  let onLongPress: jest.Mock;

  beforeEach(() => {
    onPress = jest.fn();
    onLongPress = jest.fn();
  });

  it('renders title, model, preview, badge, relativeTime and cost (§3.2 test 1)', async () => {
    const session = rowOf({
      title: 'Deploy pipeline',
      model: 'claude-sonnet-4',
      preview: 'hello there',
      estimated_cost_usd: 0.5,
      actual_cost_usd: null,
    });
    const screen = await renderRow(session);

    expect(screen.getByText('Deploy pipeline')).toBeTruthy();
    expect(screen.getByText('claude-sonnet-4')).toBeTruthy();
    expect(screen.getByText('hello there')).toBeTruthy();
    expect(screen.getByText('📱 API')).toBeTruthy(); // api_server badge
    expect(screen.getByText(/just now|1m ago/)).toBeTruthy(); // last_active 60s ago → relativeTime
    expect(screen.getByText('$0.5000')).toBeTruthy(); // formatCost(0.5, null)
  });

  it('active dot only when isActive — success token present/absent in tree (§3.2 test 2)', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const active = rowOf({ ended_at: null, last_active: nowSec - 30 });
    const beyondWindow = rowOf({ ended_at: null, last_active: nowSec - 9000 });

    const activeScreen = await renderRow(active);
    expect(JSON.stringify(activeScreen.toJSON())).toContain(lightBase.success); // the green active dot

    const inactiveScreen = await renderRow(beyondWindow);
    expect(JSON.stringify(inactiveScreen.toJSON())).not.toContain(lightBase.success);
  });

  it('press → onPress(session); longPress → onLongPress(session) (§3.2 test 3)', async () => {
    const session = rowOf();
    const screen = await renderRow(session);

    await act(async () => {
      await fireEvent.press(screen.getByText(session.title));
    });
    await act(async () => {
      await fireEvent(screen.getByText(session.title), 'longPress');
    });

    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onPress).toHaveBeenCalledWith(session);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onLongPress).toHaveBeenCalledWith(session);
  });

  it('dash cost rendered for unknown cost (KR-19 UI split case, §3.2 test 4)', async () => {
    const unknown = rowOf({ estimated_cost_usd: 0, actual_cost_usd: null });
    const screen = await renderRow(unknown);

    expect(screen.getByText('—')).toBeTruthy();
  });

  it('unknown source → raw passthrough badge', async () => {
    const session = rowOf({ source: 'mystery_source' });
    const screen = await renderRow(session);

    expect(screen.getByText('mystery_source')).toBeTruthy();
  });
});
