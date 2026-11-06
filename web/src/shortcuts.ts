/**
 * The keyboard shortcuts that switch pages. One list feeds the hotkeys in the project layout, the key shown next to each sidebar item, the
 * browser tab title and the list in Settings, so they cannot drift apart. `to` is the path under /p/:pid/.
 */
export const NAV_SHORTCUTS = [
  { key: "1", to: "dashboard", label: "Dashboard" },
  { key: "2", to: "requirements", label: "Requirements" },
  { key: "3", to: "cases", label: "Test cases" },
  { key: "4", to: "runs", label: "Runs" },
  { key: "5", to: "bugs", label: "Bug reports" },
  { key: "6", to: "manual-tests", label: "Agent proposals" },
  { key: "7", to: "automated", label: "Automated tests" },
  { key: "8", to: "import", label: "Import results" },
  { key: "9", to: "reports", label: "Sprint reports" },
  { key: "0", to: "settings", label: "Settings" },
] as const;

export const navShortcut = (to: string) => NAV_SHORTCUTS.find((s) => s.to === to)!;

/** The shortcuts of single pages, for the list in Settings. They are registered by `useHotkeys` in each page (Cases, Requirements, Runs, RunDetail); keep the two in step. */
export const PAGE_SHORTCUTS: [string, [string, string][]][] = [
  ["Test cases", [["c", "New case"], ["/", "Search"], ["j / ↓", "Next"], ["k / ↑", "Previous"], ["Enter / o", "Open"], ["x", "Select"], ["r", "Run the selected cases"]]],
  ["Requirements", [["c", "New requirement"], ["/", "Search"]]],
  ["Runs", [["c", "New run"]]],
  ["Run detail", [["j / ↓", "Next result"], ["k / ↑", "Previous result"], ["p", "Passed, then next"], ["f", "Failed"], ["b", "Blocked"], ["s", "Skipped, then next"]]],
];
