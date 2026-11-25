const BRIDGE_BASE = 'http://127.0.0.1:17501';
const SCRIPT_VERSION = '2.0.3';
const activations = new Map();
const storageReady = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });

async function bridgeRequest(route, body, anonymous = false) {
  await storageReady;
  const { reviewToken } = await chrome.storage.local.get('reviewToken');
  if (!anonymous && !reviewToken) throw new Error('请先在插件设置中配对 Herdr');
  const response = await fetch(BRIDGE_BASE + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(!anonymous ? { Authorization: `Bearer ${reviewToken}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Bridge refused request');
  return result;
}
// options_page opens in a Chrome tab, so sender.tab is not a trust boundary.
// The browser-supplied extension identity, exact packaged URL and origin are.
const settingsSender = sender => sender.id === chrome.runtime.id
  && sender.url === chrome.runtime.getURL('pairing.html')
  && (!sender.origin || sender.origin === `chrome-extension://${chrome.runtime.id}`)
  && (sender.frameId === undefined || sender.frameId === 0);
const httpPage = url => /^https?:\/\//.test(url || '');

async function activate(tab) {
  if (!tab?.id || !httpPage(tab.url)) return;
  await storageReady;
  const { reviewToken } = await chrome.storage.local.get('reviewToken');
  if (!reviewToken) { await chrome.runtime.openOptionsPage(); return; }
  await bridgeRequest('/api/ext-heartbeat', {});
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['page-hook.js'], world: 'MAIN' });
  // The guarded transport loads before the view so no send can bypass invalidation handling.
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['runtime-connection.js', 'content.js'], world: 'ISOLATED' });
  const activationNonce = crypto.randomUUID();
  activations.set(tab.id, { activationNonce, url: tab.url });
  await chrome.tabs.sendMessage(tab.id, { type: 'HERDR_TOGGLE_ANNOTATOR', activationNonce, version: SCRIPT_VERSION });
}
chrome.action.onClicked.addListener(tab => activate(tab).catch(() => chrome.runtime.openOptionsPage()));
chrome.commands.onCommand.addListener(async command => {
  if (command !== 'toggle-annotator') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) activate(tab).catch(() => chrome.runtime.openOptionsPage());
});
chrome.tabs.onRemoved.addListener(id => activations.delete(id));
chrome.tabs.onUpdated.addListener((id, change) => { if (change.status === 'loading') activations.delete(id); });

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || sender.id !== chrome.runtime.id) return false;
  (async () => {
    if (settingsSender(sender)) {
      if (msg.type === 'HERDR_PAIR') {
        if (typeof msg.code !== 'string' || !/^[A-F0-9]{16}$/.test(msg.code)) throw new Error('无效配对码');
        const result = await bridgeRequest('/api/pair', { code: msg.code, extensionId: chrome.runtime.id }, true);
        if (!/^[a-f0-9]{64}$/.test(result.token || '')) throw new Error('Invalid pairing response');
        await chrome.storage.local.set({ reviewToken: result.token });
        return { paired: true };
      }
      if (msg.type === 'HERDR_FORGET_PAIR') { await chrome.storage.local.remove('reviewToken'); activations.clear(); return { paired: false }; }
      if (msg.type === 'HERDR_PAIR_STATUS') {
        const { reviewToken } = await chrome.storage.local.get('reviewToken');
        if (!reviewToken) return { paired: false, connected: false };
        try { await bridgeRequest('/api/ext-heartbeat', {}); return { paired: true, connected: true }; }
        catch { return { paired: true, connected: false }; }
      }
      throw new Error('Unknown configuration request');
    }
    const active = activations.get(sender.tab?.id);
    if (!active || msg.activationNonce !== active.activationNonce || sender.frameId !== 0 || !httpPage(sender.url)) throw new Error('请点击插件图标重新开启标注');
    if (msg.type === 'HERDR_BRIDGE_HEARTBEAT') {
      await bridgeRequest('/api/ext-heartbeat', {});
      return {};
    }
    if (msg.type === 'HERDR_BRIDGE_STATUS') {
      await bridgeRequest('/api/ext-heartbeat', {});
      return { data: await bridgeRequest('/api/status') };
    }
    if (msg.type !== 'HERDR_CAPTURE_AND_SEND') throw new Error('Unsupported page request');
    const payload = msg.payload;
    if (!payload || !['stage','silent_stage'].includes(payload.action) || !Array.isArray(payload.items) || payload.items.length > 100 || JSON.stringify(payload).length > 100000) throw new Error('Invalid annotation request');
    const tab = await chrome.tabs.get(sender.tab.id);
    if (payload.url !== sender.url || tab.url !== sender.url) throw new Error('页面已切换，请重试');
    let screenshotDataUrl = null;
    if (msg.captureScreenshot === true) {
      const [before] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
      if (before?.id !== tab.id) throw new Error('截图前标签页已切换');
      screenshotDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      const [after] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
      const latest = await chrome.tabs.get(tab.id);
      if (after?.id !== tab.id || latest.url !== sender.url) throw new Error('截图期间标签页已切换');
    }
    // Worker constructs the allowlisted payload; the page cannot supply credentials or paths.
    const data = await bridgeRequest('/api/annotations', {
      action: payload.action, url: payload.url, title: payload.title, globalNote: payload.globalNote,
      items: payload.items, targetTerminal: payload.targetTerminal,
      requestId: crypto.randomUUID(), ...(screenshotDataUrl ? { screenshotDataUrl } : {}),
    });
    return { data };
  })().then(result => sendResponse({ ok: true, ...result }), err => sendResponse({ ok: false, error: err.message || 'Review request failed' }));
  return true;
});
