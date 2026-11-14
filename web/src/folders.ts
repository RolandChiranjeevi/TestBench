// Folders are the tree that organises test cases (table `suites`; the app says folder, and "suite" for a runnable group of cases).

/** The ids of a folder and, unless `includeSubfolders` is false, of every folder below it. */
export function folderScope(folders: { id: number; parent_id: number | null }[], id: number, includeSubfolders = true): Set<number> {
  const ids = new Set([id]);
  if (!includeSubfolders) return ids;
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of folders) if (f.parent_id != null && ids.has(f.parent_id) && !ids.has(f.id)) { ids.add(f.id); grew = true; }
  }
  return ids;
}

/** The cases that are in a folder (and its subfolders), in the order they are given. */
export function casesInFolder<C extends { suite_id: number | null }>(cases: C[], folders: { id: number; parent_id: number | null }[], id: number, includeSubfolders = true): C[] {
  const scope = folderScope(folders, id, includeSubfolders);
  return cases.filter((c) => c.suite_id != null && scope.has(c.suite_id));
}
