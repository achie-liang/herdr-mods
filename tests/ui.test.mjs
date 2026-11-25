// Behaviour the person sees: honest connection state, one Agent label, in-place pairing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = name => fs.readFileSync(new URL('../mods/ide-review/' + name, import.meta.url), 'utf8');
const main = read('main.js');

test('bridge status recovers and is not confused with queue problems', async () => {
  const method = main.slice(main.indexOf('  async reloadQueue(cx) {'), main.indexOf('  effectiveAgentAddress() {'));
  const View = vm.runInNewContext(`(class { ${method} })`, { checking: () => false });
  const snapshot = { revision: 1, batches: [] };

  const recovered = new View();
  recovered.bridgeOnline = false;
  recovered.lastQueueRaw = JSON.stringify(snapshot);
  recovered.bridgeCommand = async command => command === '--check-ext' ? { installed: true, connected: true } : snapshot;
  await recovered.reloadQueue({ notify() {} });
  assert.equal(recovered.bridgeOnline, true, 'an unchanged queue still proves the bridge answers');
  assert.equal(recovered.extStatus.connected, true);

  const unhealthyQueue = new View();
  unhealthyQueue.bridgeCommand = async command => {
    if (command === '--check-ext') return { installed: true, connected: true };
    throw new Error('queue unavailable');
  };
  await unhealthyQueue.reloadQueue({ notify() {} });
  assert.equal(unhealthyQueue.bridgeOnline, true, 'annotation storage is not connectivity');

  const offline = new View();
  offline.bridgeOnline = true;
  offline.bridgeCommand = async () => { throw new Error('connection refused'); };
  await offline.reloadQueue({ notify() {} });
  assert.equal(offline.bridgeOnline, false);
});

test('the To button and its list label Agents the same way the extension does', () => {
  const toolbar = main.slice(main.indexOf('  renderTopBar('), main.indexOf('  renderAgentDropdown('));
  const dropdown = main.slice(main.indexOf('  renderAgentDropdown('), main.indexOf('  renderBatchStrip('));
  assert.match(toolbar, /\.displayLabel/);
  assert.match(toolbar, /\.child\(selectedLabel\)/);
  assert.match(dropdown, /contextAgent\?\.displayLabel/);
  assert.match(dropdown, /\.child\(label\)/);
});

test('pairing stays in the connection menu: code on demand, copy by click, revoke by confirm', async () => {
  const source = read('security-ui.js');
  const handlers = new Map();
  const builder = () => {
    let id;
    const el = new Proxy({}, {
      get: (_target, key) => (...args) => {
        if (key === 'id') id = args[0];
        else if (key === 'on_mouse_down' && id) handlers.set(id, args[1]);
        else if (key === 'when' && args[0]) args[1](el);
        return el;
      },
    });
    return el;
  };
  const code = source.replace(/^import .*;\n/gm, '').replace('export const securityMethods =', 'const securityMethods =');
  const api = vm.runInNewContext(code + '\nsecurityMethods;', {
    div: builder, h_flex: builder, v_flex: builder, svg: builder,
    theme: () => ({}), remainingTime: () => '5:00', formatCode: value => value,
    bundledExtensionDir: () => '/ext', notify: () => {}, exec: async () => {},
    closeOverlay: () => {}, openOverlay: () => {}, popoverAnchor: () => 'pointer',
    props: () => ({ securityDialog: 'menu', paired: true }), Date, Math,
  });

  let copied = '', revocations = 0;
  const cx = { notify() {}, stop_propagation() {}, write_to_clipboard: text => { copied = text; } };
  const view = { ...api, extStatus: { installed: true }, bridgeCommand: async cmd => {
    if (cmd === '--check-ext') return { installed: true, pairedAt: 100 };
    if (cmd === '--revoke') revocations++;
    return { code: 'ABCD1234EF567890', expiresAt: Date.now() + 300000 };
  } };

  view.renderSecurityDialog(cx);
  assert.equal(handlers.has('connection-pair-code'), false, 'opening the menu must not generate a code');

  handlers.get('connection-menu-pair')({}, cx);
  await new Promise(resolve => setImmediate(resolve));
  view.renderSecurityDialog(cx);
  handlers.get('connection-pair-code')({}, cx);
  assert.equal(copied, 'ABCD1234EF567890');

  handlers.get('connection-menu-revoke')({}, cx);
  assert.equal(view.revokeConfirm, true);
  assert.equal(revocations, 0, 'revocation waits for the confirmation button');
});

test('the personal layout shows every bundled panel', () => {
  const tabs = fs.readFileSync(new URL('../mods/ide-tabs/main.js', import.meta.url), 'utf8');
  assert.doesNotMatch(tabs, /shared\("workspace\.panels"\)/, "shipped welcome settings must not hide panels here");
  assert.match(tabs, /const enabled = \["files", "changes", "review"\]/);
});
