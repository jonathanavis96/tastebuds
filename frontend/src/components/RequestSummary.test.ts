import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import RequestSummary from './RequestSummary.svelte';
import type { Recommendation, RequestSummary as Summary } from '../lib/types.js';

function makeRec(id: number, request_text: string | null): Recommendation {
  return {
    id, profile_id: 1, title_id: 100 + id, category: 'Top pick', score: 0.9, why_blurb: 'Fits.',
    request_text, state: 'pending', created_at: '2026-11-19T00:00:00Z',
  };
}

function makeSummary(overrides: Partial<Summary> = {}): Summary {
  return { text: 'Thriller new 2025', understood: ['Thriller', '2025 or newer'], matched: 13, note: null, ...overrides };
}

const picksFor = (text: string | null, count: number, from = 1) =>
  Array.from({ length: count }, (_, i) => makeRec(from + i, text));

afterEach(() => cleanup());

describe('RequestSummary', () => {
  it('renders nothing when no request is behind the feed', () => {
    const { container } = render(RequestSummary, { summary: null, recommendations: picksFor(null, 3) });
    expect(container.querySelector('.request-summary')).toBeNull();
  });

  it('shows the request as typed and one chip per rule understood', () => {
    const { getByText, getAllByRole } = render(RequestSummary, {
      summary: makeSummary(),
      recommendations: picksFor('Thriller new 2025', 10),
    });
    expect(getByText('“Thriller new 2025”')).toBeTruthy();
    expect(getAllByRole('listitem').map(li => li.textContent)).toEqual(['Thriller', '2025 or newer']);
  });

  it('says how many titles matched and how many of them are shown', () => {
    const { getByText } = render(RequestSummary, {
      summary: makeSummary({ matched: 13 }),
      recommendations: [...picksFor('Thriller new 2025', 10), ...picksFor('something funny', 4, 11)],
    });
    expect(getByText('13 titles match, showing 10')).toBeTruthy();
  });

  it('says every match is shown when there were no more', () => {
    const { getByText } = render(RequestSummary, {
      summary: makeSummary({ matched: 7 }),
      recommendations: picksFor('Thriller new 2025', 7),
    });
    expect(getByText('7 titles match, all shown')).toBeTruthy();
  });

  it('says nothing matched, suggests loosening the rules, and marks older picks as earlier', () => {
    const { getByText, queryByText } = render(RequestSummary, {
      summary: makeSummary({ text: 'korean western 1950', matched: 0 }),
      recommendations: picksFor('something funny', 5),
    });
    const line = getByText(/Nothing in the library matches/);
    expect(line.textContent).toMatch(/loosening the year, or lower the IMDb filter/);
    expect(line.textContent).toMatch(/The picks below are from earlier requests/);
    expect(queryByText(/titles match/)).toBeNull();
  });

  it('does not mention earlier picks when there are none', () => {
    const { getByText } = render(RequestSummary, {
      summary: makeSummary({ matched: 0 }),
      recommendations: [],
    });
    expect(getByText(/Nothing in the library matches/).textContent).not.toMatch(/earlier requests/);
  });

  it('shows the note when there is one', () => {
    const { getByText } = render(RequestSummary, {
      summary: makeSummary({ matched: 4, note: 'Only 4 thrillers from 2025 or newer are in the library.' }),
      recommendations: picksFor('Thriller new 2025', 4),
    });
    expect(getByText('Only 4 thrillers from 2025 or newer are in the library.')).toBeTruthy();
  });

  it('leaves out the quote for a Generate with nothing typed, counting the picks with no request', () => {
    const { container, getByText } = render(RequestSummary, {
      summary: makeSummary({ text: '', understood: ['2021 or newer'], matched: 840 }),
      recommendations: picksFor(null, 10),
    });
    expect(container.querySelector('.asked')).toBeNull();
    expect(getByText(`${(840).toLocaleString()} titles match, showing 10`)).toBeTruthy();
  });
});
