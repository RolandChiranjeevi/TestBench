import { Fragment } from "react";
import { NavLink } from "react-router-dom";
import { BookOpenCheck, Bot, Bug, ClipboardCheck, ClipboardList, Download, FileBarChart, Gauge, LayoutDashboard, ListChecks, Play, Settings, type LucideIcon } from "lucide-react";
import { NAV_GROUPS, NAV_SHORTCUTS, type NavIcon } from "../shortcuts";

const ICONS: Record<NavIcon, LucideIcon> = {
  dashboard: LayoutDashboard, "test-plan": ClipboardList, requirements: BookOpenCheck, proposals: ClipboardCheck, cases: ListChecks, automated: Bot,
  observations: Gauge, bugs: Bug, runs: Play, reports: FileBarChart, settings: Settings, import: Download,
};

/** A number shown beside a page, and what it counts ("waiting for review", "active"), which is what a screen reader says. */
export type NavCount = { n: number; meaning: string };
export type NavCounts = Partial<Record<string, NavCount>>;

/** One page in the sidebar: icon, name, an optional count and its shortcut key. The current page is marked with `aria-current="page"` by the router. */
export function NavItem({ pid, to, label, shortcut, icon, count }: { pid: number | string; to: string; label: string; shortcut: string; icon: NavIcon; count?: NavCount }) {
  const Icon = ICONS[icon];
  return (
    <NavLink to={`/p/${pid}/${to}`} className={({ isActive }) => `nav-item${isActive ? " active" : ""}`} title={label}>
      <Icon size={15} aria-hidden="true" />
      <span className="nav-label">{label}</span>
      {count && count.n > 0 && <span className="nav-count" aria-label={`${count.n} ${count.meaning}`}>{count.n}</span>}
      <span className="count"><kbd className="kbd">{shortcut}</kbd></span>
    </NavLink>
  );
}

/** The pages of a project in their sections. Built from NAV_SHORTCUTS, so the order, the keys and the sections are the same everywhere. */
export function SidebarNav({ pid, counts }: { pid: number | string; counts: NavCounts }) {
  return (
    <nav className="sidebar-nav" aria-label="Pages">
      {NAV_GROUPS.map((g) => (
        <Fragment key={g.id}>
          <div className="sidebar-section">{g.label}</div>
          {NAV_SHORTCUTS.filter((s) => s.group === g.id).map((s) => (
            <NavItem key={s.to} pid={pid} to={s.to} label={s.label} shortcut={s.key} icon={s.icon} count={counts[s.to]} />
          ))}
        </Fragment>
      ))}
    </nav>
  );
}
