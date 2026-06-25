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
