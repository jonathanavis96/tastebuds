import type { RequestRules } from './rules.js';

/**
 * One short chip per rule, in reading order, for showing the viewer what was
 * understood: ["Thriller", "Films", "2025 or newer", "IMDb 7.0+", "No nuns"].
 * The default year window is described too ("2021 or newer"), since it filters.
 */
export function describeRules(rules: RequestRules): string[] {
  void rules;
  throw new Error('not implemented');
}
