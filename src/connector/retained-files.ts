import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

export const DATA_DIRECTORY = resolve(process.env.CODEX_ANYWHERE_DATA_DIR || join(homedir(), '.codex-anywhere', 'storage'));
export const IMAGE_DIRECTORY = join(DATA_DIRECTORY, 'images');
export const FILE_DIRECTORY = join(DATA_DIRECTORY, 'files');
export const LEGACY_IMAGE_DIRECTORY = join(tmpdir(), 'personal-codex-bridge', 'attachments');
export const LEGACY_FILE_DIRECTORY = join(tmpdir(), 'personal-codex-bridge', 'files');
export const MANAGED_ROOTS = [IMAGE_DIRECTORY, FILE_DIRECTORY, LEGACY_IMAGE_DIRECTORY, LEGACY_FILE_DIRECTORY];
const normalized = (value: string) => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);

export function managedFile(path: string, roots = MANAGED_ROOTS) {
  return roots.some(root => normalized(dirname(path)) === normalized(root));
}

export async function retainedPath(value: unknown) {
  if (typeof value !== 'string' || !isAbsolute(value)) return String(value || '');
  const path = resolve(String(value || ''));
  for (const [oldRoot, newRoot] of [[LEGACY_IMAGE_DIRECTORY, IMAGE_DIRECTORY], [LEGACY_FILE_DIRECTORY, FILE_DIRECTORY]]) {
    if (managedFile(path, [oldRoot])) {
      const saved = join(newRoot, basename(path));
      if (await lstat(saved).then(s => s.isFile() && !s.isSymbolicLink()).catch(() => false)) return saved;
    }
  }
  return path;
}

export async function retainLegacyFiles() {
  for (const [oldRoot, newRoot] of [[LEGACY_IMAGE_DIRECTORY, IMAGE_DIRECTORY], [LEGACY_FILE_DIRECTORY, FILE_DIRECTORY]]) {
    await mkdir(newRoot, { recursive: true, mode: 0o700 });
    const entries = await readdir(oldRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink() || entry.name.endsWith('.part')) continue;
      await copyFile(join(oldRoot, entry.name), join(newRoot, entry.name), constants.COPYFILE_EXCL).catch(error => {
        if (error.code !== 'EEXIST') throw error;
      });
    }
  }
}

export async function bindRetainedFiles(payload: Record<string, any>) {
  const threadId = String(payload.threadId || '');
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(threadId) || !Array.isArray(payload.paths) || payload.paths.length > 12) throw new Error('attachment_binding_invalid');
  for (const value of payload.paths) {
    const path = await retainedPath(value);
    if (!managedFile(path, [IMAGE_DIRECTORY, FILE_DIRECTORY]) || !/^[\da-f-]{36}[.-]/i.test(basename(path))) throw new Error('attachment_path_not_allowed');
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('attachment_not_found');
    let metadata = {};
    try { metadata = JSON.parse(await readFile(path + '.json', 'utf8')); } catch { /* New file. */ }
    await writeFile(path + '.json', JSON.stringify({ ...metadata, threadId, retained: true }), { mode: 0o600 });
  }
  return { saved: true };
}

export async function originalRetainedFile(value: unknown) {
  const path = await retainedPath(value);
  if (!managedFile(path, [IMAGE_DIRECTORY])) return { path };
  try {
    const metadata = JSON.parse(await readFile(path + '.json', 'utf8'));
    if (typeof metadata.originalPath === 'string' && managedFile(metadata.originalPath, [FILE_DIRECTORY])) return { path: metadata.originalPath, name: metadata.name };
  } catch { /* Legacy image is itself the original. */ }
  return { path };
}
