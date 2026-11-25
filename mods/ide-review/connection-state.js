export function formatCode(code) {
  return String(code || '').replace(/[^a-f0-9]/gi, '').toUpperCase().match(/.{1,4}/g)?.join(' ') || '';
}
export function remainingTime(expiresAt, now = Date.now()) {
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return seconds ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : '已过期';
}
export function connectionLabel(online, status) {
  if (!online) return '服务未连接';
  if (status?.connected) return 'Chrome 已连接';
  return status?.installed ? '已配对 · 离线' : '浏览器未连接';
}
