// The extension worker is the only place that holds the browser credential.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { webcrypto } from 'node:crypto';

const EXT = 'gmgfppipckmjcfgfhlcokjpjmmobbopn';
const SITE = { id: EXT, frameId: 0, url: 'http://localhost:3000/', tab: { id: 1 } };

function worker() {
  let listener, requests = [], data = { reviewToken: 'a'.repeat(64) }, visible = 1;
  const chrome = {
    runtime: { id: EXT, getURL: file => `chrome-extension://${EXT}/${file}`,
      onMessage: { addListener: f => { listener = f; } }, openOptionsPage: async () => {} },
    storage: { local: { setAccessLevel: async () => {}, get: async () => data,
      set: async values => Object.assign(data, values), remove: async key => { delete data[key]; } } },
    scripting: { executeScript: async () => {} },
    action: { onClicked: { addListener: f => { chrome.activate = f; } } },
    commands: { onCommand: { addListener: () => {} } },
    tabs: {
      onRemoved: { addListener: () => {} }, onUpdated: { addListener: () => {} },
      get: async id => ({ id, url: SITE.url, windowId: 1 }),
      query: async () => [{ id: visible, url: SITE.url }],
      sendMessage: async (_id, msg) => { chrome.nonce = msg.activationNonce; },
      captureVisibleTab: async () => { visible = 2; return 'data:image/png;base64,AAAA'; },
    },
  };
  const fetch = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => ({ ok: true, token: 'b'.repeat(64) }) };
  };
  vm.runInContext(
    fs.readFileSync(new URL('../mods/ide-review/chrome-extension/background.js', import.meta.url), 'utf8'),
    vm.createContext({ chrome, crypto: webcrypto, AbortSignal, console, fetch }),
  );
  const send = (msg, sender) => new Promise(resolve => { if (!listener(msg, sender, resolve)) resolve(null); });
  return { chrome, requests, data, send };
}

test('a page cannot use the credential until the user activates it', async t => {
  const w = worker();
  assert.equal((await w.send({ type: 'HERDR_BRIDGE_STATUS' }, SITE)).ok, false);
  assert.equal(w.requests.length, 0, 'no request may leave without activation');

  await w.chrome.activate({ id: 1, url: SITE.url });
  w.requests.length = 0;
  const status = await w.send({ type: 'HERDR_BRIDGE_STATUS', activationNonce: w.chrome.nonce }, SITE);
  assert.equal(status.ok, true);
  assert.equal(w.requests[0].options.headers.Authorization, `Bearer ${'a'.repeat(64)}`);
  assert.equal(status.token, undefined, 'the credential never reaches the page');
});

test('page content cannot pair or ask the worker to execute', async t => {
  const w = worker();
  await w.chrome.activate({ id: 1, url: SITE.url });
  w.requests.length = 0;
  const pair = await w.send({ type: 'HERDR_PAIR', code: 'A'.repeat(16), activationNonce: w.chrome.nonce }, SITE);
  const run = await w.send({ type: 'HERDR_CAPTURE_AND_SEND', activationNonce: w.chrome.nonce,
    payload: { action: 'send', url: SITE.url, items: [] } }, SITE);
  assert.equal(pair.ok, false);
  assert.equal(run.ok, false);
  assert.equal(w.requests.length, 0);
});

test('a tab switch during capture aborts the stage', async t => {
  const w = worker();
  await w.chrome.activate({ id: 1, url: SITE.url });
  w.requests.length = 0;
  const result = await w.send({ type: 'HERDR_CAPTURE_AND_SEND', activationNonce: w.chrome.nonce,
    captureScreenshot: true, payload: { action: 'stage', url: SITE.url, items: [] } }, SITE);
  assert.equal(result.ok, false, 'capturing another tab must not stage');
  assert.equal(w.requests.length, 0);
});

test('only the packaged options page can exchange a pairing code', async t => {
  const w = worker();
  const options = { id: EXT, url: `chrome-extension://${EXT}/pairing.html`, origin: `chrome-extension://${EXT}`, frameId: 0, tab: { id: 42 } };
  const paired = await w.send({ type: 'HERDR_PAIR', code: 'A'.repeat(16) }, options);
  assert.equal(paired.ok, true);
  assert.equal(paired.token, undefined);
  assert.equal(w.data.reviewToken, 'b'.repeat(64));

  const impostor = { id: EXT, url: 'https://evil.example/pairing.html', origin: 'https://evil.example', frameId: 0, tab: { id: 43 } };
  assert.equal((await w.send({ type: 'HERDR_PAIR', code: 'A'.repeat(16) }, impostor)).ok, false);
});
