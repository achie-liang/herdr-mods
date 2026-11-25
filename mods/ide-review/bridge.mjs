#!/usr/bin/env node
// Local-only Review transport. Browsers can stage data, never drive terminals.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installChromeExtension } from './chrome-install.mjs';

const VERSION = '2.0.0';
const PORT = Number(process.env.HERDR_ANNOTATE_PORT || 17501);
const HOST = '127.0.0.1';
const EXT_ID = 'gmgfppipckmjcfgfhlcokjpjmmobbopn';
const MAX_BODY = 12 * 1024 * 1024;
const MAX_SHOT = 8 * 1024 * 1024;
const SHOT_QUOTA = 128 * 1024 * 1024;
const TTL = 7 * 86400000;
const secret = () => randomBytes(32).toString('hex');
const fail = (status, message) => Object.assign(new Error(message), { status });
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function plain(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function string(value, max, fallback = '') {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw fail(400, 'Invalid text field');
  return value;
}
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw fail(500, 'Invalid local state');
  }
}
function noLink(file) {
  let current = path.resolve(file);
  for (;;) {
    try { if (fs.lstatSync(current).isSymbolicLink()) throw fail(400, 'Symlinks are not allowed'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
function atomic(file, data) {
  noLink(file);
  const tmp = `${file}.tmp-${randomUUID()}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o600);
  } finally { try { fs.unlinkSync(tmp); } catch {} }
}
function dirs(home) {
  const base = path.join(home, 'data', 'annotations');
  const security = path.join(base, 'security');
  const shots = path.join(base, 'shots');
  for (const dir of [base, security, shots]) {
    noLink(dir); fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.chmodSync(dir, 0o700);
  }
  return { base, shots, security, auth: path.join(security, 'credentials.json'), queue: path.join(base, 'queue.json'), context: path.join(base, 'context.json') };
}
function credentials(p, create = false) {
  noLink(p.auth);
  let data = readJSON(p.auth, null);
  if (!data && create) { data = { admin: secret(), clients: [] }; atomic(p.auth, data); }
  if (!data?.admin || !Array.isArray(data.clients)) throw fail(500, 'Start the bridge first');
  fs.chmodSync(p.auth, 0o600);
  return data;
}
function queueRead(p) {
  noLink(p.queue);
  const q = readJSON(p.queue, { revision: 0, batches: [] });
  if (!Array.isArray(q.batches)) throw fail(500, 'Invalid queue');
  // Do not trust paths in old persisted queues. Keep only server-owned shot names.
  q.batches = q.batches.map(b => {
    const { screenshotAbsPath, screenshotRelPath, ...rest } = b;
    if (/^shot-[0-9a-f-]{36}\.png$/.test(b.shot || '')) {
      rest.shot = b.shot;
      rest.screenshotAbsPath = path.join(p.shots, b.shot);
      rest.screenshotRelPath = `data/annotations/shots/${b.shot}`;
    }
    return rest;
  });
  q.revision = Number.isSafeInteger(q.revision) ? q.revision : 0;
  return q;
}
function cleanup(p, q) {
  const now = Date.now();
  q.batches = q.batches.filter(b => now - (b.createdAt || 0) <= TTL).slice(0, 30);
  const used = new Set(q.batches.map(b => b.shot).filter(Boolean));
  let bytes = 0;
  for (const name of fs.readdirSync(p.shots)) {
    const file = path.join(p.shots, name);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw fail(400, 'Symlinks are not allowed');
    if (!/^shot-[0-9a-f-]{36}\.png$/.test(name)) continue;
    if (!used.has(name) || now - stat.mtimeMs > TTL) fs.unlinkSync(file);
    else bytes += stat.size;
  }
  return bytes;
}
function annotation(body) {
  if (!plain(body)) throw fail(400, 'Invalid annotation');
  const allowed = ['action', 'url', 'title', 'globalNote', 'items', 'viewport', 'targetTerminal', 'requestId', 'screenshotDataUrl', 'replaceSameUrl'];
  if (Object.keys(body).some(k => !allowed.includes(k))) throw fail(400, 'Unknown annotation field');
  if (!['stage', 'silent_stage'].includes(body.action)) throw fail(400, 'Only staging is allowed');
  if (!Array.isArray(body.items) || body.items.length > 100) throw fail(400, 'Invalid annotation count');
  const items = body.items.map((it, i) => {
    if (!plain(it)) throw fail(400, 'Invalid item');
    const source = it.source == null ? null : {
      framework: string(it.source.framework, 64), fileName: string(it.source.fileName, 2048),
      componentPath: string(it.source.componentPath, 2048),
      lineNumber: Number.isSafeInteger(it.source.lineNumber) && it.source.lineNumber > 0 ? it.source.lineNumber : null,
    };
    const styles = {};
    if (plain(it.styles)) for (const [key, val] of Object.entries(it.styles).slice(0, 30)) styles[string(key, 64)] = string(val, 512);
    const rect = plain(it.rect) && ['x','y','width','height'].every(k => Number.isFinite(it.rect[k]) && Math.abs(it.rect[k]) <= 100000)
      ? { x: it.rect.x, y: it.rect.y, width: it.rect.width, height: it.rect.height } : null;
    return { id: randomUUID(), index: i + 1, enabled: true, kind: ['element','area','selection'].includes(it.kind) ? it.kind : 'element',
      note: string(it.note, 4096), tagName: string(it.tagName, 64), selector: string(it.selector, 2048),
      text: string(it.text, 4096), selectedText: string(it.selectedText, 4096), htmlSnippet: string(it.htmlSnippet, 4096), source, styles, rect, groupedElements: [] };
  });
  if (Buffer.byteLength(JSON.stringify(items)) > 65536) throw fail(413, 'Annotation metadata too large');
  const url = string(body.url, 2048);
  try { if (!['http:', 'https:'].includes(new URL(url).protocol)) throw new Error(); } catch { throw fail(400, 'Invalid page URL'); }
  const requestId = string(body.requestId, 128);
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(requestId)) throw fail(400, 'Invalid request identifier');
  let screenshot = null;
  if (body.screenshotDataUrl != null) {
    if (typeof body.screenshotDataUrl !== 'string' || !/^data:image\/png;base64,[a-zA-Z0-9+/]*={0,2}$/.test(body.screenshotDataUrl)) throw fail(400, 'Invalid PNG');
    screenshot = Buffer.from(body.screenshotDataUrl.split(',')[1], 'base64');
    if (screenshot.length > MAX_SHOT) throw fail(413, 'Screenshot too large');
    if (screenshot.length < 24 || !screenshot.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || screenshot.toString('ascii', 12, 16) !== 'IHDR') throw fail(400, 'Invalid PNG');
    const w = screenshot.readUInt32BE(16), h = screenshot.readUInt32BE(20);
    if (!w || !h || w > 16000 || h > 16000 || w * h > 64000000) throw fail(400, 'Invalid image dimensions');
  }
  return { url, title: string(body.title, 1024), globalNote: string(body.globalNote, 16384), targetTerminal: string(body.targetTerminal, 128, 'default'), requestId, items, screenshot };
}
async function bodyRead(req) {
  if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw fail(415, 'JSON required');
  const chunks = []; let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY) throw fail(413, 'Request too large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail(400, 'Invalid JSON'); }
}

function server(home) {
  const p = dirs(home); let auth = credentials(p, true); let pairing = null;
  const initialQueue = queueRead(p); cleanup(p, initialQueue); atomic(p.queue, initialQueue);
  let chain = Promise.resolve(); const limits = new Map();
  const serial = fn => { const task = chain.then(fn); chain = task.catch(() => {}); return task; };
  const srv = http.createServer(async (req, res) => {
    const reply = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(data)); };
    try {
      const hostCount = req.rawHeaders.filter((v,i) => i % 2 === 0 && v.toLowerCase() === 'host').length;
      if (hostCount !== 1 || ![`127.0.0.1:${PORT}`, `localhost:${PORT}`].includes(req.headers.host)) throw fail(403, 'Host refused');
      const origin = req.headers.origin;
      const extOrigin = `chrome-extension://${EXT_ID}`;
      if (origin && origin !== extOrigin) throw fail(403, 'Origin refused');
      const route = new URL(req.url, `http://${HOST}:${PORT}`).pathname;
      if (req.method === 'OPTIONS') {
        if (!origin || origin !== extOrigin) throw fail(403, 'Origin refused');
        res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST'); res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        res.writeHead(204); res.end(); return;
      }
      if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
      if (route === '/api/ping' && req.method === 'GET') { reply(200, { ok: true, version: VERSION }); return; }
      if (route === '/api/pair' && req.method === 'POST') {
        if (Number(req.headers['content-length'] || 0) > 1024) throw fail(413, 'Pair request too large');
        const body = await bodyRead(req);
        if (!pairing || pairing.expires < Date.now() || pairing.attempts >= 5) throw fail(403, 'Generate a new pairing code in Herdr');
        pairing.attempts++;
        if (!plain(body) || body.extensionId !== EXT_ID || !equal(body.code, pairing.code)) throw fail(403, 'Invalid pairing code');
        const token = secret(); auth.clients = [{ token, extensionId: EXT_ID, pairedAt: Date.now() }]; pairing = null;
        atomic(p.auth, auth); reply(200, { ok: true, token }); return;
      }
      const token = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '')?.[1];
      const admin = equal(token, auth.admin);
      const client = auth.clients.find(c => equal(token, c.token));
      if (!admin && !client) throw fail(401, 'Authentication required');
      if (origin && (admin || client?.extensionId !== EXT_ID)) throw fail(403, 'Origin refused');
      const key = admin ? 'admin' : client.token;
      const now = Date.now(), limit = limits.get(key);
      if (!limit || now - limit.since > 60000) limits.set(key, { since: now, count: 1 });
      else if (++limit.count > 1200) throw fail(429, 'Rate limit exceeded');
      if (route.startsWith('/admin/') && !admin) throw fail(403, 'Local administration only');
      if (route === '/admin/identity' && req.method === 'GET') { reply(200, { ok: true, version: VERSION, home }); return; }
      if (route === '/admin/status' && req.method === 'GET') {
        reply(200, { ok: true, installed: auth.clients.length > 0, connected: auth.clients.some(c => now - (c.lastSeen || 0) < 60000), version: VERSION, pairedAt: auth.clients[0]?.pairedAt || null }); return;
      }
      if (route === '/admin/pair' && req.method === 'POST') {
        pairing = { code: randomBytes(8).toString('hex').toUpperCase(), expires: now + 300000, attempts: 0 };
        reply(200, { ok: true, code: pairing.code, expiresAt: pairing.expires }); return;
      }
      if (route === '/admin/cancel-pair' && req.method === 'POST') {
        const body = await bodyRead(req);
        if (plain(body) && pairing && equal(body.code, pairing.code)) pairing = null;
        reply(200, { ok: true }); return;
      }
      if (route === '/admin/revoke' && req.method === 'POST') {
        auth.clients = []; pairing = null; atomic(p.auth, auth); limits.clear(); reply(200, { ok: true }); return;
      }
      if (route === '/admin/rotate' && req.method === 'POST') {
        auth = { admin: secret(), clients: [] }; pairing = null; atomic(p.auth, auth); limits.clear(); reply(200, { ok: true }); return;
      }
      if (route === '/admin/shutdown' && req.method === 'POST') {
        reply(200, { ok: true }); setTimeout(() => srv.close(() => process.exit(0)), 50).unref(); return;
      }
      if (route === '/admin/context' && req.method === 'POST') {
        const body = await bodyRead(req); if (!plain(body) || Buffer.byteLength(JSON.stringify(body)) > 65536) throw fail(400, 'Invalid context');
        atomic(p.context, body); reply(200, { ok: true }); return;
      }
      if (route === '/api/ext-heartbeat' && req.method === 'POST') {
        if (client) client.lastSeen = now;
        reply(200, { ok: true }); return;
      }
      if (route === '/api/status' && req.method === 'GET') {
        const ctx = readJSON(p.context, {});
        const agents = (Array.isArray(ctx.agents) ? ctx.agents : []).filter(a => !String(a.address).includes('/')).map(a => ({
          address: a.address, space: a.space, spaceName: a.spaceName, sessionName: a.sessionName, programName: a.programName, displayLabel: a.displayLabel, focused: a.focused,
        }));
        reply(200, { ok: true, version: VERSION, cwd: ctx.cwd || '', activeSpace: ctx.activeSpace ? { id: ctx.activeSpace.id, name: ctx.activeSpace.name } : null, focused: { terminal: ctx.focused?.terminal || null }, agents }); return;
      }
      if ((route === '/api/annotations' || route === '/admin/queue') && req.method === 'GET') {
        if (route === '/admin/queue' || admin) { reply(200, { ok: true, ...queueRead(p) }); return; }
        throw fail(403, 'Local review only');
      }
      if (route === '/admin/queue' && req.method === 'POST') {
        const body = await bodyRead(req);
        await serial(() => {
          const old = queueRead(p);
          if (body.revision !== old.revision) throw fail(409, 'Queue changed; reload before editing');
          if (!Array.isArray(body.batches) || body.batches.length > old.batches.length) throw fail(400, 'Invalid queue edit');
          const next = body.batches.map(edit => {
            const original = old.batches.find(b => b.id === edit.id);
            if (!original) throw fail(409, 'Batch no longer exists');
            if (!Array.isArray(edit.items)) throw fail(400, 'Invalid queue edit');
            const items = edit.items.map(it => {
              const item = original.items.find(x => x.id === it.id);
              if (!item) throw fail(409, 'Item no longer exists');
              return { ...item, enabled: it.enabled !== false, note: string(it.note, 4096) };
            });
            return { ...original, globalNote: string(edit.globalNote, 16384), items };
          });
          const q = { revision: old.revision + 1, batches: next }; cleanup(p, q); atomic(p.queue, q);
          reply(200, { ok: true, ...q });
        }); return;
      }
      if (route === '/api/annotations' && req.method === 'POST') {
        if (!client) throw fail(403, 'Browser client required');
        const a = annotation(await bodyRead(req));
        await serial(() => {
          const q = queueRead(p);
          if (q.batches.some(b => b.requestId === a.requestId && b.clientId === client.extensionId)) { reply(200, { ok: true, staged: true }); return; }
          const bytes = cleanup(p, q);
          if (a.screenshot && bytes + a.screenshot.length > SHOT_QUOTA) throw fail(413, 'Screenshot quota exceeded');
          const same = q.batches.find(b => b.url === a.url && b.targetTerminal === a.targetTerminal && b.clientId === client.extensionId);
          const shot = a.screenshot ? `shot-${randomUUID()}.png` : same?.shot;
          if (a.screenshot) { const file = path.join(p.shots, shot); noLink(file); fs.writeFileSync(file, a.screenshot, { flag: 'wx', mode: 0o600 }); }
          const { screenshot, ...meta } = a;
          const batch = { ...meta, id: randomUUID(), createdAt: now, action: 'stage', untrusted: true, clientId: client.extensionId, ...(shot ? { shot, screenshotAbsPath: path.join(p.shots, shot), screenshotRelPath: `data/annotations/shots/${shot}` } : {}) };
          q.batches = q.batches.filter(b => b !== same);
          if (a.items.length || a.globalNote) q.batches.unshift(batch);
          q.revision++; cleanup(p, q); atomic(p.queue, q);
          reply(200, { ok: true, staged: true });
        }); return;
      }
      throw fail(404, 'Not found');
    } catch (e) { if (!res.headersSent && !res.destroyed) reply(e.status || 500, { ok: false, error: e.status ? e.message : 'Bridge operation failed' }); }
  });
  srv.requestTimeout = 10000; srv.headersTimeout = 5000;
  srv.on('error', () => { console.error('Bridge port unavailable'); process.exit(1); });
  srv.listen(PORT, HOST, () => {
    atomic(path.join(p.base, 'bridge.json'), { version: VERSION, pid: process.pid, port: PORT });
  });
}
async function localRequest(home, route, body) {
  const p = dirs(home); const auth = credentials(p);
  const res = await fetch(`http://${HOST}:${PORT}${route}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${auth.admin}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000),
  });
  const result = await res.json(); if (!res.ok) throw new Error(result.error || 'Bridge refused operation'); return result;
}
async function main() {
  const argv = process.argv.slice(2);
  const homeAt = argv.indexOf('--app-home');
  const requestedHome = path.resolve(homeAt >= 0 ? argv[homeAt + 1] : process.env.HERDR_APP_HOME || path.join(os.homedir(), '.config/herdr-app'));
  // macOS /var and /tmp are system symlinks. Resolve the authorized home once;
  // reject symlinks beneath that canonical storage root.
  const home = fs.realpathSync(requestedHome);
  const mode = argv.find(a => a.startsWith('--') && a !== '--app-home') || '--serve';
  if (mode === '--serve') { server(home); return; }
  if (mode === '--install-ext' || mode === '--update-ext') {
    console.log(JSON.stringify(await installChromeExtension(home))); return;
  }
  if (mode === '--daemon') {
    // Public health is not identity. Never reuse an unauthenticated/foreign listener.
    let occupied = false;
    try { await fetch(`http://${HOST}:${PORT}/api/ping`, { signal: AbortSignal.timeout(500) }); occupied = true; } catch {}
    if (occupied) {
      const identity = await localRequest(home, '/admin/identity');
      if (identity.home !== home || identity.version !== VERSION) throw new Error('Foreign or outdated bridge; stop it locally first');
      console.log(JSON.stringify({ ok: true })); return;
    }
    dirs(home);
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--serve', '--app-home', home], { detached: true, stdio: 'ignore', env: process.env });
    child.unref();
    for (let i = 0; i < 50; i++) {
      await new Promise(r => setTimeout(r, 50));
      try { const id = await localRequest(home, '/admin/identity'); if (id.home === home && id.version === VERSION) { console.log(JSON.stringify({ ok: true })); return; } } catch {}
    }
    throw new Error('Bridge failed to start');
  }
  const routes = { '--check-ext': '/admin/status', '--pair': '/admin/pair', '--cancel-pair': '/admin/cancel-pair', '--revoke': '/admin/revoke', '--rotate': '/admin/rotate', '--shutdown': '/admin/shutdown', '--queue': '/admin/queue', '--write-queue': '/admin/queue', '--context': '/admin/context' };
  if (!routes[mode]) throw new Error('Unsupported bridge command');
  let body;
  if (['--pair', '--revoke', '--rotate', '--shutdown'].includes(mode)) body = {};
  if (['--write-queue', '--context', '--cancel-pair'].includes(mode)) {
    const at = argv.indexOf('--json'); if (at < 0) throw new Error('--json is required'); body = JSON.parse(argv[at + 1]);
  }
  console.log(JSON.stringify(await localRequest(home, routes[mode], body)));
}
main().catch(() => { console.error('Bridge operation failed; ensure the secure bridge is running and its port is free'); process.exitCode = 1; });
