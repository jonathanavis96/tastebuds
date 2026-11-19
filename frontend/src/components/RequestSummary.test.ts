import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import RequestSummary from './RequestSummary.svelte';
import type { RequestSummary as Summary } from '../lib/types.js';

function makeSummary(overrides: Partial<Summary> = {}): Summary {
  return { text: 'Thriller new 2025', understood: ['Thriller', '2025 or newer'], matched: 13, note: null, ...overrides };
}

afterEach(() => cleanup());

describe('RequestSummary (the heading of one request’s section)', () => {
  it('heads the picks made without a request as picked for your taste', () => {
    const { getByRole, container } = render(RequestSummary, { text: null, summary: null, shown: 3 });
    expect(getByRole('heading').textContent).toBe('Picked for your taste');
    expect(container.querySelector('.chips')).toBeNull();
  });

  it('shows the request as typed and one chip per rule understood', () => {
    const { getByRole, getAllByRole } = render(RequestSummary, { text: 'Thriller new 2025', summary: makeSummary(), shown: 10 });
    expect(getByRole('heading').textContent).toBe('“Thriller new 2025”');
    expect(getAllByRole('listitem').map(li => li.textContent)).toEqual(['Thriller', '2025 or newer']);
  });

  it('shows the request as typed when its summary could not be read', () => {
    const { getByRole, container } = render(RequestSummary, { text: 'comedy', summary: null, shown: 4 });
    expect(getByRole('heading').textContent).toBe('“comedy”');
    expect(container.querySelector('.count')).toBeNull();
  });

  it('says how many titles match and how many of them are in the list', () => {
    const { getByText } = render(RequestSummary, { text: 'Thriller new 2025', summary: makeSummary({ matched: 13 }), shown: 10 });
    expect(getByText('13 titles match, 10 in your list')).toBeTruthy();
  });

  it('says every match is in the list when there are no more', () => {
    const { getByText } = render(RequestSummary, { text: 'Thriller new 2025', summary: makeSummary({ matched: 7 }), shown: 7 });
    expect(getByText('7 titles match, all in your list')).toBeTruthy();
  });

  it('shows the server’s note, such as every match already being in the list', () => {
    const note = 'All 7 titles that match this are already in your list. Asking for a lower IMDb rating would show more.';
    const { getByText } = render(RequestSummary, { text: 'Thriller new 2025', summary: makeSummary({ matched: 7, note }), shown: 7 });
    expect(getByText(note)).toBeTruthy();
  });

  it('says once that nothing matched, using the server’s note when there is one', () => {
    const note = 'Nothing in the library matches all of this. Asking for any year would show more.';
    const { getAllByText, queryByText } = render(RequestSummary, { text: 'korean western', summary: makeSummary({ matched: 0, note }), shown: 0 });
    expect(getAllByText(/Nothing in the library matches/)).toHaveLength(1);
    expect(queryByText(/titles match/)).toBeNull();
  });

  it('says nothing matched when the server sent no note', () => {
    const { getByText } = render(RequestSummary, { text: 'korean western', summary: makeSummary({ matched: 0 }), shown: 0 });
    expect(getByText('Nothing in the library matches all of that.')).toBeTruthy();
  });
});
