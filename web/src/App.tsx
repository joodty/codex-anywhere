import { MessageEditDialog, type MessageEditPlan } from './message-edit-dialog';
import {
  KeyboardEvent,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { SessionStatusOverlay, type SessionStatusSnapshot } from '../../src/shared/session-status';
import {
  attachLatestAssistantFileChanges,
  appendStreamedMessageText,
  appendUniqueTimelineError,
  attachmentRegistryKey,
  parseAssistantMessage,
  historyFingerprint,
  historyItems,
  isDuplicateFinalProgress,
  latestTurnProgressItemId,
  loadKnownAttachments,
  mergeHistorySnapshot,
  acknowledgeOptimisticUser,
  prependHistoryPage,
  resolveTimelineAttachment,
  storeKnownAttachments,
  type ImageAttachment,
  type KnownAttachment,
  type TimelineItem,
  type TimelineKind,
} from './history-utils';
import {
  buildImageMessage,
  fileToBase64,
  formatBytes,
  getClipboardImage,
  type UploadedImage,
} from './image-utils';
import { buildFileMessage, uploadFile } from './file-upload';
import { useAttachmentDraft } from './attachment-draft';
import { useAttachmentQueue } from './attachment-queue';
import { readLocal, writeLocal, useComposerDraft } from './personal-state';
import { ConnectionNotice } from './connection-notice';
import { MessageQueuePanel, useMessageQueue } from './message-queue';
import { useFileTransfer } from './file-transfer';
import { useFilePreviews } from './file-preview-client';
import { restoreOwnedTurn } from './owned-turn';
import { t } from './i18n';
import { adoptDeliveryThread, confirmedDelivery, useDeliveryNotice, visibleDelivery, type MessageDelivery } from './message-delivery';
import {
  buildQuestionReply, normalizeAsyncQuestions, normalizeQuestionReplies, questionReplyText, type QuestionReply,
} from '../../src/shared/async-questions';
import {
  friendlyError,
  canSendToActiveDesktopTurn,
  canSteerOwnedTurn,
  canStopOwnedTurn,
  ownsPendingSubmission,
  initialBootstrapReady,
  isConnectionInterruption,
  isCurrentSessionRequest,
  isSessionRunning,
  isEventForSelectedThread,
  isTemporaryProjectPath,
  makeId,
  markSessionAttentionRead,
  projectLabel,
  reconcileSessionAttention,
  shouldAdoptStartedThread,
  shouldLoadOlderHistory,
  type SessionAttentionState,
} from './app-utils';
import {
  CustomSelect,
  DownloadIndicator,
  SidebarIcon,
} from './ui-components';
import { ConversationTimeline, preloadMessageBubble } from './conversation-timeline';
import { useConversationScroll } from './use-conversation-scroll';
import { useTimelineImages } from './timeline-images';
import { loadHistoryPage } from './history-page-loader';
import { useConversationExecution } from './conversation-execution';
import { SessionSidebar } from './session-sidebar';
import { SessionRenameDialog } from './session-rename-dialog';
import { SessionArchiveDialog } from './session-archive-dialog';
import { ApprovalNotice, ArchivedSessionNotice } from './session-notices';
import { createApprovalPoller, resolvedDesktopExecution } from './approval-poller';
import { SessionDeleteDialog } from './session-delete-dialog';
import {
  epochMillis,
  liveEventActivity,
  LiveActivityStatus,
  RunDetailsSheet,
  safeActivityKind,
} from './live-activity';
import { ModelConfigControl } from './model-config-control';
import { StartupScreen } from './startup-screen';
import {
  SESSION_PERMISSION_MODE_KEY,
  useSessionConfiguration,
} from './session-configuration';
import {
  BridgeRequestManager,
  type BridgeRequestOptions as RequestOptions,
} from './bridge-request-manager';
import { BrowserSecureChannel } from './secure-channel-client';
import { sendWebSocketFrame } from './websocket-send';
import { ImageUploadProgress, type ImageUploadState } from './image-upload-progress';
import {
  DEFAULT_ENVIRONMENT_ID,
  environmentDisplayName,
  readEnvironmentInventory,
  type EnvironmentLabels,
  environmentOfflineLabel,
  environmentOnlineLabel,
  environmentShortName,
  loadEnvironmentValue,
  loadKnownEnvironmentIds,
  loadSelectedEnvironmentId,
  mergeKnownEnvironmentIds,
  normalizeEnvironmentId,
  normalizeEnvironmentIds,
  storeEnvironmentValue,
  storeKnownEnvironmentIds,
  storeSelectedEnvironmentId,
} from './execution-environments';
import { normalizeToolPurpose } from '../../src/shared/message-content';
import {
  normalizeContextUsage,
  type ContextUsage,
} from '../../src/shared/context-compaction';
import type { TimelineNotice } from '../../src/shared/timeline-notice';
import { appendTimelineNotice } from './timeline-notice-events';
import { clearPendingCompactions, finishTimelineCompaction, startTimelineCompaction, syncTimelineCompaction } from './compaction-timeline';
import { PresenceIndicator } from './presence-indicator';
import { PermissionModeControl } from './permission-mode-control';
import { BrowserSessionStatus } from './browser-session-status';
import { useSidePanelSession } from './sidepanel-session';
import {
  normalizePermissionMode,
  type PermissionMode,
} from '../../src/shared/permission-mode';
import {
  normalizeTurnProgress,
  type TurnFileProgress,
  type TurnProgress,
} from '../../src/shared/turn-progress';
import { requireCurrentProtocol } from '../../src/shared/protocol-contract';
import {
  clearBrowserDeviceApproval,
  createBrowserDeviceProof,
  hasApprovedBrowserDevice,
  loadOrCreateBrowserDeviceIdentity,
  markBrowserDeviceApproved,
} from './device-identity';
import {
  DEVICE_KEY_AUTH_CONTEXT,
  browserPairingVerifier,
  createBrowserPairingProof,
  encodeBrowserPairingCredential,
  type BrowserPairingCredential,
} from '../../src/shared/pairing-auth';
import { PAIRING_TIMEOUT_MS, PENDING_PAIRING_KEY, pairingFailureMessage, takePairingInput } from './pairing-input';
import type {
  Approval,
  NativeDesktopState,
  AwaitingDesktopTurn,
  BridgeMessage,
  FollowState,
  HistoryPage,
  PendingApprovals,
  PendingAttachment,
  Session,
  TurnStartResult,
} from './app-types';

const HISTORY_PAGE_SIZE = 6;
const RECONNECT_MAX_DELAY_MS = 30_000;
const CLIENT_HEARTBEAT_MS = 20_000;
const CLIENT_STALE_AFTER_MS = 55_000;
const SESSION_STATUS_REFRESH_MS = 6_000;
const INITIAL_BOOTSTRAP_TIMEOUT_MS = 10_000;
const SESSION_ATTENTION_KEY = 'bridge.sessionAttention.v1';
const LAST_THREAD_KEY = 'bridge.lastThreadId';
const NEW_SESSION_CWD_KEY = 'bridge.newSessionCwd';
const NEW_TURN_KEY = '__new_turn__';
const PairingDialog = lazy(() => import('./pairing-dialog').then((module) => ({
  default: module.PairingDialog,
})));

function loadSessionAttention(environmentId = DEFAULT_ENVIRONMENT_ID): SessionAttentionState {
  try {
    const stored = JSON.parse(
      loadEnvironmentValue(SESSION_ATTENTION_KEY, environmentId) || '{}',
    ) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(stored)
      .filter(([id, state]) => id && (state === 'running' || state === 'unread'))
      .slice(-200)) as SessionAttentionState;
  } catch {
    return {};
  }
}

function storeSessionAttention(environmentId: string, value: SessionAttentionState) {
  storeEnvironmentValue(SESSION_ATTENTION_KEY, environmentId, JSON.stringify(value));
}


export default function App({ initialPairingInput = null }: { initialPairingInput?: string | null } = {}) {
  const [pairingCredential, setPairingCredential] = useState<BrowserPairingCredential | null>(null);
  const [pairingInput, setPairingInput] = useState(initialPairingInput || '');
  const [pairingError, setPairingError] = useState('');
  const [pairingDialogOpen, setPairingDialogOpen] = useState(initialPairingInput !== null);
  const initialEnvironmentIdRef = useRef(loadSelectedEnvironmentId());
  const [environmentId, setEnvironmentId] = useState(initialEnvironmentIdRef.current);
  const [environmentIds, setEnvironmentIds] = useState(() => mergeKnownEnvironmentIds(
    loadKnownEnvironmentIds(), [], initialEnvironmentIdRef.current,
  ));
  const [onlineEnvironmentIds, setOnlineEnvironmentIds] = useState<string[]>([]);
  const [environmentLabels, setEnvironmentLabels] = useState<EnvironmentLabels>({});
  const [hasEnvironmentInventory, setHasEnvironmentInventory] = useState(false);
  const environmentLabelsRef = useRef(environmentLabels);
  environmentLabelsRef.current = environmentLabels;
  const [newSessionCwd, setNewSessionCwd] = useState(() => {
    const stored = loadEnvironmentValue(NEW_SESSION_CWD_KEY, initialEnvironmentIdRef.current) || '';
    return isTemporaryProjectPath(stored) ? '' : stored;
  });
  const [authenticated, setAuthenticated] = useState(false);
  const [initialBootstrapPending, setInitialBootstrapPending] = useState(() => (
    hasApprovedBrowserDevice() && initialPairingInput === null
  ));
  const [sessionsInitialized, setSessionsInitialized] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [online, setOnline] = useState(false);
  const [statusText, setStatusText] = useState(t('未连接', 'Disconnected'));
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionAttention, setSessionAttention] = useState<SessionAttentionState>(() => (
    loadSessionAttention(initialEnvironmentIdRef.current)
  ));
  const [sessionSearch, setSessionSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);
  const [editTarget, setEditTarget] = useState<{ item: TimelineItem; threadId: string; environment: string; selection: number } | null>(null);
  const [editingMessage, setEditingMessage] = useState(false);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [resolvedQuestionAnswers, setResolvedQuestionAnswers] = useState<Record<string, string>>({});
  const visibleQuestionIdsRef = useRef<string[]>([]);
  visibleQuestionIdsRef.current = [...new Set(timeline.flatMap((item) => item.questions?.map((question) => question.id) || []))]
    .filter((id) => !Object.prototype.hasOwnProperty.call(resolvedQuestionAnswers, id)).slice(-512);
  const rememberQuestionReplies = useCallback((replies: QuestionReply[] = []) => {
    // Each reply is validated independently; a history page may cover many
    // separate question batches (the per-call maximum is not a page maximum).
    const valid = replies.flatMap((reply) => normalizeQuestionReplies([reply]) || []);
    if (!valid.length) return;
    setResolvedQuestionAnswers((current) => valid.every((reply) => current[reply.questionItemId] === reply.answer)
      ? current : { ...current, ...Object.fromEntries(valid.map((reply) => [reply.questionItemId, reply.answer])) });
  }, []);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [olderHistoryError, setOlderHistoryError] = useState(false);
  const [olderHistoryAutoLoadEnabled, setOlderHistoryAutoLoadEnabled] = useState(false);
  const [initialHistoryLoaded, setInitialHistoryLoaded] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [prompt, setPrompt, draftSaved] = useComposerDraft(JSON.stringify([environmentId, threadId || 'new']));
  const { attachments: pendingAttachments, setAttachments: setPendingAttachments, choose: prepareMessageAttachments, invalidate: invalidateMessageAttachment } = useAttachmentQueue();
  const pendingAttachment = pendingAttachments[0] || null;
  const setPendingAttachment = useCallback((value: React.SetStateAction<PendingAttachment | null>) => setPendingAttachments(current => {
    const next = typeof value === 'function' ? value(current[0] || null) : value; return next ? [next] : [];
  }), [setPendingAttachments]);
  const [imageQuality, setImageQuality] = useState<'economy' | 'high'>(() => readLocal('personal.imageQuality', 'economy'));
  const completedUploadsRef = useRef(new WeakMap<File, { path: string; name: string; size: number; sha256: string }>());
  const [uploadingLabel, setUploadingLabel] = useState('');
  const uploadOwnerRef = useRef<string | null>(null);
  const [knownAttachments, setKnownAttachments] = useState<Record<string, KnownAttachment>>(loadKnownAttachments);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<ImageUploadState | null>(null);
  const [messageDelivery, setMessageDelivery] = useState<MessageDelivery | null>(null);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [nativeState, setNativeState] = useState<{ environmentId: string; value: NativeDesktopState } | null>(null);
  const desktopState = online && nativeState?.environmentId === environmentId && nativeState.value.threadId === threadId ? nativeState.value : null;
  const approvalRef = useRef(approval);
  approvalRef.current = approval;
  const approvalPollRef = useRef<ReturnType<typeof createApprovalPoller> | null>(null);
  const [approvalStatusError, setApprovalStatusError] = useState('');
  const [refreshingApproval, setRefreshingApproval] = useState(false);
  const [followState, setFollowState] = useState<FollowState>('idle');
  const {
    execution: {
      running,
      ownedTurnThreadId,
      state: executionState,
      purpose: toolPurpose,
      detail: activityDetail,
      activity: liveActivity,
      startedAt: activityStartedAt,
      compactionStartedAt,
      progress: turnProgress,
    },
    resetExecution,
    resetExecutionPresentation,
    updateExecution,
    setState: setExecutionState,
    setPurpose: setToolPurpose,
    setDetail: setActivityDetail,
    setActivity: setLiveActivity,
    setProgress: setTurnProgress,
  } = useConversationExecution();
  const [creatingNewSession, setCreatingNewSession] = useState(false);
  const [newSessionDialogOpen, setNewSessionDialogOpen] = useState(false);
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState<{ id: string; title: string; environment: string; cancelPendingApproval?: boolean } | null>(null);
  const [lastArchived, setLastArchived] = useState<{ id: string; title: string; environment: string } | null>(null);
  const [restoringSession, setRestoringSession] = useState(false);
  const [restoreError, setRestoreError] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<{ session: Session; environmentId: string } | null>(null);
  const deletedSessionsRef = useRef(new Map<string, Set<string>>());
  const [newSessionPrompt, setNewSessionPrompt] = useState('');
  const [newSessionPermissionMode, setNewSessionPermissionMode] = useState<PermissionMode>('ask');
  const { attachment: newSessionAttachment, setAttachment: setNewSessionAttachment, choose: prepareNewSessionAttachment } = useAttachmentDraft();
  const closeNewSessionDialog = useCallback(() => {
    setNewSessionDialogOpen(false);
    setNewSessionAttachment(null);
  }, [setNewSessionAttachment]);
  const [newSessionError, setNewSessionError] = useState('');
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const [resumeEpoch, setResumeEpoch] = useState(0);
  const [runDetailsOpen, setRunDetailsOpen] = useState(false);
  const [stopping, setStopping] = useState(false);

  const socketRef = useRef<WebSocket | null>(null);
  const pairingCredentialRef = useRef(pairingCredential);
  const approvedDeviceRef = useRef(hasApprovedBrowserDevice() && initialPairingInput === null);
  const authAttemptModeRef = useRef<'device' | 'pairing'>('device');
  const pairingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectWantedRef = useRef(false);
  const socketAuthenticatedRef = useRef(false);
  const environmentIdRef = useRef(environmentId);
  const onlineEnvironmentIdsRef = useRef<string[]>([]);
  const connectorOnlineRef = useRef(false);
  const secureChannelRef = useRef<BrowserSecureChannel | null>(null);
  const sessionStatusesRef = useRef(new SessionStatusOverlay());
  const messageHandlerRef = useRef<(message: BridgeMessage) => void>(() => {});
  const lastServerActivityRef = useRef(0);
  const scheduleReconnectRef = useRef<(immediate?: boolean) => void>(() => {});
  const threadIdRef = useRef<string | null>(null);
  const selectedRequestRef = useRef(0);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const messageContentRef = useRef<HTMLDivElement | null>(null);
  const viewport = useConversationScroll(messageListRef, messageContentRef, `${environmentId}:${threadId}`, initialBootstrapPending);
  const streamItemRef = useRef<{ id: string; kind: TimelineKind; sourceItemId: string } | null>(null);
  const activeTurnIdRef = useRef('');
  const executionVersionRef = useRef(0);
  const turnProgressRef = useRef<TurnProgress>({});
  const followFingerprintRef = useRef('');
  const latestActivityIdRef = useRef('');
  const awaitingDesktopTurnRef = useRef<AwaitingDesktopTurn | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const newSessionAttachmentInputRef = useRef<HTMLInputElement | null>(null);
  const newSessionAutoSendRef = useRef(false);
  const pendingNewRequestRef = useRef<string | null>(null);
  const sendingRef = useRef(new Set<string>());
  const sessionRefreshInFlightRef = useRef<{ environment: string; channel: BrowserSecureChannel | null } | null>(null);
  const olderHistoryLoadingRef = useRef<number | null>(null);
  const initialHistoryAttemptRef = useRef('');
  const liveHistoryHydratedThreadRef = useRef<string | null>(null);
  const runningRef = useRef(running);
  const ownedTurnThreadIdRef = useRef(ownedTurnThreadId);
  const sessionAttentionRef = useRef(sessionAttention);
  const requestManagerRef = useRef<BridgeRequestManager | null>(null);
  const relayRequestsRef = useRef<BridgeRequestManager | null>(null);
  if (!relayRequestsRef.current) relayRequestsRef.current = new BridgeRequestManager({
    isConnected: () => Boolean(socketAuthenticatedRef.current && socketRef.current?.readyState === WebSocket.OPEN),
    send: frame => {
      if (socketRef.current?.readyState !== WebSocket.OPEN) return false;
      socketRef.current.send(JSON.stringify({ ...frame, type: 'relay.request' }));
      return true;
    },
  });
  if (!requestManagerRef.current) {
    requestManagerRef.current = new BridgeRequestManager({
      isConnected: () => socketRef.current?.readyState === WebSocket.OPEN,
      send: (frame, options) => secureChannelRef.current?.sendFrame(frame, options) === true,
    });
  }

  useEffect(() => { threadIdRef.current = threadId; }, [threadId]);
  useEffect(() => { environmentIdRef.current = environmentId; }, [environmentId]);
  useEffect(() => { runningRef.current = running; }, [running]);
  useEffect(() => { ownedTurnThreadIdRef.current = ownedTurnThreadId; }, [ownedTurnThreadId]);
  useEffect(() => {
    if (executionState !== 'running' && executionState !== 'waiting') {
      setRunDetailsOpen(false);
      setStopping(false);
    }
  }, [executionState]);
  useEffect(() => { setRunDetailsOpen(false); }, [environmentId, threadId]);

  const finishInitialBootstrap = useCallback(() => {
    setInitialBootstrapPending(false);
  }, []);

  const updateSessionAttention = useCallback((
    update: (current: SessionAttentionState) => SessionAttentionState,
  ) => {
    setSessionAttention((current) => {
      const next = update(current);
      sessionAttentionRef.current = next;
      if (next !== current) storeSessionAttention(environmentIdRef.current, next);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!threadId) return;
    if (executionState === 'running' || executionState === 'waiting') {
      updateSessionAttention((current) => current[threadId] === 'running'
        ? current : { ...current, [threadId]: 'running' });
    } else if (executionState === 'completed' || executionState === 'failed') {
      updateSessionAttention((current) => {
        if (!current[threadId]) return current;
        const next = { ...current };
        delete next[threadId];
        return next;
      });
    }
  }, [executionState, threadId, updateSessionAttention]);
  useEffect(() => {
    if (!newSessionDialogOpen) return undefined;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') closeNewSessionDialog();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [newSessionDialogOpen, closeNewSessionDialog]);


  useEffect(() => {
    if (executionState !== 'completed') return;
    const timer = setTimeout(() => setExecutionState('idle'), 3_000);
    return () => clearTimeout(timer);
  }, [executionState]);

  const addTimeline = useCallback((
    kind: TimelineKind,
    text: string,
    scroll = true,
    transient = false,
    attachment?: ImageAttachment,
  ) => {
    const item = { id: makeId(), kind, text, transient, attachment };
    if (scroll) {
      viewport.following = true;
      viewport.forceBottom = true;
    }
    setTimeline((current) => kind === 'error'
      ? appendUniqueTimelineError(current, item)
      : [...current, item]);
    return item.id;
  }, []);

  const addTimelineNotice = useCallback((notice: TimelineNotice, turnId?: string) => {
    const item: TimelineItem = {
      id: makeId(),
      kind: 'system',
      text: '',
      notice,
      transient: true,
      historyTurnId: turnId || activeTurnIdRef.current || undefined,
      completedAt: Date.now(),
    };
    if (viewport.following) viewport.forceBottom = true;
    setTimeline((current) => appendTimelineNotice(current, item));
    return item.id;
  }, []);

  const reportTimelineError = useCallback((error: unknown) => {
    if (isConnectionInterruption(error)) return;
    addTimeline('error', friendlyError(error));
  }, [addTimeline]);

  const rememberAttachment = useCallback((targetThreadId: string, text: string, attachment: ImageAttachment) => {
    if (!targetThreadId || !text.trim()) return;
    setKnownAttachments((current) => {
      const next = {
        ...current,
        [attachmentRegistryKey(targetThreadId, text, environmentIdRef.current)]: {
          ...attachment, savedAt: Date.now(),
        },
      };
      const limited = Object.fromEntries(Object.entries(next)
        .sort((left, right) => left[1].savedAt - right[1].savedAt)
        .slice(-40));
      try { storeKnownAttachments(limited); } catch { /* keep in memory */ }
      return limited;
    });
  }, []);

  const appendStream = useCallback((kind: TimelineKind, text: string, sourceItemId = '') => {
    if (!text) return;
    if (viewport.following) viewport.forceBottom = true;
    const current = streamItemRef.current;
    if (current?.kind === kind) {
      const normalizedSourceItemId = sourceItemId.trim();
      const newProgressItem = kind === 'progress'
        && Boolean(normalizedSourceItemId && current.sourceItemId
          && normalizedSourceItemId !== current.sourceItemId);
      if (normalizedSourceItemId) current.sourceItemId = normalizedSourceItemId;
      setTimeline((items) => items.map((item) => item.id === current.id
        ? { ...item, text: appendStreamedMessageText(item.text, text, newProgressItem) }
        : item));
      return;
    }
    const id = makeId();
    streamItemRef.current = { id, kind, sourceItemId: sourceItemId.trim() };
    setTimeline((items) => [...items, {
      id, kind, text, transient: true,
      ...(activeTurnIdRef.current ? { historyTurnId: activeTurnIdRef.current } : {}),
    }]);
  }, []);

  const finishAssistant = useCallback((text: string, fileChanges?: TurnFileProgress) => {
    const content = parseAssistantMessage(text);
    const visibleText = content.text;
    if (!visibleText) return;
    if (viewport.following) viewport.forceBottom = true;
    const current = streamItemRef.current;
    const completedAt = Date.now();
    streamItemRef.current = null;
    setTimeline((items) => {
      const nextItems = current?.kind === 'progress'
        && items.some((item) => item.id === current.id && isDuplicateFinalProgress(item.text, visibleText))
        ? items.filter((item) => item.id !== current.id)
        : items;
      if (current?.kind === 'assistant' && nextItems.some((item) => item.id === current.id)) {
        return nextItems.map((item) => item.id === current.id
          ? {
            ...item,
            text: visibleText,
            contexts: content.contexts,
            completedAt,
            ...(fileChanges ? { fileChanges } : {}),
          }
          : item);
      }
      return [...nextItems, {
        id: makeId(), kind: 'assistant', text: visibleText, contexts: content.contexts, transient: true,
        ...(activeTurnIdRef.current ? { historyTurnId: activeTurnIdRef.current } : {}),
        ...(fileChanges ? { fileChanges } : {}),
        completedAt,
      }];
    });
  }, []);

  const request = useCallback(<T,>(
    action: string,
    payload: Record<string, unknown>,
    options: RequestOptions = {},
  ): Promise<T> => requestManagerRef.current!.request<T>(action, payload, options), []);

  const { fileDownload, downloadLocalFile, cancelFileDownload } = useFileTransfer({
    online, request, reportTimelineError, environmentIdRef, selectedRequestRef, connectorOnlineRef, secureChannelRef,
  });
  const downloadOriginalFile = useCallback(async (path: string) => {
    try { const original = await request<{ path: string }>('attachment.original', { path }); await downloadLocalFile(original.path); }
    catch (error) { reportTimelineError(error); }
  }, [request, downloadLocalFile, reportTimelineError]);
  const { readVisualization, readTextFile, readTurnDiff, readPreviewImage } = useFilePreviews(request, threadId);

  const {
    connectorStatus,
    modelConfig,
    modelConfigLoading,
    refreshModelConfig,
    permissionConfig,
    permissionConfigLoading,
    saveModelConfig,
    savePermissionMode,
    refreshPermissionConfig,
    openPermissionSettingsOnDesktop,
  } = useSessionConfiguration({ environmentId, online, threadId, request, desktopState,
    recoveryKey: `${connectionEpoch}:${resumeEpoch}` });
  const queueSupported = connectorStatus?.capabilities.messageQueue === true;
  const messageQueue = useMessageQueue({ environmentId, threadId, online, supported: queueSupported, request });
  const queueRefreshRef = useRef(messageQueue.refresh); queueRefreshRef.current = messageQueue.refresh;

  const replayPendingRequests = useCallback(() => {
    if (!secureChannelRef.current?.isReady()) return 0;
    return requestManagerRef.current!.replay();
  }, []);

  const timelineAttachments = useMemo(() => {
    const attachments = new Map<string, ImageAttachment>();
    for (const item of timeline) {
      const attachment = resolveTimelineAttachment(item, threadId, knownAttachments, environmentId);
      if (attachment) attachments.set(attachment.path, attachment);
    }
    return [...attachments.values()];
  }, [environmentId, knownAttachments, threadId, timeline]);

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === threadId) || null,
    [sessions, threadId],
  );

  const { attachmentUrls, attachmentNames, rememberImage, retryImages } = useTimelineImages(
    `${environmentId}:${threadId}:${selectedRequestRef.current}`, timelineAttachments, online, connectionEpoch, request,
  );

  const refreshSessions = useCallback(async () => {
    const refresh = { environment: environmentIdRef.current, channel: secureChannelRef.current };
    if (sessionRefreshInFlightRef.current?.environment === refresh.environment
      && sessionRefreshInFlightRef.current?.channel === refresh.channel) return [];
    sessionRefreshInFlightRef.current = refresh;
    try {
      const data = await request<{ sessions: Session[]; desktopStatuses?: SessionStatusSnapshot | null }>('sessions.list', {});
      if (sessionRefreshInFlightRef.current !== refresh || environmentIdRef.current !== refresh.environment
        || secureChannelRef.current !== refresh.channel) return [];
      sessionStatusesRef.current.accept(data.desktopStatuses);
      const nextSessions = sessionStatusesRef.current.apply((data.sessions || []).filter(session => !deletedSessionsRef.current.get(refresh.environment)?.has(session.id)),
        runningRef.current ? ownedTurnThreadIdRef.current || '' : '');
      setSessions(nextSessions);
      setSessionsInitialized(true);
      return nextSessions;
    } catch {
      // Session refreshes are background synchronization. Connection status and
      // the next retry communicate failures without polluting the conversation.
      return [];
    } finally {
      if (sessionRefreshInFlightRef.current === refresh) sessionRefreshInFlightRef.current = null;
    }
  }, [request, updateSessionAttention]);

  useEffect(() => {
    if (!sessionsInitialized) return;
    updateSessionAttention(current => reconcileSessionAttention(current, sessions, threadIdRef.current,
      runningRef.current ? ownedTurnThreadIdRef.current : null));
  }, [sessions, sessionsInitialized, updateSessionAttention]);

  const beginSecureChannel = useCallback((routeDeviceId = environmentIdRef.current) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    secureChannelRef.current?.clear();
    sessionStatusesRef.current = new SessionStatusOverlay();
    const channel = new BrowserSecureChannel({
      identity: loadOrCreateBrowserDeviceIdentity(),
      routeDeviceId,
      send: (frame, options) => {
        if (socketRef.current !== socket || socket.readyState !== WebSocket.OPEN) return false;
        return sendWebSocketFrame(socket, frame, options);
      },
      onFrame: (frame) => messageHandlerRef.current(frame as BridgeMessage),
      onReady: () => {
        if (secureChannelRef.current !== channel || environmentIdRef.current !== routeDeviceId) return;
        connectorOnlineRef.current = true;
        setConnectionEpoch((current) => current + 1);
        setOnline(true);
        setStatusText(environmentOnlineLabel(routeDeviceId, environmentLabelsRef.current));
        replayPendingRequests();
        void refreshSessions();
      },
      onError: () => {
        if (secureChannelRef.current !== channel || environmentIdRef.current !== routeDeviceId) return;
        connectorOnlineRef.current = false;
        setOnline(false);
        setStatusText(t('安全通道中断，正在重连…', 'Secure channel interrupted. Reconnecting…'));
        if (socketRef.current === socket) socket.close(4410, 'secure channel failed');
      },
    });
    secureChannelRef.current = channel;
    return channel.start();
  }, [refreshSessions, replayPendingRequests]);

  const handleBridgeMessage = useCallback((message: BridgeMessage) => {
    if (message.type === 'auth.pairing') {
      setStatusText(t('当前设备等待批准', 'This device is waiting for approval'));
      return;
    }
    if (message.type === 'auth.ok') {
      approvedDeviceRef.current = true;
      markBrowserDeviceApproved();
      pairingCredentialRef.current = null;
      setPairingCredential(null);
      if (pairingTimeoutRef.current) clearTimeout(pairingTimeoutRef.current);
      pairingTimeoutRef.current = null;
      authAttemptModeRef.current = 'device';
      setPairingInput('');
      setPairingError('');
      setPairingDialogOpen(false);
      try {
        sessionStorage.removeItem(PENDING_PAIRING_KEY);
      } catch { /* blocked store */ }
      socketAuthenticatedRef.current = true;
      reconnectAttemptRef.current = 0;
      setAuthenticated(true);
      setConnecting(false);
      const devices = normalizeEnvironmentIds(message.devices);
      onlineEnvironmentIdsRef.current = devices;
      setOnlineEnvironmentIds(devices);
      const inventory = readEnvironmentInventory(message.environments);
      setHasEnvironmentInventory(Boolean(inventory));
      environmentLabelsRef.current = inventory?.labels || {};
      setEnvironmentLabels(environmentLabelsRef.current);
      setEnvironmentIds((current) => {
        const next = inventory?.ids ?? mergeKnownEnvironmentIds(current, devices, environmentIdRef.current);
        storeKnownEnvironmentIds(next);
        return next;
      });
      const routeDeviceId = environmentIdRef.current;
      const connected = devices.includes(routeDeviceId);
      if (connected) {
        connectorOnlineRef.current = false;
        setOnline(false);
        setStatusText(t('正在建立安全通道…', 'Establishing secure channel…'));
        beginSecureChannel(routeDeviceId);
      } else {
        secureChannelRef.current?.clear();
        secureChannelRef.current = null;
        connectorOnlineRef.current = false;
        setOnline(false);
        setStatusText(environmentOfflineLabel(routeDeviceId, environmentLabelsRef.current));
        finishInitialBootstrap();
      }
      return;
    }
    if (message.type === 'relay.response') {
      relayRequestsRef.current!.handle({ ...message, type: 'response' });
      return;
    }
    if (message.type === 'pong') return;
    if (requestManagerRef.current!.handle(message)) return;
    if (message.type === 'presence') {
      const devices = normalizeEnvironmentIds(message.devices);
      onlineEnvironmentIdsRef.current = devices;
      setOnlineEnvironmentIds(devices);
      const inventory = readEnvironmentInventory(message.environments);
      setHasEnvironmentInventory(Boolean(inventory));
      environmentLabelsRef.current = inventory?.labels || {};
      setEnvironmentLabels(environmentLabelsRef.current);
      setEnvironmentIds((current) => {
        const next = inventory?.ids ?? mergeKnownEnvironmentIds(current, devices, environmentIdRef.current);
        storeKnownEnvironmentIds(next);
        return next;
      });
      const routeDeviceId = environmentIdRef.current;
      const connected = devices.includes(routeDeviceId);
      if (!connected) {
        secureChannelRef.current?.clear();
        secureChannelRef.current = null;
        connectorOnlineRef.current = false;
        setOnline(false);
        setStatusText(environmentOfflineLabel(routeDeviceId, environmentLabelsRef.current));
        finishInitialBootstrap();
      } else {
        if (!secureChannelRef.current?.isReady()) {
          connectorOnlineRef.current = false;
          setOnline(false);
          setStatusText(t('正在建立安全通道…', 'Establishing secure channel…'));
          if (!secureChannelRef.current) beginSecureChannel(routeDeviceId);
        }
      }
      return;
    }
    if (message.type !== 'event') return;
    if (['turn.started', 'turn.ended', 'turn.error', 'approval.requested', 'approval.resolved'].includes(message.event || '')) {
      executionVersionRef.current += 1;
    }
    const payload = message.payload || {};
    if (message.event === 'queue.changed') {
      if (payload.threadId === threadIdRef.current) void queueRefreshRef.current();
      return;
    }
    if (message.event === 'sessions.status') {
      if (sessionStatusesRef.current.accept(payload as SessionStatusSnapshot)) {
        setSessions(current => sessionStatusesRef.current.apply(current,
          runningRef.current ? ownedTurnThreadIdRef.current || '' : ''));
      }
      return;
    }
    const eventThreadId = String(payload.threadId || '');
    if (message.event === 'desktop.state') {
      if (eventThreadId === threadIdRef.current) {
        const state = payload as NativeDesktopState;
        setNativeState({ environmentId: environmentIdRef.current, value: state });
        approvalPollRef.current?.push({ approvals: state.approvals || [], desktopState: { ...state, waitingOnApproval: Boolean(state.waitingOnApproval) },
          ...(state.waitingOnApproval && !state.approvals?.length ? { externalApproval: {
            approvalId: '', threadId: eventThreadId, kind: 'desktop', source: 'desktop', actionable: false,
          } } : {}) });
      }
      return;
    }
    if (
      message.event !== 'turn.started'
      && !isEventForSelectedThread(eventThreadId, threadIdRef.current, ownedTurnThreadIdRef.current)
    ) {
      const ended = message.event === 'turn.error' || message.event === 'turn.ended';
      if (eventThreadId) updateSessionAttention((current) => ({
        ...current, [eventThreadId]: ended ? 'unread' : 'running',
      }));
      if (ended) {
        void refreshSessions();
      }
      return;
    }
    if (message.event === 'turn.started') {
      const selectedThreadId = threadIdRef.current;
      const previousOwnedThreadId = ownedTurnThreadIdRef.current;
      const nextThreadId = String(payload.threadId || '');
      const adoptStartedThread = shouldAdoptStartedThread(
        nextThreadId, selectedThreadId, previousOwnedThreadId === NEW_TURN_KEY
          && Boolean(message.requestId) && message.requestId === pendingNewRequestRef.current,
      );
      if (nextThreadId && !adoptStartedThread) {
        updateSessionAttention((current) => ({ ...current, [nextThreadId]: 'running' }));
        return;
      }
      activeTurnIdRef.current = String(payload.turnId || '');
      runningRef.current = true;
      ownedTurnThreadIdRef.current = nextThreadId || selectedThreadId || NEW_TURN_KEY;
      turnProgressRef.current = {};
      updateExecution({
        running: true,
        ownedTurnThreadId: ownedTurnThreadIdRef.current,
        purpose: '',
        detail: '',
        progress: {},
        activity: 'starting',
        compactionStartedAt: null,
        startedAt: Date.now(),
        ...(nextThreadId ? { state: 'running' as const } : {}),
      });
      if (nextThreadId) {
        const deliveryEnvironment = environmentIdRef.current;
        const deliverySelection = selectedRequestRef.current;
        setMessageDelivery((current) => adoptDeliveryThread(current, deliveryEnvironment, deliverySelection, nextThreadId));
        setThreadId(nextThreadId);
        threadIdRef.current = nextThreadId;
        storeEnvironmentValue(LAST_THREAD_KEY, environmentIdRef.current, nextThreadId);
        setCreatingNewSession(false);
      }
    } else if (message.event === 'turn.compaction') {
      if (String(payload.turnId || '') !== activeTurnIdRef.current) return;
      const startedAt = epochMillis(payload.startedAt);
      updateExecution({ compactionStartedAt: startedAt });
      setTimeline(current => startedAt
        ? startTimelineCompaction(current, String(payload.turnId), startedAt)
        : finishTimelineCompaction(current, String(payload.turnId), Date.now()));
      if (viewport.following) viewport.forceBottom = true;
    } else if (message.event === 'turn.delta') {
      setLiveActivity('responding');
      appendStream(
        payload.phase === 'final_answer' ? 'assistant' : 'progress',
        String(payload.delta || ''),
        String(payload.itemId || ''),
      );
    } else if (message.event === 'turn.reasoning') {
      setLiveActivity('planning');
      const purpose = normalizeToolPurpose(payload.text);
      if (purpose) setToolPurpose(purpose);
    } else if (message.event === 'turn.progress') {
      const progress = normalizeTurnProgress(payload);
      turnProgressRef.current = { ...turnProgressRef.current, ...progress };
      setTurnProgress(turnProgressRef.current);
    } else if (message.event === 'tool.started') {
      setLiveActivity(liveEventActivity(payload));
      const detail = normalizeToolPurpose(payload.detail);
      if (detail) setActivityDetail(detail);
    } else if (message.event === 'tool.completed') {
      setLiveActivity('checking');
      const detail = normalizeToolPurpose(payload.detail);
      if (detail) setActivityDetail(`✓ ${detail}`);
    } else if (message.event === 'turn.questions') {
      const questions = normalizeAsyncQuestions(payload.questions);
      if (!questions) return;
      streamItemRef.current = null;
      if (viewport.following) viewport.forceBottom = true;
      setTimeline((current) => current.some((item) => item.questions?.[0]?.id === questions[0].id)
        ? current : [...current, {
          id: `questions:${questions[0].id}`, kind: 'assistant', questions,
          text: questions.map((question) => question.title).join('\n\n'),
          historyTurnId: String(payload.turnId || activeTurnIdRef.current || ''),
          completedAt: Date.now(), transient: true,
        }]);
    } else if (message.event === 'turn.final') {
      setLiveActivity('responding');
      const text = String(payload.text || '');
      finishAssistant(text, turnProgressRef.current.files);
    } else if (message.event === 'approval.requested') {
      const nextApproval = {
        approvalId: String(payload.approvalId || ''),
        threadId: String(payload.threadId || threadIdRef.current || ''),
        kind: String(payload.kind || 'action'),
        summary: String(payload.summary || ''),
        actionable: true,
      };
      if (!nextApproval.threadId || nextApproval.threadId === threadIdRef.current) {
        setApproval(nextApproval);
        runningRef.current = true;
        ownedTurnThreadIdRef.current = nextApproval.threadId || threadIdRef.current || NEW_TURN_KEY;
        updateExecution((current) => ({
          running: true,
          ownedTurnThreadId: ownedTurnThreadIdRef.current,
          state: 'waiting',
          activity: 'waiting',
          startedAt: current.startedAt || Date.now(),
        }));
        if (viewport.following) viewport.forceBottom = true;
      }
    } else if (message.event === 'approval.resolved') {
      setApproval(null);
      addTimelineNotice({
        kind: 'approval',
        decision: payload.approved === true ? 'approved' : 'rejected',
        approvalKind: String(payload.kind || 'action'),
        summary: String(payload.summary || ''),
      });
    } else if (message.event === 'turn.error') {
      setTimeline(clearPendingCompactions);
      const error = String(payload.error || t('Codex 运行错误', 'Codex execution error'));
      addTimelineNotice({ kind: 'turnStatus', status: 'error', detail: error }, String(payload.turnId || ''));
      streamItemRef.current = null;
      activeTurnIdRef.current = '';
      setApproval(null);
      turnProgressRef.current = {};
      runningRef.current = false;
      ownedTurnThreadIdRef.current = null;
      resetExecution('failed');
    } else if (message.event === 'turn.ended') {
      setTimeline(clearPendingCompactions);
      if (payload.reason === 'cancelled') {
        addTimelineNotice({ kind: 'turnStatus', status: 'aborted', detail: 'cancelled' }, String(payload.turnId || ''));
      } else if (payload.reason === 'failed') {
        addTimelineNotice({ kind: 'turnStatus', status: 'failed', detail: String(payload.error || '') }, String(payload.turnId || ''));
      }
      streamItemRef.current = null;
      activeTurnIdRef.current = '';
      setApproval(null);
      turnProgressRef.current = {};
      runningRef.current = false;
      ownedTurnThreadIdRef.current = null;
      updateExecution((current) => ({
        running: false,
        ownedTurnThreadId: null,
        purpose: '',
        detail: '',
        activity: 'working',
        startedAt: null,
        compactionStartedAt: null,
        progress: {},
        state: payload.reason === 'failed' || current.state === 'failed' ? 'failed' : 'completed',
      }));
      void refreshSessions();
    }
  }, [
    addTimelineNotice, appendStream, beginSecureChannel, finishAssistant, finishInitialBootstrap,
    refreshSessions, resetExecution, updateExecution, updateSessionAttention,
  ]);

  useEffect(() => { messageHandlerRef.current = handleBridgeMessage; }, [handleBridgeMessage]);

  const rejectPendingRequests = useCallback((message: string) => {
    requestManagerRef.current!.rejectAll(message);
    relayRequestsRef.current!.rejectAll(message);
  }, []);

  const clearReconnectTimer = useCallback(() => {
    if (!reconnectTimerRef.current) return;
    clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
  }, []);

  const clearPendingPairing = useCallback(() => {
    pairingCredentialRef.current = null;
    setPairingCredential(null);
    if (pairingTimeoutRef.current) clearTimeout(pairingTimeoutRef.current);
    pairingTimeoutRef.current = null;
    try { sessionStorage.removeItem(PENDING_PAIRING_KEY); } catch { /* blocked store */ }
  }, []);

  const stopPairing = useCallback((error = '', keepDialogOpen = true) => {
    reconnectWantedRef.current = false;
    clearReconnectTimer();
    clearPendingPairing();
    const socket = socketRef.current;
    // Detach before closing: a late challenge/auth.ok/close from this attempt
    // must not affect cancellation or a newly entered pairing code.
    socketRef.current = null;
    socketAuthenticatedRef.current = false;
    socket?.close(1000, 'pairing stopped');
    secureChannelRef.current?.clear();
    secureChannelRef.current = null;
    connectorOnlineRef.current = false;
    setConnecting(false);
    setOnline(false);
    setAuthenticated(false);
    finishInitialBootstrap();
    rejectPendingRequests(t('配对已结束', 'Pairing ended'));
    setPairingError(error);
    setPairingDialogOpen(keepDialogOpen);
    setStatusText(error || t('已取消配对，可以重新输入', 'Pairing cancelled. You can enter another code.'));
    // Closing an unsubmitted link must not discard an existing device approval.
    if (!keepDialogOpen && hasApprovedBrowserDevice()) {
      approvedDeviceRef.current = true;
      reconnectWantedRef.current = true;
      scheduleReconnectRef.current(true);
    }
  }, [clearPendingPairing, clearReconnectTimer, finishInitialBootstrap, rejectPendingRequests]);

  const hasAuthenticationMaterial = useCallback(() => (
    approvedDeviceRef.current
    || Boolean(pairingCredentialRef.current)
  ), []);

  const openSocket = useCallback((replaceExisting = false) => {
    if (!reconnectWantedRef.current || !hasAuthenticationMaterial()) return;
    if (navigator.onLine === false) {
      setConnecting(false);
      setOnline(false);
      setStatusText(t('等待网络恢复', 'Waiting for network'));
      return;
    }
    const existing = socketRef.current;
    if (existing && !replaceExisting && (
      existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING
    )) return;
    if (existing) {
      socketRef.current = null;
      existing.close(1000, 'connection replaced');
    }
    // The detached socket's close callback cannot clean up a replacement.
    // Invalidate its channel and reads before exposing the new connection.
    secureChannelRef.current?.clear();
    secureChannelRef.current = null;
    connectorOnlineRef.current = false;
    setOnline(false);
    runningRef.current = false;
    ownedTurnThreadIdRef.current = null;
    updateExecution({ running: false, ownedTurnThreadId: null });
    clearReconnectTimer();
    setConnecting(true);
    setStatusText(reconnectAttemptRef.current ? t('正在重新连接…', 'Reconnecting…') : t('正在连接…', 'Connecting…'));
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${scheme}//${location.host}/ws`);
    socketRef.current = socket;
    lastServerActivityRef.current = Date.now();
    socketAuthenticatedRef.current = false;
    socket.addEventListener('message', (incoming) => {
      if (socketRef.current !== socket) return;
      lastServerActivityRef.current = Date.now();
      try {
        const message = JSON.parse(String(incoming.data)) as BridgeMessage;
        if (message.type === 'auth.challenge') {
          const protocol = requireCurrentProtocol(message.protocol);
          const challenge = String(message.challenge || '');
          const pairing = pairingCredentialRef.current;
          if (pairing) {
            authAttemptModeRef.current = 'pairing';
            const identity = loadOrCreateBrowserDeviceIdentity();
            const proof = createBrowserPairingProof({
              verifier: browserPairingVerifier(pairing.secret),
              challenge,
              pairingId: pairing.id,
              deviceId: identity.id,
              publicKey: identity.publicKey,
            });
            const device = createBrowserDeviceProof({ challenge, role: 'client', authProof: proof });
            sendWebSocketFrame(socket, {
              type: 'auth.enroll', role: 'client', pairingId: pairing.id, proof, device, protocol,
            });
          } else if (approvedDeviceRef.current) {
            authAttemptModeRef.current = 'device';
            const device = createBrowserDeviceProof({
              challenge, role: 'client', authProof: DEVICE_KEY_AUTH_CONTEXT,
            });
            sendWebSocketFrame(socket, { type: 'auth.device', role: 'client', device, protocol });
          } else {
            socket.close(4406, 'pairing required');
          }
          return;
        }
        if (secureChannelRef.current?.handle(message as Record<string, any>)) return;
        messageHandlerRef.current(message);
      } catch {
        if (!socketAuthenticatedRef.current) socket.close(4003, 'invalid authentication challenge');
      }
    });
    socket.addEventListener('close', (event) => {
      if (socketRef.current !== socket) return;
      if (!socketAuthenticatedRef.current && authAttemptModeRef.current === 'pairing') {
        stopPairing(pairingFailureMessage(event.code));
        return;
      }
      const replayPending = reconnectWantedRef.current
        && ![4003, 4403, 4406, 4407, 4429].includes(event.code);
      socketRef.current = null;
      socketAuthenticatedRef.current = false;
      onlineEnvironmentIdsRef.current = [];
      setOnlineEnvironmentIds([]);
      connectorOnlineRef.current = false;
      secureChannelRef.current?.clear();
      secureChannelRef.current = null;
      setConnecting(false);
      setOnline(false);
      executionVersionRef.current += 1;
      runningRef.current = false;
      ownedTurnThreadIdRef.current = null;
      updateExecution({ running: false, ownedTurnThreadId: null });
      if (!replayPending) rejectPendingRequests(t('连接已断开', 'Connection closed'));
      if (event.code === 4003) {
        reconnectWantedRef.current = false;
        finishInitialBootstrap();
        setAuthenticated(false);
        setStatusText(t('配对凭据无效或已过期', 'Pairing credential is invalid or expired'));
        return;
      }
      if (event.code === 4403) {
        setAuthenticated(false);
        finishInitialBootstrap();
        approvedDeviceRef.current = false;
        clearBrowserDeviceApproval();
        reconnectWantedRef.current = false;
        setStatusText(t('这台设备的授权已失效，请重新配对', 'This device is no longer approved. Pair it again.'));
        return;
      }
      if (event.code === 4407) {
        reconnectWantedRef.current = false;
        setAuthenticated(false);
        finishInitialBootstrap();
        setStatusText(t('设备身份验证失败', 'Device identity verification failed'));
        return;
      }
      if (event.code === 4406) {
        reconnectWantedRef.current = false;
        setAuthenticated(false);
        finishInitialBootstrap();
        setStatusText(t('连接协议已更新，请刷新页面', 'Connection protocol updated. Refresh the page.'));
        return;
      }
      if (event.code === 4429) {
        reconnectWantedRef.current = false;
        setAuthenticated(false);
        finishInitialBootstrap();
        setStatusText(t('登录尝试过多，请 15 分钟后重试', 'Too many login attempts. Try again in 15 minutes.'));
        return;
      }
      setStatusText(navigator.onLine === false
        ? t('等待网络恢复', 'Waiting for network')
        : t('连接中断，准备重连…', 'Connection lost. Reconnecting…'));
      scheduleReconnectRef.current();
    });
    socket.addEventListener('error', () => {
      if (socketRef.current === socket) setStatusText(t('连接失败', 'Connection failed'));
    });
  }, [
    clearReconnectTimer, finishInitialBootstrap, hasAuthenticationMaterial,
    rejectPendingRequests, stopPairing, updateExecution,
  ]);

  const scheduleReconnect = useCallback((immediate = false) => {
    if (!reconnectWantedRef.current || !hasAuthenticationMaterial()) return;
    clearReconnectTimer();
    if (navigator.onLine === false) {
      setConnecting(false);
      setStatusText(t('等待网络恢复', 'Waiting for network'));
      return;
    }
    const attempt = reconnectAttemptRef.current;
    const delay = immediate
      ? 0
      : Math.min(RECONNECT_MAX_DELAY_MS, 1_000 * (2 ** attempt)) + Math.floor(Math.random() * 500);
    reconnectAttemptRef.current = immediate ? attempt : attempt + 1;
    setConnecting(true);
    const seconds = Math.max(1, Math.ceil(delay / 1_000));
    setStatusText(delay
      ? t(`将在 ${seconds} 秒后重连…`, `Reconnecting in ${seconds}s…`)
      : t('正在重新连接…', 'Reconnecting…'));
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      openSocket(true);
    }, delay);
  }, [clearReconnectTimer, hasAuthenticationMaterial, openSocket]);

  useEffect(() => { scheduleReconnectRef.current = scheduleReconnect; }, [scheduleReconnect]);

  const pairBrowser = useCallback((credential: BrowserPairingCredential) => {
    const serialized = encodeBrowserPairingCredential(credential);
    clearPendingPairing();
    pairingCredentialRef.current = credential;
    setPairingCredential(credential);
    setPairingInput(serialized);
    setPairingError('');
    approvedDeviceRef.current = false;
    clearBrowserDeviceApproval();
    authAttemptModeRef.current = 'pairing';
    reconnectWantedRef.current = true;
    reconnectAttemptRef.current = 0;
    setInitialBootstrapPending(false);
    setSessionsInitialized(false);
    setPairingDialogOpen(true);
    setStatusText(t('正在安全配对…', 'Pairing securely…'));
    pairingTimeoutRef.current = setTimeout(() => stopPairing(pairingFailureMessage(4001)), PAIRING_TIMEOUT_MS);
    try { openSocket(true); } catch { stopPairing(pairingFailureMessage(1006)); }
  }, [clearPendingPairing, openSocket, stopPairing]);

  useEffect(() => {
    const receivePairingLink = () => {
      let storage: Storage | undefined;
      try { storage = sessionStorage; } catch { /* blocked store */ }
      const input = takePairingInput(location, history, storage);
      if (input === null) return;
      stopPairing();
      approvedDeviceRef.current = false;
      setPairingInput(input);
      setStatusText(t('已读取配对链接，请确认配对', 'Pairing link loaded. Confirm to pair.'));
    };
    window.addEventListener('hashchange', receivePairingLink);
    return () => window.removeEventListener('hashchange', receivePairingLink);
  }, [stopPairing]);

  useEffect(() => {
    reconnectWantedRef.current = hasAuthenticationMaterial();
    if (reconnectWantedRef.current) scheduleReconnect(true);

    const reconnectNow = () => {
      if (!reconnectWantedRef.current) return;
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN && socketAuthenticatedRef.current) {
        if (lastServerActivityRef.current && Date.now() - lastServerActivityRef.current > CLIENT_STALE_AFTER_MS) {
          scheduleReconnectRef.current(true);
          return;
        }
        sendWebSocketFrame(socket, { type: 'ping', at: Date.now() });
        return;
      }
      reconnectAttemptRef.current = 0;
      scheduleReconnect(true);
    };
    const handleOnline = () => {
      if (!reconnectWantedRef.current) return;
      reconnectAttemptRef.current = 0;
      scheduleReconnect(true);
    };
    const handleOffline = () => {
      setOnline(false);
      setConnecting(false);
      setStatusText(t('等待网络恢复', 'Waiting for network'));
    };
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        setResumeEpoch((current) => current + 1);
        reconnectNow();
      }
    };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('pageshow', handleVisibility);
    return () => {
      reconnectWantedRef.current = false;
      clearReconnectTimer();
      if (pairingTimeoutRef.current) clearTimeout(pairingTimeoutRef.current);
      pairingTimeoutRef.current = null;
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('pageshow', handleVisibility);
      const socket = socketRef.current;
      socketRef.current = null;
      secureChannelRef.current?.clear();
      secureChannelRef.current = null;
      socket?.close(1000, 'page closed');
      rejectPendingRequests(t('页面已关闭', 'Page closed'));
    };
  }, [clearReconnectTimer, hasAuthenticationMaterial, rejectPendingRequests, scheduleReconnect]);

  useEffect(() => {
    const heartbeat = setInterval(() => {
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN || !socketAuthenticatedRef.current) return;
      if (document.visibilityState === 'hidden') return;
      if (lastServerActivityRef.current && Date.now() - lastServerActivityRef.current > CLIENT_STALE_AFTER_MS) {
        scheduleReconnectRef.current(true);
        return;
      }
      sendWebSocketFrame(socket, { type: 'ping', at: Date.now() });
    }, CLIENT_HEARTBEAT_MS);
    return () => clearInterval(heartbeat);
  }, []);

  useEffect(() => {
    if (!authenticated || !online) return;
    const refreshVisibleSessions = () => {
      if (document.visibilityState === 'visible') void refreshSessions();
    };
    const timer = setInterval(refreshVisibleSessions, SESSION_STATUS_REFRESH_MS);
    document.addEventListener('visibilitychange', refreshVisibleSessions);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshVisibleSessions);
    };
  }, [authenticated, online, refreshSessions]);

  const loadHistory = useCallback(async (targetThreadId: string, cursor: string | null, requestVersion: number) => {
    const requestChannel = secureChannelRef.current;
    if (!cursor) initialHistoryAttemptRef.current = `${requestVersion}:${connectionEpoch}:${resumeEpoch}`;
    setHistoryLoading(true);
    if (cursor) setOlderHistoryError(false);
    try {
      const { page, snapshot, items } = await loadHistoryPage(request, targetThreadId, cursor, HISTORY_PAGE_SIZE);
      if (selectedRequestRef.current !== requestVersion || threadIdRef.current !== targetThreadId
        || secureChannelRef.current !== requestChannel) {
        return;
      }
      if (cursor) {
        if (messageListRef.current && !viewport.following) viewport.capture(messageListRef.current);
        setTimeline((current) => prependHistoryPage(items, current));
      }
      else {
        const state = snapshot || page;
        setContextUsage(normalizeContextUsage(state.contextUsage) || normalizeContextUsage(page.contextUsage) || null);
        viewport.following = true;
        viewport.forceBottom = true;
        setTimeline(startTimelineCompaction(items, state.activityId || '', epochMillis(state.compactionStartedAt)));
        followFingerprintRef.current = historyFingerprint(state.turns, state.turnProgress);
        latestActivityIdRef.current = state.activityId || '';
        if (snapshot) liveHistoryHydratedThreadRef.current = targetThreadId;
        const latestStatus = state.turns[0]?.status;
        const active = latestStatus === 'inProgress';
        const failed = latestStatus === 'failed';
        updateExecution({
          state: active ? 'running' : failed ? 'failed' : 'idle',
          compactionStartedAt: active ? epochMillis(state.compactionStartedAt) : null,
          purpose: active ? normalizeToolPurpose(state.toolPurpose) : '',
          detail: active ? normalizeToolPurpose(state.activityDetail) : '',
          activity: active
            ? safeActivityKind(state.activityKind || (state.toolPurpose ? 'planning' : 'working'))
            : 'working',
          startedAt: active
            ? epochMillis(state.activityStartedAt || state.turns[0]?.startedAt) || Date.now()
            : null,
          progress: active ? normalizeTurnProgress(state.turnProgress) : {},
        });
      }
      rememberQuestionReplies(page.questionReplies);
      rememberQuestionReplies(snapshot?.questionReplies);
      setNextCursor(page.nextCursor || null);
      if (cursor) setOlderHistoryError(false);
      setInitialHistoryLoaded(true);
    } catch (error) {
      if (selectedRequestRef.current === requestVersion) {
        if (cursor) setOlderHistoryError(true);
        else reportTimelineError(error);
      }
    } finally {
      if (selectedRequestRef.current === requestVersion) setHistoryLoading(false);
    }
  }, [connectionEpoch, resumeEpoch, rememberQuestionReplies, reportTimelineError, request, updateExecution]);

  useEffect(() => {
    // An initial read can time out while mobile timers are suspended. Re-enter
    // the selected conversation after recovery instead of leaving it stuck.
    const key = `${selectedRequestRef.current}:${connectionEpoch}:${resumeEpoch}`;
    if (online && threadId && !initialHistoryLoaded && !historyLoading && initialHistoryAttemptRef.current !== key) {
      void loadHistory(threadId, null, selectedRequestRef.current);
    }
    // Retry on an actual recovery, not continuously after a permanent failure.
  }, [connectionEpoch, resumeEpoch, online, threadId, initialHistoryLoaded, historyLoading, loadHistory]);

  useEffect(() => {
    if (!threadId) {
      followFingerprintRef.current = '';
      setFollowState('idle');
      return;
    }
    if (!initialHistoryLoaded || running || !online) return;
    let disposed = false;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = (delay: number) => {
      if (!disposed) timer = setTimeout(pollLatest, delay);
    };
    const pollLatest = async () => {
      if (disposed) return;
      if (document.visibilityState === 'hidden') {
        schedule(8_000);
        return;
      }
      try {
        const requestChannel = secureChannelRef.current;
        const page = await request<HistoryPage>('session.turns.list', {
          threadId,
          limit: 2,
          mode: 'live',
          questionIds: visibleQuestionIdsRef.current,
        }, { signal: controller.signal });
        if (disposed || threadIdRef.current !== threadId || secureChannelRef.current !== requestChannel) return;
        rememberQuestionReplies(page.questionReplies);
        const nextContextUsage = normalizeContextUsage(page.contextUsage);
        if (nextContextUsage) setContextUsage(nextContextUsage);
        const fingerprint = historyFingerprint(page.turns, page.turnProgress);
        const previousFingerprint = followFingerprintRef.current;
        const changed = Boolean(previousFingerprint && previousFingerprint !== fingerprint);
        const latestStatus = page.turns[0]?.status;
        const inProgress = latestStatus === 'inProgress';
        const failed = latestStatus === 'failed';
        updateExecution((current) => ({
          compactionStartedAt: inProgress ? epochMillis(page.compactionStartedAt) : null,
          purpose: inProgress ? normalizeToolPurpose(page.toolPurpose) || current.purpose : '',
          detail: inProgress ? normalizeToolPurpose(page.activityDetail) : '',
          activity: inProgress
            ? safeActivityKind(page.activityKind || (page.toolPurpose ? 'planning' : 'working'))
            : 'working',
          startedAt: inProgress
            ? epochMillis(page.activityStartedAt || page.turns[0]?.startedAt) || current.startedAt || Date.now()
            : null,
          progress: inProgress ? normalizeTurnProgress(page.turnProgress) : {},
        }));
        const latestItems = attachLatestAssistantFileChanges(historyItems(page.turns, page.source), page.turnProgress);
        if (liveHistoryHydratedThreadRef.current !== threadId) {
          liveHistoryHydratedThreadRef.current = threadId;
        }
        const awaitingDesktopTurn = awaitingDesktopTurnRef.current;
        const awaitedMessageSeen = Boolean(awaitingDesktopTurn
          && latestItems.some((item) => item.kind === 'user' && item.text.trim() === awaitingDesktopTurn.text));
        const newActivitySeen = Boolean(awaitingDesktopTurn
          && awaitingDesktopTurn.previousActivityId
          && page.activityId
          && page.activityId !== awaitingDesktopTurn.previousActivityId);
        if (awaitingDesktopTurn && (awaitedMessageSeen || newActivitySeen)) {
          awaitingDesktopTurn.seen = true;
          if (page.activityId) awaitingDesktopTurn.activityId = page.activityId;
        }
        followFingerprintRef.current = fingerprint;
        latestActivityIdRef.current = page.activityId || latestActivityIdRef.current;
        setFollowState(inProgress || changed ? 'following' : 'synced');

        if (inProgress) setExecutionState('running');
        else if (failed) {
          awaitingDesktopTurnRef.current = null;
          setExecutionState('failed');
        } else if (
          awaitingDesktopTurn?.seen
          && latestStatus === 'completed'
          && (!awaitingDesktopTurn.activityId || !page.activityId || awaitingDesktopTurn.activityId === page.activityId)
        ) {
          awaitingDesktopTurnRef.current = null;
          setExecutionState('completed');
        } else if (!awaitingDesktopTurn && latestStatus === 'completed') {
          setExecutionState((current) => current === 'running' || current === 'waiting' ? 'completed' : current);
        }

        const historyChanged = !previousFingerprint || previousFingerprint !== fingerprint;
        if (viewport.following && (historyChanged || page.compactionStartedAt)) viewport.forceBottom = true;
        const latestTurnIds = new Set(latestItems
          .map((item) => item.historyTurnId)
          .filter((turnId): turnId is string => Boolean(turnId)));
        setTimeline((current) => {
          const merged = historyChanged ? mergeHistorySnapshot(current, latestItems, latestTurnIds, { partial: true }) : current;
          return inProgress
            ? syncTimelineCompaction(merged, page.activityId || '', epochMillis(page.compactionStartedAt))
            : clearPendingCompactions(merged);
        });
        schedule(inProgress || changed ? 1_500 : 6_000);
      } catch {
        if (disposed) return;
        setFollowState('error');
        schedule(8_000);
      }
    };

    setFollowState('checking');
    schedule(liveHistoryHydratedThreadRef.current === threadId ? 1_500 : 800);
    return () => {
      disposed = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [connectionEpoch, resumeEpoch, initialHistoryLoaded, online, rememberQuestionReplies, request, running, threadId, updateExecution]);

  useEffect(() => {
    if (authenticated && online) preloadMessageBubble();
  }, [authenticated, online]);

  const selectSession = useCallback((session: Session | null, { closeDrawer = true }: { closeDrawer?: boolean } = {}) => {
    const nextThreadId = session?.id || null;
    if (nextThreadId) {
      updateSessionAttention((current) => markSessionAttentionRead(current, nextThreadId));
    }
    if (nextThreadId && nextThreadId === threadIdRef.current) {
      if (closeDrawer) setDrawerOpen(false);
      return;
    }
    cancelFileDownload();
    invalidateMessageAttachment();
    setPendingAttachments([]);
    selectedRequestRef.current += 1;
    const requestVersion = selectedRequestRef.current;
    setThreadId(nextThreadId);
    threadIdRef.current = nextThreadId;
    setCreatingNewSession(false);
    if (nextThreadId) storeEnvironmentValue(LAST_THREAD_KEY, environmentIdRef.current, nextThreadId);
    setTimeline([]);
    setResolvedQuestionAnswers({});
    setContextUsage(null);
    viewport.reset();
    olderHistoryLoadingRef.current = null;
    setNextCursor(null);
    setOlderHistoryError(false);
    setOlderHistoryAutoLoadEnabled(false);
    setInitialHistoryLoaded(!nextThreadId);
    setHistoryLoading(false);
    liveHistoryHydratedThreadRef.current = null;
    followFingerprintRef.current = '';
    latestActivityIdRef.current = '';
    awaitingDesktopTurnRef.current = null;
    setFollowState(nextThreadId ? 'checking' : 'idle');
    pendingNewRequestRef.current = null;
    executionVersionRef.current += 1;
    runningRef.current = false;
    ownedTurnThreadIdRef.current = null;
    resetExecutionPresentation();
    setApproval(null);
    viewport.following = true;
    streamItemRef.current = null;
    activeTurnIdRef.current = '';
    if (closeDrawer) setDrawerOpen(false);
    if (nextThreadId) {
      preloadMessageBubble();
      void loadHistory(nextThreadId, null, requestVersion);
    }
  }, [cancelFileDownload, invalidateMessageAttachment, loadHistory, resetExecutionPresentation, updateSessionAttention, setPendingAttachments]);

  const selectEnvironment = useCallback((value: string) => {
    const nextEnvironmentId = normalizeEnvironmentId(value);
    if (!nextEnvironmentId || nextEnvironmentId === environmentIdRef.current) {
      return;
    }

    selectedRequestRef.current += 1;
    cancelFileDownload();
    rejectPendingRequests(t('已切换执行环境', 'Execution environment changed'));
    secureChannelRef.current?.clear();
    secureChannelRef.current = null;
    connectorOnlineRef.current = false;
    runningRef.current = false;
    ownedTurnThreadIdRef.current = null;
    setOnline(false);
    setPendingAttachment(null);
    setEnvironmentId(nextEnvironmentId);
    environmentIdRef.current = nextEnvironmentId;
    storeSelectedEnvironmentId(nextEnvironmentId);
    setEnvironmentIds((current) => {
      const next = mergeKnownEnvironmentIds(current, onlineEnvironmentIdsRef.current, nextEnvironmentId);
      storeKnownEnvironmentIds(next);
      return next;
    });
    const nextAttention = loadSessionAttention(nextEnvironmentId);
    setSessionAttention(nextAttention);
    sessionAttentionRef.current = nextAttention;
    setSessions([]);
    setSessionsInitialized(false);
    setSessionSearch('');
    setSearchOpen(false);
    closeNewSessionDialog();
    setRenameDialogOpen(false);
    setNewSessionCwd(() => {
      const stored = loadEnvironmentValue(NEW_SESSION_CWD_KEY, nextEnvironmentId) || '';
      return isTemporaryProjectPath(stored) ? '' : stored;
    });
    selectSession(null, { closeDrawer: false });
    resetExecution();

    const connectorAvailable = onlineEnvironmentIdsRef.current.includes(nextEnvironmentId);
    if (socketAuthenticatedRef.current && connectorAvailable) {
      setStatusText(t('正在建立安全通道…', 'Establishing secure channel…'));
      beginSecureChannel(nextEnvironmentId);
    } else {
      setStatusText(environmentOfflineLabel(nextEnvironmentId, environmentLabelsRef.current));
    }
  }, [beginSecureChannel, cancelFileDownload, closeNewSessionDialog, rejectPendingRequests, resetExecution, selectSession, setPendingAttachment]);

  useEffect(() => {
    if (authenticated && hasEnvironmentInventory && environmentIds.length && !environmentIds.includes(environmentId)) {
      selectEnvironment(environmentIds.find(id => onlineEnvironmentIds.includes(id)) || environmentIds[0]);
    }
  }, [authenticated, hasEnvironmentInventory, environmentIds, environmentId, onlineEnvironmentIds, selectEnvironment]);
  const renameEnvironment = useCallback(async (deviceId: string, label: string) => {
    await relayRequestsRef.current!.request('device.rename', { deviceId, label }, { timeoutMs: 15000 });
  }, []);

  const beginNewSession = useCallback(() => {
    const savedMode = normalizePermissionMode(loadEnvironmentValue(SESSION_PERMISSION_MODE_KEY, environmentIdRef.current));
    setNewSessionPermissionMode(savedMode === 'full' && !connectorStatus?.capabilities.fullAccess ? 'ask' : savedMode);
    setNewSessionPrompt('');
    setNewSessionAttachment(null);
    setNewSessionError('');
    setSearchOpen(false);
    setSessionSearch('');
    setDrawerOpen(false);
    setNewSessionDialogOpen(true);
  }, [connectorStatus?.capabilities.fullAccess]);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  const archiveSession = useCallback(async () => {
    const target = archiveTarget;
    if (!target || environmentIdRef.current !== target.environment) throw new Error('session_archive_environment_changed');
    const result = await request<{ threadId: string; archived: boolean }>('session.archive', {
      threadId: target.id, confirm: true, cancelPendingApproval: target.cancelPendingApproval === true,
    });
    if (result.threadId !== target.id || result.archived !== true) throw new Error('session_delivery_mismatch');
    if (loadEnvironmentValue(LAST_THREAD_KEY, target.environment) === target.id) {
      storeEnvironmentValue(LAST_THREAD_KEY, target.environment, '');
    }
    if (environmentIdRef.current !== target.environment) return;
    setLastArchived(target); setRestoreError('');
    // Ignore a list read started before the archive completed; the next poll is authoritative.
    sessionRefreshInFlightRef.current = null;
    setSessions((current) => current.filter((session) => session.id !== target.id));
    updateSessionAttention((current) => { const next = { ...current }; delete next[target.id]; return next; });
    if (threadIdRef.current === target.id) {
      setPrompt(''); setPendingAttachment(null); setRenameDialogOpen(false);
      selectSession(null);
    }
  }, [archiveTarget, request, selectSession, updateSessionAttention]);

  const restoreArchivedSession = useCallback(async () => {
    const target = lastArchived;
    if (!target || restoringSession || environmentIdRef.current !== target.environment) return;
    setRestoringSession(true); setRestoreError('');
    try {
      const result = await request<{ threadId: string; archived: boolean }>('session.restore', { threadId: target.id });
      if (result.threadId !== target.id || result.archived !== false) throw new Error('session_delivery_mismatch');
      if (environmentIdRef.current !== target.environment) return;
      setLastArchived(null);
      selectSession({ id: target.id, title: target.title });
      void refreshSessions();
    } catch (error) {
      if (environmentIdRef.current === target.environment) setRestoreError(friendlyError(error));
    } finally { setRestoringSession(false); }
  }, [lastArchived, restoringSession, request, selectSession, refreshSessions]);

  const renameSession = useCallback(async (name: string) => {
    const targetThreadId = threadIdRef.current;
    const requestVersion = selectedRequestRef.current;
    if (!targetThreadId) throw new Error('thread_id_required');
    const renamed = await request<{ threadId: string; title: string }>('session.rename', {
      threadId: targetThreadId,
      name,
    });
    if (!isCurrentSessionRequest(
      targetThreadId, threadIdRef.current, requestVersion, selectedRequestRef.current,
    )) return;
    setSessions((current) => current.map((session) => session.id === targetThreadId
      ? { ...session, title: renamed.title }
      : session));
  }, [request]);

  const beginDeleteSession = useCallback((session: Session) => {
    setDeleteTarget({ session, environmentId: environmentIdRef.current });
  }, []);

  const deleteSession = useCallback(async () => {
    const target = deleteTarget;
    if (!target || target.environmentId !== environmentIdRef.current) return;
    const id = target.session.id;
    const result = await request<{ threadId: string; deleted: boolean }>('session.delete', { threadId: id, confirm: true });
    if (result.threadId !== id || !result.deleted) throw new Error('session_delivery_mismatch');
    const deleted = deletedSessionsRef.current.get(target.environmentId) || new Set<string>();
    deleted.add(id);
    deletedSessionsRef.current.set(target.environmentId, deleted);
    if (loadEnvironmentValue(LAST_THREAD_KEY, target.environmentId) === id) {
      storeEnvironmentValue(LAST_THREAD_KEY, target.environmentId, '');
    }
    if (environmentIdRef.current !== target.environmentId) return;
    setSessions(current => current.filter(session => session.id !== id));
    updateSessionAttention(current => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    if (threadIdRef.current === id) {
      setPrompt('');
      setPendingAttachment(null);
      setRenameDialogOpen(false);
      selectSession(null);
    }
    setDeleteTarget(current => current === target ? null : current);
  }, [deleteTarget, request, selectSession, updateSessionAttention]);

  useEffect(() => {
    if (!authenticated || !online || !connectionEpoch || creatingNewSession || threadId) return;
    const previousThreadId = loadEnvironmentValue(LAST_THREAD_KEY, environmentIdRef.current);
    if (!previousThreadId) return;
    selectSession({ id: previousThreadId, title: '' }, { closeDrawer: false });
  }, [authenticated, connectionEpoch, creatingNewSession, online, selectSession, threadId]);

  useEffect(() => {
    // The restore effect above can select synchronously before React commits
    // threadId. Do not overwrite that selection with the first list entry.
    if (!authenticated || creatingNewSession || threadId || threadIdRef.current || !sessions.length) return;
    const previousThreadId = loadEnvironmentValue(LAST_THREAD_KEY, environmentIdRef.current);
    const initialSession = sessions.find((session) => session.id === previousThreadId) || sessions[0];
    selectSession(initialSession, { closeDrawer: false });
  }, [authenticated, creatingNewSession, selectSession, sessions, threadId]);

  useEffect(() => {
    if (initialBootstrapPending && initialBootstrapReady(
      authenticated,
      sessionsInitialized,
      sessions.length,
      threadId,
      initialHistoryLoaded,
    )) finishInitialBootstrap();
  }, [
    authenticated, finishInitialBootstrap, initialBootstrapPending, initialHistoryLoaded,
    sessions.length, sessionsInitialized, threadId,
  ]);

  useEffect(() => {
    if (!initialBootstrapPending) return undefined;
    const timer = setTimeout(finishInitialBootstrap, INITIAL_BOOTSTRAP_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [finishInitialBootstrap, initialBootstrapPending]);

  const loadOlder = useCallback(() => {
    if (!threadId || !nextCursor || olderHistoryLoadingRef.current !== null) return;
    const version = selectedRequestRef.current;
    olderHistoryLoadingRef.current = version;
    if (messageListRef.current) viewport.pause(messageListRef.current);
    void loadHistory(threadId, nextCursor, version)
      .finally(() => { if (olderHistoryLoadingRef.current === version) olderHistoryLoadingRef.current = null; });
  }, [loadHistory, nextCursor, threadId]);

  const handleMessageScroll = useCallback(() => {
    const element = messageListRef.current;
    if (!element) return;
    if (!viewport.onScroll(element)) return;
    const browsingOlder = element.scrollHeight - element.scrollTop - element.clientHeight > 2;
    if (browsingOlder) setOlderHistoryAutoLoadEnabled(true);
    if (browsingOlder && shouldLoadOlderHistory(
      element, nextCursor, initialHistoryLoaded, historyLoading,
    )) loadOlder();
  }, [historyLoading, initialHistoryLoaded, loadOlder, nextCursor]);

  const chooseAttachment = useCallback((files: File[] = []) => {
    const selectionVersion = selectedRequestRef.current;
    return prepareMessageAttachments(files, reportTimelineError,
      () => selectionVersion === selectedRequestRef.current);
  }, [prepareMessageAttachments, reportTimelineError]);

  const chooseNewSessionAttachment = useCallback(async (file?: File) => {
    setNewSessionError('');
    const environment = environmentIdRef.current;
    await prepareNewSessionAttachment(file, error => setNewSessionError(friendlyError(error)),
      () => environment === environmentIdRef.current);
  }, [prepareNewSessionAttachment]);

  const submitNewSession = useCallback(() => {
    if (!online || uploading) return;
    if (newSessionPermissionMode === 'full' && !connectorStatus?.capabilities.fullAccess) {
      setNewSessionError(t('此执行节点未开放完全访问权限，请选择其他权限。', 'Full access is disabled on this connector. Choose another permission mode.'));
      return;
    }
    const projectCwd = newSessionCwd.trim();
    const text = newSessionPrompt.trim();
    if (!projectCwd) {
      setNewSessionError(t('请选择或填写项目目录。', 'Choose or enter a project directory.'));
      return;
    }
    if (!text && !newSessionAttachment) {
      setNewSessionError(t('请输入第一条消息或添加附件。', 'Enter the first message or add an attachment.'));
      return;
    }
    const transferredAttachment = newSessionAttachment ? {
      kind: newSessionAttachment.kind,
      file: newSessionAttachment.file,
      transferPreview: newSessionAttachment.transferPreview,
      previewUrl: newSessionAttachment.kind === 'image' ? URL.createObjectURL(newSessionAttachment.file) : '',
    } : null;
    storeEnvironmentValue(SESSION_PERMISSION_MODE_KEY, environmentIdRef.current, newSessionPermissionMode);
    selectSession(null);
    setCreatingNewSession(true);
    writeLocal('personal.draft.' + JSON.stringify([environmentIdRef.current, 'new']), text);
    setPendingAttachment(transferredAttachment);
    setNewSessionPrompt('');
    setNewSessionError('');
    closeNewSessionDialog();
    newSessionAutoSendRef.current = true;
  }, [closeNewSessionDialog, newSessionCwd, newSessionAttachment, newSessionPrompt, newSessionPermissionMode, online, uploading, connectorStatus?.capabilities.fullAccess, selectSession, setNewSessionAttachment, setPendingAttachment]);

  const sendTurn = useCallback(async (questionReplies?: QuestionReply[], intent: 'auto' | 'immediate' = 'auto') => {
    // A question response is independent of the message/attachment draft.
    if (questionReplies && (!threadId || threadId !== threadIdRef.current)) return;
    const text = questionReplies ? buildQuestionReply(questionReplies) : prompt.trim();
    const attachments = questionReplies ? [] : pendingAttachments;
    const attachment = attachments[0] || null;
    const targetThreadId = threadIdRef.current;
    const managedSend = !questionReplies && intent === 'auto' && Boolean(targetThreadId) && queueSupported;
    const sendKey = JSON.stringify([environmentIdRef.current, targetThreadId || NEW_TURN_KEY]);
    const steering = !managedSend && canSteerOwnedTurn(
      running, executionState, ownedTurnThreadId, targetThreadId,
    );
    const directDesktopDelivery = canSendToActiveDesktopTurn(
      running, executionState, ownedTurnThreadId, targetThreadId,
    );
    if (
      (!text && !attachment)
      || uploading
      || sendingRef.current.has(sendKey)
      || (running && !steering && !managedSend)
      || (steering && Boolean(attachment))
    ) return;
    const isExistingSession = Boolean(targetThreadId);
    const selectedPermissionMode = isExistingSession
      ? permissionConfig?.mode
      : normalizePermissionMode(loadEnvironmentValue(SESSION_PERMISSION_MODE_KEY, environmentIdRef.current));
    const selectionVersion = selectedRequestRef.current;
    const projectCwd = newSessionCwd.trim();
    if (!isExistingSession && !projectCwd) {
      addTimeline('error', t('请先填写新会话的项目目录。', 'Enter a project directory for the new session.'));
      return;
    }
    if (!isExistingSession) {
      storeEnvironmentValue(NEW_SESSION_CWD_KEY, environmentIdRef.current, projectCwd);
    }
    sendingRef.current.add(sendKey);
    executionVersionRef.current += 1;
    const delivery: MessageDelivery = {
      id: makeId(), environmentId: environmentIdRef.current, selectionVersion, threadId: targetThreadId, status: 'sending',
    };
    setMessageDelivery(delivery);
    let turnText = text;
    let visibleText = questionReplies ? questionReplyText(questionReplies) : text;
    let timelineAttachment: ImageAttachment | undefined;
    const nativeImages: Array<{ path: string }> = [];
    const gallery: ImageAttachment[] = [];
    const boundPaths: string[] = [];
    const optimisticExtraIds: string[] = [];
    let optimisticItemId = '';
    let composerCleared = false;
    if (attachment) {
      uploadOwnerRef.current = delivery.id;
      setUploading(true);
      setUploadProgress({ phase: 'preparing', percent: 0 });
    }
    try {
      const fileTexts: string[] = [], imageTexts: string[] = [];
      for (const [index, item] of attachments.entries()) {
        setUploadingLabel(`${index + 1}/${attachments.length} · ${item.file.name}`);
        const isCurrent = () => isCurrentSessionRequest(targetThreadId, threadIdRef.current, selectionVersion, selectedRequestRef.current);
        let original = completedUploadsRef.current.get(item.file);
        if (!original) {
          original = await uploadFile(item.file, request, setUploadProgress, isCurrent);
          completedUploadsRef.current.set(item.file, original);
        }
        if (!isCurrent()) return;
        boundPaths.push(original.path);
        if (item.kind === 'file') {
          fileTexts.push(buildFileMessage('', original).visibleText.replace(/^.*?\n\n/, ''));
        } else {
          const uploaded = await request<UploadedImage>('attachment.prepare', { path: original.path, name: item.file.name, quality: imageQuality });
          if (!isCurrent()) return;
          boundPaths.push(uploaded.path);
          gallery.push({ path: uploaded.path, name: uploaded.name });
          nativeImages.push({ path: uploaded.path });
          imageTexts.push(buildImageMessage(text, uploaded).turnText);
          if (item.transferPreview) rememberImage(uploaded.path, `data:${item.transferPreview.type};base64,${await fileToBase64(item.transferPreview)}`);
        }
      }
      if (attachments.length) {
        visibleText = [text || t('请查看这些附件。', 'Please inspect these attachments.'), ...fileTexts].join('\n\n');
        const native = isExistingSession && !steering && connectorStatus?.capabilities.desktopNativeImages;
        turnText = native ? visibleText : [...imageTexts, visibleText].join('\n\n');
        if (!native) nativeImages.length = 0;
        timelineAttachment = gallery[0];
      }
      if (!isCurrentSessionRequest(
        targetThreadId, threadIdRef.current, selectionVersion, selectedRequestRef.current,
      )) {
        setUploading(false);
        return;
      }
      if (attachment && timelineAttachment) {
        if (targetThreadId) rememberAttachment(targetThreadId, visibleText, timelineAttachment);
      }
      if (uploadOwnerRef.current === delivery.id) { setUploading(false); uploadOwnerRef.current = null; }
      if (managedSend) {
        const pendingKey = 'personal.queueSubmission.' + sendKey;
        const signature = JSON.stringify([text, imageQuality, attachments.map(item => [item.file.name, item.file.size, item.file.lastModified])]);
        const previous = readLocal<{ id: string; signature: string } | null>(pendingKey, null);
        const id = previous?.signature === signature ? previous.id : makeId();
        writeLocal(pendingKey, { id, signature });
        const accepted = await request<{ accepted: boolean; threadId: string; queued: boolean; existing: boolean; turnId?: string }>('queue.submit', {
          id, threadId: targetThreadId, text: turnText, images: nativeImages, files: attachments.map(item => item.file.name),
          ...(desktopState?.turnId ? { afterTurnId: desktopState.turnId } : {}),
        });
        if (!accepted.accepted || accepted.threadId !== targetThreadId) throw new Error('queue_message_invalid');
        writeLocal(pendingKey, null);
        if (boundPaths.length) void request('attachment.bind', { threadId: targetThreadId, paths: boundPaths }).catch(() => reportTimelineError(new Error('附件已保留，但会话关联未完成。')));
        if (isCurrentSessionRequest(targetThreadId, threadIdRef.current, selectionVersion, selectedRequestRef.current)) {
          setPrompt(''); setPendingAttachments([]); setMessageDelivery(null); void queueRefreshRef.current();
          if (!accepted.queued && accepted.turnId && !accepted.existing) {
            optimisticItemId = addTimeline('user', visibleText, true, true, timelineAttachment);
            for (const image of gallery.slice(1)) optimisticExtraIds.push(addTimeline('user', '', true, true, image));
            const sentAt = Date.now();
            setTimeline(current => {
              let next = acknowledgeOptimisticUser(current, optimisticItemId, sentAt);
              for (const id of optimisticExtraIds) next = acknowledgeOptimisticUser(next, id, sentAt);
              return next;
            });
            runningRef.current = false;
            ownedTurnThreadIdRef.current = null;
            updateExecution({ running: false, ownedTurnThreadId: null });
            awaitingDesktopTurnRef.current = { text: visibleText, previousActivityId: latestActivityIdRef.current, activityId: '', seen: false };
            setExecutionState('running'); setFollowState('following');
          }
        }
        return true;
      }
      if (!questionReplies) {
        setPrompt('');
        setPendingAttachment(null);
        composerCleared = true;
      }
      optimisticItemId = addTimeline('user', visibleText, true, true, timelineAttachment);
      for (const image of gallery.slice(1)) optimisticExtraIds.push(addTimeline('user', '', true, true, image));
      if (questionReplies) setTimeline((current) => current.map((item) => item.id === optimisticItemId
        ? { ...item, questionReplies } : item));
      streamItemRef.current = null;
      if (!steering) activeTurnIdRef.current = '';
      if (!steering) {
        // Desktop delivery must never temporarily claim app-server ownership:
        // stop is enabled only after native state identifies the actual turn.
        const owned = ownsPendingSubmission(isExistingSession, connectorStatus?.mode);
        runningRef.current = owned;
        ownedTurnThreadIdRef.current = owned ? targetThreadId || NEW_TURN_KEY : null;
        updateExecution({
          running: owned,
          ownedTurnThreadId: ownedTurnThreadIdRef.current,
          state: 'running',
          activity: 'starting',
          startedAt: Date.now(),
          progress: {},
        });
      }
      const action = steering ? 'turn.steer' : 'turn.start';
      const data = await request<TurnStartResult>(action, {
        text: turnText,
        ...(nativeImages.length ? { images: nativeImages } : {}),
        threadId: targetThreadId,
        ...(steering ? {} : {
          cwd: isExistingSession ? '' : projectCwd,
          ...(selectedPermissionMode && selectedPermissionMode !== 'custom' ? { permissionMode: selectedPermissionMode } : {}),
          ...(directDesktopDelivery ? { preferDesktop: true } : {}),
        }),
      }, { onRequestId: requestId => {
        if (!isExistingSession) pendingNewRequestRef.current = requestId;
      } });
      const sentAt = Date.now();
      if (environmentIdRef.current !== delivery.environmentId) return;
      if (optimisticItemId) {
        setTimeline((current) => acknowledgeOptimisticUser(current, optimisticItemId, sentAt));
        for (const id of optimisticExtraIds) setTimeline(current => acknowledgeOptimisticUser(current, id, sentAt));
      }
      const receipt = confirmedDelivery(delivery, data.threadId);
      const selectionStillCurrent = isCurrentSessionRequest(
        targetThreadId, threadIdRef.current, selectionVersion, selectedRequestRef.current,
      ) || Boolean(visibleDelivery(receipt, environmentIdRef.current, threadIdRef.current, selectedRequestRef.current));
      if (selectionStillCurrent) setMessageDelivery(receipt);
      if (data.threadId) {
        if (boundPaths.length) void request('attachment.bind', { threadId: data.threadId, paths: boundPaths }).catch(() => reportTimelineError(new Error('附件已保存，但会话关联未完成；原文件仍保留在本机。')));
        if (!isExistingSession) {
          const createdSession = {
            id: data.threadId,
            title: visibleText.split(/\r?\n/, 1)[0]?.slice(0, 80) || t('新会话', 'New session'),
            cwd: projectCwd,
            updatedAt: Date.now(),
            status: 'inProgress',
          } satisfies Session;
          setSessions((current) => [
            createdSession,
            ...current.filter((session) => session.id !== data.threadId),
          ]);
          if (selectionStillCurrent) {
            ownedTurnThreadIdRef.current = data.delivery === 'desktop' ? null : data.threadId;
            updateExecution({ ownedTurnThreadId: ownedTurnThreadIdRef.current });
            setThreadId(data.threadId);
            threadIdRef.current = data.threadId;
            storeEnvironmentValue(LAST_THREAD_KEY, environmentIdRef.current, data.threadId);
            setCreatingNewSession(false);
          } else {
            updateSessionAttention((current) => ({ ...current, [data.threadId]: 'running' }));
          }
        } else if (selectionStillCurrent) {
          ownedTurnThreadIdRef.current = data.delivery === 'desktop' ? null : data.threadId;
          updateExecution({ ownedTurnThreadId: ownedTurnThreadIdRef.current });
        }
        if (timelineAttachment) rememberAttachment(data.threadId, visibleText, timelineAttachment);
      }
      if (data.delivery === 'desktop') {
        if (!selectionStillCurrent) {
          if (targetThreadId) {
            updateSessionAttention((current) => ({ ...current, [targetThreadId]: 'running' }));
          }
          void refreshSessions();
          return;
        }
        runningRef.current = false;
        ownedTurnThreadIdRef.current = null;
        updateExecution({ running: false, ownedTurnThreadId: null });
        awaitingDesktopTurnRef.current = {
          text: visibleText,
          previousActivityId: latestActivityIdRef.current,
          activityId: '',
          seen: false,
        };
        setExecutionState('running');
        setFollowState('following');
      }
      return true;
    } catch (error) {
      setMessageDelivery((current) => current?.id === delivery.id ? { ...current, status: 'unconfirmed' } : current);
      if (uploadOwnerRef.current === delivery.id) { setUploading(false); uploadOwnerRef.current = null; }
      const selectionStillCurrent = isCurrentSessionRequest(
        targetThreadId, threadIdRef.current, selectionVersion, selectedRequestRef.current,
      );
      if (!selectionStillCurrent) {
        void refreshSessions();
        return;
      }
      if (!steering) {
        runningRef.current = false;
        ownedTurnThreadIdRef.current = null;
        resetExecution();
      }
      if (optimisticItemId) {
        setTimeline((current) => current.filter((item) => item.id !== optimisticItemId && !optimisticExtraIds.includes(item.id)));
      }
      if (composerCleared) {
        setPrompt((current) => current.trim() ? current : text);
        if (attachment) setPendingAttachments(current => current.length ? current : attachments.map(item => ({ ...item, previewUrl: item.kind === 'image' ? URL.createObjectURL(item.file) : '' })));
      }
      if (error instanceof Error && error.message === 'turn_cancelled') {
        return;
      }
      if (error instanceof Error && ['desktop_delivery_unknown', 'desktop_delivery_timeout'].includes(error.message) && targetThreadId) {
        // Reconcile from persisted history; never automatically resend an uncertain delivery.
        await loadHistory(targetThreadId, null, selectionVersion);
        void refreshSessions();
        if (!isCurrentSessionRequest(targetThreadId, threadIdRef.current, selectionVersion, selectedRequestRef.current)) return;
      }
      reportTimelineError(error);
    } finally {
      sendingRef.current.delete(sendKey);
      if (uploadOwnerRef.current === delivery.id) { uploadOwnerRef.current = null; setUploading(false); setUploadingLabel(''); setUploadProgress(null); }
    }
  }, [
    addTimeline, connectorStatus, executionState, modelConfig, newSessionCwd, ownedTurnThreadId, pendingAttachments, imageQuality,
    permissionConfig, prompt, threadId, queueSupported, desktopState, setPendingAttachments, setPrompt,
    loadHistory, refreshSessions, rememberAttachment, rememberImage, reportTimelineError, request, resetExecution, running,
    updateExecution, updateSessionAttention, uploading,
  ]);

  const openMessageEditor = useCallback((item: TimelineItem) => {
    const id = threadIdRef.current;
    if (id && item.historyTurnId) setEditTarget({ item, threadId: id, environment: environmentIdRef.current,
      selection: selectedRequestRef.current });
  }, []);
  const closeMessageEditor = useCallback(() => setEditTarget(null), []);
  const prepareMessageEdit = useCallback(async () => {
    if (!editTarget) throw new Error('message_edit_unavailable');
    return request<MessageEditPlan>('turn.edit.prepare', { threadId: editTarget.threadId, turnId: editTarget.item.historyTurnId });
  }, [editTarget, request]);
  const submitMessageEdit = useCallback(async (plan: MessageEditPlan, text: string) => {
    const target = editTarget;
    const current = () => Boolean(target && environmentIdRef.current === target.environment
      && threadIdRef.current === target.threadId && selectedRequestRef.current === target.selection);
    if (!target || !current()) throw new Error('message_edit_changed');
    const key = JSON.stringify([target.environment, target.threadId]);
    if (sendingRef.current.has(key)) throw new Error('message_edit_busy');
    sendingRef.current.add(key);
    setEditingMessage(true);
    executionVersionRef.current += 1;
    try {
      await request('turn.edit', { threadId: target.threadId, turnId: plan.turnId, token: plan.token, text, confirm: true });
      if (current()) setEditTarget(null);
    } finally {
      sendingRef.current.delete(key);
      if (current()) {
        streamItemRef.current = null;
        setTimeline([]);
        await loadHistory(target.threadId, null, target.selection);
        void refreshSessions();
      }
      setEditingMessage(false);
    }
  }, [editTarget, request, loadHistory, refreshSessions]);

  const answerQuestions = useCallback(async (replies: QuestionReply[]) => (
    Boolean(await sendTurn(replies))
  ), [sendTurn]);

  useEffect(() => {
    if (!creatingNewSession || !newSessionAutoSendRef.current || running || uploading) return;
    newSessionAutoSendRef.current = false;
    void sendTurn();
  }, [creatingNewSession, pendingAttachment, prompt, running, sendTurn, uploading]);

  const stopTurn = useCallback(async () => {
    executionVersionRef.current += 1;
    const selectionVersion = selectedRequestRef.current;
    const targetThreadId = ownedTurnThreadIdRef.current || threadIdRef.current;
    setStopping(true);
    try {
      const native = !ownedTurnThreadIdRef.current && desktopState?.threadId === targetThreadId ? desktopState : null;
      if (!ownedTurnThreadIdRef.current && !native?.canStop) throw new Error('desktop_turn_changed');
      const result = await request<{ stopped: boolean }>('turn.stop', targetThreadId ? { threadId: targetThreadId,
        ...(native ? { source: 'desktop', expectedTurnId: native.turnId } : {}) } : {});
      if (!result.stopped) throw new Error('desktop_turn_changed');
    } catch (error) {
      if (selectionVersion === selectedRequestRef.current) reportTimelineError(error);
      setStopping(false);
      return;
    }
    setStopping(false);
    executionVersionRef.current += 1;
    if (selectionVersion !== selectedRequestRef.current) return;
    runningRef.current = false;
    ownedTurnThreadIdRef.current = null;
    awaitingDesktopTurnRef.current = null;
    setApproval(null);
    setRunDetailsOpen(false);
    resetExecution();
  }, [desktopState, reportTimelineError, request, resetExecution]);

  useEffect(() => {
    setNativeState(null);
  }, [online, environmentId, threadId]);

  useEffect(() => {
    if (!desktopState || ownedTurnThreadIdRef.current) return;
    if (desktopState.status === 'unknown') {
      setApproval(current => current?.source === 'desktop' ? { ...current, actionable: false } : current);
      return;
    }
    const pending = desktopState.approvals?.[0];
    if (pending) setApproval(pending);
    else if (desktopState.waitingOnApproval) setApproval({ approvalId: '', threadId: desktopState.threadId,
      kind: 'desktop', source: 'desktop', actionable: false });
    else if (approvalRef.current?.source === 'desktop') setApproval(null);
    const state = desktopState.waitingOnApproval ? 'waiting' : desktopState.status === 'active' ? 'running'
      : desktopState.status === 'idle' ? 'completed' : null;
    if (state) updateExecution({ running: false, ownedTurnThreadId: null, state });
  }, [desktopState, updateExecution]);

  const answerApproval = useCallback(async (approved: boolean) => {
    if (!approval || approval.actionable === false) return;
    const current = approval;
    const selectionVersion = selectedRequestRef.current;
    setApproval(null);
    try {
      await request('approval.respond', {
        approvalId: current.approvalId,
        threadId: current.threadId,
        approved,
      });
    } catch (error) {
      if (selectionVersion === selectedRequestRef.current) {
        setApproval(current);
        reportTimelineError(error);
      }
    }
  }, [approval, reportTimelineError, request]);

  useEffect(() => {
    setApprovalStatusError('');
    if (!authenticated || !online || !threadId) {
      setApproval(null);
      return;
    }
    const targetEnvironment = environmentIdRef.current;
    const isCurrent = () => threadIdRef.current === threadId && environmentIdRef.current === targetEnvironment;
    let snapshotVersion = executionVersionRef.current;
    const poller = createApprovalPoller({
      read: () => { snapshotVersion = executionVersionRef.current; return request<PendingApprovals>('approval.pending', { threadId }); },
      onError: () => { if (isCurrent()) setApprovalStatusError(t('状态查询失败，正在自动重试。', 'Status check failed; retrying automatically.')); },
      apply: (result) => {
        if (!isCurrent() || snapshotVersion !== executionVersionRef.current
          || sendingRef.current.has(JSON.stringify([environmentIdRef.current, threadId]))) return;
        if (result.desktopStatusUnavailable) {
          setNativeState(null);
          setApprovalStatusError(t('暂时无法确认电脑端状态，正在重试。', 'Desktop status is temporarily unavailable; retrying.'));
          return;
        }
        setApprovalStatusError('');
        if (result.desktopState?.threadId) setNativeState({ environmentId: targetEnvironment, value: result.desktopState as NativeDesktopState });
        const previous = approvalRef.current;
        const pending = result.approvals?.[0] || result.externalApproval || null;
        if (pending) {
          setApproval(pending);
          const webOwned = pending.actionable !== false && pending.source !== 'desktop';
          runningRef.current = webOwned;
          ownedTurnThreadIdRef.current = webOwned ? (pending.threadId || threadId) : null;
          updateExecution((current) => ({
            running: webOwned,
            ownedTurnThreadId: ownedTurnThreadIdRef.current,
            state: 'waiting', activity: 'waiting', startedAt: current.startedAt || Date.now(),
          }));
          if (!previous && viewport.following) viewport.forceBottom = true;
        } else if (result.activeTurn !== undefined && (result.activeTurn !== null || ownedTurnThreadIdRef.current === threadId)) {
          setApproval(null);
          const restored = restoreOwnedTurn(result.activeTurn, threadId,
            ownedTurnThreadIdRef.current, snapshotVersion, executionVersionRef.current);
          if (restored) {
            runningRef.current = restored.running!;
            ownedTurnThreadIdRef.current = restored.ownedTurnThreadId!;
            activeTurnIdRef.current = result.activeTurn?.turnId || '';
            updateExecution(restored);
          }
        } else if (previous?.actionable === false || previous?.source === 'desktop') {
          const state = resolvedDesktopExecution(result);
          if (!state) return;
          setApproval(null);
          runningRef.current = false;
          ownedTurnThreadIdRef.current = null;
          updateExecution({ running: false, ownedTurnThreadId: null,
            state, activity: 'working' });
        }
      },
    });
    approvalPollRef.current = poller;
    void poller.refresh();
    return () => {
      poller.stop();
      if (approvalPollRef.current === poller) approvalPollRef.current = null;
    };
  }, [authenticated, connectionEpoch, environmentId, online, request, threadId, updateExecution]);

  const refreshApprovalStatus = useCallback(async () => {
    setRefreshingApproval(true);
    try { await approvalPollRef.current?.refresh(); }
    finally { setRefreshingApproval(false); }
  }, []);

  const existingProjects = useMemo(() => {
    const seen = new Set<string>();
    const projects: string[] = [];
    for (const session of sessions) {
      const cwd = String(session.cwd || '').trim();
      const key = cwd.toLocaleLowerCase();
      if (!cwd || session.canStartNewSession === false || isTemporaryProjectPath(cwd) || seen.has(key)) continue;
      seen.add(key);
      projects.push(cwd);
    }
    return projects;
  }, [sessions]);
  const selectedExistingProject = existingProjects.find((project) => (
    project.toLocaleLowerCase() === newSessionCwd.trim().toLocaleLowerCase()
  )) || '';
  const steeringAvailable = canSteerOwnedTurn(
    running, executionState, ownedTurnThreadId, threadId,
  );
  const directDesktopDeliveryAvailable = canSendToActiveDesktopTurn(
    running, executionState, ownedTurnThreadId, threadId,
  );
  const stopAvailable = canStopOwnedTurn(
    running, ownedTurnThreadId, threadId || (creatingNewSession ? NEW_TURN_KEY : null),
  ) || Boolean(desktopState?.canStop);
  const executionActive = executionState === 'running' || executionState === 'waiting';
  const showQueueSend = queueSupported && Boolean(threadId) && (executionActive || Boolean(messageQueue.queue?.items.length));
  const deliveryReceipt = useDeliveryNotice(
    visibleDelivery(messageDelivery, environmentId, threadId, selectedRequestRef.current),
    JSON.stringify([executionState, liveActivity, toolPurpose, activityDetail, turnProgress]),
  );
  const liveProgressItemId = useMemo(
    () => executionActive ? latestTurnProgressItemId(timeline) : null,
    [executionActive, timeline],
  );

  useSidePanelSession({ environmentId, threadId: authenticated ? threadId : null,
    title: String(sessions.find((session) => session.id === threadId)?.title || '').slice(0, 160),
    online: authenticated && online }, authenticated);

  if (initialBootstrapPending && !pairingDialogOpen) return <StartupScreen status={statusText} />;

  if (!authenticated) {
    return (
      <main className="login-shell">
        <section className="login-card">
          <div className="brand-mark">C</div>
          <p className="eyebrow">PRIVATE BRIDGE</p>
          <h1>{t('连接 Codex Anywhere', 'Connect to Codex Anywhere')}</h1>
          <p className="login-copy">{t('使用管理员生成的十分钟单次配对链接连接这台设备。', 'Connect this device with a ten-minute, single-use pairing link from the administrator.')}</p>
          {window.__CODEX_ANYWHERE_CONFIG__?.ownerPairingUrl === '/pair' && <a className="owner-connect" href="/pair">{t('连接我的电脑', 'Connect my computer')}</a>}
          <button type="button" className="pair-device-button" onClick={() => setPairingDialogOpen(true)}>
            {connecting ? t('连接中…', 'Connecting…') : t('输入配对链接', 'Enter pairing link')}
          </button>
          <div className="login-status">{statusText}</div>
        </section>
        {pairingDialogOpen && (
          <Suspense fallback={null}>
            <PairingDialog
              open
              value={pairingInput}
              onValueChange={(value) => { setPairingInput(value); setPairingError(''); }}
              pairing={Boolean(pairingCredential)}
              status={statusText}
              error={pairingError}
              onCancel={() => stopPairing()}
              onClose={() => stopPairing('', false)}
              onPair={pairBrowser}
            />
          </Suspense>
        )}
      </main>
    );
  }

  return (
    <main className="app-shell">
      {drawerOpen && <button className="drawer-backdrop" aria-label={t('关闭会话列表', 'Close session list')} onClick={closeDrawer} />}
      <SessionSidebar
        open={drawerOpen}
        environmentId={environmentId}
        environmentIds={environmentIds}
        environmentLabels={environmentLabels}
        onEnvironmentRename={hasEnvironmentInventory ? renameEnvironment : undefined}
        onlineEnvironmentIds={onlineEnvironmentIds}
        sessions={sessions}
        selectedThreadId={threadId}
        executionState={executionState}
        attention={sessionAttention}
        searchOpen={searchOpen}
        search={sessionSearch}
        onSearchOpenChange={setSearchOpen}
        onSearchChange={setSessionSearch}
        onEnvironmentChange={selectEnvironment}
        onNewSession={beginNewSession}
        onClose={closeDrawer}
        onSelect={selectSession}
      />

      {newSessionDialogOpen && (
        <div
          className="new-session-overlay"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeNewSessionDialog();
          }}
        >
          <section className="new-session-dialog" role="dialog" aria-modal="true" aria-labelledby="new-session-title">
            <header className="new-session-dialog-head">
              <p className="eyebrow">CODEX ANYWHERE</p>
              <h2 id="new-session-title">{t('新建会话', 'New session')}</h2>
              <span>{t('选择项目并发送第一条消息；创建前，当前会话保持不变。', 'Choose a project and send the first message. The current session stays unchanged until creation.')}</span>
            </header>
            <div className="new-session-dialog-body">
              {existingProjects.length > 0 && (
                <div className="new-session-field">
                  <span>{t('已有项目', 'Existing project')}</span>
                  <CustomSelect
                    value={selectedExistingProject}
                    ariaLabel={t('选择已有项目', 'Select an existing project')}
                    options={[
                      { value: '', label: t('手动输入其他目录', 'Enter another directory') },
                      ...existingProjects.map((project) => ({
                        value: project,
                        label: projectLabel(project),
                        description: project,
                      })),
                    ]}
                    onChange={setNewSessionCwd}
                  />
                </div>
              )}
              <label className="new-session-field" htmlFor="new-session-cwd">
                <span>{t('项目目录', 'Project directory')}</span>
                <input
                  id="new-session-cwd"
                  value={newSessionCwd}
                  onChange={(event) => {
                    setNewSessionCwd(event.target.value);
                    setNewSessionError('');
                  }}
                  placeholder={t('例如 C:\\workspace\\my-app', 'For example, C:\\workspace\\my-app')}
                  autoComplete="off"
                />
              </label>
              <label className="new-session-field" htmlFor="new-session-prompt">
                <span>{t('第一条消息', 'First message')}</span>
                <textarea
                  id="new-session-prompt"
                  autoFocus
                  rows={4}
                  value={newSessionPrompt}
                  onPaste={(event) => {
                    const file = getClipboardImage(event.clipboardData);
                    if (!file) return;
                    event.preventDefault();
                    void chooseNewSessionAttachment(file);
                  }}
                  onChange={(event) => {
                    setNewSessionPrompt(event.target.value);
                    setNewSessionError('');
                  }}
                  onKeyDown={(event) => {
                    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') submitNewSession();
                  }}
                  placeholder={t('告诉 Codex 要做什么…', 'Tell Codex what to do…')}
                />
              </label>
              <div className="new-session-field new-session-permissions">
                <span>{t('访问权限', 'Access permissions')}</span>
                <PermissionModeControl
                  newSession
                  config={{
                    mode: newSessionPermissionMode, editable: true,
                    networkAccess: connectorStatus?.capabilities.networkAccess === true,
                    allowFullAccess: connectorStatus?.capabilities.fullAccess === true,
                  }}
                  loading={false}
                  disabled={!online}
                  onChange={async (mode) => { setNewSessionPermissionMode(mode); setNewSessionError(''); }}
                />
              </div>
              {newSessionAttachment && (
                <div className="new-session-image-preview">
                  <>{newSessionAttachment.kind === 'image' ? <img src={newSessionAttachment.previewUrl} alt="" /> : <span className="attachment-file-icon" aria-hidden="true">▤</span>}</>
                  <span title={newSessionAttachment.file.name}>{newSessionAttachment.file.name}</span>
                  <button type="button" onClick={() => setNewSessionAttachment(null)} aria-label={t('移除附件', 'Remove attachment')}>×</button>
                </div>
              )}
              <input
                ref={newSessionAttachmentInputRef}
                className="image-input"
                type="file"
                aria-label={t('选择附件', 'Choose attachment')}
                onChange={(event) => {
                  void chooseNewSessionAttachment(event.target.files?.[0]);
                  event.target.value = '';
                }}
              />
              <button className="new-session-attach" type="button" onClick={() => newSessionAttachmentInputRef.current?.click()}>
                <span aria-hidden="true">＋</span>{t('添加附件', 'Add attachment')}
              </button>
              {newSessionError && <p className="new-session-error" role="alert">{newSessionError}</p>}
            </div>
            <footer className="new-session-dialog-actions">
              <button type="button" onClick={() => closeNewSessionDialog()}>{t('取消', 'Cancel')}</button>
              <button
                className="primary-action"
                type="button"
                disabled={!online || uploading || !newSessionCwd.trim() || (!newSessionPrompt.trim() && !newSessionAttachment)}
                onClick={submitNewSession}
              >
                {t('创建并发送', 'Create and send')}
              </button>
            </footer>
          </section>
        </div>
      )}

      <SessionRenameDialog
        open={renameDialogOpen}
        initialName={activeSession?.title || ''}
        onClose={() => setRenameDialogOpen(false)}
        onRename={renameSession}
      />

      {archiveTarget && <SessionArchiveDialog
        key={`${archiveTarget.environment}:${archiveTarget.id}`}
        title={archiveTarget.title}
        cancelPendingApproval={archiveTarget.cancelPendingApproval}
        onClose={() => setArchiveTarget(null)}
        onArchive={archiveSession}
      />}
      {deleteTarget && (
        <SessionDeleteDialog key={`${deleteTarget.environmentId}:${deleteTarget.session.id}`}
          title={deleteTarget.session.title || deleteTarget.session.id}
          onClose={() => setDeleteTarget(null)} onDelete={deleteSession} />
      )}

      <RunDetailsSheet
        open={runDetailsOpen && executionActive}
        state={executionState}
        kind={compactionStartedAt ? 'compacting' : liveActivity}
        purpose={compactionStartedAt ? '' : toolPurpose}
        detail={compactionStartedAt ? '' : activityDetail}
        progress={turnProgress}
        startedAt={activityStartedAt}
        environment={environmentDisplayName(environmentId, environmentLabels)}
        canStop={stopAvailable}
        stopping={stopping}
        onClose={() => setRunDetailsOpen(false)}
        onStop={() => void stopTurn()}
      />

      <section className="conversation">
        <header className="topbar">
          <button className="icon-button mobile-only" onClick={() => setDrawerOpen(true)} aria-label={t('展开会话列表', 'Expand session list')} title={t('展开会话列表', 'Expand session list')}>
            <SidebarIcon name="panel-open" />
          </button>
          <div className="conversation-heading">
            {activeSession && <details className="session-identity">
              <summary title={activeSession.cwd}>{activeSession.project?.name || t('未分配项目', 'Unassigned')}<span> / {activeSession.cwd}</span></summary>
              <div><span>{t('工作目录', 'Working directory')}</span><code>{activeSession.cwd}</code>
                <span>{t('原会话 ID', 'Original chat ID')}</span><code>{activeSession.id}</code></div>
            </details>}
            <div className="conversation-title">
              <strong>{activeSession?.title || (threadId ? t('Codex 会话', 'Codex session') : creatingNewSession ? t('新会话', 'New session') : t('最近会话', 'Recent session'))}</strong>
              {threadId && (
                <button
                  className="session-rename-button"
                  type="button"
                  disabled={!online}
                  onClick={() => setRenameDialogOpen(true)}
                  aria-label={t('修改会话名称', 'Rename session')}
                  title={t('修改会话名称', 'Rename session')}
                >
                  <SidebarIcon name="edit" />
                </button>
              )}
              <span>{environmentShortName(environmentId, environmentLabels)}</span>
              {threadId && connectorStatus?.capabilities.sessionArchive && (
                <button type="button" className="session-rename-button" disabled={!online || (executionActive && !(approval?.actionable === false && connectorStatus.capabilities.sessionArchivePendingApproval))}
                  aria-label={t('归档会话', 'Archive session')} title={t('归档会话', 'Archive session')}
                  onClick={() => setArchiveTarget({ id: threadId, title: activeSession?.title || threadId, environment: environmentId,
                    cancelPendingApproval: approval?.actionable === false })}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                    <path d="M4 8v12h16V8M3 4h18v4H3zM9 12h6" />
                  </svg>
                </button>
              )}
              {threadId && activeSession && connectorStatus?.mode === 'headless'
                && connectorStatus.capabilities.sessionDelete && !connectorStatus.capabilities.sessionArchive && (
                <button type="button" className="session-rename-button"
                  disabled={!online || executionActive || isSessionRunning(activeSession.status) || sessionAttention[threadId] === 'running'}
                  aria-label={t('删除会话', 'Delete session')} title={t('删除会话', 'Delete session')}
                  onClick={() => beginDeleteSession(activeSession)}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                    <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7M14 10v7" />
                  </svg>
                </button>
              )}
            </div>
            <div className="conversation-controls">
              <ModelConfigControl
                config={modelConfig}
                hasSession={Boolean(threadId)}
                onRefresh={refreshModelConfig}
                loading={modelConfigLoading}
                disabled={!online || executionActive}
                onSave={saveModelConfig}
              />
              <PermissionModeControl
                key={`permission:${environmentId}:${threadId}`}
                config={permissionConfig}
                loading={permissionConfigLoading}
                disabled={!online || executionActive}
                onChange={savePermissionMode}
                onRefresh={refreshPermissionConfig}
                onOpenDesktop={openPermissionSettingsOnDesktop}
              />
              <BrowserSessionStatus key={`${environmentId}:${threadId}`} environmentId={environmentId} threadId={threadId} online={online} request={request} />
            </div>
          </div>
          <PresenceIndicator
            online={online}
            executionState={executionState}
            statusText={statusText}
            contextUsage={contextUsage}
          />
        </header>

        {editTarget && editTarget.environment === environmentId && editTarget.threadId === threadId
          && editTarget.selection === selectedRequestRef.current && <MessageEditDialog
          originalText={editTarget.item.text} onPrepare={prepareMessageEdit} onSubmit={submitMessageEdit} onClose={closeMessageEditor} />}
        <ConversationTimeline
          onEditMessage={openMessageEditor}
          editDisabled={!online || executionActive || uploading || editingMessage}
          messageListRef={messageListRef}
          messageContentRef={messageContentRef}
          threadId={threadId}
          environmentId={environmentId}
          creatingNewSession={creatingNewSession}
          initialHistoryLoaded={initialHistoryLoaded}
          nextCursor={nextCursor}
          historyLoading={historyLoading}
          olderHistoryError={olderHistoryError}
          olderHistoryAutoLoadEnabled={olderHistoryAutoLoadEnabled}
          timeline={timeline}
          questionReplyDisabled={!online || uploading || (running && !steeringAvailable)}
          onQuestionReply={answerQuestions}
          resolvedQuestionAnswers={resolvedQuestionAnswers}
          knownAttachments={knownAttachments}
          attachmentUrls={attachmentUrls}
          attachmentNames={attachmentNames}
          onRetryImages={retryImages}
          executionActive={executionActive}
          progressAnimationReady={followState !== 'checking'}
          liveProgressItemId={liveProgressItemId}
          onScroll={handleMessageScroll}
          onLoadOlder={loadOlder}
          onDownloadFile={downloadOriginalFile}
          onReadTextFile={readTextFile}
          onReadTurnDiff={readTurnDiff}
          onReadVisualization={readVisualization}
          onReadPreviewImage={readPreviewImage}
        />
        <div className="execution-strip">
          {(deliveryReceipt || (!compactionStartedAt && executionActive)) && (
            <LiveActivityStatus
              active={!compactionStartedAt && executionActive}
              kind={liveActivity}
              purpose={toolPurpose}
              detail={activityDetail}
              progress={turnProgress}
              startedAt={activityStartedAt}
              onOpenDetails={!compactionStartedAt && executionActive ? () => setRunDetailsOpen(true) : undefined}
              notice={deliveryReceipt && <div className={`message-delivery ${deliveryReceipt.status}`} role="status" aria-live="polite" aria-atomic="true">
                {deliveryReceipt.status === 'confirmed'
                  ? t(`✓ 上一条消息已送达${environmentDisplayName(deliveryReceipt.environmentId, environmentLabels)}`,
                    `✓ Last message delivered to ${environmentDisplayName(deliveryReceipt.environmentId, environmentLabels)}`)
                  : deliveryReceipt.status === 'sending'
                    ? t('正在投递消息…', 'Delivering your message…')
                    : t('未确认送达，请检查会话后再重试。', 'Delivery not confirmed. Check the conversation before retrying.')}
              </div>}
            />
          )}
          <DownloadIndicator download={fileDownload} onCancel={cancelFileDownload} />
        </div>

        {lastArchived?.environment === environmentId && (
          <ArchivedSessionNotice title={lastArchived.title} online={online} restoring={restoringSession} error={restoreError}
            onDismiss={() => setLastArchived(null)}
            onRestore={connectorStatus?.capabilities.sessionRestore ? () => void restoreArchivedSession() : undefined} />
        )}

        {approval && (
          <ApprovalNotice approval={approval} online={online} refreshing={refreshingApproval} error={approvalStatusError}
            onAnswer={(approved) => void answerApproval(approved)}
            onRefresh={() => void refreshApprovalStatus()}
            onOpen={() => {
              const selected = selectedRequestRef.current;
              void openPermissionSettingsOnDesktop().catch((error) => {
                if (selected === selectedRequestRef.current) setApprovalStatusError(friendlyError(error));
              });
            }}
            onArchive={threadId && connectorStatus?.capabilities.sessionArchivePendingApproval
              ? () => setArchiveTarget({ id: threadId, title: activeSession?.title || threadId,
                environment: environmentId, cancelPendingApproval: true }) : undefined} />
        )}

        {(threadId || creatingNewSession) && <footer className="composer-wrap">
          {queueSupported && threadId && <MessageQueuePanel key={`${environmentId}:${threadId}`} queue={messageQueue.queue} error={messageQueue.error} online={online} change={messageQueue.change} />}
          <ConnectionNotice relayConnected={socketAuthenticatedRef.current} connectorConnected={online} desktop={connectorStatus?.mode === 'desktop'} desktopOnline={connectorStatus?.desktopOnline} />
          {!draftSaved && prompt && <p className="connection-notice" role="status">{t('当前浏览器无法保存草稿，请先复制文字再刷新。', 'This browser cannot save the draft. Copy your text before refreshing.')}</p>}
          {!!pendingAttachments.length && <div className="attachment-controls">
            <span>{pendingAttachments.length}/6 {t('个附件', 'attachments')}</span>
            {pendingAttachments.some(item => item.kind === 'image') && <label>{t('交给模型的图片', 'Model image')} <select aria-label={t('图片清晰度', 'Image quality')} value={imageQuality} disabled={uploading}
              onChange={event => { const next = event.target.value === 'high' ? 'high' : 'economy'; setImageQuality(next); writeLocal('personal.imageQuality', next); }}>
              <option value="economy">{t('省流', 'Compact')}</option><option value="high">{t('原图', 'Original')}</option></select></label>}
            <small>{t('原文件始终保留在本机，首次上传仍传原文件。', 'Originals stay on your computer; the first upload transfers the original.')}</small>
          </div>}
          {!!pendingAttachments.length && <div className="attachment-queue">{pendingAttachments.map((item, index) => (
            <div className="image-preview" key={item.previewUrl || `${index}:${item.file.name}`}>
              {item.kind === 'image' ? <img src={item.previewUrl} alt={t('待发送图片预览', 'Image ready to send')} /> : <span className="attachment-file-icon" aria-hidden="true">▤</span>}
              <div className="image-preview-details">
                <strong>{item.file.name}</strong><small>{formatBytes(item.file.size)}</small>
              </div>
              <button
                type="button"
                onClick={() => setPendingAttachments(items => items.filter((_, i) => i !== index))}
                disabled={uploading || (running && !queueSupported)}
                aria-label={`${t('移除附件', 'Remove attachment')} ${index + 1}`}
              >×</button>
            </div>
          ))}</div>}
          {uploading && uploadProgress && <div className="queue-progress" role="status"><span>{uploadingLabel}</span><ImageUploadProgress state={uploadProgress} kind={pendingAttachment?.kind || 'file'} /></div>}
          <div className="composer">
            <input
              ref={attachmentInputRef}
              className="image-input"
              type="file"
              multiple
              aria-label={t('选择附件', 'Choose attachment')}
              onChange={(event) => {
                const files = Array.from(event.target.files || []);
                event.target.value = '';
                void chooseAttachment(files);
              }}
              disabled={(running && !queueSupported) || uploading}
            />
            <button
              className="attach-button"
              type="button"
              onClick={() => attachmentInputRef.current?.click()}
              disabled={(running && !queueSupported) || uploading}
              aria-label={t('添加附件', 'Add attachment')}
              title={t('最多 6 个附件，图片最大 32 MB，其他文件最大 100 MB', 'Up to 6 attachments; images 32 MB, other files 100 MB')}
            >＋</button>
            <textarea
              rows={1}
              value={prompt}
              onPaste={(event) => {
                if ((running && !queueSupported) || uploading) return;
                const file = getClipboardImage(event.clipboardData);
                if (!file) return;
                event.preventDefault();
                void chooseAttachment([file]);
              }}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
                if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') void sendTurn();
              }}
              placeholder={uploading
                ? t('正在上传附件…', 'Uploading attachment…')
                : queueSupported && threadId && (executionActive || Boolean(messageQueue.queue?.items.length))
                  ? t('写好下一条消息，当前任务结束后发送…', 'Write the next message; it will send when this run ends…')
                : steeringAvailable
                  ? t('向当前任务追加指令…', 'Steer the current run…')
                  : directDesktopDeliveryAvailable
                    ? t('直接发送到当前任务…', 'Send to the current run…')
                  : online ? t('发送给当前 Codex…', 'Send to the current Codex…') : t('当前执行环境离线', 'Current environment is offline')}
              disabled={uploading}
            />
            <div className="composer-actions">
              {queueSupported && threadId && executionActive && <button type="button" className="queue-immediate-button" disabled={!online || uploading || !prompt.trim() || Boolean(pendingAttachment)}
                onClick={() => void sendTurn(undefined, 'immediate')} aria-label={t('立即追加', 'Send immediately')} title={t('立即交给当前任务，可能改变它正在进行的工作', 'Send to the current run immediately; this may change its work')}>
                {t('立即追加', 'Send now')}</button>}
              <button
                  className={`send-button${uploading ? ' uploading' : ''}${showQueueSend ? ' queue-send' : ''}`}
                  disabled={
                    !online
                    || uploading
                    || (running && !steeringAvailable && !queueSupported)
                    || (!prompt.trim() && !pendingAttachment)
                    || (!threadId && !newSessionCwd.trim())
                  }
                  onClick={() => void sendTurn()}
                  aria-label={uploading
                    ? t('正在发送附件', 'Sending attachment')
                    : queueSupported && threadId
                      ? executionActive || Boolean(messageQueue.queue?.items.length) ? t('加入队列', 'Add to queue') : t('发送', 'Send')
                    : steeringAvailable
                      ? t('追加指令', 'Steer')
                      : t('发送', 'Send')}
                >
                  {showQueueSend && !uploading ? <span>{t('排队', 'Queue')}</span> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 5 16 7-16 7 3-7-3-7Zm3 7h13" /></svg>}
              </button>
            </div>
          </div>
          <small>{queueSupported && threadId
            ? t('运行中发送默认排队；“立即追加”会影响当前任务。', 'Messages queue during a run. Send now steers the current task.')
            : steeringAvailable
            ? t('运行中可继续追加文字指令', 'You can steer this run with another text instruction')
            : t('Ctrl/⌘+V 粘贴图片 · Ctrl/⌘+Enter 发送', 'Ctrl/⌘+V to paste an image · Ctrl/⌘+Enter to send')}</small>
        </footer>}
      </section>
    </main>
  );
}
