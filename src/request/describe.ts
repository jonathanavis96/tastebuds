import type { RequestRules } from './rules.js';
import { LANGUAGE_NAMES } from './vocabulary.js';

/**
 * One short chip per rule, in reading order, for showing the viewer what was
 * understood: ["Thriller", "Films", "2025 or newer", "IMDb 7.0+", "No nuns"].
 * The default year window is described too ("2021 or newer"), since it filters.
 */
export function describeRules(rules: RequestRules): string[] {
  const chips = rules.must.map((c) => c.label);
  if (rules.mediaType) chips.push(rules.mediaType === 'movie' ? 'Films' : 'Series');
  const years = describeYearWindow(rules);
  if (years) chips.push(years);
  if (rules.minImdb !== null) chips.push(`IMDb ${rules.minImdb.toFixed(1)}+`);
  if (rules.hiddenGem) chips.push('Hidden gems');
  const runtime = describeRuntime(rules);
  if (runtime) chips.push(runtime);
  if (rules.language) chips.push(languageName(rules.language));
  for (const c of rules.mustNot) chips.push(`No ${c.label}`);
  for (const ref of rules.similarTo) chips.push(`Like ${ref}`);
  return chips;
}

/** "2025 or newer", "2010–2015", "1990s", "Up to 1999", "2025"; "Any year" when asked for older titles. */
export function describeYearWindow(rules: Pick<RequestRules, 'yearMin' | 'yearMax' | 'yearSource'>): string | null {
  const { yearMin: min, yearMax: max } = rules;
  if (min !== null && max !== null) {
    if (min === max) return String(min);
    if (min % 10 === 0 && max === min + 9) return `${min}s`;
    return `${min}–${max}`;
  }
  if (min !== null) return `${min} or newer`;
  if (max !== null) return `Up to ${max}`;
  return rules.yearSource === 'any' ? 'Any year' : null;
}

/** "Under 90 min", "Over 120 min", "90–120 min". */
export function describeRuntime(rules: Pick<RequestRules, 'minRuntime' | 'maxRuntime'>): string | null {
  const { minRuntime: min, maxRuntime: max } = rules;
  if (min !== null && max !== null) return `${min}–${max} min`;
  if (max !== null) return `Under ${max} min`;
  if (min !== null) return `Over ${min} min`;
  return null;
}

export function languageName(code: string): string {
  return LANGUAGE_NAMES[code] ?? code;
}
