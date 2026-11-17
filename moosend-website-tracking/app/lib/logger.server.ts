/**
 * Minimal structured logger. Never pass email addresses, API keys or access
 * tokens in `meta` - logs are not covered by field-level encryption.
 */
type Level = "debug" | "info" | "warn" | "error";

function serialize(meta?: Record<string, unknown>) {
  if (!meta) return "";
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    safe[key] = value instanceof Error ? value.message : value;
  }
  return ` ${JSON.stringify(safe)}`;
}

function write(level: Level, message: string, meta?: Record<string, unknown>) {
  if (process.env.NODE_ENV === "test" && level !== "error") return;
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}${serialize(meta)}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) => write("debug", message, meta),
  info: (message: string, meta?: Record<string, unknown>) => write("info", message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => write("warn", message, meta),
  error: (message: string, meta?: Record<string, unknown>) => write("error", message, meta),
};
