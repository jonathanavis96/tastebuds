import { leftoverWords, parseRequest } from './parse.js';

/** Requests the parser reads in full, shown when one could not be read. Kept true by unreadable.test.ts. */
export const EXAMPLE_REQUESTS = ['funny series from 2023', 'scary film, no gore', 'like Inception'];

const KEYBOARD_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

/**
 * How a leftover word reads:
 *  - 'mash': surely keys pressed at random: five consonants in a row ("asdkjh"),
 *    a q before a consonant other than u ("qwe"), four or more letters straight
 *    off one keyboard row ("asdf"), or four or more letters with no vowel ("zxcvb").
 *  - 'unsure': three letters or fewer with no vowel ("zzv", but also "bbc", "wtf",
 *    "pls"), or no letter or digit at all.
 *  - 'word': anything else, including words in other scripts and anything with a digit.
 */
export function wordKind(word: string): 'mash' | 'unsure' | 'word' {
  const w = word.toLowerCase();
  if (/\d/.test(w) || /[^\x00-\x7f]/.test(w)) return 'word';
  const letters = w.replace(/[^a-z]/g, '');
  if (letters.length === 0) return 'unsure';
  const vowel = /[aeiouy]/.test(letters);
  if (/[^aeiouy]{5}/.test(letters) || /q[^aeiouy]/.test(letters.replace(/qu/g, ''))) return 'mash';
  if (letters.length >= 4 && KEYBOARD_ROWS.some((row) => row.includes(letters) || [...row].reverse().join('').includes(letters))) return 'mash';
  if (!vowel) return letters.length >= 4 ? 'mash' : 'unsure';
  return 'word';
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
 * rule, and it has no letter or digit ("???"), or some word left over is surely
 * random keys and none is a word ("asdkjh qwe zzv", see wordKind). Null for anything else, which is read and
 * answered as usual. Pure and quick: no model call is made for it.
 */
export function unreadableRequestReply(text: string, now: Date = new Date()): string | null {
  const trimmed = text.trim();
  if (!trimmed || readsAnyRule(trimmed, now)) return null;
  if (/[\p{L}\p{N}]/u.test(trimmed)) {
    // A word typed in capitals is an abbreviation ("BBC", "NSFW") as often as not.
    const caps = new Set(trimmed.split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 1 && /[A-Z]/.test(w) && w === w.toUpperCase())
      .map((w) => w.toLowerCase()));
    const kinds = leftoverWords(trimmed, now).map((w) => (caps.has(w) ? 'unsure' : wordKind(w)));
    // Refused only when some word is surely random keys and none is a word.
    if (!kinds.includes('mash') || kinds.includes('word')) return null;
  }
  const shown = trimmed.length > 60 ? `${trimmed.slice(0, 57)}…` : trimmed;
  const examples = EXAMPLE_REQUESTS.map((e) => `“${e}”`);
  return `“${shown}” could not be read, so no picks were made. ` +
    `Try something like ${examples.slice(0, -1).join(', ')} or ${examples[examples.length - 1]}.`;
}
