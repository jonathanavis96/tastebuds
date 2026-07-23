import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/svelte';
import DetailModal from './DetailModal.svelte';

const baseProps = (title_id: number, title: string) => ({
  item: { title_id, title },
  onClose: () => {},
});

afterEach(() => cleanup());

describe('DetailModal "Not interested" — immediate commit + undo', () => {
  it('commits the dismiss immediately on tap for the shown title', async () => {
    const onDismiss = vi.fn();
    const { getByText } = render(DetailModal, { ...baseProps(1, 'Movie A'), onDismiss });
    await fireEvent.click(getByText('Not interested'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDismiss.mock.calls[0][0]).toMatchObject({ title_id: 1 });
  });

  it('flips the button to an undo state after dismissing', async () => {
    const { getByText, queryByText } = render(DetailModal, {
      ...baseProps(1, 'Movie A'),
      onDismiss: () => {},
      onUndismiss: () => {},
    });
    await fireEvent.click(getByText('Not interested'));
    expect(getByText('✗ Not interested — tap to undo')).toBeTruthy();
    expect(queryByText('Not interested')).toBeNull(); // the plain label is gone
  });

  it('re-tapping undoes it (fires onUndismiss, not a second onDismiss)', async () => {
    const onDismiss = vi.fn();
    const onUndismiss = vi.fn();
    const { getByText } = render(DetailModal, {
      ...baseProps(1, 'Movie A'),
      onDismiss,
      onUndismiss,
    });
    await fireEvent.click(getByText('Not interested'));                  // commit
    await fireEvent.click(getByText('✗ Not interested — tap to undo'));  // undo
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onUndismiss).toHaveBeenCalledTimes(1);
    expect(onUndismiss.mock.calls[0][0]).toMatchObject({ title_id: 1 });
  });

  it('reflects the parent `dismissed` flag for the shown title', async () => {
    const { getByText } = render(DetailModal, {
      ...baseProps(1, 'Movie A'),
      onDismiss: () => {},
      onUndismiss: () => {},
      dismissed: true,
    });
    // Opens already marked — button shows the undo state without any tap.
    expect(getByText('✗ Not interested — tap to undo')).toBeTruthy();
  });

  it('reconciles the armed state from the prop when navigating to a new title', async () => {
    const { getByText, rerender } = render(DetailModal, {
      ...baseProps(1, 'Movie A'),
      onDismiss: () => {},
      onUndismiss: () => {},
    });
    await fireEvent.click(getByText('Not interested'));                  // A is now armed
    await rerender({ item: { title_id: 2, title: 'Movie B' }, dismissed: false });
    // B is not dismissed — the button resets to the plain label.
    expect(getByText('Not interested')).toBeTruthy();
  });
});

describe('DetailModal dismiss-reason tiles', () => {
  it('does not show reason tiles before a dismiss', () => {
    const { queryByText } = render(DetailModal, {
      ...baseProps(1, 'Movie A'),
      onDismiss: () => {},
      onDismissReason: () => {},
    });
    expect(queryByText('Not my genre')).toBeNull();
  });

  it('shows the 5 reason tiles after dismissing, and tapping one fires onDismissReason', async () => {
    const onDismissReason = vi.fn();
    const { getByText } = render(DetailModal, {
      ...baseProps(1, 'Movie A'),
      onDismiss: () => {},
      onUndismiss: () => {},
      onDismissReason,
    });
    await fireEvent.click(getByText('Not interested'));
    for (const label of ['Not my genre', 'Too dark/violent', 'Seen enough like it', 'Cast/vibe', 'Not in the mood']) {
      expect(getByText(label)).toBeTruthy();
    }
    await fireEvent.click(getByText('Too dark/violent'));
    expect(onDismissReason).toHaveBeenCalledTimes(1);
    expect(onDismissReason.mock.calls[0][0]).toMatchObject({ title_id: 1 });
    expect(onDismissReason.mock.calls[0][1]).toBe('too_dark');
  });

  it('hides the reason tiles again after undoing the dismiss', async () => {
    const { getByText, queryByText } = render(DetailModal, {
      ...baseProps(1, 'Movie A'),
      onDismiss: () => {},
      onUndismiss: () => {},
      onDismissReason: () => {},
    });
    await fireEvent.click(getByText('Not interested'));                  // commit
    await fireEvent.click(getByText('✗ Not interested — tap to undo'));  // undo
    expect(queryByText('Not my genre')).toBeNull();
  });

  it('does not render the reason tiles when onDismissReason is not provided', async () => {
    const { getByText, queryByText } = render(DetailModal, {
      ...baseProps(1, 'Movie A'),
      onDismiss: () => {},
      onUndismiss: () => {},
    });
    await fireEvent.click(getByText('Not interested'));
    expect(queryByText('Not my genre')).toBeNull();
  });

  it('disables the reason tiles while the dismiss request is still in flight', async () => {
    let resolveDismiss!: () => void;
    const dismissPromise = new Promise<void>((resolve) => { resolveDismiss = resolve; });
    const onDismiss = vi.fn(() => dismissPromise);
    const { getByText } = render(DetailModal, {
      ...baseProps(1, 'Movie A'),
      onDismiss,
      onUndismiss: () => {},
      onDismissReason: () => {},
    });

    await fireEvent.click(getByText('Not interested'));
    const tile = getByText('Not my genre') as HTMLButtonElement;
    expect(tile.disabled).toBe(true);

    resolveDismiss();
    await dismissPromise;
    await Promise.resolve(); // flush the component's .finally()

    expect(tile.disabled).toBe(false);
  });

  it('waits for an in-flight dismiss to resolve before firing the reason request (no race)', async () => {
    let resolveDismiss!: () => void;
    const dismissPromise = new Promise<void>((resolve) => { resolveDismiss = resolve; });
    const onDismiss = vi.fn(() => dismissPromise);
    const onDismissReason = vi.fn();
    const { getByText } = render(DetailModal, {
      ...baseProps(1, 'Movie A'),
      onDismiss,
      onUndismiss: () => {},
      onDismissReason,
    });

    await fireEvent.click(getByText('Not interested')); // dismiss is now in flight
    // The tile is disabled while in flight (asserted above), so a real tap can't
    // fire yet — but even if one slipped through, doDismissReason itself must
    // still chain after the dismiss rather than racing it.
    const tile = getByText('Not my genre') as HTMLButtonElement;
    expect(tile.disabled).toBe(true);
    expect(onDismissReason).not.toHaveBeenCalled();

    resolveDismiss();
    await dismissPromise;
    await Promise.resolve();
    expect(tile.disabled).toBe(false);

    await fireEvent.click(tile);
    expect(onDismissReason).toHaveBeenCalledTimes(1);
    expect(onDismissReason.mock.calls[0][1]).toBe('not_my_genre');
  });

  it('serializes rapid successive reason taps — no overlapping requests, last tap wins', async () => {
    // Tracks concurrency directly: bumps on call start, drops on resolve, and
    // records the peak so we can assert it never exceeded 1 in-flight request.
    let active = 0;
    let peakActive = 0;
    const resolvers: Array<() => void> = [];
    const onDismissReason = vi.fn(() => new Promise<void>((resolve) => {
      active += 1;
      peakActive = Math.max(peakActive, active);
      resolvers.push(() => { active -= 1; resolve(); });
    }));

    const { getByText } = render(DetailModal, {
      ...baseProps(1, 'Movie A'),
      onDismiss: () => {},
      onUndismiss: () => {},
      onDismissReason,
    });
    await fireEvent.click(getByText('Not interested'));

    const tileA = getByText('Not my genre');
    const tileB = getByText('Too dark/violent');

    // Fire two taps in immediate succession (both dispatched before either
    // request has resolved) — the scenario that used to race.
    fireEvent.click(tileA);
    fireEvent.click(tileB);

    // Only A's request should go out first — B's tap must be queued behind
    // it, never fired concurrently.
    await waitFor(() => expect(onDismissReason).toHaveBeenCalledTimes(1));
    expect(onDismissReason.mock.calls[0][1]).toBe('not_my_genre');
    expect(peakActive).toBe(1);

    // Resolving A's request unblocks B's, which fires next — never overlapping.
    resolvers[0]();
    await waitFor(() => expect(onDismissReason).toHaveBeenCalledTimes(2));
    expect(onDismissReason.mock.calls[1][1]).toBe('too_dark'); // the LAST tile tapped
    expect(peakActive).toBe(1); // still never more than 1 concurrent request

    resolvers[1]();
    await waitFor(() => expect(active).toBe(0));
  });

  it('serializes A → B → A tapping — requests fire strictly in tap order, one at a time', async () => {
    const calls: string[] = [];
    let resolveCurrent: (() => void) | null = null;
    const onDismissReason = vi.fn((_item, reason: string) => new Promise<void>((resolve) => {
      calls.push(reason);
      resolveCurrent = () => resolve();
    }));

    const { getByText } = render(DetailModal, {
      ...baseProps(1, 'Movie A'),
      onDismiss: () => {},
      onUndismiss: () => {},
      onDismissReason,
    });
    await fireEvent.click(getByText('Not interested'));

    fireEvent.click(getByText('Not my genre'));       // A
    fireEvent.click(getByText('Too dark/violent'));   // B — queued behind A
    fireEvent.click(getByText('Not my genre'));       // A again — queued behind B

    await waitFor(() => expect(calls).toEqual(['not_my_genre']));
    resolveCurrent!();

    await waitFor(() => expect(calls).toEqual(['not_my_genre', 'too_dark']));
    resolveCurrent!();

    // The final request sent is the LAST tile tapped, in tap order, one at a time.
    await waitFor(() => expect(calls).toEqual(['not_my_genre', 'too_dark', 'not_my_genre']));
    resolveCurrent!();
  });
});
