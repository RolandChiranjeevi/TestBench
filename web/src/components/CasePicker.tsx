import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Bot, Search } from "lucide-react";
import { api, type CaseSummary, type Project, type Suite } from "../api";
import { PriorityIcon } from "./ui";

/** Cases that can be put in a run: everything except deprecated ones. */
export function useRunnableCases() {
  const { pid } = useParams();
  const { data: cases = [] } = useQuery({ queryKey: ["cases", pid], queryFn: () => api.get<CaseSummary[]>(`/api/projects/${pid}/cases`) });
  return useMemo(() => cases.filter((c) => c.status !== "deprecated"), [cases]);
}

/** Searchable, suite-grouped checklist of cases. The parent owns the selection. */
export function CasePicker({ selected, onChange, maxHeight = 300 }: { selected: Set<number>; onChange: (next: Set<number>) => void; maxHeight?: number }) {
  const { pid } = useParams();
  const [search, setSearch] = useState("");
  const { data: projects } = useQuery({ queryKey: ["projects"], queryFn: () => api.get<Project[]>("/api/projects") });
  const key = projects?.find((p) => p.id === Number(pid))?.key;
  const { data: suites = [] } = useQuery({ queryKey: ["suites", pid], queryFn: () => api.get<Suite[]>(`/api/projects/${pid}/suites`) });
  const runnable = useRunnableCases();

  const q = search.trim().toLowerCase();
  const shown = runnable.filter((c) => !q || `${key}-${c.number} ${c.title} ${c.tags.join(" ")}`.toLowerCase().includes(q));
  const groups = [...suites.map((s) => ({ id: s.id as number | null, name: s.name })), { id: null, name: "No suite" }]
    .map((g) => ({ ...g, items: shown.filter((c) => c.suite_id === g.id) }))
    .filter((g) => g.items.length);

  const setMany = (ids: number[], on: boolean) => {
    const next = new Set(selected);
    ids.forEach((id) => (on ? next.add(id) : next.delete(id)));
    onChange(next);
  };

  return (
    <>
      <div className="row">
        <div className="search grow">
          <Search size={13} />
          <input className="input" placeholder="Filter cases" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Filter cases" />
        </div>
        <button className="btn sm" onClick={() => setMany(shown.map((c) => c.id), true)}>Select {q ? "shown" : "all"}</button>
        <button className="btn ghost sm" onClick={() => onChange(new Set())}>Clear</button>
      </div>
      <div className="card" style={{ maxHeight, overflow: "auto" }}>
        {groups.length === 0 && <div className="muted" style={{ padding: 16 }}>No cases to pick. Create test cases first.</div>}
        {groups.map((g) => {
          const ids = g.items.map((c) => c.id);
          const all = ids.every((id) => selected.has(id));
          const some = !all && ids.some((id) => selected.has(id));
          return (
            <div key={g.id ?? "none"}>
              <label className="group-header" style={{ cursor: "pointer", padding: "0 12px" }}>
                <input type="checkbox" className="checkbox" checked={all} ref={(el) => { if (el) el.indeterminate = some; }} onChange={() => setMany(ids, !all)} />
                {g.name} <span className="count">{g.items.length}</span>
              </label>
              {g.items.map((c) => (
                <label key={c.id} className="list-row" style={{ height: 32, padding: "0 12px" }}>
                  <input type="checkbox" className="checkbox" checked={selected.has(c.id)} onChange={() => setMany([c.id], !selected.has(c.id))} />
                  <PriorityIcon priority={c.priority} />
                  <span className="mono muted" style={{ width: 62 }}>{key}-{c.number}</span>
                  <span className="title">{c.title}</span>
                  {c.automated_count > 0 && <Bot size={12} className="faint" />}
                </label>
              ))}
            </div>
          );
        })}
      </div>
    </>
  );
}
