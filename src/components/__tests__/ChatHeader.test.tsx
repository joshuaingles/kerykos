/**
 * §3.6 ChatHeader / LiveChatHeader — KR-19 live cost display: computeDisplayCost
 * composed with the sessions store + analytics pricing cache.
 */
import { renderThemeProvider, makeSession, resetMMKV } from '@/test/helpers';
import { LiveChatHeader } from '@/components/ChatHeader';
import { useSessionsStore, deriveSessionRow } from '@/store/sessions';
import { useAnalyticsStore } from '@/store/analytics';
import { lightBase } from '@/theme/tokens';
import type { ModelPricing } from '@/services/types';

type Screen = Awaited<ReturnType<typeof renderThemeProvider>>;

describe('§3.6 ChatHeader / LiveChatHeader', () => {
  const seedSession = (overrides = {}) => {
    const row = deriveSessionRow(makeSession(overrides));
    useSessionsStore.setState({ sessions: new Map([[row.id, row]]) });
    return row;
  };

  beforeEach(() => {
    resetMMKV();
    useSessionsStore.setState({ sessions: new Map() });
    useAnalyticsStore.setState({ pricingCache: new Map() });
  });

  afterEach(() => {
    useSessionsStore.setState({ sessions: new Map() });
    useAnalyticsStore.setState({ pricingCache: new Map() });
  });

  it('LiveChatHeader composes computeDisplayCost — pricing-derived cost rendered (§3.6 test 1)', async () => {
    // 1000 in × $0.000003 + 500 out × $0.000015 = 0.003 + 0.0075 = 0.0105
    const pricing: ModelPricing = {
      model: 'claude-sonnet-4',
      provider: 'anthropic',
      input_cost_per_token: 0.000003,
      output_cost_per_token: 0.000015,
      cached_cost_per_token: 0,
      updated_at: 0,
    };
    seedSession({ estimated_cost_usd: 0, actual_cost_usd: null });
    useAnalyticsStore.getState().setPricingCache([pricing]);

    const screen: Screen = await renderThemeProvider(<LiveChatHeader sessionId="sess_1" />);

    expect(screen.getByText('Test Session')).toBeTruthy();
    expect(screen.getByText('claude-sonnet-4')).toBeTruthy();
    expect(screen.getByText('$0.0105')).toBeTruthy();
  });

  it('unknown session → fallback "Chat · — · —" (§3.6 test 2)', async () => {
    const screen = await renderThemeProvider(<LiveChatHeader sessionId="nope" />);

    expect(screen.getByText('Chat')).toBeTruthy();
    expect(screen.getAllByText('—')).toHaveLength(2);
  });

  it('isUnknown gate — session exists, cost unknown (0 + no pricing) → "—" not "$0.0000"', async () => {
    seedSession({ estimated_cost_usd: 0, actual_cost_usd: null }); // pricing cache stays empty

    const screen = await renderThemeProvider(<LiveChatHeader sessionId="sess_1" />);

    expect(screen.getByText('Test Session')).toBeTruthy();
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.queryByText('$0.0000')).toBeNull();
  });

  it('known actual cost renders 4dp', async () => {
    seedSession({ estimated_cost_usd: 0, actual_cost_usd: 0.25 });

    const screen = await renderThemeProvider(<LiveChatHeader sessionId="sess_1" />);

    expect(screen.getByText('$0.2500')).toBeTruthy();
    expect(lightBase.success).toBeDefined(); // trivial guard for import hygiene
  });

  it('render fallback for known-session — plain ChatHeader pieces present', async () => {
    seedSession();

    const screen = await renderThemeProvider(<LiveChatHeader sessionId="sess_1" />);

    expect(screen.getByText('Test Session')).toBeTruthy();
    expect(screen.getAllByText('·')).toHaveLength(2); // separators
  });
});
