<script lang="ts">
  import { onMount } from 'svelte';
  import ProfileSwitcher from './components/ProfileSwitcher.svelte';
  import PosterFeed from './components/PosterFeed.svelte';
  import RequestBox from './components/RequestBox.svelte';
  import WatchlistView from './components/WatchlistView.svelte';
  import WatchedHistory from './components/WatchedHistory.svelte';
  import DetailModal from './components/DetailModal.svelte';
  import CategoryLegend from './components/CategoryLegend.svelte';
  import type { Profile, Recommendation, WatchEvent, MediaFilter } from './lib/types.js';
  import {
    getProfiles, getRecommendations, generateRecommendations,
    rateTitle, addToWatchlist, markWatched, dismissRecommendation, undismissRecommendation,
    removeWatch, getWatched, getWatchlist, saveNote, getStats, type CatalogueStats,
  } from './lib/api.js';

  // Persist the user's place (profile + tab) across refreshes via localStorage, so
  // reloading on e.g. "second profile · Watched" stays there instead of resetting to
  // the first profile's Picks. Reads are guarded for non-browser/test contexts.
  const LS = {
    profile: 'tastebuds:profileId', tab: 'tastebuds:tab', filter: 'tastebuds:mediaFilter',
    listFilter: 'tastebuds:listFilter', wlSort: 'tastebuds:wlSort', wdSort: 'tastebuds:wdSort',
  };
  function lsGet(key: string): string | null {
    try { return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null; } catch { return null; }
  }
  function lsSet(key: string, value: string): void {
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(key, value); } catch { /* ignore */ }
  }
  // Captured at script init, BEFORE the persist effect can run, so the saved profile
  // isn't clobbered by the initial null while onMount fetches the profile list.
  const savedProfileId = (() => { const v = lsGet(LS.profile); return v != null ? Number(v) : null; })();
  const savedTab = lsGet(LS.tab);
  const savedFilter = lsGet(LS.filter);
  const savedListFilter = lsGet(LS.listFilter);
  const savedWlSort = lsGet(LS.wlSort);
  const savedWdSort = lsGet(LS.wdSort);

  type WatchlistSort = 'added_desc' | 'added_asc' | 'title' | 'year_desc';
  type WatchedSort = 'watched_desc' | 'watched_asc' | 'rating_desc' | 'title' | 'year_desc';
  const WL_SORTS: WatchlistSort[] = ['added_desc', 'added_asc', 'title', 'year_desc'];
  const WD_SORTS: WatchedSort[] = ['watched_desc', 'watched_asc', 'rating_desc', 'title', 'year_desc'];

  let stats = $state<CatalogueStats | null>(null);
  let profiles = $state<Profile[]>([]);
  let activeProfileId = $state<number | null>(null);
  let recommendations = $state<Recommendation[]>([]);
  // Rec ids the user marked "Not interested" THIS session. They stay visible in the
  // feed (marked, dimmed) instead of vanishing — so the grid never jumps — and clear
  // on the next Generate/Surprise/profile-switch (when a fresh pending list loads).
  let dismissedRecIds = $state<number[]>([]);
  let watchlist = $state<WatchEvent[]>([]);
  let watched = $state<WatchEvent[]>([]);
  let tab = $state<'recs' | 'watchlist' | 'history'>(
    savedTab === 'watchlist' || savedTab === 'history' || savedTab === 'recs' ? savedTab : 'recs',
  );
  let mediaFilter = $state<MediaFilter>(
    savedFilter === 'movie' || savedFilter === 'tv' || savedFilter === 'all' ? savedFilter : 'all',
  );
  // Watchlist/Watched tabs have their own media filter + sort (separate from the Picks
  // filter, which also biases generation).
  let listMediaFilter = $state<MediaFilter>(
    savedListFilter === 'movie' || savedListFilter === 'tv' || savedListFilter === 'all' ? savedListFilter : 'all',
  );
  let watchlistSort = $state<WatchlistSort>(
    WL_SORTS.includes(savedWlSort as WatchlistSort) ? (savedWlSort as WatchlistSort) : 'added_desc',
  );
  let watchedSort = $state<WatchedSort>(
    WD_SORTS.includes(savedWdSort as WatchedSort) ? (savedWdSort as WatchedSort) : 'watched_desc',
  );

  // Persist place whenever it changes. These effects only READ state + WRITE to
  // localStorage (never write component state), so they don't self-trigger. The
  // profile guard (!= null) keeps the saved value intact until onMount restores it.
  $effect(() => { if (activeProfileId != null) lsSet(LS.profile, String(activeProfileId)); });
  $effect(() => { lsSet(LS.tab, tab); });
  $effect(() => { lsSet(LS.filter, mediaFilter); });
  $effect(() => { lsSet(LS.listFilter, listMediaFilter); });
  $effect(() => { lsSet(LS.wlSort, watchlistSort); });
  $effect(() => { lsSet(LS.wdSort, watchedSort); });
  let loading = $state(false);
  let generating = $state(false);
  let error = $state('');

  // Detail modal — a carousel over the current list (Picks / Watchlist / Watched).
  let modalList = $state<(Recommendation | WatchEvent)[]>([]);
  let modalIndex = $state(0);
  let modalContext = $state<'recs' | 'watchlist' | 'history'>('recs');
  const modalItem = $derived(modalList[modalIndex] ?? null);
  const modalPosition = $derived(modalList.length > 1 ? `${modalIndex + 1} / ${modalList.length}` : undefined);

  function openModal(list: (Recommendation | WatchEvent)[], index: number, ctx: 'recs' | 'watchlist' | 'history') {
    modalList = list;
    modalIndex = Math.max(0, index);
    modalContext = ctx;
  }
  function closeModal() { flushRefresh(); modalList = []; modalIndex = 0; }
  function navModal(step: number) {
    if (modalList.length === 0) return;
    modalIndex = (modalIndex + step + modalList.length) % modalList.length;
  }

  // The media filter also narrows what's already on screen (not just biasing the
  // next generate). media_type comes through on each enriched rec.
  const visibleRecs = $derived(
    mediaFilter === 'all'
      ? recommendations
      : recommendations.filter(r => r.media_type === mediaFilter),
  );

  // Watchlist / Watched: filter by media type then sort. New arrays (slice) so we never
  // mutate the source lists in place.
  function byMedia(items: WatchEvent[], f: MediaFilter): WatchEvent[] {
    return f === 'all' ? items : items.filter(i => i.media_type === f);
  }
  const cmpStr = (a?: string | null, b?: string | null) => (a ?? '').localeCompare(b ?? '');
  const visibleWatchlist = $derived.by(() => {
    const list = byMedia(watchlist, listMediaFilter).slice();
    switch (watchlistSort) {
      case 'added_asc': return list.sort((a, b) => cmpStr(a.created_at, b.created_at));
      case 'title': return list.sort((a, b) => cmpStr(a.title, b.title));
      case 'year_desc': return list.sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
      default: return list.sort((a, b) => cmpStr(b.created_at, a.created_at)); // added_desc
    }
  });
  const visibleWatched = $derived.by(() => {
    const list = byMedia(watched, listMediaFilter).slice();
    switch (watchedSort) {
      case 'watched_asc': return list.sort((a, b) => cmpStr(a.watched_at, b.watched_at));
      case 'rating_desc': return list.sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1));
      case 'title': return list.sort((a, b) => cmpStr(a.title, b.title));
      case 'year_desc': return list.sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
      default: return list.sort((a, b) => cmpStr(b.watched_at, a.watched_at)); // watched_desc
    }
  });

  // Open the modal from a list, locating the clicked item by id.
  function openRec(rec: Recommendation) {
    openModal(visibleRecs, visibleRecs.findIndex(r => r.id === rec.id), 'recs');
  }
  function openWatchlistItem(item: WatchEvent) {
    openModal(visibleWatchlist, visibleWatchlist.findIndex(w => w.id === item.id), 'watchlist');
  }
  function openWatchedItem(item: WatchEvent) {
    openModal(visibleWatched, visibleWatched.findIndex(w => w.id === item.id), 'history');
  }

  // Initial toggle state for the open item, by which tab it came from.
  const modalInWatchlist = $derived(modalContext === 'watchlist');
  const modalWatched = $derived(modalContext === 'history');

  // Modal actions persist immediately, but the background lists refresh on a
  // DEBOUNCE (and silently — no skeleton swap). This stops the feed behind the
  // modal from reordering/flickering on every star-tap and stops items appearing
  // to "remove themselves" mid-interaction. The modal reads its own snapshot, so
  // it stays open and updates in place; the lists reconcile once you settle/close.
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { refreshTimer = null; loadRecs(true); }, 1100);
  }
  function flushRefresh() {
    if (!refreshTimer) return;
    clearTimeout(refreshTimer);
    refreshTimer = null;
    loadRecs(true);
  }

  async function modalRate(r: number) {
    if (!activeProfileId || !modalItem) return;
    await rateTitle(activeProfileId, modalItem.title_id, r);
    scheduleRefresh();
  }
  async function modalWatchlist() {
    if (!activeProfileId || !modalItem) return;
    await addToWatchlist(activeProfileId, modalItem.title_id);
    scheduleRefresh();
  }
  async function modalRemoveWatchlist() {
    if (!activeProfileId || !modalItem) return;
    await removeWatch(activeProfileId, modalItem.title_id);
    scheduleRefresh();
  }
  async function modalMarkWatched() {
    if (!activeProfileId || !modalItem) return;
    await markWatched(activeProfileId, modalItem.title_id);
    scheduleRefresh();
  }
  async function modalUnwatch() {
    if (!activeProfileId || !modalItem) return;
    await removeWatch(activeProfileId, modalItem.title_id);
    scheduleRefresh();
  }
  async function modalSaveNote(note: string) {
    if (!activeProfileId || !modalItem) return;
    await saveNote(activeProfileId, modalItem.title_id, note);
    // Keep the open snapshot in sync so reopening shows the saved note.
    (modalItem as { note?: string | null }).note = note;
    scheduleRefresh();
  }
  // Whether the title currently shown in the modal is marked "Not interested".
  const modalItemDismissed = $derived(
    modalItem != null && dismissedRecIds.includes((modalItem as Recommendation).id),
  );

  // Mark a rec "Not interested": commit immediately and mark it IN PLACE (kept in the
  // feed, dimmed, with a "Not interested" badge) rather than removing it — so the grid
  // doesn't jump and it's clear it's headed for the dismissed fold. No background
  // refresh (that would drop it and cause the jump). Idempotent.
  async function modalDismiss(item: Recommendation | WatchEvent) {
    if (!activeProfileId) return;
    const recId = (item as Recommendation).id;
    if (recId == null || dismissedRecIds.includes(recId)) return;
    dismissedRecIds = [...dismissedRecIds, recId];
    await dismissRecommendation(activeProfileId, recId);
  }

  // Undo "Not interested": restore the rec to pending on the server and un-mark it.
  async function modalUndismiss(item: Recommendation | WatchEvent) {
    if (!activeProfileId) return;
    const recId = (item as Recommendation).id;
    if (recId == null || !dismissedRecIds.includes(recId)) return;
    dismissedRecIds = dismissedRecIds.filter(id => id !== recId);
    await undismissRecommendation(activeProfileId, recId);
  }

  onMount(async () => {
    try {
      getStats().then(s => stats = s).catch(() => {});
      profiles = await getProfiles();
      if (profiles.length > 0) {
        // Restore the last-used profile if it still exists, else fall back to the first.
        activeProfileId = profiles.some(p => p.id === savedProfileId) ? savedProfileId! : profiles[0].id;
        await loadRecs();
      }
    } catch (e) {
      error = String(e);
    }
  });

  // silent = background reconcile (no skeleton flash) used by debounced modal refreshes.
  async function loadRecs(silent = false) {
    if (!activeProfileId) return;
    if (!silent) loading = true;
    try {
      [recommendations, watchlist, watched] = await Promise.all([
        getRecommendations(activeProfileId),
        getWatchlist(activeProfileId),
        getWatched(activeProfileId),
      ]);
    } catch (e) {
      error = String(e);
    } finally {
      if (!silent) loading = false;
    }
  }

  async function switchProfile(id: number) {
    activeProfileId = id;
    closeModal();
    // Clear stale data so a slow fetch never shows the previous profile's lists.
    recommendations = [];
    dismissedRecIds = [];
    watchlist = [];
    watched = [];
    await loadRecs();
  }

  async function handleGenerate(request?: string) {
    if (!activeProfileId) return;
    generating = true;
    error = '';
    try {
      const opts: Parameters<typeof generateRecommendations>[0] = { profileId: activeProfileId };
      if (mediaFilter === 'movie') opts.mediaType = 'movie';
      if (mediaFilter === 'tv') opts.mediaType = 'tv';
      if (request) opts.request = request;
      recommendations = await generateRecommendations(opts);
      dismissedRecIds = [];
    } catch (e) {
      error = String(e);
    } finally {
      generating = false;
    }
  }

  // Surprise Me: 5 top picks only (no wildcard/adversarial), APPENDED to the list
  // (newest first), never replacing it.
  async function handleSurpriseMe() {
    if (!activeProfileId) return;
    generating = true;
    error = '';
    try {
      const opts: Parameters<typeof generateRecommendations>[0] = { profileId: activeProfileId, surprise: true };
      if (mediaFilter === 'movie') opts.mediaType = 'movie';
      if (mediaFilter === 'tv') opts.mediaType = 'tv';
      recommendations = await generateRecommendations(opts);
      dismissedRecIds = [];
    } catch (e) {
      error = String(e);
    } finally {
      generating = false;
    }
  }

  // Quick "Mark Watched" from the watchlist list (no modal).
  async function handleMarkWatched(titleId: number) {
    if (!activeProfileId) return;
    await markWatched(activeProfileId, titleId);
    await loadRecs();
  }

  const filters: { value: MediaFilter; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'movie', label: 'Movies' },
    { value: 'tv', label: 'Series' },
  ];
</script>

<div class="app">
  <header>
    <div class="header-top">
      <div class="brand">
        <svg class="mark" viewBox="0 0 32 32" aria-hidden="true">
          <path d="M9.5 11 Q16 8.5 22.5 11 Q23.5 22 16 27 Q8.5 22 9.5 11Z" fill="#e94560" />
          <path d="M16 12 Q16 19 16 23" stroke="#0c0c14" stroke-width="1.7" fill="none" stroke-linecap="round" />
        </svg>
        <h1>Taste<span class="accent">Buds</span></h1>
      </div>
      {#if stats}
        <div class="catalogue" title="Titles available in the library on the home server">
          <span class="cat-total">{stats.total.toLocaleString()}</span>
          <span class="cat-split">{stats.movie.toLocaleString()} films · {stats.tv.toLocaleString()} series</span>
        </div>
      {/if}
    </div>
    <p class="tag">Picked for how you actually watch</p>
  </header>

  <ProfileSwitcher {profiles} {activeProfileId} onSelect={switchProfile} />

  <nav class="tab-bar">
    <button class:active={tab === 'recs'} onclick={() => tab = 'recs'}>Picks</button>
    <button class:active={tab === 'watchlist'} onclick={() => tab = 'watchlist'}>Watchlist</button>
    <button class:active={tab === 'history'} onclick={() => tab = 'history'}>Watched</button>
  </nav>

  {#if tab === 'recs'}
    <div class="filter-bar">
      {#each filters as f}
        <button class:active={mediaFilter === f.value} onclick={() => mediaFilter = f.value}>{f.label}</button>
      {/each}
    </div>

    <RequestBox onSubmit={handleGenerate} />

    <div class="action-bar">
      <button class="generate-btn" onclick={() => handleGenerate()} disabled={generating}>
        {generating ? 'Curating…' : 'Generate More'}
      </button>
      <button class="surprise-btn" onclick={handleSurpriseMe} disabled={generating}>
        Surprise Me
      </button>
    </div>

    <CategoryLegend />

    {#if error}<p class="error">{error}</p>{/if}

    {#if generating}
      <div class="gen-status">
        <span class="spinner"></span>
        <div>
          <strong>Sonnet is curating your picks…</strong>
          <span class="sub">Reading your taste + scoring candidates. Usually 30–45s.</span>
        </div>
      </div>
    {/if}

    {#if loading && !generating}
      <div class="poster-skeleton">
        {#each Array(6) as _}<div class="skel"></div>{/each}
      </div>
    {:else}
      <PosterFeed recommendations={visibleRecs} dismissedIds={dismissedRecIds} onOpen={openRec} />
    {/if}
  {:else if tab === 'watchlist'}
    {#if loading}
      <p class="loading">Loading…</p>
    {:else}
      <div class="list-controls">
        <div class="filter-bar">
          {#each filters as f}
            <button class:active={listMediaFilter === f.value} onclick={() => listMediaFilter = f.value}>{f.label}</button>
          {/each}
        </div>
        <select class="sort-select" bind:value={watchlistSort} aria-label="Sort watchlist">
          <option value="added_desc">Recently added</option>
          <option value="added_asc">Oldest added</option>
          <option value="title">Title A–Z</option>
          <option value="year_desc">Year (newest)</option>
        </select>
      </div>
      <WatchlistView items={visibleWatchlist} onOpen={openWatchlistItem} onMarkWatched={handleMarkWatched} />
    {/if}
  {:else}
    {#if loading}
      <p class="loading">Loading…</p>
    {:else}
      <div class="list-controls">
        <div class="filter-bar">
          {#each filters as f}
            <button class:active={listMediaFilter === f.value} onclick={() => listMediaFilter = f.value}>{f.label}</button>
          {/each}
        </div>
        <select class="sort-select" bind:value={watchedSort} aria-label="Sort watched history">
          <option value="watched_desc">Recently watched</option>
          <option value="watched_asc">Oldest watched</option>
          <option value="rating_desc">Highest rated</option>
          <option value="title">Title A–Z</option>
          <option value="year_desc">Year (newest)</option>
        </select>
      </div>
      <WatchedHistory items={visibleWatched} onOpen={openWatchedItem} />
    {/if}
  {/if}
</div>

{#if modalItem}
  <DetailModal
    item={modalItem}
    position={modalPosition}
    inWatchlist={modalInWatchlist}
    watched={modalWatched}
    onClose={closeModal}
    onPrev={modalList.length > 1 ? () => navModal(-1) : undefined}
    onNext={modalList.length > 1 ? () => navModal(1) : undefined}
    onRate={modalRate}
    onWatchlist={modalWatchlist}
    onRemoveWatchlist={modalRemoveWatchlist}
    onMarkWatched={modalMarkWatched}
    onUnwatch={modalUnwatch}
    onSaveNote={modalSaveNote}
    dismissed={modalItemDismissed}
    onDismiss={modalContext === 'recs' ? modalDismiss : undefined}
    onUndismiss={modalContext === 'recs' ? modalUndismiss : undefined}
  />
{/if}

<style>
  :global(*, *::before, *::after) { box-sizing: border-box; margin: 0; padding: 0; }
  :global(body) { background: #0f0f23; color: #eee; font-family: system-ui, sans-serif; min-height: 100vh; }
  .app { min-height: 100vh; max-width: 1040px; margin: 0 auto; border-left: 1px solid #1c1c33; border-right: 1px solid #1c1c33; }
  header {
    padding: 0.95rem 1rem 0.85rem;
    background: linear-gradient(180deg, #1d1d36 0%, #1a1a2e 100%);
    border-bottom: 1px solid #2a2a4a;
    position: relative;
  }
  header::after {
    content: ''; position: absolute; left: 0; right: 0; bottom: -1px; height: 2px;
    background: #e94560;
  }
  .header-top { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
  .brand { display: flex; align-items: center; gap: 0.5rem; }
  .catalogue { display: flex; flex-direction: column; align-items: flex-end; line-height: 1.1; flex-shrink: 0; cursor: default; }
  .cat-total { font-size: 1.05rem; font-weight: 800; color: #fff; letter-spacing: -0.01em; }
  .cat-split { font-size: 0.66rem; color: #8a8ab0; margin-top: 2px; white-space: nowrap; }
  .mark { width: 30px; height: 30px; flex-shrink: 0; margin-top: -2px; }
  h1 { font-size: 1.4rem; color: #fff; font-weight: 800; letter-spacing: -0.01em; }
  h1 .accent { color: #e94560; }
  .tag { margin-top: 2px; font-size: 0.74rem; color: #8a8ab0; letter-spacing: 0.01em; }
  .tab-bar { display: flex; gap: 4px; padding: 0.5rem 0.75rem; background: #1a1a2e; border-bottom: 1px solid #23233f; }
  .tab-bar button { flex: 1; padding: 0.5rem 0.4rem; background: transparent; border: none; border-radius: 10px; color: #9a9ab8; cursor: pointer; font-size: 0.85rem; font-weight: 600; transition: all 0.15s; }
  .tab-bar button:hover { color: #fff; background: rgba(255,255,255,0.04); }
  .tab-bar button.active { color: #fff; background: linear-gradient(180deg, #e94560 0%, #d13a54 100%); box-shadow: 0 3px 12px rgba(233,69,96,0.32); }
  .filter-bar { display: flex; gap: 0.5rem; padding: 0.75rem 1rem; overflow-x: auto; }
  .filter-bar button { padding: 0.35rem 0.75rem; border-radius: 20px; border: 1px solid #444; background: transparent; color: #ccc; cursor: pointer; font-size: 0.8rem; white-space: nowrap; transition: all 0.15s; }
  .filter-bar button.active { background: #e94560; border-color: #e94560; color: #fff; }
  .list-controls { display: flex; align-items: center; gap: 0.5rem; padding: 0.75rem 1rem 0; flex-wrap: wrap; }
  .list-controls .filter-bar { padding: 0; flex: 1; min-width: 0; }
  .sort-select { padding: 0.35rem 0.6rem; border-radius: 20px; border: 1px solid #444; background: #16213e; color: #ccc; font-size: 0.8rem; cursor: pointer; }
  .sort-select:focus { outline: none; border-color: #e94560; }
  .action-bar { display: flex; gap: 0.75rem; padding: 0 1rem 0.75rem; }
  .generate-btn { flex: 1; padding: 0.6rem; background: #e94560; border: none; border-radius: 8px; color: #fff; font-weight: 600; cursor: pointer; transition: opacity 0.15s; }
  .generate-btn:disabled { opacity: 0.6; cursor: default; }
  .surprise-btn { padding: 0.6rem 1rem; background: #0f3460; border: none; border-radius: 8px; color: #fff; cursor: pointer; font-weight: 500; transition: opacity 0.15s; }
  .surprise-btn:disabled { opacity: 0.6; cursor: default; }
  .error { color: #e94560; padding: 1rem; text-align: center; font-size: 0.9rem; }
  .loading { color: #888; padding: 1rem; text-align: center; font-size: 0.9rem; }

  .gen-status { display: flex; align-items: center; gap: 0.85rem; margin: 0.25rem 1rem 0; padding: 0.85rem 1rem; background: #14142b; border: 1px solid #2a2a4a; border-radius: 10px; }
  .gen-status strong { display: block; font-size: 0.88rem; color: #fff; }
  .gen-status .sub { display: block; font-size: 0.76rem; color: #9a9ab8; margin-top: 2px; }
  .spinner { width: 20px; height: 20px; flex-shrink: 0; border: 2px solid #33335a; border-top-color: #e94560; border-radius: 50%; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  .poster-skeleton { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; padding: 1rem; }
  @media (min-width: 640px) { .poster-skeleton { grid-template-columns: repeat(3, 1fr); } }
  @media (min-width: 900px) { .poster-skeleton { grid-template-columns: repeat(4, 1fr); } }
  .skel { aspect-ratio: 2/3; border-radius: 12px; background: linear-gradient(100deg, #16213e 30%, #1d2a4e 50%, #16213e 70%); background-size: 200% 100%; animation: shimmer 1.3s ease-in-out infinite; }
  @keyframes shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
</style>
