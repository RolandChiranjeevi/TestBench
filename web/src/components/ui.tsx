import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, CheckCircle2, X } from "lucide-react";
import type { Counts, Priority, Status } from "../api";
import { claimKeys, isClaimed } from "../hotkeys";

// ---------- Status icon (Linear-style circles) ----------

export const STATUS_LABEL: Record<Status, string> = {
  untested: "Untested",
  passed: "Passed",
  failed: "Failed",
  blocked: "Blocked",
  skipped: "Skipped",
};

export function StatusIcon({ status, size = 14, flaky }: { status: Status | null; size?: number; flaky?: boolean }) {
  const s = status ?? "untested";
  const color = flaky && s === "passed" ? "var(--flaky)" : `var(--${s})`;
  const title = flaky ? "Passed (flaky)" : STATUS_LABEL[s];
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" aria-label={title} role="img" style={{ flexShrink: 0 }}>
      <title>{title}</title>
      {s === "untested" ? (
        <circle cx="7" cy="7" r="5.5" stroke={color} strokeWidth="1.5" strokeDasharray="2.2 1.9" />
      ) : (
        <>
          <circle cx="7" cy="7" r="6" fill={color} />
          {s === "passed" && <path d="M4.3 7.2 6.1 9l3.6-3.8" stroke="var(--bg)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />}
          {s === "failed" && <path d="m4.9 4.9 4.2 4.2m0-4.2-4.2 4.2" stroke="var(--bg)" strokeWidth="1.6" strokeLinecap="round" />}
          {s === "blocked" && <path d="M4.3 7h5.4" stroke="var(--bg)" strokeWidth="1.7" strokeLinecap="round" />}
          {s === "skipped" && <path d="m5 9.2 4-4.4" stroke="var(--bg)" strokeWidth="1.6" strokeLinecap="round" />}
        </>
      )}
    </svg>
  );
}

// ---------- Priority icon (signal bars) ----------

export const PRIORITY_LABEL: Record<Priority, string> = { low: "Low", medium: "Medium", high: "High", critical: "Critical" };

export function PriorityIcon({ priority, size = 14 }: { priority: Priority | null; size?: number }) {
  const p = priority ?? "medium";
  if (p === "critical") {
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" aria-label="Critical priority" role="img" style={{ flexShrink: 0 }}>
        <title>Critical</title>
        <rect x="1" y="1" width="12" height="12" rx="3" fill="var(--critical)" />
        <path d="M7 3.8v4" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" />
        <circle cx="7" cy="10.1" r="0.95" fill="#fff" />
      </svg>
    );
  }
  const level = { low: 1, medium: 2, high: 3 }[p];
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" aria-label={`${PRIORITY_LABEL[p]} priority`} role="img" style={{ flexShrink: 0 }}>
      <title>{PRIORITY_LABEL[p]}</title>
      {[0, 1, 2].map((i) => (
        <rect key={i} x={1.5 + i * 4} y={8 - i * 3} width="3" height={4 + i * 3} rx="1" fill={i < level ? "var(--text-2)" : "var(--border-strong)"} />
      ))}
    </svg>
  );
}

// ---------- Progress ----------

type BarCounts = Pick<Counts, "total" | "passed" | "failed" | "blocked" | "skipped">;
const ORDER = ["passed", "failed", "blocked", "skipped"] as const;

export function ProgressBar({ counts, large }: { counts: BarCounts; large?: boolean }) {
  const total = counts.total || 1;
  return (
    <div className={`progress${large ? " lg" : ""}`} role="img" aria-label={ORDER.map((k) => `${counts[k]} ${k}`).join(", ")}>
      {ORDER.map((k) => (counts[k] ? <span key={k} style={{ width: `${(counts[k] / total) * 100}%`, background: `var(--${k})` }} /> : null))}
    </div>
  );
}

export function FrameworkBadge({ framework }: { framework: string | null }) {
  if (!framework) return null;
  const color: Record<string, string> = { playwright: "#45ba4b", testcafe: "#36b6e5", selenium: "#43b02a", bruno: "#f4aa41", junit: "#9a9ea6" };
  return (
    <span className="chip" title={`Framework: ${framework}`}>
      <span className="dot" style={{ background: color[framework] ?? "var(--text-3)" }} />
      {framework}
    </span>
  );
}

export const Kbd = ({ children }: { children: ReactNode }) => <kbd className="kbd">{children}</kbd>;

export function Empty({ icon, title, children, action }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

// ---------- Modal ----------

export function Modal({ title, onClose, children, footer, width }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" style={width ? { width: `min(${width}px, calc(100vw - 32px))` } : undefined}>
        <div className="modal-header">
          {title}
          <span className="spacer" />
          <button className="btn ghost icon sm" onClick={onClose} aria-label="Close">
            <X size={14} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

// ---------- Toasts ----------

interface Toast { id: number; kind: "success" | "error"; text: string }
const ToastCtx = createContext<(kind: Toast["kind"], text: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const push = useCallback((kind: Toast["kind"], text: string) => {
    const id = nextId.current++;
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 6000 : 3000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.kind === "error" ? <AlertCircle size={15} /> : <CheckCircle2 size={15} />}
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ---------- Hotkeys ----------

const isTyping = (e: KeyboardEvent) => {
  const el = e.target as HTMLElement | null;
  return !!el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
};

/**
 * Single-key shortcuts that are ignored while typing in a field, with modifier keys held, or while a modal is open.
 * A page's own shortcuts take their keys while the page is shown. The shortcuts of the layout (`yieldToPages`) give way to a key that a page has taken,
 * so `s` is "Skipped" on a run and "Settings" everywhere else.
 */
export function useHotkeys(map: Record<string, (e: KeyboardEvent) => void>, enabled = true, opts: { yieldToPages?: boolean } = {}) {
  const ref = useRef(map);
  ref.current = map;
  const keys = Object.keys(map).join("\n");
  const yieldToPages = !!opts.yieldToPages;
  useEffect(() => {
    if (!enabled) return;
    const release = yieldToPages ? () => {} : claimKeys(keys ? keys.split("\n") : []);
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e) || document.querySelector(".overlay")) return;
      if (yieldToPages && isClaimed(e.key)) return;
      const fn = ref.current[e.key];
      if (fn) {
        e.preventDefault();
        fn(e);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      release();
    };
  }, [enabled, keys, yieldToPages]);
}

/** Calls `fn` with the latest value once it has stopped changing for `ms`; flushes on unmount. */
export function useDebouncedCallback<T>(fn: (v: T) => void, ms: number) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const pending = useRef<{ v: T } | null>(null);
  const flush = useCallback(() => {
    clearTimeout(timer.current);
    if (pending.current) {
      const { v } = pending.current;
      pending.current = null;
      fnRef.current(v);
    }
  }, []);
  const call = useCallback(
    (v: T) => {
      pending.current = { v };
      clearTimeout(timer.current);
      timer.current = setTimeout(flush, ms);
    },
    [ms, flush],
  );
  useEffect(() => flush, [flush]);
  return { call, flush };
}

/** GitHub mark (lucide no longer ships brand icons). */
export function Github({ size = 14, className, style }: { size?: number; className?: string; style?: React.CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className} style={{ flexShrink: 0, ...style }}>
      <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.7 5.38-5.26 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z" />
    </svg>
  );
}

/**
 * A confirmation for something that cannot be undone. With `requireText` the button stays disabled until that text is typed
 * (used for deleting a whole project, so a slip of the mouse is not enough).
 */
export function ConfirmModal({ title, children, confirmLabel = "Delete", requireText, busy, onConfirm, onClose }: {
  title: ReactNode; children: ReactNode; confirmLabel?: string; requireText?: string; busy?: boolean; onConfirm: () => void; onClose: () => void;
}) {
  const [typed, setTyped] = useState("");
  const ok = !requireText || typed === requireText;
  return (
    <Modal
      title={title}
      onClose={busy ? () => {} : onClose}
      width={480}
      footer={
        <>
          <button className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn danger-solid" disabled={!ok || busy} onClick={onConfirm}>{busy ? "Deleting…" : confirmLabel}</button>
        </>
      }
    >
      <form className="col" style={{ gap: 12 }} onSubmit={(e) => { e.preventDefault(); if (ok && !busy) onConfirm(); }}>
        {children}
        {requireText && (
          <div className="field">
            <label htmlFor="confirm-text">Type <code className="inline">{requireText}</code> to confirm</label>
            <input id="confirm-text" className="input mono" autoFocus autoComplete="off" spellCheck={false} value={typed} onChange={(e) => setTyped(e.target.value)} />
          </div>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

/**
 * Props for a row that is clicked to open something: the row can be reached with Tab and opened with Enter or Space, and the open one is marked for
 * screen readers. A row is not a `button` because many rows hold their own controls (a checkbox, a link); the keys only act when the row itself has the focus.
 */
export function rowActivation(onActivate: () => void, selected = false) {
  return {
    tabIndex: 0,
    onClick: onActivate,
    onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
      if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
      e.preventDefault();
      e.stopPropagation(); // the page's own Enter hotkey would otherwise open the row it thinks is focused
      onActivate();
    },
    "aria-current": selected ? ("true" as const) : undefined,
  };
}

interface ConfirmOptions { title: ReactNode; body?: ReactNode; confirmLabel?: string; requireText?: string }
const ConfirmCtx = createContext<(o: ConfirmOptions) => Promise<boolean>>(() => Promise.resolve(false));

/**
 * `const confirm = useConfirm(); if (!(await confirm({ title, body, confirmLabel }))) return;` asks in the same dialog as every other delete, instead of the
 * browser's own box. `requireText` makes the person type a word first, for what cannot be undone. Cancel, Escape and the backdrop answer false.
 */
export const useConfirm = () => useContext(ConfirmCtx);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<(ConfirmOptions & { resolve: (ok: boolean) => void }) | null>(null);
  const ask = useCallback((o: ConfirmOptions) => new Promise<boolean>((resolve) => setReq((prev) => { prev?.resolve(false); return { ...o, resolve }; })), []);
  const answer = (ok: boolean) => { req?.resolve(ok); setReq(null); };
  return (
    <ConfirmCtx.Provider value={ask}>
      {children}
      {req && (
        <ConfirmModal title={req.title} confirmLabel={req.confirmLabel} requireText={req.requireText} onConfirm={() => answer(true)} onClose={() => answer(false)}>
          {req.body}
        </ConfirmModal>
      )}
    </ConfirmCtx.Provider>
  );
}

/** Placeholder rows shown while a list loads, instead of an empty page. */
export function ListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton-row">
          <span className="skeleton" style={{ width: 16 }} />
          <span className="skeleton" style={{ width: 56 }} />
          <span className="skeleton" style={{ width: `${40 + ((i * 13) % 35)}%` }} />
        </div>
      ))}
    </div>
  );
}
