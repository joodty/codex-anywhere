import { useCallback, useEffect, useRef, useState } from 'react';
import type { PendingAttachment } from './app-types';
import { prepareAttachment } from './file-upload';

export const MAX_ATTACHMENTS = 6;
export function useAttachmentQueue() {
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const current = useRef(attachments); current.current = attachments;
  const generation = useRef(0);
  const invalidate = useCallback(() => { generation.current++; }, []);
  const choose = useCallback(async (files: File[], onError: (e: unknown) => void, isCurrent: () => boolean = () => true) => {
    const version = generation.current;
    if (files.length + current.current.length > MAX_ATTACHMENTS) { onError(new Error('一次最多添加 6 个附件')); return; }
    const prepared: PendingAttachment[] = [];
    try {
      for (const file of files) prepared.push(await prepareAttachment(file));
      if (version !== generation.current || !isCurrent()) { for (const item of prepared) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl); return; }
      const next = [...current.current, ...prepared];
      if (next.length <= MAX_ATTACHMENTS) { current.current = next; setAttachments(next); }
      else { for (const item of prepared) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl); onError(new Error('一次最多添加 6 个附件')); }
    } catch (error) { for (const item of prepared) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl); if (version === generation.current && isCurrent()) onError(error); }
  }, []);
  // Revoke only resources no longer in the queue; preserve originals for retry.
  const previous = useRef<PendingAttachment[]>([]);
  useEffect(() => { for (const item of previous.current) if (!attachments.some(next => next.previewUrl === item.previewUrl) && item.previewUrl) URL.revokeObjectURL(item.previewUrl); previous.current = attachments; }, [attachments]);
  useEffect(() => () => { generation.current++; for (const item of current.current) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl); }, []);
  return { attachments, setAttachments, choose, invalidate };
}
