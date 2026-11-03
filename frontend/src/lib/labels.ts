import { ApiError } from "../api";
import type { JobStatus } from "../types";

export const STATUS_LABELS: Record<JobStatus, string> = {
  uploading: "アップロード中",
  queued: "待機中",
  processing: "処理中",
  completed: "完了",
  failed: "失敗",
};

const ERROR_LABELS: Record<string, string> = {
  audio_decode_failed: "音声ファイルを読み取れませんでした",
  diarization_failed: "話者分離に失敗しました",
  download_failed: "音声ファイルを取得できませんでした",
  file_too_large: "ファイルサイズが上限を超えています",
  internal_error: "処理中に予期しないエラーが発生しました",
  modal_start_failed: "処理を開始できませんでした(Modal のクレジット切れの可能性があります)",
  out_of_memory: "GPU のメモリが不足しました",
  result_missing: "処理結果が保存されませんでした",
  result_upload_failed: "処理結果を保存できませんでした",
  timeout: "制限時間内に処理が完了しませんでした",
  transcription_failed: "文字起こしに失敗しました",
  upload_abandoned: "アップロードが完了しませんでした",
};

export const errorLabel = (code: string | null) => (code ? (ERROR_LABELS[code] ?? `エラー: ${code}`) : "不明なエラー");

export function requestErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return "認証の有効期限が切れています。ページを再読み込みしてください。";
    if (err.code === "audio_expired") return "音声の保存期間(24時間)が過ぎたため再実行できません。もう一度アップロードしてください。";
    return `リクエストに失敗しました(${err.code})`;
  }
  return "通信に失敗しました。接続を確認するか、ページを再読み込みしてください。";
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("ja-JP", { dateStyle: "short", timeStyle: "short" });
}

export function formatBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
