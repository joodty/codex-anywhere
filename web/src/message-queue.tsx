import { useCallback, useEffect, useRef, useState } from 'react';
import { friendlyError } from './app-utils';
import { t } from './i18n';

type Item = { id: string; text: string; revision: number; createdAt: number; files: string[]; images: Array<{ path: string }>;
  status: 'queued' | 'dispatching' | 'awaiting' | 'failed' | 'uncertain'; error?: string };
type Queue = { threadId: string; paused: boolean; reason: string; items: Item[] };
type Request = <T>(action: string, payload: Record<string, unknown>) => Promise<T>;

export function useMessageQueue({ environmentId, threadId, online, supported, request }: {
  environmentId: string; threadId: string | null; online: boolean; supported: boolean; request: Request;
}) {
  const scope = JSON.stringify([environmentId, threadId]);
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const revision = useRef(0);
  const [state, setState] = useState<{ scope: string; queue: Queue | null; error: string }>({ scope, queue: null, error: '' });
  const refresh = useCallback(async () => {
    if (!online || !supported || !threadId) return;
    const version = ++revision.current;
    try { const queue = await request<Queue>('queue.list', { threadId });
      if (scopeRef.current === scope && version === revision.current) setState({ scope, queue, error: '' });
    } catch { if (scopeRef.current === scope && version === revision.current) setState(current => ({ scope, queue: current.scope === scope ? current.queue : null, error: t('队列状态暂时无法读取，正在重试。', 'Queue status is unavailable. Retrying.') })); }
  }, [online, supported, threadId, request, scope]);
  useEffect(() => { void refresh(); if (!online || !supported || !threadId) return; const timer = setInterval(() => void refresh(), 2500); return () => clearInterval(timer); }, [refresh, online, supported, threadId]);
  const change = useCallback(async (action: string, payload: Record<string, unknown> = {}) => {
    if (!threadId || !online) return false;
    const version = ++revision.current;
    try { const queue = await request<Queue>(action, { ...payload, threadId });
      if (scopeRef.current === scope && version === revision.current) setState({ scope, queue, error: '' }); return true;
    } catch (error) { if (scopeRef.current === scope) setState(current => ({ scope, queue: current.scope === scope ? current.queue : null, error: friendlyError(error) })); return false; }
  }, [threadId, online, request, scope]);
  return { queue: state.scope === scope ? state.queue : null, error: state.scope === scope ? state.error : '', refresh, change };
}

export function MessageQueuePanel({ queue, error, online, change }: {
  queue: Queue | null; error: string; online: boolean; change(action: string, payload?: Record<string, unknown>): Promise<boolean>;
}) {
  const [editing, setEditing] = useState<{ item: Item; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!queue?.items.length && !queue?.paused && !error) return null;
  const labels = { queued: t('等待发送', 'Waiting'), dispatching: t('正在发送', 'Sending'), awaiting: t('已发送，等待完成', 'Sent; waiting for completion'), failed: t('发送失败', 'Failed'), uncertain: t('需要核对', 'Review required') };
  const run = async (action: string, payload: Record<string, unknown> = {}) => { setBusy(true); try { return await change(action, payload); } finally { setBusy(false); } };
  return <details className="message-queue-panel" open>
    <summary>{t('消息队列', 'Message queue')} <span>{queue?.items.length || 0}</span>{queue?.paused && <small>{t('已暂停', 'Paused')}</small>}</summary>
    <div className="message-queue-body">
      <div className="message-queue-toolbar"><small>{t('保存在本机，关闭网页后继续；只在原会话空闲时发送。', 'Stored on your computer. Continues with the page closed, only when this chat is idle.')}</small>
        <button type="button" disabled={!online || busy} onClick={() => void run(queue?.paused ? 'queue.resume' : 'queue.pause')}>{queue?.paused ? t('继续队列', 'Resume queue') : t('暂停队列', 'Pause queue')}</button></div>
      {(error || queue?.reason) && <p className="message-queue-error" role="status">{error || queue?.reason}</p>}
      <ol>{queue?.items.map((item, index) => <li key={item.id} data-queue-id={item.id}>
        <div className="message-queue-item-head"><span>{index + 1}. {labels[item.status]}</span><small>{item.files.length ? t(`${item.files.length} 个附件`, `${item.files.length} attachments`) : ''}</small></div>
        {editing?.item.id === item.id ? <form onSubmit={event => { event.preventDefault(); void run('queue.edit', { id: item.id, revision: editing.item.revision, text: editing.text }).then(ok => { if (ok) setEditing(null); }); }}>
          <textarea aria-label={t('编辑排队消息', 'Edit queued message')} value={editing.text} onChange={event => setEditing({ ...editing, text: event.target.value })} autoFocus disabled={busy} />
          <div className="message-queue-item-actions"><button type="button" onClick={() => setEditing(null)}>{t('取消编辑', 'Cancel edit')}</button><button type="submit" disabled={!online || busy || !editing.text.trim()}>{t('保存修改', 'Save changes')}</button></div>
        </form> : <><p className="message-queue-text">{item.text}</p><div className="message-queue-item-actions">
          {['queued', 'failed'].includes(item.status) && <button type="button" disabled={!online || busy} onClick={() => setEditing({ item, text: item.text })}>{t('编辑', 'Edit')}</button>}
          {!['dispatching', 'awaiting'].includes(item.status) && <button type="button" disabled={!online || busy} onClick={() => void run('queue.remove', { id: item.id, revision: item.revision })}>{t('撤回', 'Remove')}</button>}
        </div></>}
        {item.error && <p className="message-queue-error">{item.error}</p>}
      </li>)}</ol>
    </div>
  </details>;
}
