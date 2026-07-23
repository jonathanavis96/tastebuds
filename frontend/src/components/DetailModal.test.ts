import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
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
});
