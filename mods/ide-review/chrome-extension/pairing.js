const status = document.getElementById('status');
const code = document.getElementById('code');
const connect = document.getElementById('connect');
const form = document.getElementById('pair-form');
const connectedActions = document.getElementById('connected-actions');
const confirmation = document.getElementById('forget-confirm');
let busy = false;
const normalize = value => value.replace(/[^a-f0-9]/gi, '').toUpperCase().slice(0, 16);
function show(text, state = '') { status.textContent = text; status.dataset.state = state; }
function setBusy(value) {
  busy = value; code.disabled = value; connect.disabled = value;
  connect.textContent = value ? '正在连接…' : '连接 Herdr';
  document.getElementById('forget-allow').disabled = value;
}
async function message(msg) {
  const result = await chrome.runtime.sendMessage(msg);
  if (!result?.ok) throw new Error(result?.error || '连接失败，请确认 Herdr 正在运行。');
  return result;
}
async function refresh() {
  try {
    const r = await message({ type: 'HERDR_PAIR_STATUS' });
    form.hidden = Boolean(r.connected); connectedActions.hidden = !r.paired;
    show(r.connected ? '✓ 已连接 Herdr。点击插件图标开始页面标注。' : r.paired ? '已保存配对，但 Herdr 服务离线或授权已撤销。可检查服务或重新配对。' : '尚未配对，请输入 Herdr 显示的配对码。', r.connected ? 'success' : '');
  } catch (e) { show(e.message, 'error'); }
}
code.addEventListener('input', () => {
  const raw = normalize(code.value);
  code.value = raw.match(/.{1,4}/g)?.join(' ') || '';
});
form.addEventListener('submit', async e => {
  e.preventDefault(); if (busy) return;
  const raw = normalize(code.value);
  if (raw.length !== 16) { show('请输入完整的 16 位配对码。', 'error'); code.focus(); return; }
  setBusy(true); show('正在验证配对码…');
  try { await message({ type: 'HERDR_PAIR', code: raw }); code.value = ''; await refresh(); }
  catch (e) { show(e.message, 'error'); }
  finally { setBusy(false); }
});
document.getElementById('forget').addEventListener('click', () => { confirmation.hidden = false; });
document.getElementById('forget-cancel').addEventListener('click', () => { confirmation.hidden = true; });
document.getElementById('forget-allow').addEventListener('click', async () => {
  if (busy) return; setBusy(true);
  try { await message({ type: 'HERDR_FORGET_PAIR' }); confirmation.hidden = true; await refresh(); }
  catch (e) { show(e.message, 'error'); }
  finally { setBusy(false); }
});
refresh();
