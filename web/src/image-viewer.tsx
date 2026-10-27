import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { t } from './i18n';

export type GalleryImage = { path: string; name: string; url?: string };
export function ImageViewer({ images, initialPath, load, download, close }: {
  images: GalleryImage[]; initialPath: string;
  load?: (path: string, quality?: 'high') => Promise<string>;
  download: (path: string) => void; close: () => void;
}) {
  const [index, setIndex] = useState(Math.max(0, images.findIndex(image => image.path === initialPath)));
  const image = images[Math.min(index, images.length - 1)];
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const [high, setHigh] = useState<{ path: string; url: string } | null>(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState('');
  const request = useRef(0), root = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef({ distance: 0, scale: 1, x: 0, y: 0, startX: 0, startY: 0, dragX: 0, dragY: 0, pinched: false });
  const reset = useCallback(() => setView({ scale: 1, x: 0, y: 0 }), []);
  const navigate = useCallback((delta: number) => { request.current++; setLoading(false); setError(''); reset(); setIndex(current => Math.max(0, Math.min(images.length - 1, current + delta))); }, [images.length, reset]);
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; root.current?.focus();
    return () => { request.current++; previous?.focus(); };
  }, []);
  useEffect(() => { const key = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    else if (event.key === 'ArrowLeft') navigate(-1); else if (event.key === 'ArrowRight') navigate(1);
    else if (event.key === 'Tab') { const buttons = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || []); const first = buttons[0], last = buttons.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === root.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }; document.addEventListener('keydown', key, true); return () => document.removeEventListener('keydown', key, true);
  }, [close, navigate]);
  const zoom = (delta: number) => setView(current => ({ ...current, scale: Math.max(1, Math.min(6, current.scale + delta)), ...(current.scale + delta <= 1 ? { x: 0, y: 0 } : {}) }));
  const start = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId); pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const points = [...pointers.current.values()];
    if (points.length === 1) gesture.current = { distance: 0, scale: view.scale, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, dragX: view.x, dragY: view.y, pinched: false };
    if (points.length === 2) { gesture.current.distance = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y); gesture.current.scale = view.scale; gesture.current.pinched = true; }
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY }); const points = [...pointers.current.values()], g = gesture.current;
    if (points.length === 2 && g.distance > 0) setView(current => ({ ...current, scale: Math.max(1, Math.min(6, g.scale * Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y) / g.distance)) }));
    else if (points.length === 1 && view.scale > 1 && !g.pinched) { const bounds = event.currentTarget.getBoundingClientRect();
      setView(current => ({ ...current, x: Math.max(-bounds.width * (current.scale - 1) / 2, Math.min(bounds.width * (current.scale - 1) / 2, g.dragX + event.clientX - g.x)), y: Math.max(-bounds.height * (current.scale - 1) / 2, Math.min(bounds.height * (current.scale - 1) / 2, g.dragY + event.clientY - g.y)) })); }
  };
  const end = (event: PointerEvent<HTMLDivElement>) => {
    const g = gesture.current; const wasSingle = pointers.current.size === 1; pointers.current.delete(event.pointerId);
    if (event.type !== 'pointercancel' && wasSingle && !g.pinched && view.scale === 1 && Math.abs(event.clientX - g.startX) > 60 && Math.abs(event.clientY - g.startY) < 70) navigate(event.clientX > g.startX ? -1 : 1);
  };
  const loadHigh = async () => { if (!load || !image) return; const id = ++request.current; setLoading(true); setError('');
    try { const url = await load(image.path, 'high'); if (id === request.current) setHigh({ path: image.path, url }); }
    catch { if (id === request.current) setError(t('高清加载失败，可以重试或下载原图。', 'Could not load HD; retry or download the original.')); }
    finally { if (id === request.current) setLoading(false); }
  };
  if (!image) return null;
  return <div className="image-viewer" ref={root} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t('图片预览', 'Image preview')}>
    <header><span>{index + 1}/{images.length} · {image.name}</span><button type="button" onClick={close} aria-label={t('关闭图片预览', 'Close image preview')}>×</button></header>
    <div className="image-viewer-canvas" onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end}
      onDoubleClick={() => view.scale > 1 ? reset() : zoom(1)} onWheel={event => zoom(event.deltaY < 0 ? .25 : -.25)}>
      <img src={high?.path === image.path ? high.url : image.url} alt={image.name} draggable={false} style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }} />
    </div>
    <footer>
      <div className="image-viewer-actions"><button type="button" disabled={index === 0} onClick={() => navigate(-1)}>{t('上一张', 'Previous')}</button><button type="button" disabled={index === images.length - 1} onClick={() => navigate(1)}>{t('下一张', 'Next')}</button>
        <button type="button" onClick={() => zoom(-.5)} aria-label={t('缩小图片', 'Zoom out')}>−</button><button type="button" onClick={reset}>{Math.round(view.scale * 100)}%</button><button type="button" onClick={() => zoom(.5)} aria-label={t('放大图片', 'Zoom in')}>＋</button>
        {load && <button type="button" onClick={() => void loadHigh()} disabled={loading || high?.path === image.path}>{loading ? t('加载中…', 'Loading…') : high?.path === image.path ? t('已加载高清', 'HD loaded') : t('加载高清', 'Load HD')}</button>}
        <button type="button" onClick={() => download(image.path)}>{t('下载原图', 'Download original')}</button></div>
      <small role="status">{error || t('默认显示省流预览；双指缩放，放大后拖动，左右滑动切图。', 'Compact preview by default. Pinch to zoom, drag to pan, swipe to switch.')}</small>
    </footer>
  </div>;
}
