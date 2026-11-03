// 文字起こし本文、署名付き URL、用語リストはログに渡さないこと。
type Fields = Record<string, unknown>;

export const log = {
  info: (event: string, fields: Fields = {}) => console.info("[whisper]", event, fields),
  warn: (event: string, fields: Fields = {}) => console.warn("[whisper]", event, fields),
  error: (event: string, fields: Fields = {}) => console.error("[whisper]", event, fields),
};
