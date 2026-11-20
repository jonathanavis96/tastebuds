<script lang="ts">
  import { onMount, onDestroy } from 'svelte';

  interface Props {
    /** Resolve false when the request was not run: the text goes back in the box. */
    onSubmit?: (text: string) => void | boolean | Promise<void | boolean>;
  }

  let { onSubmit = () => {} }: Props = $props();

  // Persist the in-progress (unsent) request across refreshes, so a half-typed prompt
  // isn't lost on reload. Cleared on submit (the box empties anyway).
  const DRAFT_KEY = 'tastebuds:requestDraft';
  function draftGet(): string {
    try { return typeof localStorage !== 'undefined' ? (localStorage.getItem(DRAFT_KEY) ?? '') : ''; } catch { return ''; }
  }
  function draftSet(v: string): void {
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(DRAFT_KEY, v); } catch { /* ignore */ }
  }
  let text = $state(draftGet());
  $effect(() => { draftSet(text); });

  // Rotating, deliberately varied example prompts so the box suggests the range
  // of things you can ask for (not one over-specific example).
  const examples = [
    'something funny and easy to watch',
    'a gripping thriller for tonight',
    'a feel-good film for a rainy day',
    'something mind-bending and clever',
    'a short movie under 90 minutes',
    'a cosy series to binge',
    'something romantic but not cheesy',
    'a true-story drama',
    'a hidden-gem sci-fi',
    'something dark and tense',
  ];
  let idx = $state(0);
  const placeholder = $derived(`e.g. "${examples[idx]}"`);
  let timer: ReturnType<typeof setInterval>;

  onMount(() => {
    idx = Math.floor(Math.random() * examples.length);
    timer = setInterval(() => { idx = (idx + 1) % examples.length; }, 3500);
  });
  onDestroy(() => clearInterval(timer));

  async function submit() {
    const sent = text.trim();
    if (!sent) return;
    text = '';
    // A request that was not run (the household's request cap, a server error) comes
    // back into the box, unless something new has been typed meanwhile.
    if ((await onSubmit(sent)) === false && text === '') text = sent;
  }
</script>

<div class="request-box">
  <textarea bind:value={text} {placeholder} rows={2}></textarea>
  <button onclick={submit}>
    Generate
  </button>
</div>

<style>
  .request-box { display: flex; gap: 0.5rem; padding: 0.75rem 1rem; }
  textarea { flex: 1; border-radius: 8px; border: 1px solid #444; background: #16213e; color: #fff; padding: 0.5rem; font-size: 0.9rem; resize: none; }
  textarea::placeholder { color: #6b6b8a; transition: color 0.3s; }
  button { padding: 0.5rem 1rem; border-radius: 8px; background: #e94560; border: none; color: #fff; cursor: pointer; font-weight: 600; }
</style>
