/**
 * Which keys a page has taken for itself. The shortcuts that switch pages are registered once, in the project layout, and a page registers its own
 * (`s` marks a result as skipped on a run). Both listen on the window, so without this a key that both use would do both things: mark the result and
 * leave the run. A page that has taken a key wins; the layout lets it go (see `useHotkeys` in components/ui.tsx).
 * Kept free of React so that it can be tested without a browser.
 */
const claims = new Map<string, number>();

/** Takes `keys` for as long as the page is shown. Returns the function that gives them back. */
export function claimKeys(keys: string[]): () => void {
  for (const k of keys) claims.set(k, (claims.get(k) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const k of keys) {
      const n = (claims.get(k) ?? 0) - 1;
      if (n > 0) claims.set(k, n);
      else claims.delete(k);
    }
  };
}

/** True while some page has taken `key`. */
export const isClaimed = (key: string) => (claims.get(key) ?? 0) > 0;
