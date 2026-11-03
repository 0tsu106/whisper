import { notifyDiscord } from "./discord";
import type { Env } from "./env";
import { errorFields, log } from "./logger";
import { startModalJob } from "./modal";
import { audioKey, MODAL_URL_TTL_SEC, presignUrl, resultKey } from "./r2";
import type { JobOptions } from "./validation";

export const MAX_AUTO_RETRIES = 2;
const RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

export type JobStatus = "uploading" | "queued" | "processing" | "completed" | "failed";

export interface JobRow {
  id: string;
  filename: string;
  size_bytes: number;
  status: JobStatus;
  attempt: number;
  retries_left: number;
  options: string;
  speaker_names: string;
  error_code: string | null;
  duration_sec: number | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  expires_at: string | null;
}

export function toPublicJob(row: JobRow) {
  return {
    id: row.id,
    filename: row.filename,
    size_bytes: row.size_bytes,
    status: row.status,
    attempt: row.attempt,
    options: JSON.parse(row.options) as JobOptions,
    speaker_names: JSON.parse(row.speaker_names) as Record<string, string>,
    error_code: row.error_code,
    duration_sec: row.duration_sec,
    created_at: row.created_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
    expires_at: row.expires_at,
  };
}

const nowIso = () => new Date().toISOString();
const expiresAtIso = () => new Date(Date.now() + RETENTION_MS).toISOString();

export async function createJob(
  env: Env,
  input: { filename: string; size_bytes: number; options: JobOptions },
): Promise<JobRow> {
  const row = await env.DB.prepare(
    `INSERT INTO jobs (id, filename, size_bytes, status, retries_left, options, created_at)
     VALUES (?, ?, ?, 'uploading', ?, ?, ?) RETURNING *`,
  )
    .bind(crypto.randomUUID(), input.filename, input.size_bytes, MAX_AUTO_RETRIES, JSON.stringify(input.options), nowIso())
    .first<JobRow>();
  if (!row) throw new Error("Failed to insert job");
  log.info("job.created", {
    job_id: row.id,
    size_bytes: row.size_bytes,
    diarization: input.options.diarization,
    term_count: input.options.terms.length,
  });
  return row;
}

export function getJob(env: Env, jobId: string): Promise<JobRow | null> {
  return env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(jobId).first<JobRow>();
}

export async function listJobs(env: Env): Promise<JobRow[]> {
  const { results } = await env.DB.prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT 200").all<JobRow>();
  return results;
}

export async function updateSpeakerNames(env: Env, jobId: string, names: Record<string, string>): Promise<JobRow | null> {
  return env.DB.prepare("UPDATE jobs SET speaker_names = ? WHERE id = ? AND status = 'completed' RETURNING *")
    .bind(JSON.stringify(names), jobId)
    .first<JobRow>();
}

// uploading → queued。二重の完了通知では1回だけ成功する
export async function markUploaded(env: Env, jobId: string, sizeBytes: number): Promise<boolean> {
  const row = await env.DB.prepare(
    "UPDATE jobs SET status = 'queued', size_bytes = ? WHERE id = ? AND status = 'uploading' RETURNING id",
  )
    .bind(sizeBytes, jobId)
    .first();
  return row !== null;
}

export async function failUpload(env: Env, job: JobRow, errorCode: string): Promise<void> {
  const row = await env.DB.prepare(
    "UPDATE jobs SET status = 'failed', error_code = ?, expires_at = ? WHERE id = ? AND status = 'uploading' RETURNING id",
  )
    .bind(errorCode, expiresAtIso(), job.id)
    .first();
  if (!row) return;
  log.warn("job.upload_rejected", { job_id: job.id, error_code: errorCode });
  await notifyDiscord(env, { kind: "failed", jobId: job.id, filename: job.filename, errorCode });
}

// failed → queued。attempt は単調増加のままにし、古い実行のコールバックと衝突させない
export async function requeueFailedJob(env: Env, jobId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `UPDATE jobs SET status = 'queued', retries_left = ?, error_code = NULL, started_at = NULL, expires_at = NULL
     WHERE id = ? AND status = 'failed' RETURNING id`,
  )
    .bind(MAX_AUTO_RETRIES, jobId)
    .first();
  if (row) log.info("job.manual_retry", { job_id: jobId });
  return row !== null;
}

// queued → processing。同時に呼ばれても UPDATE を取れた1回だけが Modal を起動する
export async function dispatchJob(env: Env, jobId: string): Promise<void> {
  const job = await env.DB.prepare(
    `UPDATE jobs SET status = 'processing', attempt = attempt + 1, started_at = ?
     WHERE id = ? AND status = 'queued' RETURNING *`,
  )
    .bind(nowIso(), jobId)
    .first<JobRow>();
  if (!job) {
    log.info("job.dispatch_skipped", { job_id: jobId });
    return;
  }
  log.info("job.dispatching", { job_id: job.id, attempt: job.attempt, retries_left: job.retries_left });
  try {
    await startModalJob(env, {
      job_id: job.id,
      attempt: job.attempt,
      audio_url: await presignUrl(env, "GET", audioKey(job.id), MODAL_URL_TTL_SEC),
      result_url: await presignUrl(env, "PUT", resultKey(job.id), MODAL_URL_TTL_SEC),
      callback_url: `${env.APP_URL}/internal/callback`,
      options: JSON.parse(job.options),
    });
  } catch (err) {
    log.error("job.dispatch_failed", { job_id: job.id, attempt: job.attempt, ...errorFields(err) });
    await recordAttemptFailure(env, job.id, job.attempt, "modal_start_failed");
  }
}

// 1回の実行の失敗を記録する。再試行が残っていれば再実行し、なければ failed にして通知する
export async function recordAttemptFailure(env: Env, jobId: string, attempt: number, errorCode: string): Promise<void> {
  const requeued = await env.DB.prepare(
    `UPDATE jobs SET status = 'queued', retries_left = retries_left - 1, error_code = ?, started_at = NULL
     WHERE id = ? AND status = 'processing' AND attempt = ? AND retries_left > 0 RETURNING retries_left`,
  )
    .bind(errorCode, jobId, attempt)
    .first<{ retries_left: number }>();
  if (requeued) {
    log.warn("job.retry_scheduled", {
      job_id: jobId,
      attempt,
      error_code: errorCode,
      retries_left: requeued.retries_left,
    });
    await dispatchJob(env, jobId);
    return;
  }

  const failed = await env.DB.prepare(
    `UPDATE jobs SET status = 'failed', error_code = ?, expires_at = ?
     WHERE id = ? AND status = 'processing' AND attempt = ? RETURNING *`,
  )
    .bind(errorCode, expiresAtIso(), jobId, attempt)
    .first<JobRow>();
  if (!failed) {
    log.info("job.failure_ignored", { job_id: jobId, attempt, error_code: errorCode });
    return;
  }
  log.error("job.failed", { job_id: jobId, attempt, error_code: errorCode });
  await notifyDiscord(env, { kind: "failed", jobId, filename: failed.filename, errorCode });
}

export async function recordAttemptSuccess(
  env: Env,
  jobId: string,
  attempt: number,
  durationSec: number | null,
): Promise<void> {
  const resultHead = await env.BUCKET.head(resultKey(jobId));
  if (!resultHead) {
    log.error("job.result_missing", { job_id: jobId, attempt });
    await recordAttemptFailure(env, jobId, attempt, "result_missing");
    return;
  }
  const job = await env.DB.prepare(
    `UPDATE jobs SET status = 'completed', error_code = NULL, duration_sec = ?, completed_at = ?, expires_at = ?
     WHERE id = ? AND status = 'processing' AND attempt = ? RETURNING *`,
  )
    .bind(durationSec, nowIso(), expiresAtIso(), jobId, attempt)
    .first<JobRow>();
  if (!job) {
    log.info("job.success_ignored", { job_id: jobId, attempt });
    return;
  }
  log.info("job.completed", { job_id: jobId, attempt, duration_sec: durationSec, result_bytes: resultHead.size });
  try {
    await env.BUCKET.delete(audioKey(jobId));
    log.info("job.audio_deleted", { job_id: jobId });
  } catch (err) {
    // 消し損ねてもライフサイクルルールが1日で削除する
    log.error("job.audio_delete_failed", { job_id: jobId, ...errorFields(err) });
  }
  await notifyDiscord(env, { kind: "completed", jobId, filename: job.filename });
}
