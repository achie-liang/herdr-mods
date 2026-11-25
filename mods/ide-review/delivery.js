// Pure delivery policy, separate from UI and transport.
export function validateTarget(address, agentList) {
  if (typeof address !== 'string' || !/^t[a-zA-Z0-9]+$/.test(address)) throw new Error('请选择本机 Agent；不支持向远端自动发送');
  const agent = agentList.find(a => a.address === address);
  if (!agent || !agent.pane || agent.status === 'blocked' || agent.status === 'working') throw new Error('目标 Agent 不存在、正在工作或等待操作；请重新选择');
  return agent;
}
export async function deliverConfirmed({ confirmation, currentRevision, agents, send, copy }) {
  if (!confirmation?.text || confirmation.revision !== currentRevision) throw new Error('标注已变化，请重新预览并确认');
  const agent = validateTarget(confirmation.address, agents);
  if (confirmation.targetKey !== JSON.stringify([agent.address, agent.pane, agent.tab, agent.space, agent.seq])) throw new Error('目标会话已变化，请重新确认');
  if (confirmation.mode === 'copy') { copy(confirmation.text); return { consumed: false }; }
  if (confirmation.mode !== 'send') throw new Error('Unknown delivery mode');
  const result = await send(agent.address, confirmation.text);
  let acknowledgement;
  try { acknowledgement = JSON.parse(result?.stdout || ''); } catch {}
  if (result?.code !== 0 || acknowledgement?.error || !Number.isSafeInteger(acknowledgement?.turn)) throw new Error('发送失败或状态不明确；标注已保留，不会自动重试');
  return { consumed: true };
}
