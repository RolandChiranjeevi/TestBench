/** The sections of the sidebar, in order. */
export const NAV_GROUPS = [
  { id: "workspace", label: "Workspace" },
  { id: "reporting", label: "Reporting" },
  { id: "manage", label: "Manage" },
] as const;
export type NavGroupId = (typeof NAV_GROUPS)[number]["id"];

/** Which icon a page has in the sidebar (SidebarNav maps the name to the drawing). */
export type NavIcon = "dashboard" | "test-plan" | "requirements" | "proposals" | "cases" | "automated" | "observations" | "bugs" | "runs" | "reports" | "settings" | "import";

/**
 * The pages of a project, in the order of the sidebar. One list feeds the sidebar itself (SidebarNav), the hotkeys in the project layout, the key shown next
 * to each item, the browser tab title and the list in Settings, so they cannot drift apart. `to` is the path under /p/:pid/.
 */
export const NAV_SHORTCUTS = [
  // The digits follow the sidebar from the top: 0 to 8 under Workspace, 9 under Reporting. test/shortcuts.test.ts checks it.
  { key: "0", to: "dashboard", label: "Dashboard", group: "workspace", icon: "dashboard" },
  { key: "1", to: "test-plan", label: "Test plan", group: "workspace", icon: "test-plan" },
  { key: "2", to: "requirements", label: "Requirements", group: "workspace", icon: "requirements" },
  { key: "3", to: "manual-tests", label: "Agent proposals", group: "workspace", icon: "proposals" },
  { key: "4", to: "cases", label: "Test cases", group: "workspace", icon: "cases" },
  { key: "5", to: "automated", label: "Automated tests", group: "workspace", icon: "automated" },
  { key: "6", to: "observations", label: "Observations", group: "workspace", icon: "observations" },
  { key: "7", to: "bugs", label: "Bug reports", group: "workspace", icon: "bugs" },
  { key: "8", to: "runs", label: "Runs", group: "workspace", icon: "runs" },
  { key: "9", to: "reports", label: "Sprint reports", group: "reporting", icon: "reports" },
  // Under Manage, with letters. A page that uses the same letter itself wins (`s` is "Skipped" on a run), see hotkeys.ts.
  { key: "s", to: "settings", label: "Settings", group: "manage", icon: "settings" },
  { key: "i", to: "import", label: "Import results", group: "manage", icon: "import" },
] as const satisfies readonly { key: string; to: string; label: string; group: NavGroupId; icon: NavIcon }[];

export const navShortcut = (to: string) => NAV_SHORTCUTS.find((s) => s.to === to)!;

/** The shortcuts of single pages, for the list in Settings. They are registered by `useHotkeys` in each page (Cases, Requirements, Runs, RunDetail); keep the two in step. */
export const PAGE_SHORTCUTS: [string, [string, string][]][] = [
  ["Test cases", [["c", "New case"], ["/", "Search"], ["j / ↓", "Next"], ["k / ↑", "Previous"], ["Enter / o", "Open"], ["x", "Select"], ["r", "Run the selected cases"]]],
  ["Requirements", [["c", "New requirement"], ["/", "Search"]]],
  ["Runs", [["c", "New run"]]],
  ["Run detail", [["j / ↓", "Next result"], ["k / ↑", "Previous result"], ["p", "Passed, then next"], ["f", "Failed"], ["b", "Blocked"], ["s", "Skipped, then next"]]],
];
