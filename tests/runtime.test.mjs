// A page outlives the extension that injected it: stale copies must stop, quietly.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function load() {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(new URL('../mods/ide-review/chrome-extension/runtime-connection.js', import.meta.url), 'utf8'), context);
  return context.__herdrRuntimeConnection.create;
}

test('an invalidated extension disposes the page once and stops sending', () => {
  const create = load();
  let disposed = 0, sends = 0, replies = 0;
  const client = create(() => ({ id: 'extension', sendMessage() { sends++; throw new Error('Extension context invalidated.'); } }), () => disposed++);
  assert.doesNotThrow(() => client.send({}, () => replies++));
  client.send({}, () => replies++);
  assert.equal(disposed, 1);
  assert.equal(sends, 1);
  assert.equal(replies, 0);
});

test('late callbacks cannot touch a replaced UI, while real errors still show', () => {
  const create = load();
  let callback, replies = [], disposed = 0;
  const runtime = { id: 'extension', sendMessage(_m, cb) { callback = cb; }, lastError: undefined };
  const client = create(() => runtime, () => disposed++);
  client.send({}, value => replies.push(value));
  client.dispose();
  callback({ ok: true });
  assert.deepEqual(replies, [], 'a disposed copy updates nothing');

  let errorReply;
  const failing = create(() => ({ id: 'extension', sendMessage(_m, cb) { cb(); }, lastError: { message: 'Could not establish connection.' } }), () => {});
  failing.send({}, value => { errorReply = value; });
  assert.equal(errorReply.ok, false);
  assert.match(errorReply.error, /Could not establish connection/);
});

test('the page script sends only through that transport', () => {
  const dir = new URL('../mods/ide-review/chrome-extension/', import.meta.url);
  const content = fs.readFileSync(new URL('content.js', dir), 'utf8');
  const worker = fs.readFileSync(new URL('background.js', dir), 'utf8');
  assert.doesNotMatch(content, /chrome\.runtime\.sendMessage\(/);
  assert.match(content, /function disposeAnnotator\(/);
  assert.match(worker, /files: \['runtime-connection\.js', 'content\.js'\]/, 'the transport must load first');
});
