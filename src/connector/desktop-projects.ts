import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type DesktopProject = { id: string; name: string; position: number; roots: string[] };

/** Read display metadata only. Desktop remains the sole writer of its catalog. */
export async function readDesktopProjects() {
  const projects = new Map<string, DesktopProject>();
  const assignments = new Map<string, string>();
  let db: import('node:sqlite').DatabaseSync | undefined;
  try {
    const home = process.env.CODEX_HOME || join(homedir(), '.codex');
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(join(home, 'state_5.sqlite'), { readOnly: true });
    for (const row of db.prepare('SELECT id,name,position FROM projects ORDER BY position').all()) {
      const id = String(row.id);
      projects.set(id, { id, name: String(row.name), position: Number(row.position),
        roots: db.prepare('SELECT path FROM project_roots WHERE project_id=? ORDER BY position').all(id).map(r => String(r.path)) });
    }
    // Older desktop versions store assignments in the global state file.
    try {
      const state = JSON.parse(readFileSync(join(home, '.codex-global-state.json'), 'utf8'));
      const ids = Object.assign({}, ...Object.values(state['app-server-project-id-by-legacy-project-id-by-host'] || {}));
      for (const [id, assignment] of Object.entries(state['thread-project-assignments'] || {})) {
        const legacyId = (assignment as { projectId?: string }).projectId;
        if (legacyId) assignments.set(id, ids[legacyId] || legacyId);
      }
    } catch { /* Optional legacy metadata. */ }
    for (const row of db.prepare('SELECT id,project_id FROM threads WHERE project_id IS NOT NULL').all()) {
      assignments.set(String(row.id), String(row.project_id));
    }
  } catch { /* CLI-only installs can continue grouping by their working directory. */ }
  finally { db?.close(); }
  return { projects, assignments };
}
