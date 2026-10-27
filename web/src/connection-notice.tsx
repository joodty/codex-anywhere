import { useEffect, useState } from 'react';
import { t } from './i18n';

export function ConnectionNotice({ relayConnected, connectorConnected, desktop, desktopOnline }: {
  relayConnected: boolean; connectorConnected: boolean; desktop: boolean; desktopOnline?: boolean;
}) {
  const [browserOnline, setBrowserOnline] = useState(navigator.onLine);
  useEffect(() => { const sync = () => setBrowserOnline(navigator.onLine); window.addEventListener('online', sync); window.addEventListener('offline', sync);
    return () => { window.removeEventListener('online', sync); window.removeEventListener('offline', sync); };
  }, []);
  let text = '';
  if (!browserOnline) text = t('当前浏览器已断网，网络恢复后会自动重连。文字草稿仍保存在此浏览器。', 'Your browser is offline. It will reconnect; text drafts stay in this browser.');
  else if (!relayConnected) text = t('暂时无法连接网页服务，正在重试。文字草稿仍保存在此浏览器。', 'The web service is unreachable. Retrying; your text draft is kept.');
  else if (!connectorConnected) text = t('网页服务已连接，本机暂时离线。请检查电脑是否开机、连接器是否在运行。', 'Web service connected; your computer is offline. Check its power and connector.');
  else if (desktop && desktopOnline === false) text = t('本机已连接，Codex 桌面暂未就绪。请检查电脑上的 Codex。', 'Your computer is connected; Codex Desktop is not ready. Check Codex on your computer.');
  return text ? <p className="connection-notice" role="status">{text}</p> : null;
}
