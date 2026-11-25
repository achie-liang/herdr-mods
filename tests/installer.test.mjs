// Chrome installation is local-only, touches only Herdr's own card, and reports permission gaps.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { installChromeExtension } from '../mods/ide-review/chrome-install.mjs';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-installer-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, 'mods/ide-review/chrome-extension');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ version: '2.0.2' }));
  return { home, dir };
}
const scripted = (stdout, stderr = '') => async (cmd) => cmd === 'osascript'
  ? { ok: !stderr, stdout, stderr } : { ok: true, stdout: '' };

test('reload targets the Herdr card and needs registered proof', async t => {
  const { home } = fixture(t);
  const calls = [];
  const result = await installChromeExtension(home, {
    platform: 'darwin', registration: () => ({ version: '2.0.2' }), wait: async () => {},
    run: async (cmd, args) => { calls.push({ cmd, args }); return { ok: true, stdout: 'RELOAD_REQUESTED' }; },
  });
  assert.equal(result.mode, 'auto');
  assert.equal(calls[0].args[1 + 1], 'reload');
  assert.match(calls[0].args[2 - 1], /Herdr UI Review/, 'the script may only act inside the Herdr card');
  assert.doesNotMatch(calls[0].args[1], /n is "Update"|n is "更新"/, 'other extensions keep their buttons');

  const unverified = await installChromeExtension(home, { platform: 'darwin', registration: () => null,
    run: scripted('INSTALL_REQUESTED'), wait: async () => {} });
  assert.equal(unverified.mode, 'assisted', 'a click is not proof of installation');
});

test('macOS permission denials explain which setting to enable', async t => {
  const { home } = fixture(t);
  const assistive = await installChromeExtension(home, { platform: 'darwin', registration: () => null, wait: async () => {},
    run: scripted('', 'execution error: osascript is not allowed assistive access. (-1719)') });
  assert.equal(assistive.mode, 'permission');
  assert.match(assistive.message, /辅助功能/);
  assert.match(assistive.settingsUrl, /Privacy_Accessibility$/);

  const automation = await installChromeExtension(home, { platform: 'darwin', registration: () => null, wait: async () => {},
    run: scripted('', 'Not authorized to send Apple events to System Events. (-1743)') });
  assert.equal(automation.mode, 'permission');
  assert.match(automation.settingsUrl, /Privacy_Automation$/);
});

test('the installer is local CLI only', () => {
  const bridge = fs.readFileSync(new URL('../mods/ide-review/bridge.mjs', import.meta.url), 'utf8');
  assert.match(bridge, /installChromeExtension/, 'the CLI can install');
  assert.doesNotMatch(bridge, /route === ['"]\/api\/(install-extension|update-extension)/, 'no HTTP route may install');
});
