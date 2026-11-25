// Herdr writes to an agent only after the person confirms an explicit target.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deliverConfirmed, validateTarget } from '../mods/ide-review/delivery.js';

const agent = { address: 't7', pane: 'p7', tab: 'tab7', space: 's7', seq: 7, status: 'idle' };
const key = JSON.stringify(['t7', 'p7', 'tab7', 's7', 7]);
const confirmation = { mode: 'send', text: 'review this', address: 't7', targetKey: key, revision: 3 };
const ack = { turn: 12 };

test('only a live, idle, local agent the person picked can be a target', () => {
  assert.equal(validateTarget('t7', [agent]), agent);
  for (const address of [null, 'default', 'vps/t7', 't8']) assert.throws(() => validateTarget(address, [agent]));
  assert.throws(() => validateTarget('t7', [{ ...agent, status: 'blocked' }]));
  assert.throws(() => validateTarget('t7', [{ ...agent, pane: null }]));
});

test('a stale preview or changed session is never sent', async () => {
  let sent = false;
  const send = async () => { sent = true; return { code: 0, stdout: JSON.stringify(ack) }; };
  await assert.rejects(deliverConfirmed({ confirmation, currentRevision: 4, agents: [agent], send }));
  await assert.rejects(deliverConfirmed({ confirmation, currentRevision: 3, agents: [{ ...agent, pane: 'moved' }], send }));
  assert.equal(sent, false);
});

test('annotations survive a failed or unacknowledged send', async () => {
  for (const result of [{ code: 1 }, { code: 0, stdout: '{}' }]) {
    await assert.rejects(deliverConfirmed({ confirmation, currentRevision: 3, agents: [agent], send: async () => result }));
  }
  const delivered = await deliverConfirmed({ confirmation, currentRevision: 3, agents: [agent],
    send: async (address, text) => { assert.equal(address, 't7'); assert.equal(text, 'review this'); return { code: 0, stdout: JSON.stringify(ack) }; } });
  assert.equal(delivered.consumed, true, 'only an acknowledged send consumes the queue');
});

test('copying is confirmable and never consumes', async () => {
  let copied;
  const result = await deliverConfirmed({ confirmation: { ...confirmation, mode: 'copy' }, currentRevision: 3,
    agents: [agent], copy: text => { copied = text; } });
  assert.equal(copied, 'review this');
  assert.equal(result.consumed, false);
});
