# TasteBuds

A self-hosted movie & TV recommender for a household — built to learn *how you
actually watch*, not what's trending. It blends two people's taste into a shared
**"Joint"** profile (great for couples deciding what to watch together), grounds
every suggestion in real TMDB titles (no hallucinated movies), and only spends an
LLM call when you explicitly ask for fresh picks.

- **Three profiles out of the box:** two solo profiles + a derived **Joint** profile
  (a live blend of the two, with a mutual veto so neither person gets something they hate).
- **Grounded candidates:** titles, posters and metadata come from [TMDB](https://www.themoviedb.org/),
  refreshed by a free daily harvest. The model never invents titles.
- **Local, free retrieval:** embeddings via local [Ollama](https://ollama.com/) stored in
  `sqlite-vec`; finding candidates is pure vector math — no LLM, no cost.
- **LLM only on request:** when you tap **Generate** (or type a request like
  *"mind-bending sci-fi"*), Claude ranks a small pre-filtered set and writes a one-line
  "why" for each. Browsing, rating and watchlisting are all database-only.
- **Learns from feedback:** ratings, free-text notes and "not interested" dismissals all
  steer your taste vector (positive *and* negative signal).
- **Mobile-first web app:** poster feed, one-tap rating, watchlist, watched history.

---

## Hand this to your Claude

Repo: **<https://github.com/jonathanavis96/tastebuds>**

The fastest way to get this running is to let [Claude Code](https://claude.com/claude-code)
drive the whole setup. Clone the repo, open it in Claude Code, and paste the prompt below —
it will use the **Docker** path (recommended), walk you through getting the API keys, and run
the Claude OAuth step itself.

> You are setting up TasteBuds — a self-hosted household movie & TV recommender
> (<https://github.com/jonathanavis96/tastebuds>). Read `README.md` first, then set it up for me
> end to end using the **Docker** path (recommended over bare Node).
>
> Do this in order, and don't skip the explanations:
>
> 1. **Check prerequisites.** Make sure Docker and [Ollama](https://ollama.com/) are installed
>    and running. Pull the embedding model: `ollama pull nomic-embed-text`.
> 2. **Get the TMDB API key (required, free).** Walk me through it: tell me to sign up at
>    <https://www.themoviedb.org/signup>, then go to **Settings → API**
>    (<https://www.themoviedb.org/settings/api>), request a developer key, and copy the
>    **"API Key" (v3 auth)** value. Wait for me to paste it back to you.
> 3. **Get the OMDb API key (optional, free).** Tell me I can grab one at
>    <https://www.omdbapi.com/apikey.aspx> for IMDb/Rotten Tomatoes ratings, or skip it. If I
>    skip it, leave `OMDB_API_KEY` blank.
> 4. **Set up the Claude OAuth token yourself.** I have a Claude Pro/Max subscription. Run
>    `claude setup-token` for me, follow the browser auth flow, capture the printed token, and
>    write it into `CLAUDE_CODE_OAUTH_TOKEN` — don't ask me to copy/paste it manually.
> 5. **Configure.** Copy `.env.example` to `.env` and fill in `TMDB_API_KEY`, the OAuth token,
>    and `OMDB_API_KEY` if I provided one. Leave `OLLAMA_URL` as
>    `http://host.docker.internal:11434` for the Docker path.
> 6. **Build and start:** `docker compose up -d --build`.
> 7. **Seed and verify:** seed the profiles, run a harvest, then confirm
>    `curl http://localhost:8094/api/profiles` responds.
>
> If anything fails along the way, diagnose and fix it before moving on, and tell me what you
> changed.

---

## How it works

```
TMDB harvest ──► titles + posters ──► Ollama embeddings ──► sqlite-vec
                                                                │
   you tap "Generate" / type a request                         ▼
                         ──► vector retrieval (free) ──► small candidate set
                                                                │
                                                                ▼
                                      claude -p ranks + writes "why" ──► your picks
```

Stack: Node/TypeScript · [Hono](https://hono.dev/) API + [Svelte](https://svelte.dev/) SPA ·
a single SQLite file (`sqlite-vec`, WAL) · Ollama embeddings · `claude -p` curation · Docker.

---

## Prerequisites

| Need | Why | Notes |
|------|-----|-------|
| **Docker** (recommended) *or* Node 20+ | Run the app | Docker path installs everything for you |
| **[Ollama](https://ollama.com/)** running, with `nomic-embed-text` pulled | Local embeddings | `ollama pull nomic-embed-text` |
| **TMDB API key** (free) | Real titles + posters | *Required* — see below |
| **Claude Pro/Max subscription** + OAuth token | Recommendation curation | *Required for the "Generate" feature* |
| **OMDb API key** (free) | IMDb/RT ratings on picks | *Optional* |

> Without the Claude token you can still browse, rate, watchlist and import history —
> only the **Generate** button (which calls Claude) is disabled.

---

## Getting the API keys

### 1. TMDB API key (required, free)
1. Create an account at <https://www.themoviedb.org/signup>.
2. Go to **Settings → API** (<https://www.themoviedb.org/settings/api>) and request a
   developer key.
3. Copy the **"API Key" (v3 auth)** value — that's what goes in `TMDB_API_KEY`.

### 2. Claude OAuth token (required for Generate)
You need a **Claude Pro or Max** subscription. The app shells out to the Claude Code CLI,
which authenticates with a long-lived OAuth token:

```bash
# Install the CLI if you don't have it (the Docker image already includes it):
npm install -g @anthropic-ai/claude-code

# Generate a token — opens a browser to authorise, then prints the token:
claude setup-token
```

Copy the printed token into `CLAUDE_CODE_OAUTH_TOKEN` in your `.env`.

### 3. OMDb API key (optional, free)
Get a free key (1000 req/day) at <https://www.omdbapi.com/apikey.aspx> and put it in
`OMDB_API_KEY`. Leave it blank to skip IMDb/RT ratings.

---

## Quick start (Docker — recommended)

```bash
# 1. Configure
cp .env.example .env
nano .env            # fill in TMDB_API_KEY and CLAUDE_CODE_OAUTH_TOKEN
                     # OLLAMA_URL should be http://host.docker.internal:11434 (default)

# 2. Make sure Ollama is running on the host with the embed model:
ollama pull nomic-embed-text

# 3. Build and start
docker compose up -d --build

# 4. Verify
curl http://localhost:8094/api/profiles
```

Then **seed profiles, harvest titles, and import your watch history**:

```bash
# Create the Alex / Sam / Joint profiles
docker compose exec tastebuds node dist/server/seed/seedProfiles.js

# Populate the title pool from TMDB (run anytime; also runs daily on its own)
docker compose exec tastebuds node dist/server/harvest/harvest.js

# (Optional) import your own watch history — see "Seeding your taste" below
cp seed.example.json seed.json     # then edit seed.json with your real history
docker cp seed.json $(docker compose ps -q tastebuds):/app/data/seed.json
docker compose exec tastebuds node dist/server/seed/importWatchHistory.js /app/data/seed.json
```

Open **http://localhost:8094** (or your server's IP/hostname on port 8094).

---

## Quick start (bare Node, no Docker)

```bash
cp .env.example .env
nano .env                         # set OLLAMA_URL=http://localhost:11434 for bare Node
npm install
npm run build

node dist/server/seed/seedProfiles.js
node dist/server/harvest/harvest.js
node dist/server/server.js        # serves on $PORT (default 8094)
```

For development with hot reload: `npm run dev`.

---

## Seeding your taste

Recommendations are only as good as the history you give each profile. Copy the sample and
edit it:

```bash
cp seed.example.json seed.json
```

Each entry:

```json
{ "title": "Severance", "year": 2022, "mediaType": "tv", "rating": 9, "status": "watched", "profile": "alex" }
```

- `mediaType`: `"movie"` or `"tv"`
- `status`: `"watched"`, `"watchlist"` or `"rated"`
- `rating`: 0–10 (mapped to the app's 1–5 stars on import); omit for watchlist items
- `profile`: which profile this belongs to — `alex`, `sam` or `joint` by default
  (`joint` = things you watched *together*)

Titles are matched against TMDB automatically (with a year hint), so you don't need IDs.
`seed.json` is git-ignored so your real history never gets committed.

---

## Customising the profiles

The default seed creates two solo profiles **Alex** and **Sam** plus a derived **Joint**
profile. To rename them (or change default genres), edit
[`src/seed/seedProfiles.ts`](src/seed/seedProfiles.ts) — the `SOLO_A` / `SOLO_B` constants
near the top. The rest of the code resolves the solo profiles by *role* (`is_derived = 0`),
not by name, so renaming there is all that's needed.

Running solo instead of as a couple? Keep one solo profile and delete the Joint one — or
just ignore the profiles you don't use.

---

## Configuration reference (`.env`)

| Var | Required | Default | Purpose |
|-----|----------|---------|---------|
| `TMDB_API_KEY` | ✅ | — | TMDB v3 API key |
| `CLAUDE_CODE_OAUTH_TOKEN` | ✅ (for Generate) | — | `claude setup-token` output |
| `OLLAMA_URL` | — | `http://host.docker.internal:11434` | Ollama endpoint |
| `OMDB_API_KEY` | — | — | IMDb/RT ratings |
| `PORT` | — | `8094` | HTTP port |
| `DB_PATH` | — | `./data/tastebuds.db` | SQLite file (persisted via the `./data` volume) |

---

## Tests

```bash
npm test          # vitest
npx tsc --noEmit  # type-check
```

---

## License

[MIT](LICENSE) © 2026 Jonathan Avis
