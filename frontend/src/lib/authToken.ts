// TasteBuds is a single-shared-secret app (no multi-user login) — the server
// requires `Authorization: Bearer <TASTEBUDS_TOKEN>` on every /api/* request.
// This module is the client-side half: capture the token once (via a
// bookmarked `?token=` URL), persist it in localStorage, and attach it to
// every request api.ts makes.

const STORAGE_KEY = 'tastebuds:token';

function lsGet(key: string): string | null {
  try { return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null; } catch { return null; }
}
function lsSet(key: string, value: string): void {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(key, value); } catch { /* ignore */ }
}
function lsRemove(key: string): void {
  try { if (typeof localStorage !== 'undefined') localStorage.removeItem(key); } catch { /* ignore */ }
}

/**
 * Pull a `?token=` query param off the URL (if present), persist it, and strip
 * it from the address bar so it doesn't linger in browser history/bookmarks.
 * Safe to call multiple times; a no-op when there's no `token` param.
 */
function captureUrlToken(): void {
  if (typeof window === 'undefined') return;
  try {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    if (!token) return;
    lsSet(STORAGE_KEY, token);
    params.delete('token');
    const rest = params.toString();
    const cleanUrl = window.location.pathname + (rest ? `?${rest}` : '') + window.location.hash;
    window.history.replaceState({}, '', cleanUrl);
  } catch {
    // non-fatal — worst case the token stays in the URL for this load
  }
}

// Run once at module load (before any API call fires).
captureUrlToken();

export function getToken(): string | null {
  return lsGet(STORAGE_KEY);
}

export function setToken(token: string): void {
  lsSet(STORAGE_KEY, token);
}

export function clearToken(): void {
  lsRemove(STORAGE_KEY);
}

export function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Ask for the access token via a native prompt. Crude but sufficient for a
 * single-shared-secret, single-household app — avoids building a whole login
 * screen for what is really just "paste the value from your .env once".
 */
export function promptForToken(): string | null {
  if (typeof window === 'undefined') return null;
  const token = window.prompt('TasteBuds access token (set as TASTEBUDS_TOKEN on the server):');
  const trimmed = token?.trim();
  if (trimmed) {
    setToken(trimmed);
    return trimmed;
  }
  return null;
}
