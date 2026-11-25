// Core guarantees of the local Review bridge: clients are paired, scoped, and can only stage.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const EXT = 'gmgfppipckmjcfgfhlcokjpjmmobbopn';
const bridge = new URL('../mods/ide-review/bridge.mjs', import.meta.url);

async function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-bridge-'));
  const probe = http.createServer();
  await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise(r => probe.close(r));
  const child = spawn(process.execPath, [bridge.pathname, '--serve', '--app-home', home], {
    env: { ...process.env, HERDR_ANNOTATE_PORT: String(port) }, stdio: 'ignore',
  });
  t.after(() => { child.kill(); fs.rmSync(home, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const request = (route, body, token, origin) => fetch(base + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(origin ? { Origin: origin } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(base + '/api/ping');
      const auth = JSON.parse(fs.readFileSync(path.join(home, 'data/annotations/security/credentials.json')));
      return { home, base, port, auth, request, admin: (route, body) => request(route, body, auth.admin) };
    } catch {}
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error('Bridge did not start');
}
const staged = (extra = {}) => ({ action: 'stage', url: 'http://localhost:3000/', items: [{ note: 'fix spacing' }], requestId: 'request_123456', ...extra });
async function pair(request, auth) {
  const { code } = await (await request('/admin/pair', {}, auth.admin)).json();
  const response = await request('/api/pair', { code, extensionId: EXT });
  return { code, status: response.status, token: (await response.json()).token };
}

test('unpaired clients cannot read workspace data or call the bridge', async t => {
  const { base, request, auth } = await fixture(t);
  assert.equal((await request('/api/status')).status, 401);
  assert.equal((await request('/api/ext-heartbeat', {})).status, 401);
  const health = await (await request('/api/ping')).json();
  assert.equal(health.appHome, undefined, 'health must not leak local paths');
  const hostStatus = await new Promise((resolve, reject) => {
    http.get(base + '/api/ping', { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(hostStatus, 403);
  assert.equal((await request('/api/ping', undefined, undefined, 'https://evil.example')).status, 403);
  assert.equal((await request('/api/status', undefined, auth.admin)).status, 200, 'local admin keeps working');
});

test('pairing is one use, private on disk, cancellable, and revocable', async t => {
  const { home, request, auth } = await fixture(t);
  const first = await pair(request, auth);
  assert.equal(first.status, 200);
  assert.match(first.token, /^[a-f0-9]{64}$/);
  assert.equal((await request('/api/pair', { code: first.code, extensionId: EXT })).status, 403, 'codes are single use');
  assert.equal(fs.statSync(path.join(home, 'data/annotations/security')).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(home, 'data/annotations/security/credentials.json')).mode & 0o777, 0o600);

  const pending = (await (await request('/admin/pair', {}, auth.admin)).json()).code;
  await request('/admin/cancel-pair', { code: pending }, auth.admin);
  assert.equal((await request('/api/pair', { code: pending, extensionId: EXT })).status, 403, 'cancelled codes die');

  await request('/admin/revoke', {}, auth.admin);
  assert.equal((await request('/api/status', undefined, first.token)).status, 401, 'revocation is immediate');
});

test('a browser client can stage annotations and nothing else', async t => {
  const { request, auth } = await fixture(t);
  const { token } = await pair(request, auth);
  for (const action of ['send', 'paste']) {
    assert.equal((await request('/api/annotations', staged({ action }), token)).status, 400);
  }
  assert.equal((await request('/api/annotations', staged({ id: '../../bad', screenshotAbsPath: '/tmp/bad' }), token)).status, 400);
  for (const route of ['/api/shutdown', '/api/install-extension', '/admin/pair', '/admin/queue']) {
    assert.notEqual((await request(route, {}, token)).status, 200, `${route} must be admin only`);
  }
  assert.equal((await request('/api/annotations', staged(), token)).status, 200);
  const queue = await (await request('/admin/queue', undefined, auth.admin)).json();
  assert.equal(queue.batches.length, 1);
  assert.equal(queue.batches[0].action, 'stage');
  assert.equal(queue.batches[0].untrusted, true);
  assert.equal(queue.batches[0].screenshotAbsPath, undefined, 'client paths are ignored');
});

test('queue edits need the current revision and staging retries are idempotent', async t => {
  const { request, auth } = await fixture(t);
  const { token } = await pair(request, auth);
  await Promise.all([request('/api/annotations', staged(), token), request('/api/annotations', staged(), token)]);
  const queue = await (await request('/admin/queue', undefined, auth.admin)).json();
  assert.equal(queue.batches.length, 1, 'a retried request stages once');
  const write = (body) => request('/admin/queue', body, auth.admin);
  assert.equal((await write({ revision: queue.revision - 1, batches: [] })).status, 409);
  assert.equal((await write({ revision: queue.revision, batches: [] })).status, 200);
});

test('annotation payloads are bounded and validated', async t => {
  const { request, auth } = await fixture(t);
  const { token } = await pair(request, auth);
  const post = body => request('/api/annotations', body, token);
  assert.equal((await post(staged({ screenshotDataUrl: 'data:image/png;base64,AAAA' }))).status, 400, 'not a PNG');
  assert.equal((await post(staged({ items: Array(101).fill({}) }))).status, 400, 'annotation count');
  assert.equal((await post(staged({ items: [{ note: 'a'.repeat(4097) }] }))).status, 400, 'note size');
  assert.equal((await post(staged({ url: 'file:///etc/passwd' }))).status, 400, 'page URL scheme');
});
