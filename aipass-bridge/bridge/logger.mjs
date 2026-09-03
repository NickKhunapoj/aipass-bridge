const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });

const colours = Object.freeze({
  debug: '\x1b[90m',
  info: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  scope: '\x1b[36m',
  dim: '\x1b[90m',
  reset: '\x1b[0m',
});

function localTimestamp(date) {
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function detail(value) {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); }
  catch { return String(value); }
}

function configuredLevel(value) {
  const level = String(value ?? 'info').toLowerCase();
  return Object.hasOwn(LEVELS, level) ? level : 'info';
}

/**
 * Creates the bridge's compact operational logger. `write` and `now` are
 * injectable so the format can be verified without relying on a terminal.
 */
export function createLogger({
  level = process.env.AIPASS_LOG_LEVEL,
  colour = process.env.AIPASS_LOG_COLOR,
  isTTY = process.stdout.isTTY,
  write = (line) => console.log(line),
  now = () => new Date(),
} = {}) {
  const minimum = LEVELS[configuredLevel(level)];
  const useColour = colour === 'always' || (colour !== 'never' && !process.env.NO_COLOR && Boolean(isTTY));

  const log = (levelName, scope, ...values) => {
    if (LEVELS[levelName] < minimum) return;
    const label = levelName.toUpperCase().padStart(5);
    const component = String(scope ?? 'bridge').padEnd(18);
    const message = values.map(detail).join(' ');
    const timestamp = localTimestamp(now());
    const plain = `${timestamp} ${label} ${component} ${message}`.trimEnd();
    if (!useColour) return write(plain);
    const painted = `${colours.dim}${timestamp}${colours.reset} ${colours[levelName]}${label}${colours.reset} ${colours.scope}${component}${colours.reset} ${message}`.trimEnd();
    write(painted);
  };

  return Object.freeze({
    debug: (scope, ...values) => log('debug', scope, ...values),
    info: (scope, ...values) => log('info', scope, ...values),
    warn: (scope, ...values) => log('warn', scope, ...values),
    error: (scope, ...values) => log('error', scope, ...values),
  });
}
