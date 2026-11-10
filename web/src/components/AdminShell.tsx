import type { ReactNode } from "react";
import { Link, NavLink } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { buttonClass } from "./Button";

/**
 * The frame of the pages that belong to a person or to the installation and not to a project (/account, and /admin): the logo, a way back, optional tabs, and the page.
 * It has no project sidebar, so it works for someone who is in no project too.
 */
export function AdminShell({ title, tabs, children }: { title: string; tabs?: readonly { to: string; label: string }[]; children: ReactNode }) {
  return (
    <div className="account-shell">
      <header className="account-head">
        <img src="/apple-touch-icon.png" alt="" width={28} height={28} className="account-logo" />
        <span className="brand-name">Testbench</span>
        <span className="spacer" />
        <Link to="/" className={buttonClass("secondary", "sm")}><ArrowLeft size={13} aria-hidden="true" /> Back to project</Link>
      </header>
      <main className="account-main" id="main" tabIndex={-1}>
        <h1 className="account-title">{title}</h1>
        {tabs && (
          <nav className="tabs" aria-label={`${title} sections`} style={{ flexWrap: "wrap" }}>
            {tabs.map((t) => <NavLink key={t.to} to={t.to} end className={({ isActive }) => `tab${isActive ? " active" : ""}`}>{t.label}</NavLink>)}
          </nav>
        )}
        <div className="account-body">{children}</div>
      </main>
    </div>
  );
}
