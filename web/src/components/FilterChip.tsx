import type { ReactNode } from "react";
import { Check } from "lucide-react";

/** A toggle in a row of filters. The selected one has a check as well as the tint, so the state is not colour alone. `count` is the number shown after the label. */
export function FilterChip({ pressed, count, onClick, children }: { pressed: boolean; count?: number | null; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className={`chip${pressed ? " on" : ""}`} aria-pressed={pressed} onClick={onClick}>
      {pressed && <Check size={12} aria-hidden="true" className="chip-check" />}
      {children}
      {count != null && <span className="chip-n">{count}</span>}
    </button>
  );
}
