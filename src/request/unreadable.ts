import { leftoverWords, parseRequest } from './parse.js';

/** Requests the parser reads in full, shown when one could not be read. Kept true by unreadable.test.ts. */
export const EXAMPLE_REQUESTS = ['funny series from 2023', 'scary film, no gore', 'like Inception'];

const KEYBOARD_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

/**
 * Whether a word looks like keys pressed at random rather than a word: three or
 * more letters with no vowel ("zzv"), five consonants in a row ("asdkjh"), a q
 * followed by a consonant other than u ("qwe"), or four or more letters straight
 * off one keyboard row ("asdf").
 * Words in other scripts, and anything with a digit, count as readable.
 */
export function looksLikeKeyMash(word: string): boolean {
  const w = word.toLowerCase();
  if (/\d/.test(w)) return false;
  const letters = w.replace(/[^a-z]/g, '');
  if (/[^\x00-\x7f]/.test(w) && letters.length === 0) return false;
  if (letters.length === 0) return true;
  // Two letters with no vowel are an abbreviation ("tv", "uk", "dc") as often as not.
  if (!/[aeiouy]/.test(letters)) return letters.length > 2;
  if (/[^aeiouy]{5}/.test(letters)) return true;
  if (/q[^aeiouy]/.test(letters.replace(/qu/g, ''))) return true;
  if (letters.length >= 4 && KEYBOARD_ROWS.some((row) => row.includes(letters) || [...row].reverse().join('').includes(letters))) return true;
  return false;
}

/** Whether parseRequest read anything at all from the request. */
function readsAnyRule(text: string, now: Date): boolean {
  const r = parseRequest(text, now);
  return r.mediaType !== null || r.yearSource !== 'default' || r.must.length > 0 || r.mustNot.length > 0 ||
    r.similarTo.length > 0 || r.minImdb !== null || r.minRuntime !== null || r.maxRuntime !== null ||
    r.language !== null || r.hiddenGem;
}

/**
 * The reply for a request that cannot be read at all: nothing in it became a
 * rule, and it has no letter or digit ("???") or every word left over looks
 * like a key-mash ("asdkjh qwe zzv"). Null for anything else, which is read and
 * answered as usual. Pure and quick: no model call is made for it.
 */
export function unreadableRequestReply(text: string, now: Date = new Date()): string | null {
  const trimmed = text.trim();
  if (!trimmed || readsAnyRule(trimmed, now)) return null;
  if (/[\p{L}\p{N}]/u.test(trimmed)) {
    const leftover = leftoverWords(trimmed, now);
    if (leftover.length === 0 || !leftover.every(looksLikeKeyMash)) return null;
  }
  const shown = trimmed.length > 60 ? `${trimmed.slice(0, 57)}…` : trimmed;
  const examples = EXAMPLE_REQUESTS.map((e) => `“${e}”`);
  return `“${shown}” could not be read, so no picks were made. ` +
    `Try something like ${examples.slice(0, -1).join(', ')} or ${examples[examples.length - 1]}.`;
}
