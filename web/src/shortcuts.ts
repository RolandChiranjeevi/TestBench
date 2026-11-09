/**
 * The keyboard shortcuts that switch pages. One list feeds the hotkeys in the project layout, the key shown next to each sidebar item, the
 * browser tab title and the list in Settings, so they cannot drift apart. `to` is the path under /p/:pid/.
 */
export const NAV_SHORTCUTS = [
  // The digits follow the sidebar from the top: 0 to 8 under Workspace, 9 under Reporting. The sidebar in main.tsx lists the pages in this order
  // (test/shortcuts.test.ts checks it), so keep the two in step.
  { key: "0", to: "dashboard", label: "Dashboard" },
  { key: "1", to: "test-plan", label: "Test plan" },
  { key: "2", to: "requirements", label: "Requirements" },
  { key: "3", to: "manual-tests", label: "Agent proposals" },
  { key: "4", to: "cases", label: "Test cases" },
  { key: "5", to: "automated", label: "Automated tests" },
  { key: "6", to: "observations", label: "Observations" },
  { key: "7", to: "bugs", label: "Bug reports" },
  { key: "8", to: "runs", label: "Runs" },
  { key: "9", to: "reports", label: "Sprint reports" },
  // Under Manage, with letters. A page that uses the same letter itself wins (`s` is "Skipped" on a run), see hotkeys.ts.
  { key: "s", to: "settings", label: "Settings" },
  { key: "i", to: "import", label: "Import results" },
] as const;

export const navShortcut = (to: string) => NAV_SHORTCUTS.find((s) => s.to === to)!;

/** The shortcuts of single pages, for the list in Settings. They are registered by `useHotkeys` in each page (Cases, Requirements, Runs, RunDetail); keep the two in step. */
export const PAGE_SHORTCUTS: [string, [string, string][]][] = [
  ["Test cases", [["c", "New case"], ["/", "Search"], ["j / ↓", "Next"], ["k / ↑", "Previous"], ["Enter / o", "Open"], ["x", "Select"], ["r", "Run the selected cases"]]],
  ["Requirements", [["c", "New requirement"], ["/", "Search"]]],
  ["Runs", [["c", "New run"]]],
  ["Run detail", [["j / ↓", "Next result"], ["k / ↑", "Previous result"], ["p", "Passed, then next"], ["f", "Failed"], ["b", "Blocked"], ["s", "Skipped, then next"]]],
];
