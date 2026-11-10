import type { ReactNode } from "react";

/** A titled box, as used on the settings pages. */
export const Card = ({ icon, title, children }: { icon?: ReactNode; title: string; children: ReactNode }) => (
  <div className="card">
    <div className="card-header" role="heading" aria-level={2}>{icon} {title}</div>
    <div className="card-body col" style={{ gap: 12 }}>{children}</div>
  </div>
);
