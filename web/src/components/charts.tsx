import { useState } from "react";
import { formatDateTime } from "../api";

interface Point { id: number; label: string; date: string; rate: number | null; detail: string }

/** Pass rate per run as a line chart. Hover or focus a point for details; click opens the run. */
export function TrendChart({ points, onOpen }: { points: Point[]; onOpen?: (id: number) => void }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 640, H = 200, L = 34, R = 12, T = 24, B = 22;
  const usable = points.filter((p) => p.rate != null);
  if (usable.length < 1) return <div className="muted" style={{ padding: 24 }}>No executed runs yet.</div>;

  const x = (i: number) => (points.length === 1 ? (L + W - R) / 2 : L + (i * (W - L - R)) / (points.length - 1));
  // Zoom the axis to the data (to the nearest 10 below the lowest rate, at most 0..100) so a few runs don't sit in the top corner of an empty 0-100 box.
  const lo = Math.max(0, Math.min(80, Math.floor((Math.min(...usable.map((p) => p.rate!)) - 10) / 10) * 10));
  const ticks = [lo, Math.round((lo + 100) / 2), 100];
  const y = (v: number) => T + ((100 - v) * (H - T - B)) / (100 - lo);
  const path = points.flatMap((p, i) => (p.rate == null ? [] : [`${x(i)},${y(p.rate)}`]));
  const line = path.length > 1 ? `M${path.join("L")}` : "";
  const area = path.length > 1 ? `${line}L${x(points.length - 1)},${y(lo)}L${x(0)},${y(lo)}Z` : "";
  const summary = `Pass rate over ${points.length} runs, latest ${usable.at(-1)!.rate}%`;
  const shown = hover != null ? points[hover] : null;

  return (
    <div style={{ position: "relative" }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={summary} style={{ display: "block" }}>
        <defs>
          <linearGradient id="trend-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((v, i) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="var(--border)" strokeDasharray={i === 1 ? "3 4" : undefined} />
            <text x={L - 8} y={y(v) + 4} textAnchor="end" fontSize="10.5" fill="var(--text-4)">{v}%</text>
          </g>
        ))}
        {area && <path d={area} fill="url(#trend-fill)" />}
        {line && <path d={line} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />}
        {points.map((p, i) =>
          p.rate == null ? null : (
            <g key={p.id}>
              <circle
                cx={x(i)} cy={y(p.rate)} r={hover === i ? 5 : 3.5}
                fill={p.rate >= 90 ? "var(--passed)" : p.rate >= 70 ? "var(--blocked)" : "var(--failed)"} stroke="var(--bg-panel)" strokeWidth="1.5"
              />
              {/* The value, so the line can be read without hovering (a long series would be crowded: then only the tooltip). */}
              {points.length <= 12 && (
                <text x={x(i)} y={y(p.rate) - 9} textAnchor="middle" fontSize="10.5" fill="var(--text-3)">{p.rate}%</text>
              )}
              {/* Larger invisible hit target */}
              <circle
                cx={x(i)} cy={y(p.rate)} r={12} fill="transparent" tabIndex={0} style={{ cursor: onOpen ? "pointer" : "default", outline: "none" }}
                aria-label={`${p.label}: ${p.rate}%. ${p.detail}`}
                onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}
                onClick={() => onOpen?.(p.id)} onKeyDown={(e) => e.key === "Enter" && onOpen?.(p.id)}
              />
            </g>
          ),
        )}
      </svg>
      {shown && shown.rate != null && hover != null && (
        <div
          className="card"
          style={{
            position: "absolute", pointerEvents: "none", padding: "6px 12px", fontSize: "var(--fs-sm)", boxShadow: "var(--shadow)", background: "var(--bg-elev)", whiteSpace: "nowrap",
            left: `${(x(hover) / W) * 100}%`, top: `${(y(shown.rate) / H) * 100}%`, transform: `translate(${hover > points.length / 2 ? "calc(-100% - 10px)" : "10px"}, -50%)`,
          }}
        >
          <div style={{ fontWeight: 600 }}>{shown.rate}% · {shown.label}</div>
          <div className="muted">{shown.detail} · {formatDateTime(shown.date)}</div>
        </div>
      )}
    </div>
  );
}

interface DurationBar { id: number; label: string; date: string; ms: number; failed: number }

/** Total test time per run as bars (red when the run had failures). Hover for details; click opens the run. */
export function DurationChart({ bars, onOpen }: { bars: DurationBar[]; onOpen?: (id: number) => void }) {
  const [hover, setHover] = useState<number | null>(null);
  if (!bars.length) return <div className="muted" style={{ padding: 24 }}>No automated runs yet.</div>;
  const W = 640, H = 170, L = 44, R = 8, T = 10, B = 20;
  const max = Math.max(...bars.map((b) => b.ms), 1);
  const slot = (W - L - R) / bars.length;
  const bw = Math.max(3, Math.min(28, slot * 0.7));
  const y = (ms: number) => T + (1 - ms / max) * (H - T - B);
  const fmt = (ms: number) => (ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}m` : `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s`);
  const shown = hover != null ? bars[hover] : null;

  return (
    <div style={{ position: "relative" }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`Test time per run, latest ${fmt(bars.at(-1)!.ms)}`} style={{ display: "block" }}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={L} x2={W - R} y1={y(max * f)} y2={y(max * f)} stroke="var(--border)" strokeDasharray={f === 0.5 ? "3 4" : undefined} />
            <text x={L - 8} y={y(max * f) + 4} textAnchor="end" fontSize="10.5" fill="var(--text-4)">{fmt(max * f)}</text>
          </g>
        ))}
        {bars.map((b, i) => {
          const x = L + i * slot + (slot - bw) / 2;
          return (
            <g key={b.id}>
              <rect x={x} y={y(b.ms)} width={bw} height={Math.max(1, H - B - y(b.ms))} rx={2} fill={b.failed ? "var(--failed)" : "var(--accent)"} opacity={hover == null || hover === i ? 1 : 0.55} />
              <rect
                x={L + i * slot} y={T} width={slot} height={H - T - B} fill="transparent" tabIndex={0} style={{ cursor: onOpen ? "pointer" : "default", outline: "none" }}
                aria-label={`${b.label}: ${fmt(b.ms)}${b.failed ? `, ${b.failed} failed` : ""}`}
                onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}
                onClick={() => onOpen?.(b.id)} onKeyDown={(e) => e.key === "Enter" && onOpen?.(b.id)}
              />
            </g>
          );
        })}
      </svg>
      {shown && hover != null && (
        <div
          className="card"
          style={{
            position: "absolute", pointerEvents: "none", padding: "6px 12px", fontSize: "var(--fs-sm)", boxShadow: "var(--shadow)", background: "var(--bg-elev)", whiteSpace: "nowrap",
            left: `${((L + hover * slot + slot / 2) / W) * 100}%`, top: 0, transform: `translateX(${hover > bars.length / 2 ? "calc(-100% - 8px)" : "8px"})`,
          }}
        >
          <div style={{ fontWeight: 600 }}>{fmt(shown.ms)} · {shown.label}</div>
          <div className="muted">{shown.failed ? `${shown.failed} failed · ` : ""}{formatDateTime(shown.date)}</div>
        </div>
      )}
    </div>
  );
}

/** Horizontal bar with a label, used for coverage per suite. */
export function CoverageBar({ label, value, total }: { label: string; value: number; total: number }) {
  const pct = total ? Math.round((value / total) * 100) : 0;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 110px 80px", gap: 12, alignItems: "center", height: 30 }}>
      <span className="truncate">{label}</span>
      <div className="progress" role="img" aria-label={`${pct}% automated`}>
        <span style={{ width: `${pct}%`, background: "var(--accent)" }} />
      </div>
      <span className="muted tabular" style={{ textAlign: "right", fontSize: "var(--fs-sm)" }}>{value}/{total} · {pct}%</span>
    </div>
  );
}
