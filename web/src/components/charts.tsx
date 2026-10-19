import { useState } from "react";
import { formatDateTime } from "../api";

interface Point { id: number; label: string; date: string; rate: number | null; detail: string }

/** Pass rate per run as a line chart. Hover or focus a point for details; click opens the run. */
export function TrendChart({ points, onOpen }: { points: Point[]; onOpen?: (id: number) => void }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 640, H = 200, L = 34, R = 12, T = 12, B = 22;
  const usable = points.filter((p) => p.rate != null);
  if (usable.length < 1) return <div className="muted" style={{ padding: 24 }}>No executed runs yet.</div>;

  const x = (i: number) => (points.length === 1 ? (L + W - R) / 2 : L + (i * (W - L - R)) / (points.length - 1));
  const y = (v: number) => T + ((100 - v) * (H - T - B)) / 100;
  const path = points.flatMap((p, i) => (p.rate == null ? [] : [`${x(i)},${y(p.rate)}`]));
  const line = path.length > 1 ? `M${path.join("L")}` : "";
  const area = path.length > 1 ? `${line}L${x(points.length - 1)},${y(0)}L${x(0)},${y(0)}Z` : "";
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
        {[0, 50, 100].map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="var(--border)" strokeDasharray={v === 50 ? "3 4" : undefined} />
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
            position: "absolute", pointerEvents: "none", padding: "6px 10px", fontSize: 12, boxShadow: "var(--shadow)", background: "var(--bg-elev)", whiteSpace: "nowrap",
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

/** Horizontal bar with a label, used for coverage per suite. */
export function CoverageBar({ label, value, total }: { label: string; value: number; total: number }) {
  const pct = total ? Math.round((value / total) * 100) : 0;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 110px 80px", gap: 10, alignItems: "center", height: 30 }}>
      <span className="truncate">{label}</span>
      <div className="progress" role="img" aria-label={`${pct}% automated`}>
        <span style={{ width: `${pct}%`, background: "var(--accent)" }} />
      </div>
      <span className="muted tabular" style={{ textAlign: "right", fontSize: 12 }}>{value}/{total} · {pct}%</span>
    </div>
  );
}
