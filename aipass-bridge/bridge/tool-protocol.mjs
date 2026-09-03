const START = 'ACTION';
const INPUT = 'INPUT';
const END = 'END';

const compact = (text, maximum = 96) => String(text ?? '').replace(/\s+/g, ' ').slice(0, maximum);

function describeSchema(schema, depth = 0) {
  if (depth > 3) return 'a JSON value';
  if (!schema || typeof schema !== 'object') return 'any value';
  if (schema.enum) return `one of ${schema.enum.map((value) => JSON.stringify(value)).join(', ')}`;
  if (Array.isArray(schema.anyOf)) return schema.anyOf.map((part) => describeSchema(part, depth + 1)).join(' or ');
  if (Array.isArray(schema.oneOf)) return schema.oneOf.map((part) => describeSchema(part, depth + 1)).join(' or ');
  if (schema.type === 'array') return `a list of ${describeSchema(schema.items, depth + 1)}`;
  if (schema.type !== 'object') return schema.type ?? 'any value';
  const fields = Object.entries(schema.properties ?? {}).slice(0, 12).map(([name, value]) => `${name}: ${describeSchema(value, depth + 1)}${(schema.required ?? []).includes(name) ? '*' : ''}`);
  return fields.length ? `an object with ${fields.join('; ')}` : 'an object';
}

export function toolInstructions(tools) {
  return [
    'Cline can run the following local tools after its normal approval process.',
    'Use a tool only when it is necessary. After receiving sufficient results, answer the user directly.',
    'For a tool, reply with only one or more blocks; no prose or Markdown:',
    `${START} tool_name\n${INPUT}\n{"argument":"value"}\n${END}`,
    'The input must be a JSON object. Fields marked * are required. Multiple blocks are allowed.',
    'AVAILABLE TOOLS',
    ...tools.map((tool) => `- ${tool.name}: ${compact(tool.description) || 'no description'}. Input: ${describeSchema(tool.parameters)}.`),
  ].join('\n');
}

export function parseToolProtocol(text) {
  const source = String(text ?? '').trim();
  // Some otherwise compliant models add one short natural-language lead-in
  // before a complete action envelope. Accept only a trailing, complete
  // envelope; arbitrary prose after/between blocks remains invalid. The
  // original client schema still validates every requested action.
  const markerAt = source.startsWith(`${START} `) ? 0 : source.search(/\n\s*ACTION\s+/);
  if (markerAt < 0) return { kind: 'text', text: String(text ?? '') };
  const prelude = source.slice(0, markerAt).trim();
  const envelope = source.slice(markerAt).trim();
  if (prelude.length > 500) return { kind: 'invalid', message: 'tool-call prelude is too long' };
  const blocks = [...envelope.matchAll(/^ACTION\s+([^\s]+)\s+INPUT\s+([\s\S]*?)\s+END\s*(?:\n|$)/gm)];
  // This accepts one or more complete blocks in either multiline or inline
  // form, but rejects any unconsumed text between them.
  if (!blocks.length || blocks.map((block) => block[0]).join('').trim() !== envelope) return { kind: 'invalid', message: 'malformed ACTION block' };
  let calls;
  try { calls = blocks.map((block) => ({ name: block[1], arguments: JSON.parse(block[2]) })); }
  catch { return { kind: 'invalid', message: 'action input is not valid JSON' }; }
  if (!calls.every((call) => call.arguments && typeof call.arguments === 'object' && !Array.isArray(call.arguments))) return { kind: 'invalid', message: 'each action needs object input' };
  return { kind: 'calls', calls };
}

export function validateArguments(schema, value, path = 'arguments') {
  if (!schema || typeof schema !== 'object') return null;
  if (Object.hasOwn(schema, 'const') && JSON.stringify(schema.const) !== JSON.stringify(value)) return `${path} must equal its required constant`;
  if (Array.isArray(schema.allOf)) for (const part of schema.allOf) { const err = validateArguments(part, value, path); if (err) return err; }
  if (schema.not && !validateArguments(schema.not, value, path)) return `${path} matches a disallowed schema`;
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) return `${path} is not an allowed value`;
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((part) => !validateArguments(part, value, path))) return `${path} does not match any allowed schema`;
  if (Array.isArray(schema.oneOf) && schema.oneOf.filter((part) => !validateArguments(part, value, path)).length !== 1) return `${path} does not match exactly one schema`;
  const type = schema.type;
  if (type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return `${path} must be an object`;
    for (const key of schema.required ?? []) if (!(key in value)) return `${path}.${key} is required`;
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!(key in (schema.properties ?? {}))) return `${path}.${key} is not allowed`;
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (key in value) { const err = validateArguments(child, value[key], `${path}.${key}`); if (err) return err; }
    }
    if (schema.minProperties != null && Object.keys(value).length < schema.minProperties) return `${path} needs at least ${schema.minProperties} properties`;
    if (schema.maxProperties != null && Object.keys(value).length > schema.maxProperties) return `${path} has too many properties`;
  } else if (type === 'array') {
    if (!Array.isArray(value)) return `${path} must be an array`;
    if (schema.minItems != null && value.length < schema.minItems) return `${path} needs at least ${schema.minItems} items`;
    if (schema.maxItems != null && value.length > schema.maxItems) return `${path} has too many items`;
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) return `${path} items must be unique`;
    for (let i = 0; i < value.length; i++) { const err = validateArguments(schema.items, value[i], `${path}[${i}]`); if (err) return err; }
  } else if (type === 'string') {
    if (typeof value !== 'string') return `${path} must be a string`;
    if (schema.minLength != null && value.length < schema.minLength) return `${path} is shorter than ${schema.minLength}`;
    if (schema.maxLength != null && value.length > schema.maxLength) return `${path} is longer than ${schema.maxLength}`;
    if (schema.pattern && !(new RegExp(schema.pattern).test(value))) return `${path} does not match its required pattern`;
  } else if (type === 'number' || type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (type === 'integer' && !Number.isInteger(value))) return `${path} must be a ${type}`;
    if (schema.minimum != null && value < schema.minimum) return `${path} is below its minimum`;
    if (schema.maximum != null && value > schema.maximum) return `${path} is above its maximum`;
  }
  else if (type === 'boolean' && typeof value !== 'boolean') return `${path} must be a boolean`;
  return null;
}

export function validateCalls(calls, tools) {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  for (const call of calls) {
    const tool = byName.get(call.name);
    if (!tool) return { error: `model requested unavailable tool: ${call.name}` };
    const error = validateArguments(tool.parameters, call.arguments);
    if (error) return { error: `invalid arguments for ${call.name}: ${error}` };
  }
  return { calls };
}
