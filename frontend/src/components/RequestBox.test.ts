import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import RequestBox from './RequestBox.svelte';

beforeEach(() => localStorage.clear());
afterEach(() => cleanup());

async function submitWith(onSubmit: (text: string) => unknown) {
  const view = render(RequestBox, { onSubmit: onSubmit as (text: string) => Promise<boolean> });
  const box = view.container.querySelector('textarea')!;
  await fireEvent.input(box, { target: { value: '  thriller new 2025 ' } });
  await fireEvent.click(view.getByRole('button', { name: 'Generate' }));
  return box;
}

describe('RequestBox', () => {
  it('sends the trimmed request and empties the box', async () => {
    const sent: string[] = [];
    const box = await submitWith(async (t) => { sent.push(t); return true; });
    await tick();
    expect(sent).toEqual(['thriller new 2025']);
    expect(box.value).toBe('');
  });

  it('puts the request back in the box when it was not run', async () => {
    const box = await submitWith(async () => false);
    await tick();
    await tick();
    expect(box.value).toBe('thriller new 2025');
  });
});
