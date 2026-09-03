// Normalisation deliberately supports the text-only subset accepted by the
// upstream web chat.  Refusing media is safer than quietly losing it.
import { createHash } from 'node:crypto';
import { contentParts } from './attachments.mjs';

export const digest = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

export function textContent(content, label = 'message content') {
  return contentParts(content, label).text;
}

export function normaliseMessages(messages) {
  if (!Array.isArray(messages)) throw new Error('messages must be an array');
  return messages.map((message, index) => {
    if (!message || typeof message !== 'object' || typeof message.role !== 'string') {
      throw new Error(`messages[${index}] is not a valid chat message`);
    }
    const role = message.role;
    if (!['system', 'developer', 'user', 'assistant', 'tool'].includes(role)) {
      throw new Error(`unsupported message role: ${role}`);
    }
    const parts = contentParts(message.content, `messages[${index}].content`);
    const toolCalls = message.tool_calls == null ? [] : message.tool_calls;
    if (!Array.isArray(toolCalls)) throw new Error(`messages[${index}].tool_calls must be an array`);
    return { role, text: parts.text, attachments: parts.attachments, toolCalls, toolCallId: message.tool_call_id ?? null };
  });
}

export function toolsFromRequest(tools) {
  if (tools == null) return [];
  if (!Array.isArray(tools)) throw new Error('tools must be an array');
  const seen = new Set();
  return tools.map((tool, index) => {
    const fn = tool?.type === 'function' ? tool.function : null;
    if (!fn || typeof fn.name !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(fn.name)) {
      throw new Error(`tools[${index}] must be an OpenAI function with a valid name`);
    }
    if (seen.has(fn.name)) throw new Error(`duplicate tool name: ${fn.name}`);
    seen.add(fn.name);
    if (fn.parameters != null && (typeof fn.parameters !== 'object' || Array.isArray(fn.parameters))) {
      throw new Error(`tools[${index}].function.parameters must be a JSON Schema object`);
    }
    return { name: fn.name, description: String(fn.description ?? ''), parameters: fn.parameters ?? { type: 'object' } };
  });
}

export function firstTaskFingerprint(messages) {
  const stable = messages.filter((m) => ['system', 'developer', 'user'].includes(m.role)).slice(0, 3)
    .map((m) => [m.role, m.text]);
  return digest({ stable });
}
