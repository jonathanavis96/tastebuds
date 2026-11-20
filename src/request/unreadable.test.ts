import { describe, it, expect } from 'vitest';
import { EXAMPLE_REQUESTS, unreadableRequestReply, wordKind } from './unreadable.js';
import { leftoverWords, parseRequest } from './parse.js';
import { describeRules } from './describe.js';

const NOW = new Date('2026-06-15T12:00:00Z');

describe('unreadableRequestReply', () => {
  it.each(['asdkjh qwe zzv', 'asdf', 'zxcvb', '???', '!!! ...', 'qwerty', 'hjkl lkjh', 'xcvb zzv', 'sdfghj'])('says %j could not be read', (text) => {
    const reply = unreadableRequestReply(text, NOW);
    expect(reply).toMatch(/could not be read, so no picks were made\. Try something like “funny series from 2023”/);
  });

  it.each([
    'thriller', 'something', 'anything good tonight', 'surprise me', 'a heist with a twist', 'medical drama',
    'films about grief', 'like Parasite', '007', 'Amélie', '드라마', 'asdkjh comedy', 'hmm a film', 'qatar', 'iraq war',
    'rhythm and blues', 'strength', 'BBC', 'NSFW', 'wtf is good', 'tbh whatever', 'pls help', 'hmm something',
    'hmm', 'pls', 'Brr', 'zzz', 'Björk',
  ])('lets %j through to be read as usual', (text) => {
    expect(unreadableRequestReply(text, NOW)).toBeNull();
  });

  it('shortens a long request in its reply', () => {
    const reply = unreadableRequestReply('zxcv '.repeat(30), NOW)!;
    expect(reply.startsWith('“zxcv zxcv')).toBe(true);
    expect(reply).toContain('…” could not be read');
  });

  it('offers examples that are read in full with no model call', () => {
    for (const text of EXAMPLE_REQUESTS) {
      expect(leftoverWords(text, NOW)).toEqual([]);
      expect(describeRules(parseRequest(text, NOW)).length).toBeGreaterThan(1);
    }
  });
});

describe('wordKind', () => {
  it.each(['asdkjh', 'qwe', 'asdf', 'poiu', 'zxcvb'])('%s is surely random keys', (w) => expect(wordKind(w)).toBe('mash'));
  it.each(['zzv', 'bbc', 'wtf', 'pls', 'hmm', '...'])('%s is unsure', (w) => expect(wordKind(w)).toBe('unsure'));
  it.each(['rhythm', 'strength', 'queen', 'qi', 'type', 'iraq', '2023', 'björk'])('%s is a word', (w) => expect(wordKind(w)).toBe('word'));
});
