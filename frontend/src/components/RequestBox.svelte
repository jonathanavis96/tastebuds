<script lang="ts">
  import { onMount, onDestroy } from 'svelte';

  interface Props {
    onSubmit?: (text: string) => void;
  }

  let { onSubmit = () => {} }: Props = $props();
  let text = $state('');

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
</script>

<div class="request-box">
  <textarea bind:value={text} {placeholder} rows={2}></textarea>
  <button onclick={() => { if (text.trim()) { onSubmit(text.trim()); text = ''; } }}>
    Generate
  </button>
</div>

<style>
  .request-box { display: flex; gap: 0.5rem; padding: 0.75rem 1rem; }
  textarea { flex: 1; border-radius: 8px; border: 1px solid #444; background: #16213e; color: #fff; padding: 0.5rem; font-size: 0.9rem; resize: none; }
  textarea::placeholder { color: #6b6b8a; transition: color 0.3s; }
  button { padding: 0.5rem 1rem; border-radius: 8px; background: #e94560; border: none; color: #fff; cursor: pointer; font-weight: 600; }
</style>
