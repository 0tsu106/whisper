import type { Env } from "./env";
import { dispatchJob, type JobRow, recordAttemptFailure } from "./jobs";
import { errorFields, log } from "./logger";
import { resultKey } from "./r2";

export const DAILY_CLEANUP_CRON = "0 18 * * *";

// Modal のタイムアウト(60分)+ 起動待ちとコールバック遅延の余裕(15分)
const PROCESSING_TIMEOUT_MS = 75 * 60 * 1000;
// R2 ライフサイクルが音声を消す時間に合わせる
const UPLOAD_ABANDON_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
const CLEANUP_BATCH_SIZE = 200;

export async function handleScheduled(cron: string, env: Env): Promise<void> {
  log.info("cron.started", { cron });
  if (cron === DAILY_CLEANUP_CRON) {
    await abandonStaleUploads(env);
    await deleteExpiredJobs(env);
  } else {
    await failTimedOutJobs(env);
    await dispatchStrandedJobs(env);
  }
  log.info("cron.finished", { cron });
}

// コールバックが届かないまま制限時間を超えたジョブを失敗として扱う
export async function failTimedOutJobs(env: Env): Promise<void> {
  const cutoff = new Date(Date.now() - PROCESSING_TIMEOUT_MS).toISOString();
  const { results } = await env.DB.prepare(
    "SELECT id, attempt FROM jobs WHERE status = 'processing' AND started_at < ?",
  )
    .bind(cutoff)
    .all<Pick<JobRow, "id" | "attempt">>();
  log.info("cron.timeout_check", { timed_out: results.length });
  for (const job of results) {
    try {
      log.warn("job.timed_out", { job_id: job.id, attempt: job.attempt });
      await recordAttemptFailure(env, job.id, job.attempt, "timeout");
    } catch (err) {
      log.error("cron.timeout_handling_failed", { job_id: job.id, ...errorFields(err) });
    }
  }
}

// queued のまま Worker が中断したジョブを拾い直す
export async function dispatchStrandedJobs(env: Env): Promise<void> {
  const { results } = await env.DB.prepare("SELECT id FROM jobs WHERE status = 'queued'").all<Pick<JobRow, "id">>();
  if (results.length > 0) log.warn("cron.stranded_jobs", { count: results.length });
  for (const job of results) {
    try {
      await dispatchJob(env, job.id);
    } catch (err) {
      log.error("cron.redispatch_failed", { job_id: job.id, ...errorFields(err) });
    }
  }
}

export async function abandonStaleUploads(env: Env): Promise<void> {
  const cutoff = new Date(Date.now() - UPLOAD_ABANDON_MS).toISOString();
  const { meta } = await env.DB.prepare(
    `UPDATE jobs SET status = 'failed', error_code = 'upload_abandoned', expires_at = ?
     WHERE status = 'uploading' AND created_at < ?`,
  )
    .bind(new Date(Date.now() + RETENTION_MS).toISOString(), cutoff)
    .run();
  log.info("cron.uploads_abandoned", { count: meta.changes });
}

export async function deleteExpiredJobs(env: Env): Promise<void> {
  const { results } = await env.DB.prepare("SELECT id FROM jobs WHERE expires_at < ? LIMIT ?")
    .bind(new Date().toISOString(), CLEANUP_BATCH_SIZE)
    .all<Pick<JobRow, "id">>();
  log.info("cron.expired_jobs", { count: results.length });
  for (const job of results) {
    try {
      await env.BUCKET.delete(resultKey(job.id));
      await env.DB.prepare("DELETE FROM jobs WHERE id = ?").bind(job.id).run();
      log.info("job.expired_deleted", { job_id: job.id });
    } catch (err) {
      log.error("cron.expired_delete_failed", { job_id: job.id, ...errorFields(err) });
    }
  }
}
