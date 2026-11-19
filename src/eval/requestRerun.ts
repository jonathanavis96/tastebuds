/**
 * Request rerun: make fresh picks for every past request, so the replay check
 * (npm run eval:requests -- --picks new) can score what the app returns today.
 *
 *   npm run eval:rerun -- --db COPY.db [--only "<text>"] [--limit N]
 *
 * THIS WRITES TO THE DATABASE: point --db at a copy, never at the live file.
 * Each run makes one /generate call (and so one model call) per request.
 *
 * It takes every distinct (profile, request text) among the picks that carry no
 * request_summary (the ones made before requests were read into rules) and
 * calls generatePicks once for each. When all the old picks for a request were
 * one media type, that type is passed as the Films/Series filter, since it was
 * on when the request was made. After each call the profile's pending picks
 * move to 'shown', so the next request starts from a clean feed and the picks
 * stay in the table for scoring. Config comes from the environment, like the
 * other CLIs.
 */
import { config as dotenvConfig } from 'dotenv';
import { loadConfig } from '../config.js';
import { openDb } from '../db/open.js';
import { generatePicks } from '../api/generate.js';

interface PastRequest {
  profile_id: number;
  request_text: string;
  media: string;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const dbPath = arg('db');
  if (!dbPath) throw new Error('usage: npm run eval:rerun -- --db COPY.db [--only "<text>"] [--limit N]');
  const only = arg('only');
  const limit = arg('limit') === undefined ? Infinity : Number(arg('limit'));
  if (!(limit > 0)) throw new Error('--limit needs a number above 0');

  dotenvConfig();
  const config = { ...loadConfig(), dbPath };
  const db = openDb(dbPath);

  const past = (db.prepare(`
    SELECT r.profile_id, r.request_text, GROUP_CONCAT(DISTINCT t.media_type) AS media
    FROM recommendations r JOIN titles t ON t.id = r.title_id
    WHERE r.request_text IS NOT NULL AND r.request_summary IS NULL
    GROUP BY r.profile_id, r.request_text
    ORDER BY MIN(r.id)
  `).all() as PastRequest[])
    .filter((p) => only === undefined || p.request_text === only)
    .slice(0, limit);

  const moveToShown = db.prepare("UPDATE recommendations SET state = 'shown' WHERE profile_id = ? AND state = 'pending'");
  const started = Date.now();
  let picked = 0;
  for (const p of past) {
    const mediaType = p.media === 'movie' || p.media === 'tv' ? p.media : undefined;
    const t0 = Date.now();
    const outcome = await generatePicks(db, config, { profileId: p.profile_id, request: p.request_text, mediaType });
    const seconds = ((Date.now() - t0) / 1000).toFixed(1);
    if (!outcome.ok) {
      console.log(`[p${p.profile_id}] ${JSON.stringify(p.request_text)}: failed (${outcome.error})`);
      continue;
    }
    const summary = outcome.feed.request;
    const count = outcome.feed.recs.filter((r) => r.request_text === p.request_text).length;
    picked += count;
    console.log(
      `[p${p.profile_id}] ${JSON.stringify(p.request_text)}${mediaType ? ` (${mediaType})` : ''}: ` +
      `[${summary?.understood.join(', ') ?? ''}] matched=${summary?.matched ?? 0} picked=${count} ${seconds}s`,
    );
    moveToShown.run(p.profile_id);
  }
  console.log(`${past.length} requests, ${picked} picks, ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
