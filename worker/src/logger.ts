// 文字起こし本文、署名付き URL、用語リスト、トークン類はログに渡さないこと。
type Fields = Record<string, unknown>;
type Level = "info" | "warn" | "error";

function emit(level: Level, event: string, fields: Fields): void {
  console[level](JSON.stringify({ level, event, ...fields }));
}

export const log = {
  info: (event: string, fields: Fields = {}) => emit("info", event, fields),
  warn: (event: string, fields: Fields = {}) => emit("warn", event, fields),
  error: (event: string, fields: Fields = {}) => emit("error", event, fields),
};

export function errorFields(err: unknown): Fields {
  if (err instanceof Error) {
    return { error_name: err.name, error_message: err.message };
  }
  return { error_name: "UnknownError" };
}
