import { beforeAll, describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { rulesSql, titleObeys } from './enforce.js';
import type { CheckableTitle } from './enforce.js';
import { parseRequest } from './parse.js';
import { defaultRules } from './rules.js';
import type { RequestRules } from './rules.js';

const NOW = new Date('2026-11-19T12:00:00Z');

function title(over: Partial<CheckableTitle> = {}): CheckableTitle {
  return {
    media_type: 'movie', title: 'Example', year: 2025, genres: '["Thriller"]', keywords: '[]',
    synopsis: null, imdb_genres: null, imdb_rating: '7.2', imdb_votes: 12_000, runtime_minutes: 100,
    original_language: 'en', ...over,
  };
}

function check(text: string, over: Partial<CheckableTitle> = {}) {
  return titleObeys(parseRequest(text, NOW), title(over));
}

describe('titleObeys', () => {
  it('passes a title that satisfies every rule', () => {
    expect(check('Thriller new 2025')).toEqual({ ok: true, failed: [] });
  });

  it('gives one short reason per broken rule', () => {
    const result = check('Thriller new 2025', { year: 2008, genres: '["Comedy"]' });
    expect(result).toEqual({ ok: false, failed: ['released 2008, asked for 2025 or newer', 'not Thriller'] });
  });

  it('fails a rule whose metadata is unknown', () => {
    expect(check('Thriller new 2025', { year: null }).failed).toEqual(['release year unknown, asked for 2025 or newer']);
    expect(check('top rated thrillers', { imdb_rating: null }).failed).toEqual(['no IMDb rating, asked for IMDb 7.5+']);
    expect(check('thriller hidden gems', { imdb_votes: null }).failed).toEqual(['IMDb votes unknown, asked for a hidden gem']);
    expect(check('thriller in English', { original_language: null }).failed).toEqual(['language unknown, asked for English']);
    expect(check('a thriller under 90 minutes', { runtime_minutes: null }).failed).toEqual(['runtime unknown, asked for under 90 min']);
  });

  it('checks film vs series, the rating floor, language and the hidden-gem cap', () => {
    expect(check('thriller series').failed).toEqual(['a film, asked for series']);
    expect(check('top rated thrillers', { imdb_rating: '6.4' }).failed).toEqual(['IMDb 6.4, asked for IMDb 7.5+']);
    expect(check('Korean thriller').failed).toEqual(['in English, asked for Korean']);
    expect(check('thriller hidden gems', { imdb_votes: 250_000 }).failed)
      .toEqual(['250,000 IMDb votes, too well known for a hidden gem']);
  });

  it('applies runtime bounds to films only', () => {
    expect(check('a thriller under 90 minutes', { runtime_minutes: 120 }).failed).toEqual(['runs 120 min, asked for under 90 min']);
    expect(check('a thriller under 90 minutes', { media_type: 'tv', runtime_minutes: null }).ok).toBe(true);
  });

  it('satisfies a clause by a canonical tag from any source', () => {
    expect(check('sci-fi', { media_type: 'tv', genres: '["Sci-Fi & Fantasy"]', imdb_genres: '["Sci-Fi"]' }).ok).toBe(true);
    expect(check('sci-fi', { media_type: 'tv', genres: '["Sci-Fi & Fantasy"]', imdb_genres: '["Fantasy"]' }).ok).toBe(false);
    const keyworded = { genres: '["Drama"]', keywords: '["psychological thriller"]' };
    expect(check('thriller', { ...keyworded, media_type: 'tv' }).ok).toBe(true);
    expect(check('thriller', { ...keyworded, media_type: 'movie' }).failed).toEqual(['not Thriller']);
  });

  it('matches terms on word boundaries, tolerating plurals and hyphens, in keywords, title or synopsis', () => {
    const medical = 'Medical dramas';
    const drama = { genres: '["Drama"]' };
    expect(check(medical, { ...drama, keywords: '["hospital"]' }).ok).toBe(true);
    expect(check(medical, { ...drama, synopsis: 'Two surgeons fight for a job.' }).ok).toBe(true);
    expect(check(medical, { ...drama, title: 'The Nurses' }).ok).toBe(true);
    expect(check(medical, { ...drama, synopsis: 'A hospitality worker.' }).failed).toEqual(['not Medical']);
    expect(check('mind bending thriller', { keywords: '["mind-bending"]' }).ok).toBe(true);
  });

  it('rejects a title that matches an exclusion', () => {
    const scary = { genres: '["Horror"]' };
    const text = 'Scary movie. No devils or nuns.';
    expect(check(text, { ...scary, keywords: '["demonic possession"]' }).failed).toEqual(['excluded: devils']);
    expect(check(text, { ...scary, synopsis: 'A young nun is sent to Rome.' }).failed).toEqual(['excluded: nuns']);
    expect(check(text, { ...scary, synopsis: 'A family moves into a farmhouse.' }).ok).toBe(true);
  });

  it('never throws on malformed JSON columns', () => {
    expect(check('thriller', { genres: '{', keywords: 'null' }).ok).toBe(false);
  });
});

describe('rulesSql', () => {
  it('returns no condition for rules that only a clause can decide', () => {
    const rules: RequestRules = { ...defaultRules(NOW), yearMin: null, yearSource: 'any' };
    expect(rulesSql(rules)).toEqual({ sql: '', params: [] });
  });

  it('builds one condition per column rule, under the given alias', () => {
    const { sql, params } = rulesSql(parseRequest('High rated new series in Korean. Hidden gems.', NOW), 'x');
    expect(sql).toBe(' AND x.media_type = ? AND x.year >= ? AND CAST(x.imdb_rating AS REAL) >= ? AND x.original_language = ? AND x.imdb_votes <= ?');
    expect(params).toEqual(['tv', 2025, 7, 'ko', 50_000]);
  });
});

/**
 * rulesSql is a prefilter: it must admit every row titleObeys accepts. Checked
 * on a sample of a real catalogue when TASTEBUDS_REPLAY_DB names a copy of one
 * (none ships with the repository). The sample gets made-up IMDb vote counts,
 * some of them unknown, so the hidden-gem rule is exercised on any copy.
 */
const REPLAY_DB = process.env.TASTEBUDS_REPLAY_DB ?? '';

describe.skipIf(!REPLAY_DB || !existsSync(REPLAY_DB))('rulesSql against a sample of the real catalogue', () => {
  const COLUMNS = 'id, tmdb_id, media_type, title, year, genres, keywords, synopsis, updated_at, imdb_rating, runtime_minutes, original_language';

  function sampleDb(): InstanceType<typeof Database> {
    const source = new Database(REPLAY_DB, { readonly: true, fileMustExist: true });
    const rows = source.prepare(`SELECT ${COLUMNS} FROM titles WHERE id % 50 = 0`).all() as Record<string, unknown>[];
    source.close();
    const db = new Database(':memory:');
    runMigrations(db);
    const insert = db.prepare(`INSERT INTO titles (${COLUMNS}, imdb_votes) VALUES (${COLUMNS.split(', ').map((c) => `@${c}`).join(', ')}, @imdb_votes)`);
    for (const row of rows) {
      const id = row.id as number;
      insert.run({ ...row, imdb_votes: id % 7 === 0 ? null : (id * 7919) % 200_000 });
    }
    return db;
  }

  let db: InstanceType<typeof Database>;
  let titles: (CheckableTitle & { id: number })[];
  // In beforeAll, not the describe body: a skipped describe still runs its body.
  beforeAll(() => {
    db = sampleDb();
    titles = db.prepare('SELECT * FROM titles t').all() as (CheckableTitle & { id: number })[];
  });

  it.each([
    'Thriller new 2025',
    'Scary movies. Good reviews.',
    'High rated new series. Hidden gems.',
    'a short movie under 90 minutes in English',
    'classic westerns',
    'Korean thriller between 2010 and 2015',
    'well reviewed films over 2 hours',
    'Scary Sunday night movie. No devils or nuns.',
  ])('%s', (text) => {
    const rules = parseRequest(text, NOW);
    const { sql, params } = rulesSql(rules);
    const admitted = new Set((db.prepare(`SELECT t.id FROM titles t WHERE 1 = 1${sql}`).all(...params) as { id: number }[]).map((r) => r.id));

    const passing = titles.filter((t) => titleObeys(rules, t).ok);
    for (const t of passing) expect(admitted.has(t.id), `${t.title} passes but is not admitted`).toBe(true);

    // Without the clauses, the SQL decides exactly the column rules.
    const columnOnly = { ...rules, must: [], mustNot: [] };
    const columnPassing = titles.filter((t) => titleObeys(columnOnly, t).ok).map((t) => t.id);
    expect(new Set(columnPassing)).toEqual(admitted);
  });

  it('samples a few hundred titles, some of which pass', () => {
    expect(titles.length).toBeGreaterThan(300);
    const rules = parseRequest('Scary movies. Good reviews.', NOW);
    expect(titles.filter((t) => titleObeys({ ...rules, yearMin: null }, t).ok).length).toBeGreaterThan(0);
  });
});
