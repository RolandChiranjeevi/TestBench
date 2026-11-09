/**
 * The colour theme. "system" follows the operating system (the CSS does that when `data-theme` is not set); "light" and "dark" set it by hand.
 * The choice is kept in this browser only. Storage can be blocked (private windows), so every access is guarded and the page works without it.
 */
export type Theme = "system" | "light" | "dark";

const KEY = "testbench:theme";

export function getTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(theme: Theme = getTheme()) {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

export function setTheme(theme: Theme) {
  try {
    if (theme === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    /* private mode: the choice lasts until the page is closed */
  }
  applyTheme(theme);
}
