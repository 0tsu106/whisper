import { Hono } from "hono";
import type { Env } from "../env";
import { verifySignature } from "../hmac";
import { getJob, recordAttemptFailure, recordAttemptSuccess } from "../jobs";
import { log } from "../logger";
import { callbackSchema } from "../validation";

export const internal = new Hono<{ Bindings: Env }>();

internal.post("/callback", async (c) => {
  const body = await c.req.text();
  const verification = await verifySignature(
    c.env.CALLBACK_SECRET,
    c.req.header("X-Callback-Timestamp") ?? "",
    body,
    c.req.header("X-Callback-Signature") ?? "",
  );
  if (verification !== "ok") {
    log.warn("callback.rejected", { reason: verification });
    return c.json({ error: "unauthorized" }, 401);
  }

  let json: unknown = null;
  try {
    json = JSON.parse(body);
  } catch {
    // 下の検証で invalid_request になる
  }
  const parsed = callbackSchema.safeParse(json);
  if (!parsed.success) {
    log.warn("callback.invalid_payload", { paths: parsed.error.issues.map((issue) => issue.path.join(".")) });
    return c.json({ error: "invalid_request" }, 400);
  }
  const callback = parsed.data;
  const fields = { job_id: callback.job_id, attempt: callback.attempt, callback_status: callback.status };
  log.info("callback.received", { ...fields, error_code: callback.error_code ?? null });

  const job = await getJob(c.env, callback.job_id);
  if (!job || job.status !== "processing" || job.attempt !== callback.attempt) {
    log.info("callback.stale_ignored", {
      ...fields,
      current_status: job?.status ?? null,
      current_attempt: job?.attempt ?? null,
    });
    return c.json({ ok: true, ignored: true });
  }

  if (callback.status === "completed") {
    await recordAttemptSuccess(c.env, job.id, job.attempt, callback.duration_sec ?? null);
  } else {
    await recordAttemptFailure(c.env, job.id, job.attempt, callback.error_code ?? "unknown_error");
  }
  return c.json({ ok: true });
});
