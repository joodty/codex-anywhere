import { memo, useEffect, useMemo, useState } from 'react';
import {
  formatDate,
  isSessionRunning,
  sessionProjectName,
  sessionUpdatedAt,
  type SessionAttentionState,
} from './app-utils';
import type { ExecutionState, Session } from './app-types';
import { t } from './i18n';
import { readLocal, writeLocal } from './personal-state';
import { SidebarIcon } from './ui-components';
import { EnvironmentSwitcher } from './environment-switcher';
import type { EnvironmentLabels } from './execution-environments';

type SessionSidebarProps = {
  open: boolean;
  environmentId: string;
  environmentIds: string[];
  environmentLabels?: EnvironmentLabels;
  onEnvironmentRename?: (id: string, label: string) => Promise<void>;
  onlineEnvironmentIds: string[];
  sessions: Session[];
  selectedThreadId: string | null;
  executionState: ExecutionState;
  attention: SessionAttentionState;
  searchOpen: boolean;
  search: string;
  onSearchOpenChange: (open: boolean) => void;
  onSearchChange: (search: string) => void;
  onEnvironmentChange: (environmentId: string) => void;
  onNewSession: () => void;
  onClose: () => void;
  onSelect: (session: Session) => void;
};

/**
 * Kept outside App so prompt typing and live progress updates do not rebuild a
 * potentially long session list. It still refreshes for real session/status changes.
 */
export const SessionSidebar = memo(function SessionSidebar({
  open,
  environmentId,
  environmentIds,
  environmentLabels,
  onEnvironmentRename,
  onlineEnvironmentIds,
  sessions,
  selectedThreadId,
  executionState,
  attention,
  searchOpen,
  search,
  onSearchOpenChange,
  onSearchChange,
  onEnvironmentChange,
  onNewSession,
  onClose,
  onSelect,
}: SessionSidebarProps) {
  const selectedSession = sessions.find(session => session.id === selectedThreadId);
  const selectedProject = selectedSession && (selectedSession.project?.id || (selectedSession.desktopCatalogAvailable ? 'unassigned' : selectedSession.cwd || 'unassigned'));
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([...readLocal<string[]>('personal.projects.' + environmentId, []), ...(selectedProject ? [selectedProject] : [])]));
  useEffect(() => { setExpanded(new Set(readLocal<string[]>('personal.projects.' + environmentId, []))); }, [environmentId]);
  useEffect(() => {
    if (selectedProject) setExpanded(current => { const next = new Set([...current, selectedProject]); writeLocal('personal.projects.' + environmentId, [...next]); return next; });
  }, [selectedProject, environmentId]);
  const visibleSessions = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const matches = query
      ? sessions.filter((session) => `${session.title} ${session.cwd || ''} ${session.preview || ''}`
        .toLocaleLowerCase().includes(query))
      : sessions;
    return [...matches]
      .sort((left, right) => sessionUpdatedAt(right.updatedAt) - sessionUpdatedAt(left.updatedAt));
  }, [search, sessions]);

  const groups = useMemo(() => {
    const groups = new Map<string, { id: string; name: string; path: string; position: number; sessions: Session[] }>();
    for (const session of visibleSessions) {
      const project = session.project;
      const id = project?.id || (session.desktopCatalogAvailable ? 'unassigned' : session.cwd || 'unassigned');
      let group = groups.get(id);
      if (!group) {
        group = { id, name: project?.name || (session.desktopCatalogAvailable ? t('未分配项目', 'Unassigned') : sessionProjectName(session.cwd) || t('未分配项目', 'Unassigned')),
          path: project?.roots.join('\n') || session.cwd || '', position: project?.position ?? 10000, sessions: [] };
        groups.set(id, group);
      }
      group.sessions.push(session);
    }
    return [...groups.values()].sort((a, b) => a.position - b.position);
  }, [visibleSessions]);

  return (
    <aside className={`sidebar ${open ? 'open' : ''}`} aria-label={t('会话列表', 'Session list')}>
      <div className="sidebar-head">
        <div><p className="eyebrow">Codex <span className="web-label">网页版</span></p></div>
        <div className="sidebar-actions">
          <button className="sidebar-tool" onClick={onNewSession} aria-label={t('新会话', 'New session')} title={t('新会话', 'New session')}>
            <SidebarIcon name="plus" />
          </button>
          <button
            className={`sidebar-tool ${searchOpen ? 'active' : ''}`}
            onClick={() => {
              if (searchOpen) onSearchChange('');
              onSearchOpenChange(!searchOpen);
            }}
            aria-label={searchOpen ? t('收起搜索', 'Collapse search') : t('搜索会话', 'Search sessions')}
            title={searchOpen ? t('收起搜索', 'Collapse search') : t('搜索会话', 'Search sessions')}
          >
            <SidebarIcon name="search" />
          </button>
          <button className="sidebar-tool mobile-only" onClick={onClose} aria-label={t('收起会话列表', 'Collapse session list')} title={t('收起会话列表', 'Collapse session list')}>
            <SidebarIcon name="panel-close" />
          </button>
        </div>
      </div>
      <EnvironmentSwitcher value={environmentId} environmentIds={environmentIds}
        labels={environmentLabels} onRename={onEnvironmentRename}
        onlineEnvironmentIds={onlineEnvironmentIds} onChange={onEnvironmentChange} />
      {searchOpen && (
        <label className="compact-search session-search-panel">
          <span className="compact-search-icon"><SidebarIcon name="search" /></span>
          <input
            autoFocus
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                onSearchChange('');
                onSearchOpenChange(false);
              }
            }}
            placeholder={t('搜索会话或目录', 'Search sessions or folders')}
          />
        </label>
      )}
      <div className="project-section-label">{t('项目', 'Projects')}</div>
      <nav className="session-list" aria-label={t('项目和原会话', 'Projects and original chats')}>
        {groups.map(group => <section className="project-group" key={group.id}>
          <button type="button" className="project-group-heading" title={group.path}
            aria-expanded={search.trim() ? true : expanded.has(group.id)}
            onClick={() => setExpanded(current => {
              const next = new Set(current); if (next.has(group.id)) next.delete(group.id); else next.add(group.id); writeLocal('personal.projects.' + environmentId, [...next]); return next;
            })}>
            <span className="project-chevron" aria-hidden="true">{!search.trim() && !expanded.has(group.id) ? '›' : '⌄'}</span>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M3 7V5a1 1 0 0 1 1-1h6l2 3h8a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7z" /></svg>
            <span>{group.name}</span><small>{group.sessions.length}</small>
          </button>
          {(search.trim() || expanded.has(group.id)) && <div className="project-chats">{group.sessions.map((session) => {
          const sessionRunning = isSessionRunning(session.status)
            || attention[session.id] === 'running'
            || (session.id === selectedThreadId
              && (executionState === 'running' || executionState === 'waiting'));
          const completedUnread = !sessionRunning && attention[session.id] === 'unread';
          const projectName = sessionProjectName(session.cwd);
          return (
            <button
              key={session.id}
              data-thread-id={session.id}
              className={`session-card ${selectedThreadId === session.id ? 'active' : ''} ${sessionRunning ? 'running' : ''} ${completedUnread ? 'completed-unread' : ''}`}
              onClick={() => onSelect(session)}
            >
              <span className="session-title" title={session.title || session.id}>{session.title || session.id}</span>
              <span className="session-meta">
                {sessionRunning && <span className="session-running-dot" aria-label={t('运行中', 'Running')} title={t('运行中', 'Running')} />}
                {completedUnread && <span className="session-unread-dot" aria-label={t('已完成，未读', 'Completed, unread')} title={t('已完成，未读', 'Completed, unread')} />}
                <span
                  className={projectName ? 'session-project' : 'session-project placeholder'}
                  title={projectName ? session.cwd : undefined}
                >
                  {projectName || t('普通会话', 'General session')}
                </span>
                <time>{formatDate(session.updatedAt)}</time>
              </span>
            </button>
          );
        })}</div>}
        </section>)}
        {!visibleSessions.length && <p className="empty-list">{t('没有匹配的会话', 'No matching sessions')}</p>}
      </nav>
    </aside>
  );
});
