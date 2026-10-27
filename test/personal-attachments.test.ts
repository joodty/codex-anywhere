import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { userImageAttachments } from '../src/shared/user-image.js';
import { mapTurns } from '../src/connector/app-server-history.js';
import { uploadFile } from '../web/src/file-upload.js';
import { readRolloutTail } from '../src/connector/rollout-tail.js';
sharp.cache(false);

test('originals survive compact processing, old age and subsequent uploads; metadata binds to the original chat', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-retention-'));
  process.env.CODEX_ANYWHERE_DATA_DIR = directory;
  const { FileUploadManager } = await import('../src/connector/file-uploads.js');
  const { prepareRetainedImage, resolveNativeImageAttachment, readImageAttachment } = await import('../src/connector/attachments.js');
  const { originalRetainedFile, bindRetainedFiles } = await import('../src/connector/retained-files.js');
  try {
    const manager = new FileUploadManager();
    const original = await sharp({ create: { width: 3000, height: 1600, channels: 4, background: '#218cdd80' } }).png().toBuffer();
    let dropped = false;
    const request = async <T>(action: string, payload: Record<string, unknown>): Promise<T> => {
      if (action === 'connector.status') return { capabilities: { fileUpload: true } } as T;
      if (action === 'file.upload.begin') return await manager.begin(payload, 'owner') as T;
      if (action === 'file.upload.chunk') { const result = await manager.chunk(payload, 'owner'); if (!dropped) { dropped = true; throw new Error('lost_ack'); } return result as T; }
      if (action === 'file.upload.status') return await manager.status(payload, 'owner') as T;
      if (action === 'file.upload.complete') return await manager.complete(payload, 'owner') as T;
      if (action === 'file.upload.cancel') return await manager.cancel(payload, 'owner') as T;
      throw new Error(action);
    };
    const uploaded = await uploadFile(new File([original], 'transparent-original.png', { type: 'image/png' }), request, () => {}, () => true);
    assert.equal(dropped, true);
    assert.deepEqual(await readFile(uploaded.path), original, 'lost acknowledgements must not duplicate chunks');
    const compact = await prepareRetainedImage({ path: uploaded.path, name: 'transparent-original.png', quality: 'economy' });
    const high = await prepareRetainedImage({ path: uploaded.path, quality: 'high' });
    assert.equal((await sharp(compact.path).metadata()).width, 2048);
    assert.deepEqual(await readFile(high.path), original, 'original mode must preserve exact bytes and transparency');
    assert.equal(await resolveNativeImageAttachment(compact), compact.path);
    assert.equal((await originalRetainedFile(compact.path)).path, uploaded.path);
    assert.equal((await readImageAttachment({ path: compact.path })).name, 'transparent-original.png');
    await bindRetainedFiles({ threadId: 'original-chat', paths: [uploaded.path, compact.path] });
    assert.equal(JSON.parse(await readFile(compact.path + '.json', 'utf8')).threadId, 'original-chat');
    const old = new Date(Date.now() - 3 * 24 * 60 * 60_000); await utimes(uploaded.path, old, old); await utimes(compact.path, old, old);
    const next = await manager.begin({ name: 'next.txt', size: 0 }, 'owner'); await manager.complete(next, 'owner');
    assert.deepEqual(await readFile(uploaded.path), original);
    assert.ok((await stat(compact.path)).isFile());
    assert.ok((await readImageAttachment({ path: compact.path, source: 'local', quality: 'high' })).data.length);
    await assert.rejects(prepareRetainedImage({ path: join(directory, '..', 'private.png') }), /attachment_path_not_allowed/);
    await assert.rejects(manager.status({ uploadId: 'missing' }, 'other'), /file_upload_not_found/);
  } finally { delete process.env.CODEX_ANYWHERE_DATA_DIR; await rm(directory, { recursive: true, force: true }); }
});

test('all native images survive history hydration, without repeating the user text', () => {
  const content = [{ type: 'text', text: 'Compare these' }, { type: 'localImage', path: 'D:/images/a.png' }, { type: 'localImage', path: 'D:/images/b.png' }];
  assert.equal(userImageAttachments(content).length, 2);
  const turn = mapTurns([{ id: 'turn', items: [{ type: 'userMessage', content }] }])[0];
  assert.equal(turn.items.filter((item: any) => item.attachment).length, 2);
  assert.equal(turn.items.filter((item: any) => item.text === 'Compare these').length, 1);
});

test('live rollout history preserves the same image order as the initial history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-gallery-tail-'));
  try {
    const file = join(directory, 'rollout.jsonl');
    const rows = [
      { type: 'event_msg', timestamp: '2026-10-27T00:00:00Z', payload: { type: 'task_started', turn_id: 'turn' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Compare both' }, { type: 'localImage', path: 'D:/a.png' }, { type: 'localImage', path: 'D:/b.png' }] } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn' } },
    ];
    await writeFile(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    const tail = await readRolloutTail({ filePath: file, threadId: 'chat' });
    const images = tail.turns.flatMap(turn => turn.items).filter(item => item.attachment);
    assert.deepEqual(images.map(item => item.attachment!.path), ['D:/a.png', 'D:/b.png']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
