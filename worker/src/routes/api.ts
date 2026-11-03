import { Hono } from "hono";
import type { z } from "zod";
import type { Env } from "../env";
import {
  createJob,
  dispatchJob,
  failUpload,
  getJob,
  listJobs,
  markUploaded,
  requeueFailedJob,
  toPublicJob,
  updateSpeakerNames,
} from "../jobs";
import { log } from "../logger";
import { audioKey, presignUrl, resultKey, UPLOAD_URL_TTL_SEC } from "../r2";
import { createJobSchema, MAX_UPLOAD_BYTES, speakerNamesSchema } from "../validation";

export const api = new Hono<{ Bindings: Env }>();

async function parseBody<T extends z.ZodType>(request: Request, schema: T): Promise<z.infer<T> | null> {
  const body: unknown = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    // 入力値(用語リストなど)を含めないよう、項目のパスだけを記録する
    log.warn("api.validation_failed", { paths: parsed.error.issues.map((issue) => issue.path.join(".")) });
    return null;
  }
  return parsed.data;
}

api.post("/jobs", async (c) => {
  const input = await parseBody(c.req.raw, createJobSchema);
  if (!input) return c.json({ error: "invalid_request" }, 400);
  const job = await createJob(c.env, input);
  const uploadUrl = await presignUrl(c.env, "PUT", audioKey(job.id), UPLOAD_URL_TTL_SEC);
  return c.json({ job: toPublicJob(job), upload_url: uploadUrl }, 201);
});

api.get("/jobs", async (c) => {
  const jobs = await listJobs(c.env);
  log.info("api.jobs_listed", { count: jobs.length });
  return c.json({ jobs: jobs.map(toPublicJob) });
});

api.get("/jobs/:id", async (c) => {
  const job = await getJob(c.env, c.req.param("id"));
  if (!job) return c.json({ error: "not_found" }, 404);
  return c.json({ job: toPublicJob(job) });
});

api.post("/jobs/:id/complete", async (c) => {
  const job = await getJob(c.env, c.req.param("id"));
  if (!job) return c.json({ error: "not_found" }, 404);
  if (job.status !== "uploading") {
    log.info("job.complete_ignored", { job_id: job.id, status: job.status });
    return c.json({ job: toPublicJob(job) });
  }

  const head = await c.env.BUCKET.head(audioKey(job.id));
  if (!head) {
    log.warn("job.upload_not_found", { job_id: job.id });
    return c.json({ error: "upload_not_found" }, 409);
  }
  log.info("job.upload_verified", { job_id: job.id, size_bytes: head.size });

  if (head.size > MAX_UPLOAD_BYTES) {
    await c.env.BUCKET.delete(audioKey(job.id));
    await failUpload(c.env, job, "file_too_large");
  } else if (await markUploaded(c.env, job.id, head.size)) {
    await dispatchJob(c.env, job.id);
  }

  const updated = await getJob(c.env, job.id);
  return c.json({ job: toPublicJob(updated ?? job) });
});

api.get("/jobs/:id/result", async (c) => {
  const job = await getJob(c.env, c.req.param("id"));
  if (!job) return c.json({ error: "not_found" }, 404);
  if (job.status !== "completed") return c.json({ error: "not_completed" }, 409);
  const object = await c.env.BUCKET.get(resultKey(job.id));
  if (!object) {
    log.error("job.result_object_missing", { job_id: job.id });
    return c.json({ error: "result_not_found" }, 404);
  }
  log.info("api.result_served", { job_id: job.id, result_bytes: object.size });
  return new Response(object.body, {
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store" },
  });
});

api.patch("/jobs/:id/speakers", async (c) => {
  const input = await parseBody(c.req.raw, speakerNamesSchema);
  if (!input) return c.json({ error: "invalid_request" }, 400);
  const names = Object.fromEntries(Object.entries(input.speaker_names).filter(([, name]) => name !== ""));
  const job = await updateSpeakerNames(c.env, c.req.param("id"), names);
  if (!job) return c.json({ error: "not_completed" }, 409);
  log.info("job.speakers_renamed", { job_id: job.id, renamed_count: Object.keys(names).length });
  return c.json({ job: toPublicJob(job) });
});

api.post("/jobs/:id/retry", async (c) => {
  const job = await getJob(c.env, c.req.param("id"));
  if (!job) return c.json({ error: "not_found" }, 404);
  if (job.status !== "failed") return c.json({ error: "not_failed" }, 409);
  if (!(await c.env.BUCKET.head(audioKey(job.id)))) {
    log.warn("job.retry_audio_expired", { job_id: job.id });
    return c.json({ error: "audio_expired" }, 410);
  }
  if (await requeueFailedJob(c.env, job.id)) {
    await dispatchJob(c.env, job.id);
  }
  const updated = await getJob(c.env, job.id);
  return c.json({ job: toPublicJob(updated ?? job) });
});
