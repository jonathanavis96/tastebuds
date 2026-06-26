<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import RatingBar from './RatingBar.svelte';
  import { kindMeta, parseList, CATEGORY_BLURBS } from '../lib/categories.js';
  import type { RecKind } from '../lib/types.js';

  interface DetailItem {
    title_id: number;
    title?: string | null;
    year?: number | null;
    poster_path?: string | null;
    synopsis?: string | null;
    genres?: string | null;
    cast?: string | null;
    media_type?: 'movie' | 'tv' | null;
    imdb_id?: string | null;
    imdb_rating?: string | null;
    rt_rating?: string | null;
    rt_url?: string | null;
    kind?: RecKind;
    category?: string;
    why_blurb?: string;
    rating?: number | null;
    watched_at?: string | null;
    note?: string | null;
    we_status?: string | null;
  }

  interface Props {
    item: DetailItem;
    onClose: () => void;
    position?: string;
    onPrev?: () => void;
    onNext?: () => void;
    /** Initial state of this title for the current profile. */
    inWatchlist?: boolean;
    watched?: boolean;
    /** Persisters — these should NOT close the modal. */
    onRate?: (rating: number) => void | Promise<void>;
    onWatchlist?: () => void | Promise<void>;
    onRemoveWatchlist?: () => void | Promise<void>;
    onMarkWatched?: () => void | Promise<void>;
    onUnwatch?: () => void | Promise<void>;
    onSaveNote?: (note: string) => void | Promise<void>;
    /** Whether THIS title is currently marked "Not interested" (parent-owned truth). */
    dismissed?: boolean;
    /** Mark / un-mark "Not interested". Both commit immediately in the parent. */
    onDismiss?: (item: DetailItem) => void;
    onUndismiss?: (item: DetailItem) => void;
  }

  let {
    item, onClose, position, onPrev, onNext,
    inWatchlist = false, watched = false,
    onRate, onWatchlist, onRemoveWatchlist, onMarkWatched, onUnwatch, onSaveNote,
    dismissed = false, onDismiss, onUndismiss,
  }: Props = $props();

  const meta = $derived(item.kind ? kindMeta(item) : null);
  const genres = $derived(parseList(item.genres, 4));
  const cast = $derived(parseList(item.cast, 6));
  const categoryBlurb = $derived(item.category ? CATEGORY_BLURBS[item.category] : undefined);
  const imdbUrl = $derived(item.imdb_id ? `https://www.imdb.com/title/${item.imdb_id}/` : null);
  const rtUrl = $derived(item.rt_url ?? null);
  // Build label text in JS so the space between label and number is never
  // collapsed by the template compiler.
  const imdbText = $derived(item.imdb_rating ? `IMDb ${item.imdb_rating}` : 'IMDb');
  const rtText = $derived(item.rt_rating ? `🍅 ${item.rt_rating}` : '🍅 RT');

  // Local, optimistic state so actions update IN PLACE without closing the modal.
  let rating = $state<number | null>(null);
  let inList = $state(false);
  let seen = $state(false);
  let zoomed = $state(false);
  let note = $state('');
  let noteSaved = $state(false);
  // Optimistic local copy of the parent's "Not interested" flag for THIS title, so
  // the button flips instantly on tap; reconciled from the prop on every nav.
  let isDismissed = $state(false);
  // What we last persisted, to avoid re-posting an unchanged note (blur + unmount).
  // $state so the green "saved" border below can react to it.
  let lastSavedNote = $state('');
  // Green border whenever the current text matches what's persisted and isn't empty
  // — a steady "this is saved" signal, not just a transient flash.
  const noteIsSaved = $derived(note.trim() !== '' && note.trim() === lastSavedNote.trim());
  // Reset ONLY when the displayed title changes (carousel navigation). The reset
  // body is untracked so editing local state (typing a note, tapping a star) never
  // re-triggers it — otherwise every keystroke wiped the note + rating and closed
  // the box. Derive watched/on-list state from the item's OWN data first, falling
  // back to the tab the modal was opened from.
  $effect(() => {
    item.title_id; // the only tracked dependency
    untrack(() => {
      // Carousel navigated to a new title. Reset only the VISUAL armed state for
      // this title — the pending dismiss timer keeps running so the title it was
      // armed on still gets dismissed in the background.
      rating = item.rating ?? null;
      seen = watched || item.watched_at != null || item.rating != null;
      inList = inWatchlist || item.we_status === 'watchlist';
      note = item.note ?? '';
      lastSavedNote = note;
      noteSaved = false;
      zoomed = false;
      isDismissed = dismissed; // reconcile the armed state from the parent for this title
    });
  });

  // Main poster comes from our local cache (w342) by title id; the lightbox zoom
  // pulls a larger w780 straight from TMDB (we don't cache that size).
  function cachedPoster(titleId: number): string {
    return `/api/poster/${titleId}`;
  }
  function tmdbPoster(path: string | null | undefined, w = 780): string {
    if (!path) return cachedPoster(item.title_id);
    return `https://image.tmdb.org/t/p/w${w}${path}`;
  }

  function onKeydown(e: KeyboardEvent) {
    // Never hijack keys while the user is typing a note (arrows must move the
    // caret, Enter must insert a newline — not navigate/close the carousel).
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) {
      if (e.key === 'Escape') (t as HTMLElement).blur();
      return;
    }
    if (e.key === 'Escape') { if (zoomed) zoomed = false; else void close(); }
    else if (e.key === 'ArrowLeft') void goPrev();
    else if (e.key === 'ArrowRight') void goNext();
  }

  // Every exit path (close, dismiss-modal, carousel nav) flushes the note FIRST so
  // whatever is typed is always persisted — tapping the backdrop or swiping to the
  // next title never loses an in-progress note.
  async function close() { await saveNote(); onClose(); }
  async function goPrev() { await saveNote(); onPrev?.(); }
  async function goNext() { await saveNote(); onNext?.(); }

  // Navigation gestures. Swipe is detected from pointer events (works anywhere,
  // incl. on the poster); tap-to-navigate uses a real click (far more reliable on
  // mobile than inferring a tap from pointer coords). Both ignore real controls
  // (links, buttons, the note field) so they never fight typing or button taps.
  // The note textarea must NOT be a swipe/tap target — that broke typing before.
  let sheetEl = $state<HTMLElement>();
  let downX = NaN, downY = 0, suppressClick = false;
  const CONTROLS = 'a, button, textarea, input, select';
  function gestureStart(e: PointerEvent) {
    suppressClick = false;
    if ((e.target as HTMLElement).closest(CONTROLS)) { downX = NaN; return; }
    downX = e.clientX; downY = e.clientY;
  }
  function gestureEnd(e: PointerEvent) {
    if (Number.isNaN(downX)) return;
    const dx = e.clientX - downX, dy = e.clientY - downY;
    downX = NaN;
    if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy)) {
      suppressClick = true; // don't let the trailing click also navigate/zoom
      void (dx < 0 ? goNext() : goPrev());
    }
  }
  // Tap on the far-left / far-right of the sheet → navigate (mobile has no arrows).
  function onSheetClick(e: MouseEvent) {
    e.stopPropagation(); // taps inside the sheet never close the modal
    if (suppressClick) { suppressClick = false; return; }
    const t = e.target as HTMLElement;
    if (t.closest(CONTROLS) || t.closest('.poster')) return; // controls + poster (zoom) handle themselves
    if (!sheetEl) return;
    const rect = sheetEl.getBoundingClientRect();
    const rel = (e.clientX - rect.left) / rect.width;
    if (rel <= 0.28) void goPrev();
    else if (rel >= 0.72) void goNext();
  }
  // Keep the note field visible above the on-screen keyboard on mobile.
  function scrollNoteIntoView(e: FocusEvent) {
    const el = e.target as HTMLElement;
    setTimeout(() => el.scrollIntoView({ block: 'center', behavior: 'smooth' }), 300);
  }

  // Actions update local state immediately, then persist (no close).
  // Rating or marking watched implies you've SEEN it, so it leaves the watchlist:
  // the watchlist button unticks (greys) and the watched button greens — in place.
  async function doRate(r: number) { rating = r; seen = true; inList = false; await onRate?.(r); }
  async function toggleWatchlist() {
    if (inList) { inList = false; await onRemoveWatchlist?.(); }
    else { inList = true; await onWatchlist?.(); }
  }
  async function toggleWatched() {
    if (seen) { seen = false; rating = null; await onUnwatch?.(); }
    else { seen = true; inList = false; await onMarkWatched?.(); }
  }
  // Persist the note when it actually changed (fires on blur and on unmount).
  async function saveNote() {
    if (!onSaveNote) return;
    const trimmed = note.trim();
    if (trimmed === lastSavedNote.trim()) return;
    lastSavedNote = trimmed;
    await onSaveNote(trimmed);
    noteSaved = true;
    setTimeout(() => { noteSaved = false; }, 1800);
  }
  // Safety net: if the modal closes before blur fires (mobile), still save.
  onDestroy(() => { void saveNote(); });
  function openZoom() { if (!suppressClick) zoomed = true; }
  // "Not interested" toggle. Commits immediately (parent marks it in place + persists)
  // and flips the button optimistically — so it always reflects reality on the first
  // tap. Tapping again genuinely undoes it (restores to pending). The modal stays open.
  function doDismiss() {
    const target = item;
    if (isDismissed) { isDismissed = false; onUndismiss?.(target); }
    else { isDismissed = true; onDismiss?.(target); }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div
  class="backdrop"
  onclick={() => void close()}
  onkeydown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) void close(); }}
  role="button"
  tabindex="-1"
  aria-label="Close details"
>
  <!-- Desktop: clickable arrows (stopPropagation so they don't close the modal). -->
  {#if onPrev}<button class="nav prev" onclick={(e) => { e.stopPropagation(); void goPrev(); }} aria-label="Previous">‹</button>{/if}
  {#if onNext}<button class="nav next" onclick={(e) => { e.stopPropagation(); void goNext(); }} aria-label="Next">›</button>{/if}

  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="sheet"
    bind:this={sheetEl}
    role="dialog"
    aria-modal="true"
    tabindex="-1"
    onclick={onSheetClick}
    onpointerdown={gestureStart}
    onpointerup={gestureEnd}
  >
    <!-- Mobile: non-interactive swipe hints — a faint arrow (shaft + head), no circle. -->
    {#if onPrev}
      <svg class="swipe-hint left" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M21 12 H4 M10 6 L4 12 L10 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    {/if}
    {#if onNext}
      <svg class="swipe-hint right" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M3 12 H20 M14 6 L20 12 L14 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    {/if}

    <div class="topbar">
      {#if position}<span class="pos">{position}</span>{/if}
      <button class="close" onclick={() => void close()} aria-label="Close">×</button>
    </div>

    <div class="body">
      <button type="button" class="poster-btn" onclick={openZoom} aria-label="Zoom poster">
        <img
          class="poster"
          src={cachedPoster(item.title_id)}
          alt={item.title ?? 'Poster'}
          draggable="false"
        />
      </button>

      <div class="head">
        <h2>{item.title ?? 'Unknown'}</h2>
        <div class="meta-row">
          {#if item.year}<span class="year">{item.year}</span>{/if}
          {#if item.media_type}<span class="pill type">{item.media_type === 'tv' ? 'Series' : 'Movie'}</span>{/if}
        </div>
        {#if genres.length}
          <div class="genres">{#each genres as g}<span class="pill">{g}</span>{/each}</div>
        {/if}
        <div class="scores">
          {#if imdbUrl}
            <a class="score imdb" href={imdbUrl} target="_blank" rel="noopener">{imdbText} ↗</a>
          {:else if item.imdb_rating}
            <span class="score imdb">{imdbText}</span>
          {/if}
          {#if rtUrl}
            <a class="score rt" href={rtUrl} target="_blank" rel="noopener">{rtText} ↗</a>
          {:else if item.rt_rating}
            <span class="score rt">{rtText}</span>
          {/if}
        </div>
      </div>

      <div class="rest">
        {#if meta}
          <div class="kind-banner" style="--kc:{meta.color}">
            <span class="kind-label">{meta.icon} {meta.label}</span>
            <span class="kind-blurb">{meta.blurb}</span>
          </div>
        {/if}
        {#if item.why_blurb}<p class="why">“{item.why_blurb}”</p>{/if}
        {#if categoryBlurb}<p class="cat-blurb"><strong>{item.category}:</strong> {categoryBlurb}</p>{/if}
        {#if item.synopsis}<p class="synopsis">{item.synopsis}</p>{/if}
        {#if cast.length}
          <div class="cast"><span class="cast-label">Cast</span><span class="cast-names">{cast.join(' · ')}</span></div>
        {/if}

        {#if onRate || onWatchlist || onMarkWatched || onDismiss}
          <div class="actions">
            {#if onRate}
              <div class="rate-block">
                <span class="rate-label">{rating ? 'Your rating' : 'Rate it'}</span>
                <RatingBar {rating} onRate={doRate} />
              </div>
            {/if}
            <div class="btn-row">
              {#if onWatchlist || onRemoveWatchlist}
                <button class="act" class:on={inList} onclick={toggleWatchlist}>
                  {inList ? '✓ On watchlist' : '+ Watchlist'}
                </button>
              {/if}
              {#if onMarkWatched || onUnwatch}
                <button class="act" class:on={seen} onclick={toggleWatched} title={seen ? 'Tap to remove from watched' : 'Mark as watched'}>
                  {seen ? '✓ Watched' : '✓ Mark watched'}
                </button>
              {/if}
              {#if onDismiss}
                <button class="act dismiss" class:dismissing={isDismissed} onclick={doDismiss}
                        title={isDismissed ? 'Tap to undo' : 'Not interested'}>
                  {isDismissed ? '✗ Not interested — tap to undo' : 'Not interested'}
                </button>
              {/if}
            </div>

            {#if onSaveNote && (seen || inList)}
              <div class="note-block">
                <label class="note-label" for="taste-note">
                  Your take <span class="note-hint">— helps pick better (pacing, mood, a performance…)</span>
                </label>
                <textarea
                  id="taste-note"
                  class="note-input"
                  class:saved={noteIsSaved}
                  bind:value={note}
                  onblur={saveNote}
                  onfocus={scrollNoteIntoView}
                  rows="2"
                  placeholder="e.g. Loved the slow-burn tension and the score; could do without the gore."
                ></textarea>
                {#if noteSaved}<span class="note-saved">Saved ✓</span>{/if}
              </div>
            {/if}
          </div>
        {/if}
      </div>
    </div>
  </div>

  {#if zoomed}
    <div
      class="lightbox"
      role="button"
      tabindex="0"
      aria-label="Close zoomed poster"
      onclick={(e) => { e.stopPropagation(); zoomed = false; }}
      onkeydown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.stopPropagation(); zoomed = false; } }}
    >
      <img src={tmdbPoster(item.poster_path, 780)} alt={item.title ?? 'Poster'} />
    </div>
  {/if}
</div>

<style>
  .backdrop {
    position: fixed; inset: 0; z-index: 50;
    background: rgba(6, 6, 18, 0.8);
    backdrop-filter: blur(3px);
    display: flex; align-items: center; justify-content: center;
    padding: 0.75rem;
  }
  @media (min-width: 600px) { .backdrop { padding: 1.5rem; } }

  .sheet {
    position: relative;
    width: 100%; max-width: 520px;
    max-height: 90vh; max-height: 90dvh;
    overflow-y: auto;
    background: #14142b;
    border: 1px solid #2a2a4a;
    border-radius: 16px;
    padding: 0.75rem 1.25rem 1.4rem;
    box-shadow: 0 12px 48px rgba(0,0,0,0.6);
    animation: rise 0.2s ease;
    touch-action: pan-y;
  }
  @media (min-width: 600px) { .sheet { max-width: 760px; } }
  @keyframes rise { from { transform: translateY(16px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }

  /* Mobile swipe hints — non-interactive, faded, gently nudging. */
  .swipe-hint {
    position: fixed; top: 50%; z-index: 3; pointer-events: none;
    width: 30px; height: 30px; color: #fff; opacity: 0.2;
    filter: drop-shadow(0 1px 3px rgba(0,0,0,0.5));
  }
  .swipe-hint.left { left: 6px; animation: hintL 2s ease-in-out infinite; }
  .swipe-hint.right { right: 6px; animation: hintR 2s ease-in-out infinite; }
  @keyframes hintR { 0%,100% { opacity: 0.16; transform: translateY(-50%) translateX(0); } 50% { opacity: 0.42; transform: translateY(-50%) translateX(4px); } }
  @keyframes hintL { 0%,100% { opacity: 0.16; transform: translateY(-50%) translateX(0); } 50% { opacity: 0.42; transform: translateY(-50%) translateX(-4px); } }
  @media (min-width: 600px) { .swipe-hint { display: none; } }
  @media (prefers-reduced-motion: reduce) { .swipe-hint { animation: none; } }

  /* Desktop clickable arrows. */
  .nav {
    position: absolute; top: 50%; transform: translateY(-50%); z-index: 2;
    width: 40px; height: 40px; border-radius: 50%;
    background: rgba(20,20,40,0.85); border: 1px solid #3a3a5a;
    color: #fff; font-size: 1.6rem; line-height: 1; cursor: pointer;
    display: none; align-items: center; justify-content: center;
  }
  .nav:hover { background: #e94560; border-color: #e94560; }
  @media (min-width: 600px) { .nav { display: flex; } .nav.prev { left: -52px; } .nav.next { right: -52px; } }

  .topbar { display: flex; align-items: center; justify-content: space-between; height: 28px; }
  .pos { font-size: 0.72rem; color: #8a8ab0; font-weight: 600; letter-spacing: 0.03em; }
  .close { margin-left: auto; width: 30px; height: 30px; border-radius: 50%; background: rgba(255,255,255,0.08); border: none; color: #ccc; font-size: 1.25rem; line-height: 1; cursor: pointer; }
  .close:hover { background: rgba(255,255,255,0.16); color: #fff; }

  .body {
    display: grid;
    grid-template-columns: 132px 1fr;
    grid-template-areas: "poster head" "rest rest";
    gap: 0.85rem 1rem; margin-top: 0.4rem;
  }
  @media (min-width: 600px) {
    .body { grid-template-columns: 240px 1fr; grid-template-areas: "poster head" "poster rest"; gap: 0.5rem 1.4rem; }
  }
  .poster-btn { grid-area: poster; align-self: start; display: block; width: 100%; padding: 0; border: none; background: none; cursor: zoom-in; }
  .poster { display: block; width: 100%; border-radius: 12px; user-select: none; box-shadow: 0 4px 16px rgba(0,0,0,0.45); }
  .head { grid-area: head; min-width: 0; }
  .rest { grid-area: rest; min-width: 0; }

  h2 { font-size: 1.2rem; color: #fff; line-height: 1.2; margin-bottom: 0.4rem; }
  .meta-row { display: flex; gap: 0.4rem; align-items: center; flex-wrap: wrap; }
  .year { color: #9aa; font-size: 0.85rem; }
  .genres { display: flex; flex-wrap: wrap; gap: 0.3rem; margin-top: 0.5rem; }
  .pill { font-size: 0.68rem; background: #21213f; color: #b9b9d6; padding: 2px 7px; border-radius: 20px; }
  .pill.type { background: #0f3460; color: #8ec5ff; }
  .scores { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.7rem; }
  .score { font-size: 0.76rem; font-weight: 700; text-decoration: none; padding: 3px 9px; border-radius: 7px; border: 1px solid currentColor; cursor: pointer; }
  a.score:hover { background: rgba(255,255,255,0.08); }
  span.score { cursor: default; opacity: 0.85; }
  .score.imdb { color: #f5c518; }
  .score.rt { color: #fa6e51; }

  .kind-banner { padding: 0.6rem 0.75rem; border-left: 3px solid var(--kc); background: color-mix(in srgb, var(--kc) 12%, transparent); border-radius: 0 8px 8px 0; }
  .kind-label { display: block; font-weight: 700; font-size: 0.82rem; color: var(--kc); }
  .kind-blurb { display: block; font-size: 0.78rem; color: #c5c5dd; margin-top: 2px; line-height: 1.35; }

  .why { margin-top: 0.85rem; font-style: italic; color: #d6d6ea; font-size: 0.88rem; line-height: 1.4; }
  .cat-blurb { margin-top: 0.5rem; font-size: 0.78rem; color: #9a9ab8; }
  .cat-blurb strong { color: #c9c9e6; }
  .synopsis { margin-top: 0.85rem; font-size: 0.85rem; color: #b9b9d0; line-height: 1.5; display: -webkit-box; -webkit-line-clamp: 6; line-clamp: 6; -webkit-box-orient: vertical; overflow: hidden; }
  .cast { margin-top: 0.85rem; font-size: 0.8rem; }
  .cast-label { color: #777; text-transform: uppercase; letter-spacing: 0.05em; font-size: 0.68rem; display: block; margin-bottom: 2px; }
  .cast-names { color: #bbb; }

  .actions { margin-top: 1.1rem; border-top: 1px solid #2a2a4a; padding-top: 0.9rem; }
  .rate-block { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.85rem; }
  /* Fixed width so swapping "Rate it" → "Your rating" never shifts the stars. */
  .rate-label { font-size: 0.82rem; color: #aaa; min-width: 5.25rem; flex-shrink: 0; }
  .btn-row { display: flex; flex-wrap: wrap; gap: 0.5rem; }
  .act { flex: 1; min-width: 110px; padding: 0.6rem; border-radius: 9px; border: 1px solid #3a3a5a; background: #1c1c38; color: #ddd; cursor: pointer; font-size: 0.85rem; font-weight: 600; transition: all 0.15s; }
  .act:hover { border-color: #5a5a7a; }
  .act.on { background: #16352a; border-color: #4ade80; color: #6ee7a0; }
  .act.dismiss { color: #e9728a; border-color: #5a3a44; }
  .act.dismiss:hover { background: #2a1620; border-color: #e94560; color: #e94560; }
  /* Armed: solid red during the grace window — still tappable to undo. */
  .act.dismiss.dismissing, .act.dismiss.dismissing:hover { background: #e94560; border-color: #e94560; color: #fff; cursor: pointer; opacity: 1; }

  /* scroll-margin keeps the field clear of the sheet edge when scrolled into view
     above the mobile keyboard; padding-bottom gives the last element breathing room. */
  .note-block { margin-top: 0.85rem; position: relative; scroll-margin-block: 1.5rem; padding-bottom: 1.4rem; }
  .note-label { display: block; font-size: 0.78rem; color: #b9b9d0; margin-bottom: 0.35rem; }
  .note-hint { color: #7a7a98; font-weight: 400; }
  .note-input {
    width: 100%; resize: vertical; min-height: 2.4rem;
    background: #1c1c38; border: 1px solid #3a3a5a; border-radius: 9px;
    color: #e6e6f2; font: inherit; font-size: 0.84rem; line-height: 1.4;
    padding: 0.5rem 0.6rem;
  }
  .note-input:focus { outline: none; border-color: #e94560; }
  /* Green ring whenever the typed note is what's persisted — focus keeps the green
     too (saved state wins over the focus accent so the confirmation stays visible). */
  .note-input.saved, .note-input.saved:focus { border-color: #4ade80; box-shadow: 0 0 0 1px #4ade80; }
  .note-input::placeholder { color: #6a6a88; }
  .note-saved { position: absolute; right: 4px; bottom: -1.1rem; font-size: 0.7rem; color: #6ee7a0; }

  .lightbox { position: fixed; inset: 0; z-index: 60; background: rgba(0,0,0,0.9); display: flex; align-items: center; justify-content: center; padding: 1rem; cursor: zoom-out; }
  .lightbox img { max-width: 100%; max-height: 100%; border-radius: 10px; box-shadow: 0 10px 50px rgba(0,0,0,0.7); }
</style>
