/**
 * §3.3 ApprovalCard — pending → Approve/Deny; responded → static card (KR-13 UI).
 */
import { fireEvent, act } from '@testing-library/react-native';
import { renderThemeProvider } from '@/test/helpers';
import { ApprovalCard } from '@/components/ApprovalCard';
import type { ApprovalRequest } from '@/store/chat';

type Screen = Awaited<ReturnType<typeof renderThemeProvider>>;

describe('§3.3 ApprovalCard', () => {
  let onRespond: jest.Mock;

  beforeEach(() => {
    onRespond = jest.fn();
  });

  const renderCard = async (approval: ApprovalRequest): Promise<Screen> =>
    renderThemeProvider(<ApprovalCard approval={approval} onRespond={onRespond} />);

  const pending: ApprovalRequest = {
    runId: 'r1',
    message: 'Run `rm -rf /tmp/caches`?',
    responded: false,
  };

  it('pending → Approve press → onRespond("approve") (§3.3 test 1)', async () => {
    const screen = await renderCard(pending);

    await act(async () => {
      await fireEvent.press(screen.getByText('Approve'));
    });

    expect(onRespond).toHaveBeenCalledTimes(1);
    expect(onRespond).toHaveBeenCalledWith('approve');
  });

  it('pending → Deny press → onRespond("deny")', async () => {
    const screen = await renderCard(pending);

    await act(async () => {
      await fireEvent.press(screen.getByText('Deny'));
    });

    expect(onRespond).toHaveBeenCalledWith('deny');
  });

  it('responded approve → static "Approved" card, no buttons (§3.3 test 2)', async () => {
    const screen = await renderCard({
      ...pending,
      responded: true,
      decision: 'approve',
    });

    expect(screen.getByText('Approved')).toBeTruthy();
    expect(screen.queryByText('Approve')).toBeNull();
    expect(screen.queryByText('Deny')).toBeNull();
    expect(onRespond).not.toHaveBeenCalled();
  });

  it('responded deny → static "Denied" card (§3.3 test 3)', async () => {
    const screen = await renderCard({
      ...pending,
      responded: true,
      decision: 'deny',
    });

    expect(screen.getByText('Denied')).toBeTruthy();
    expect(screen.queryByText('Approve')).toBeNull();
    expect(screen.queryByText('Deny')).toBeNull();
  });

  it('message text rendered in the pending card (§3.3 test 4)', async () => {
    const screen = await renderCard(pending);

    expect(screen.getByText(/Approval requested: Run `rm -rf \/tmp\/caches`\?/)).toBeTruthy();
  });
});
