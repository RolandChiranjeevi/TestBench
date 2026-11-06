import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type BackupInfo, type Project } from "../api";
import { ConfirmModal, Modal, useToast } from "./ui";

export function RenameProjectModal({ project, onClose }: { project: Project; onClose: () => void }) {
  const [name, setName] = useState(project.name);
  const qc = useQueryClient();
  const toast = useToast();
  const save = useMutation({
    mutationFn: () => api.patch<Project>(`/api/projects/${project.id}`, { name: name.trim() }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["projects"] });
      onClose();
    },
    onError: (e: Error) => toast("error", e.message),
  });
  const valid = !!name.trim() && name.trim() !== project.name;
  return (
    <Modal
      title="Rename project"
      onClose={onClose}
      width={440}
      footer={<button className="btn primary" disabled={!valid || save.isPending} onClick={() => save.mutate()}>Save</button>}
    >
      <form className="col" style={{ gap: 12 }} onSubmit={(e) => { e.preventDefault(); if (valid) save.mutate(); }}>
        <div className="field">
          <label htmlFor="rname">Name</label>
          <input id="rname" className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          <span className="muted" style={{ fontSize: "var(--fs-sm)" }}>
            The key <code className="inline">{project.key}</code> stays the same, because case IDs and <code className="inline">@{project.key}-12</code> tags in your tests use it.
          </span>
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

/** Deleting a project is permanent: the key has to be typed, and the server saves a backup first when automatic backups are on. */
export function DeleteProjectModal({ project, onClose }: { project: Project; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const { data: backup } = useQuery({ queryKey: ["backup-info"], queryFn: () => api.get<BackupInfo>("/api/backup/info"), staleTime: 60_000 });
  const { data: preview } = useQuery({
    queryKey: ["deletion-preview", project.id],
    queryFn: () => api.get<{ counts: { cases: number; runs: number; requirements: number; automatedTests: number } }>(`/api/projects/${project.id}/deletion-preview`),
  });
  const del = useMutation({
    mutationFn: () => api.post<{ name: string; deleted: { cases: number; runs: number }; backup: string | null }>(`/api/projects/${project.id}/delete`, { confirm: project.key }),
    onSuccess: (r) => {
      qc.clear();
      toast("success", `Deleted "${r.name}" (${r.deleted.cases} cases, ${r.deleted.runs} runs).${r.backup ? ` A backup was saved first (${r.backup}).` : ""}`);
      onClose();
      navigate("/");
    },
    onError: (e: Error) => toast("error", e.message),
  });
  const c = preview?.counts;
  return (
    <ConfirmModal
      title={`Delete "${project.name}"?`}
      confirmLabel="Delete project permanently"
      requireText={project.key}
      busy={del.isPending}
      onConfirm={() => del.mutate()}
      onClose={onClose}
    >
      <p style={{ margin: 0 }}>
        This permanently deletes the project and everything in it
        {c ? `: ${c.cases} test cases, ${c.runs} runs, ${c.requirements} requirements and ${c.automatedTests} automated tests` : ""}.
        Sprints, templates, the release checklists, and all uploaded screenshots, traces and attachments go too.
      </p>
      <p className="muted" style={{ margin: 0 }}>
        {backup?.auto.enabled
          ? "A backup is saved first. To get the project back, restore that backup from Settings, Data."
          : "Automatic backups are turned off, so nothing is saved first. This cannot be undone."}
      </p>
    </ConfirmModal>
  );
}
