import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type QueueState = { status: string; turnId: string | null; blocked: boolean; turns: Array<{ id: string; status: string }> };
export type QueuedMessage = {
  id: string; threadId: string; text: string; images: Array<{ path: string }>; files: string[];
  createdAt: number; revision: number; status: 'queued' | 'dispatching' | 'awaiting' | 'failed' | 'uncertain';
  afterTurnId?: string; turnId?: string; error?: string;
};
type ThreadQueue = { paused: boolean; reason: string; pauseCause?: 'manual' | 'stopped' | 'review'; items: QueuedMessage[] };
type Document = { version: 1; threads: Record<string, ThreadQueue>; receipts: Array<{ id: string; threadId: string }> };
type Dependencies = {
  path: string;
  state(threadId: string): Promise<QueueState>;
  send(message: QueuedMessage): Promise<{ turnId: string }>;
  changed?(threadId: string): void;
};
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const endedBadly = (status: string) => /^(?:failed|interrupted|aborted|cancelled|canceled)$/i.test(status);
const completed = (status: string) => /^(?:completed|complete)$/i.test(status);

/** A durable outbox. Delivery uncertainty never causes an automatic resend. */
export class MessageQueue {
  private document: Document = { version: 1, threads: Object.create(null), receipts: [] };
  private active = new Map<string, Promise<void>>();
  private timer?: NodeJS.Timeout;
  private closed = false;
  private storageFailed = false;

  constructor(private dependencies: Dependencies) {
    if (existsSync(dependencies.path)) {
      const saved = JSON.parse(readFileSync(dependencies.path, 'utf8'));
      if (saved.version !== 1 || !saved.threads || !Array.isArray(saved.receipts)) throw new Error('queue_storage_invalid');
      this.document = { version: 1, threads: Object.assign(Object.create(null), saved.threads), receipts: saved.receipts };
      for (const queue of Object.values(this.document.threads)) for (const item of queue.items) {
        if (item.status === 'dispatching') { item.status = 'uncertain'; queue.paused = true; queue.pauseCause = 'review'; queue.reason = '连接器重启时消息交付结果未确认，请核对原会话后处理。'; }
      }
    }
  }

  private thread(threadId: unknown) {
    if (this.storageFailed) throw new Error('queue_storage_unavailable');
    if (!identifier(threadId)) throw new Error('queue_thread_required');
    return this.document.threads[threadId] ??= { paused: false, reason: '', items: [] };
  }
  private persist(threadId: string) {
    const path = this.dependencies.path;
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const temp = path + '.tmp';
      writeFileSync(temp, JSON.stringify(this.document), { mode: 0o600 });
      renameSync(temp, path);
    } catch { this.storageFailed = true; throw new Error('queue_storage_unavailable'); }
    this.dependencies.changed?.(threadId);
  }
  list(threadId: string) {
    const queue = this.thread(threadId);
    return { threadId, paused: queue.paused, reason: queue.reason, items: queue.items.map(item => ({ ...item, images: item.images.map(image => ({ ...image })), files: [...item.files] })) };
  }
  add(value: Record<string, any>) {
    const { id, threadId } = value;
    if (!identifier(id)) throw new Error('queue_message_id_required');
    const queue = this.thread(threadId);
    const existing = this.document.receipts.find(item => item.id === id) || Object.values(this.document.threads).flatMap(q => q.items).find(item => item.id === id);
    if (existing) {
      if (existing.threadId !== threadId) throw new Error('queue_message_changed');
      return { accepted: true, id, threadId };
    }
    if (Object.values(this.document.threads).filter(q => q.items.length).length >= 10 && !queue.items.length) throw new Error('queue_limit');
    if (queue.items.length >= 30 || Object.values(this.document.threads).reduce((sum, q) => sum + q.items.length, 0) >= 100) throw new Error('queue_limit');
    const text = typeof value.text === 'string' ? value.text.trim() : '';
    if (!text || Buffer.byteLength(text, 'utf8') > 100_000) throw new Error('queue_message_invalid');
    const images = value.images ?? [];
    if (!Array.isArray(images) || images.length > 6 || images.some(image => typeof image?.path !== 'string' || image.path.length > 4096)) throw new Error('queue_message_invalid');
    const files = Array.isArray(value.files) ? value.files.filter((name: unknown) => typeof name === 'string').slice(0, 6).map((name: string) => name.slice(0, 160)) : [];
    if (!queue.items.length && queue.pauseCause !== 'manual' && queue.reason !== '队列已暂停') { queue.paused = false; queue.reason = ''; delete queue.pauseCause; }
    queue.items.push({ id, threadId, text, images: images.map(image => ({ path: image.path })), files,
      createdAt: Date.now(), revision: 1, status: 'queued', ...(identifier(value.afterTurnId) ? { afterTurnId: value.afterTurnId } : {}) });
    this.persist(threadId);
    return { accepted: true, id, threadId };
  }
  edit(value: Record<string, any>) {
    const queue = this.thread(value.threadId), item = queue.items.find(message => message.id === value.id);
    if (!item || item.revision !== value.revision) throw new Error('queue_message_changed');
    if (!['queued', 'failed'].includes(item.status)) throw new Error('queue_message_locked');
    const text = typeof value.text === 'string' ? value.text.trim() : '';
    if (!text || Buffer.byteLength(text, 'utf8') > 100_000) throw new Error('queue_message_invalid');
    item.text = text; item.revision++; item.status = 'queued'; delete item.error;
    this.persist(value.threadId);
    return this.list(value.threadId);
  }
  remove(value: Record<string, any>) {
    const queue = this.thread(value.threadId), item = queue.items.find(message => message.id === value.id);
    if (!item) return this.list(value.threadId);
    if (item.revision !== value.revision) throw new Error('queue_message_changed');
    if (['dispatching', 'awaiting'].includes(item.status)) throw new Error('queue_message_locked');
    queue.items = queue.items.filter(message => message !== item);
    this.receipt(item.id, item.threadId); this.persist(value.threadId);
    return this.list(value.threadId);
  }
  pause(threadId: string, reason = '队列已暂停') {
    const queue = this.thread(threadId); queue.paused = true; queue.reason = reason;
    queue.pauseCause = reason === '队列已暂停' ? 'manual' : 'stopped';
    this.persist(threadId); return this.list(threadId);
  }
  resume(threadId: string) {
    const queue = this.thread(threadId);
    if (queue.items.some(item => ['uncertain', 'failed'].includes(item.status))) throw new Error('queue_needs_review');
    // Explicit resume acknowledges a stopped/failed predecessor.
    if (queue.items[0]?.status === 'queued') delete queue.items[0].afterTurnId;
    queue.paused = false; queue.reason = ''; delete queue.pauseCause; this.persist(threadId); return this.list(threadId);
  }
  private receipt(id: string, threadId: string) { this.document.receipts.push({ id, threadId }); this.document.receipts = this.document.receipts.slice(-5000); }

  start() {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => { void this.tick(); }, 1500); this.timer.unref(); void this.tick();
  }
  async tick() {
    if (this.closed || this.storageFailed) return;
    const pending: Promise<void>[] = [];
    for (const [threadId, queue] of Object.entries(this.document.threads)) {
      if (this.active.has(threadId) || !queue.items.length || (queue.paused && queue.items[0].status !== 'awaiting')) continue;
      if (this.active.size >= 3) break;
      const work = this.process(threadId).catch(() => { /* Read/transport failures leave the durable queue untouched. */ }).finally(() => this.active.delete(threadId));
      this.active.set(threadId, work); pending.push(work);
    }
    await Promise.all(pending);
  }
  private async process(threadId: string) {
    const queue = this.thread(threadId), head = queue.items[0];
    if (!head) return;
    const state = await this.dependencies.state(threadId);
    if (this.closed || queue.items[0] !== head) return;
    if (head.status === 'awaiting') {
      const turn = state.turns.find(turn => turn.id === head.turnId);
      if (!turn || (!completed(turn.status) && !endedBadly(turn.status))) return;
      queue.items.shift(); this.receipt(head.id, head.threadId);
      if (endedBadly(turn.status)) { queue.paused = true; queue.pauseCause = 'stopped'; queue.reason = '上一条排队任务已停止或失败，请检查后继续队列。'; }
      this.persist(threadId); return;
    }
    if (queue.paused || head.status !== 'queued') return;
    if (state.status === 'active') {
      if (state.turnId && head.afterTurnId !== state.turnId) { head.afterTurnId = state.turnId; this.persist(threadId); }
      return;
    }
    if (state.status !== 'idle' || state.blocked) return;
    if (head.afterTurnId) {
      const previous = state.turns.find(turn => turn.id === head.afterTurnId);
      if (!previous || (!completed(previous.status) && !endedBadly(previous.status))) return;
      if (endedBadly(previous.status)) { queue.paused = true; queue.pauseCause = 'stopped'; queue.reason = '当前任务已停止或失败，后续消息保持排队。'; this.persist(threadId); return; }
    }
    head.status = 'dispatching'; head.revision++; this.persist(threadId);
    try {
      const result = await this.dependencies.send({ ...head, images: head.images.map(image => ({ ...image })), files: [...head.files] });
      if (!result.turnId) throw new Error('desktop_delivery_unknown');
      head.turnId = result.turnId; head.status = 'awaiting'; delete head.error;
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message === 'queue_thread_busy' || message === 'desktop_input_not_ready') head.status = 'queued';
      else { head.status = /unknown|timeout|unconfirmed/.test(message) ? 'uncertain' : 'failed'; head.error = head.status === 'uncertain' ? '消息可能已送达，请先检查原会话，避免重复发送。' : '消息未能发送，请检查本机连接后编辑重试或撤回。'; queue.paused = true; queue.pauseCause = 'review'; queue.reason = head.error; }
    }
    this.persist(threadId);
  }
  async close() { this.closed = true; clearInterval(this.timer); await Promise.allSettled(this.active.values()); }
}

/** Stable wire IDs keep desktop delivery tied to the same queued message. */
export function queueRequestId(id: string) { return 'queue_' + createHash('sha256').update(id).digest('hex').slice(0, 40); }
