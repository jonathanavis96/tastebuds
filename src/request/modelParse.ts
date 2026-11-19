import type { Config } from '../config.js';
import { runClaudeJson } from '../claude/runJson.js';
import type { SpawnFn } from '../claude/runJson.js';
import { CANON_GENRES } from './rules.js';
import type { CanonGenre, RequestRules, RuleClause } from './rules.js';
import { describeRules } from './describe.js';
import { leftoverWords } from './parse.js';

/** Reading a request is a small task; the cheap model is enough. */
export const REQUEST_PARSE_MODEL = 'claude-haiku-5-5';
export const REQUEST_PARSE_TIMEOUT_MS = 30_000;

/** Caps on what one model reading may add. */
const MAX_MODEL_CLAUSES = 6;
const MAX_TERMS = 12;
const MAX_REFERENCES = 5;

const CLAUSE_SCHEMA = {
  type: 'object',
  properties: {
    label: { type: 'string' },
    terms: { type: 'array', items: { type: 'string' } },
  },
  required: ['label', 'terms'],
} as const;

export const REQUEST_PARSE_SCHEMA = {
  type: 'object',
  properties: {
    subjects: { type: 'array', items: CLAUSE_SCHEMA },
    exclude: { type: 'array', items: CLAUSE_SCHEMA },
    references: { type: 'array', items: { type: 'string' } },
    corrections: {
      type: 'object',
      properties: {
        mediaType: { type: 'string', enum: ['movie', 'tv'] },
        yearMin: { type: 'integer' },
        yearMax: { type: 'integer' },
        genres: { type: 'array', items: { type: 'string', enum: [...CANON_GENRES] } },
        minImdb: { type: 'number' },
        language: { type: 'string' },
      },
    },
  },
  required: ['subjects', 'exclude', 'references', 'corrections'],
} as const;

const SYSTEM_PROMPT =
  'You read one request for films or TV series and report only what the request itself says, ' +
  'as JSON matching the given schema. Never add anything the request does not say.';

function buildPrompt(text: string, base: RequestRules, now: Date): string {
  const understood = describeRules(base).join(', ') || 'nothing';
  return [
    `Today is ${now.toISOString().slice(0, 10)}.`,
    `Request: ${JSON.stringify(text)}`,
    `Already understood: ${understood}`,
    `Words not yet understood: ${leftoverWords(text, now).join(', ')}`,
    '',
    'Return:',
    '- subjects: what the titles must be about, as named in the request (a person, a place, a topic such as "medical"). ' +
      'For each, a short label in the request\'s words and 4-10 lowercase search terms that would appear in a title\'s keywords or synopsis. ' +
      'For a person, the full name is the only term.',
    '- exclude: what the request says to leave out, in the same shape.',
    '- references: titles the request names as an example of what it wants, as written.',
    '- corrections: only film or series (mediaType), release years (yearMin, yearMax), genres, a minimum IMDb rating (0-10) ' +
      'or an original language (ISO 639-1 code) that the request states and "Already understood" is missing.',
    '',
    'Add nothing the request does not say. Vague qualities (pace, cleverness, "interesting", "fun", a mood) are not subjects. ' +
      'Empty lists and empty corrections are a correct answer.',
  ].join('\n');
}

/**
 * Let the model read what parseRequest could not (a subject such as "medical",
 * an exclusion in unusual words, a title named as a reference) and merge it into
 * `base`. Runs only when leftoverWords(text) is non-empty, so a request that was
 * fully understood costs no model call.
 *
 * What the model returns is validated before it is merged: genres must be
 * canonical, years plausible, terms short. Anything the request states outright
 * (film or series, a year, a recency word) keeps the value parseRequest gave it.
 * Never throws: on a timeout, a refusal or unusable output it returns `base`.
 */
export async function refineRulesWithModel(
  text: string,
  base: RequestRules,
  config: Pick<Config, 'claudeToken'>,
  now: Date = new Date(),
  spawnFn?: SpawnFn,
): Promise<RequestRules> {
  if (leftoverWords(text, now).length === 0) return base;
  try {
    return await readWithModel(text, base, config.claudeToken, now, spawnFn);
  } catch (err) {
    console.warn(`[request] model reading failed, keeping the parsed rules: ${(err as Error).message}`);
    return base;
  }
}

/** One model call, validated and merged into `base`. Rejects when the call fails. */
export async function readWithModel(
  text: string,
  base: RequestRules,
  token: string,
  now: Date,
  spawnFn?: SpawnFn,
): Promise<RequestRules> {
  const raw = await runClaudeJson<Record<string, unknown>>({
    prompt: buildPrompt(text, base, now),
    system: SYSTEM_PROMPT,
    model: REQUEST_PARSE_MODEL,
    schema: REQUEST_PARSE_SCHEMA,
    token,
    timeoutMs: REQUEST_PARSE_TIMEOUT_MS,
    spawnFn,
  });
  return mergeReading(base, raw, text, now.getFullYear());
}

function mergeReading(base: RequestRules, raw: Record<string, unknown>, text: string, cy: number): RequestRules {
  const rules: RequestRules = { ...base, must: [...base.must], mustNot: [...base.mustNot], similarTo: [...base.similarTo] };
  const subjects = cleanClauses(raw.subjects, text).slice(0, MAX_MODEL_CLAUSES);
  const exclude = cleanClauses(raw.exclude, text).slice(0, MAX_MODEL_CLAUSES - subjects.length);
  addSubjects(rules, subjects);
  for (const c of exclude) {
    if (!rules.mustNot.some((m) => m.label.toLowerCase() === c.label.toLowerCase())) rules.mustNot.push(c);
  }
  addReferences(rules, raw.references, text);
  applyCorrections(rules, base, record(raw.corrections), cy, MAX_MODEL_CLAUSES - subjects.length - exclude.length);
  return rules;
}

function record(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Clauses with usable terms whose label the request actually mentions. */
function cleanClauses(raw: unknown, text: string): RuleClause[] {
  if (!Array.isArray(raw)) return [];
  const out: RuleClause[] = [];
  for (const item of raw.map(record)) {
    const terms = cleanTerms(item.terms);
    if (terms.length === 0) continue;
    const label = typeof item.label === 'string' && item.label.trim().length > 0 ? item.label.trim().slice(0, 40) : terms[0];
    if (mentioned(label, text)) out.push({ label, genres: [], terms });
  }
  return out;
}

function cleanTerms(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const terms = raw
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.toLowerCase().trim().replace(/\s+/g, ' '))
    .filter((t) => t.length >= 2 && t.length <= 40);
  return [...new Set(terms)].slice(0, MAX_TERMS);
}

/** What the model adds must come from the request: some word of it appears in the text. */
function mentioned(label: string, text: string): boolean {
  const flat = text.toLowerCase().replace(/-/g, ' ');
  return label.toLowerCase().split(/[^a-z0-9]+/)
    .map((w) => w.replace(/s$/, ''))
    .some((w) => w.length >= 3 && flat.includes(w));
}

/** Subjects join the request's one any-of theme clause (the must clause without genres). */
function addSubjects(rules: RequestRules, subjects: RuleClause[]): void {
  if (subjects.length === 0) return;
  const at = rules.must.findIndex((c) => c.genres.length === 0);
  const existing = at >= 0 ? rules.must[at] : null;
  const labels = existing ? existing.label.split(', ') : [];
  for (const s of subjects) {
    if (!labels.some((l) => l.toLowerCase() === s.label.toLowerCase())) labels.push(s.label);
  }
  const merged: RuleClause = {
    label: labels.join(', '),
    genres: [],
    terms: [...new Set([...(existing?.terms ?? []), ...subjects.flatMap((s) => s.terms)])],
  };
  if (existing) rules.must[at] = merged;
  else rules.must.push(merged);
}

function addReferences(rules: RequestRules, raw: unknown, text: string): void {
  if (!Array.isArray(raw)) return;
  const seen = new Set(rules.similarTo.map((s) => s.toLowerCase()));
  const refs = raw
    .filter((r): r is string => typeof r === 'string')
    .map((r) => r.trim())
    .filter((r) => r.length > 0 && r.length <= 80 && !seen.has(r.toLowerCase()) && mentioned(r, text));
  rules.similarTo.push(...[...new Set(refs)].slice(0, MAX_REFERENCES));
}

/** Fill only what the parser left open; what the request said outright stays as parsed. */
function applyCorrections(rules: RequestRules, base: RequestRules, c: Record<string, unknown>, cy: number, genreRoom: number): void {
  if (base.mediaType === null && (c.mediaType === 'movie' || c.mediaType === 'tv')) rules.mediaType = c.mediaType;
  if (base.yearSource === 'default') {
    const valid = (y: unknown): y is number => Number.isInteger(y) && (y as number) >= 1900 && (y as number) <= cy + 1;
    const min = valid(c.yearMin) ? c.yearMin : null;
    const max = valid(c.yearMax) ? c.yearMax : null;
    if ((min !== null || max !== null) && (min === null || max === null || min <= max)) {
      Object.assign(rules, { yearMin: min, yearMax: max, yearSource: 'stated' });
    }
  }
  if (base.minImdb === null && typeof c.minImdb === 'number' && c.minImdb > 0 && c.minImdb <= 10) {
    rules.minImdb = Math.round(c.minImdb * 10) / 10;
  }
  if (base.language === null && typeof c.language === 'string' && /^[a-z]{2}$/.test(c.language)) rules.language = c.language;
  const named = new Set([...rules.must, ...rules.mustNot].flatMap((cl) => cl.genres));
  const genres = Array.isArray(c.genres) ? c.genres : [];
  const added = [...new Set(genres)].filter((g): g is CanonGenre =>
    CANON_GENRES.includes(g as CanonGenre) && !named.has(g as CanonGenre) && !insideReference(g as CanonGenre, base));
  for (const g of added.slice(0, Math.max(0, genreRoom))) rules.must.push({ label: g, genres: [g], terms: [] });
}

/** "the drama type of movie" names a title; its genre word is not a genre rule. */
function insideReference(genre: CanonGenre, base: RequestRules): boolean {
  return base.similarTo.some((ref) => ref.toLowerCase().includes(genre.toLowerCase()));
}
