/**
 * Run one ratings job by hand:
 *   npm run ratings:sync                 IMDb ratings from IMDb's ratings file
 *   npm run ratings:genres               IMDb genres from IMDb's basics file (230 MB)
 *   npm run ratings:gaps -- --cap 500    the same pass, plus adding well-rated titles the catalogue lacks
 *   npm run ratings:rt -- --cap 30       re-read Rotten Tomatoes pages
 *   npm run ratings:imdb-ids -- --cap 50 fill missing imdb_id values from TMDB
 * In the container: node dist/server/ratings/cli.js <job> [--cap N]
 */
import { config as dotenvConfig } from 'dotenv';
import { loadConfig, RT_REFRESH_CAP_DEFAULT } from '../config.js';
import { openDb } from '../db/open.js';
import { syncImdbGenres, syncImdbRatings } from '../imdb/dataset.js';
import { fillMissingImdbIds, IMDB_ID_FILL_CAP_DEFAULT } from '../imdb/fillIds.js';
import { fillImdbGaps } from '../imdb/gapFill.js';
import { refreshRtScores } from '../rt/refresh.js';

const JOBS = ['sync', 'genres', 'gaps', 'rt', 'imdb-ids'] as const;
type Job = (typeof JOBS)[number];

function capArg(args: string[]): number | undefined {
  const i = args.indexOf('--cap');
  if (i === -1) return undefined;
  const cap = Number(args[i + 1]);
  if (!Number.isInteger(cap) || cap < 1) throw new Error('--cap needs a whole number above 0');
  return cap;
}

async function main(): Promise<void> {
  const [job, ...rest] = process.argv.slice(2);
  if (!JOBS.includes(job as Job)) {
    throw new Error(`Usage: ratings/cli <${JOBS.join('|')}> [--cap N]`);
  }
  dotenvConfig();
  const config = loadConfig();
  const db = openDb(config.dbPath);
  const cap = capArg(rest);
  const started = Date.now();

  let result: unknown;
  switch (job as Job) {
    case 'sync':
      result = await syncImdbRatings(db, config);
      break;
    case 'genres':
      result = { updated: (await syncImdbGenres(db)).updated };
      break;
    case 'gaps':
      result = await fillImdbGaps(db, config, { cap });
      break;
    case 'rt':
      result = await refreshRtScores(db, { cap: cap ?? config.rtRefreshCap ?? RT_REFRESH_CAP_DEFAULT });
      break;
    case 'imdb-ids':
      result = await fillMissingImdbIds(db, config, { cap: cap ?? IMDB_ID_FILL_CAP_DEFAULT });
      break;
  }
  console.log(`${job} complete in ${((Date.now() - started) / 1000).toFixed(1)} s:`, result);
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
