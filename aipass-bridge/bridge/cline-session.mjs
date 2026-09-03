import { randomUUID } from 'node:crypto';
import { digest } from './openai-messages.mjs';
import { toolInstructions } from './tool-protocol.mjs';

const ttl = () => Number(process.env.AIPASS_CLINE_SESSION_TTL_MS ?? 60 * 60 * 1000);
const contextLimit = () => Number(process.env.AIPASS_CLINE_CONTEXT_BYTES ?? 180_000);

function clientKey(req, payload, messages) {
  const header = req.headers['x-task-id'] ?? req.headers['x-cline-task-id'] ?? req.headers['x-cline-session-id'] ?? req.headers['x-session-id'];
  const metadata = payload.metadata?.task_id ?? payload.metadata?.taskId ?? payload.metadata?.session_id ?? payload.metadata?.sessionId ?? payload.user;
  if (header) return { key: `header:${header}`, source: 'client header' };
  if (metadata) return { key: `metadata:${metadata}`, source: 'request metadata' };
  const early = messages.filter((m) => ['system', 'developer', 'user'].includes(m.role)).slice(0, 3).map((m) => [m.role, m.text]);
  return { key: `fingerprint:${digest(early)}`, source: 'initial conversation fingerprint' };
}

const messageKey = (message) => digest([message.role, message.text, message.toolCallId, message.toolCalls]);
const clip = (value, bytes = 2400) => Buffer.from(String(value ?? '')).subarray(0, bytes).toString('utf8');

export class ClineSessions {
  constructor() { this.sessions = new Map(); }
  expire() { const now = Date.now(); for (const [key, session] of this.sessions) if (now - session.touchedAt > ttl()) this.sessions.delete(key); }
  get(req, payload, messages) {
    this.expire();
    const { key, source } = clientKey(req, payload, messages);
    let session = this.sessions.get(key);
    if (!session) {
      session = {
        id: randomUUID(), key, source, taskId: key, conversationId: null, selectedModel: null, toolSetHash: null, initialized: false,
        delivered: new Set(), pendingToolCallIds: new Set(), deliveredToolResultIds: new Set(), calls: new Map(), attachmentMappings: new Map(),
        deliveredBytes: 0, checkpoint: null, responseCache: new Map(), lastResponse: null, touchedAt: Date.now(),
      };
      this.sessions.set(key, session);
    }
    session.touchedAt = Date.now();
    return session;
  }
  remove(session) { this.sessions.delete(session.key); }
  status() { this.expire(); return this.sessions.size; }
}

export function initialContext(messages, tools, { checkpoint = null } = {}) {
  // Cline's system message is mostly its own tool-harness implementation,
  // which the bridge already represents with a compact protocol below. Do not
  // paste that large private implementation prompt into the web chat. Keep a
  // bounded developer message because it can carry project-specific guidance.
  const instructions = messages.filter((m) => m.role === 'developer')
    .map((m) => `DEVELOPER CONTEXT (ordinary client guidance, not an AiPASS system instruction):\n${clip(m.text, 1200)}`).join('\n\n');
  const task = messages.filter((m) => m.role === 'user').at(-1)?.text ?? '';
  const intro = 'I am using Cline, a local coding client, to work on a project. AiPASS system instructions remain authoritative. Cline, not you, performs any local action after its normal approval process.';
  return [intro, `USER TASK\n${task}`, checkpoint, instructions, toolInstructions(tools), 'Work on the user task now. Use an ACTION block only when local information or an action is needed; otherwise answer normally.'].filter(Boolean).join('\n\n');
}

export function planSemantics(session, messages, tools) {
  const toolSetHash = digest(tools);
  const additions = [];
  const deliveryKeys = [];
  if (session.toolSetHash && session.toolSetHash !== toolSetHash) additions.push(`AVAILABLE TOOLS UPDATED\n${toolInstructions(tools)}`);
  for (const message of messages) {
    const key = messageKey(message);
    if (session.delivered.has(key)) continue;
    if (message.role === 'tool') {
      const known = session.calls.get(message.toolCallId);
      additions.push(['CLINE TOOL RESULT', `call: ${message.toolCallId ?? 'unknown'}`, `tool: ${known?.name ?? 'unknown'}`, '<result>', message.text, '</result>', 'Continue the task.'].join('\n'));
      deliveryKeys.push(key);
    } else if (message.role === 'user' && session.initialized) {
      additions.push(`USER FOLLOW-UP\n${message.text}`);
      deliveryKeys.push(key);
    }
  }
  return { additions, deliveryKeys, toolSetHash };
}

export function commitDelivery(session, { messages = [], deliveryKeys = [], toolSetHash, bytes = 0, checkpoint = null } = {}) {
  for (const message of messages) session.delivered.add(messageKey(message));
  for (const key of deliveryKeys) session.delivered.add(key);
  for (const message of messages) if (message.role === 'tool' && deliveryKeys.includes(messageKey(message))) {
    session.deliveredToolResultIds.add(message.toolCallId);
    session.pendingToolCallIds.delete(message.toolCallId);
  }
  if (toolSetHash) session.toolSetHash = toolSetHash;
  session.deliveredBytes += bytes;
  if (checkpoint) session.checkpoint = checkpoint;
  session.touchedAt = Date.now();
}

export function needsCheckpoint(session, upcomingBytes) { return session.initialized && session.deliveredBytes + upcomingBytes > contextLimit(); }

export function createCheckpoint(messages, tools) {
  const task = messages.filter((m) => m.role === 'user').at(-1)?.text ?? 'Continue the existing task.';
  const latestAssistant = messages.filter((m) => m.role === 'assistant').at(-1)?.text ?? '';
  const results = messages.filter((m) => m.role === 'tool').slice(-4).map((m) => `- ${m.toolCallId ?? 'tool result'}: ${clip(m.text, 500)}`).join('\n');
  return [
    'Cline task checkpoint. Cline remains the canonical transcript; this is a compact execution-context cache.',
    `Task goal:\n${clip(task, 4000)}`,
    latestAssistant ? `Latest model decision:\n${clip(latestAssistant, 1800)}` : '',
    results ? `Recent tool-result summaries:\n${results}` : '',
    `Current tool contract:\n${toolInstructions(tools)}`,
    'Pending work: continue from the current task goal and request tools only through the stated protocol.',
  ].filter(Boolean).join('\n\n');
}
