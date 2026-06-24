import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import DetailModal from './DetailModal.svelte';

const baseProps = (title_id: number, title: string) => ({
  item: { title_id, title },
  onClose: () => {},
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('DetailModal "Not interested" — deferred background dismiss', () => {
  it('locks the dismiss to the armed title even after navigating away', async () => {
    // Arm "Not interested" on movie A, then swipe to movie B before the 1s window
    // elapses. The dismiss must still fire for A (the armed title), not B.
    const onDismiss = vi.fn();
    const { getByText, rerender } = render(DetailModal, {
      ...baseProps(1, 'Movie A'),
      onDismiss,
    });
    await fireEvent.click(getByText('Not interested'));
    await rerender({ item: { title_id: 2, title: 'Movie B' } });

    vi.advanceTimersByTime(1000);

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDismiss.mock.calls[0][0]).toMatchObject({ title_id: 1 });
  });

  it('fires the dismiss for the title when left untouched', async () => {
    const onDismiss = vi.fn();
    const { getByText } = render(DetailModal, { ...baseProps(1, 'Movie A'), onDismiss });
    await fireEvent.click(getByText('Not interested'));
    vi.advanceTimersByTime(1000);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDismiss.mock.calls[0][0]).toMatchObject({ title_id: 1 });
  });

  it('cancels when re-tapped (undo) within the grace window', async () => {
    const onDismiss = vi.fn();
    const { getByText } = render(DetailModal, { ...baseProps(1, 'Movie A'), onDismiss });
    await fireEvent.click(getByText('Not interested'));        // arm
    await fireEvent.click(getByText(/Not interested/));        // re-tap → undo
    vi.advanceTimersByTime(1500);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('cancels when the modal closes before the window elapses', async () => {
    const onDismiss = vi.fn();
    const { getByText, unmount } = render(DetailModal, { ...baseProps(1, 'Movie A'), onDismiss });
    await fireEvent.click(getByText('Not interested'));
    unmount();                                                 // modal closed pre-lock-in
    vi.advanceTimersByTime(1500);
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
