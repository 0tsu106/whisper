import { env as rawEnv } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAILY_CLEANUP_CRON, handleScheduled } from "../src/cron";
import type { Env } from "../src/env";
import { signPayload, verifySignature } from "../src/hmac";
import { app } from "../src/index";
import type { JobRow } from "../src/jobs";
import { MAX_UPLOAD_BYTES } from "../src/validation";

const env = rawEnv as unknown as Env;

interface ModalCall {
  job_id: string;
  attempt: number;
  audio_url: string;
  result_url: string;
  callback_url: string;
  options: { terms: string[] };
}

let modalCalls: ModalCall[];
let modalHeaders: Headers[];
let discordMessages: { content: string; allowed_mentions: unknown }[];
let modalStatus: number;
let logs: string[];

beforeEach(async () => {
  modalCalls = [];
  modalHeaders = [];
  discordMessages = [];
  modalStatus = 200;
  logs = [];
  await env.DB.prepare("DELETE FROM jobs").run();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === env.MODAL_ENDPOINT_URL) {
      modalCalls.push(JSON.parse(String(init?.body)));
      modalHeaders.push(new Headers(init?.headers));
      return new Response("{}", { status: modalStatus });
    }
    if (url === env.DISCORD_WEBHOOK_URL) {
      discordMessages.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  for (const level of ["info", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((line: string) => {
      logs.push(line);
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

const request = (path: string, init?: RequestInit) => app.request(path, init, env);

const jsonRequest = (path: string, method: string, body: unknown) =>
  request(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function createJob(options: Record<string, unknown> = {}) {
  const response = await jsonRequest("/api/jobs", "POST", { filename: "講義.mp3", size_bytes: 1000, options });
  expect(response.status).toBe(201);
  return (await response.json()) as { job: { id: string; status: string }; upload_url: string };
}

async function startProcessing(): Promise<string> {
  const { job } = await createJob();
  await env.BUCKET.put(`audio/${job.id}`, "audio-bytes");
  const response = await request(`/api/jobs/${job.id}/complete`, { method: "POST" });
  expect(response.status).toBe(200);
  return job.id;
}

async function sendCallback(body: Record<string, unknown>, secret = env.CALLBACK_SECRET, timestamp?: string) {
  const raw = JSON.stringify(body);
  const ts = timestamp ?? String(Math.floor(Date.now() / 1000));
  return request("/internal/callback", {
    method: "POST",
    headers: { "X-Callback-Timestamp": ts, "X-Callback-Signature": await signPayload(secret, ts, raw) },
    body: raw,
  });
}

const getRow = async (id: string) => (await env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first<JobRow>())!;

describe("POST /api/jobs", () => {
  it("creates an uploading job with a presigned PUT URL", async () => {
    const { job, upload_url: uploadUrl } = await createJob();
    const url = new URL(uploadUrl);
    expect(job.status).toBe("uploading");
    expect(url.hostname).toBe("account.r2.cloudflarestorage.com");
    expect(url.pathname).toBe(`/bucket/audio/${job.id}`);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("3600");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ["oversized file", { filename: "a.mp3", size_bytes: MAX_UPLOAD_BYTES + 1 }],
    ["unsupported extension", { filename: "a.exe", size_bytes: 1 }],
    ["inverted speaker range", { filename: "a.mp3", size_bytes: 1, options: { min_speakers: 5, max_speakers: 2 } }],
  ])("rejects %s", async (_name, body) => {
    const response = await jsonRequest("/api/jobs", "POST", body);
    expect(response.status).toBe(400);
  });
});

describe("POST /api/jobs/:id/complete", () => {
  it("rejects when the upload is missing", async () => {
    const { job } = await createJob();
    const response = await request(`/api/jobs/${job.id}/complete`, { method: "POST" });
    expect(response.status).toBe(409);
    expect((await getRow(job.id)).status).toBe("uploading");
  });

  it("starts Modal with per-job URLs and proxy auth", async () => {
    const id = await startProcessing();
    const row = await getRow(id);
    expect(row.status).toBe("processing");
    expect(row.attempt).toBe(1);
    expect(row.size_bytes).toBe("audio-bytes".length);
    expect(modalCalls).toHaveLength(1);
    const call = modalCalls[0]!;
    expect(new URL(call.audio_url).pathname).toBe(`/bucket/audio/${id}`);
    expect(new URL(call.audio_url).searchParams.get("X-Amz-Expires")).toBe("5400");
    expect(new URL(call.result_url).pathname).toBe(`/bucket/results/${id}.json`);
    expect(call.callback_url).toBe("https://app.example.com/internal/callback");
    expect(modalHeaders[0]!.get("Modal-Key")).toBe("modal-key");
    expect(modalHeaders[0]!.get("Modal-Secret")).toBe("modal-secret");
  });

  it("does not start Modal twice on a duplicate completion", async () => {
    const id = await startProcessing();
    await request(`/api/jobs/${id}/complete`, { method: "POST" });
    expect(modalCalls).toHaveLength(1);
  });

  it("deletes oversized uploads and fails the job", async () => {
    const { job } = await createJob();
    await env.BUCKET.put(`audio/${job.id}`, "x");
    const oversizedBucket = {
      head: async () => ({ size: MAX_UPLOAD_BYTES + 1 }),
      delete: (key: string) => env.BUCKET.delete(key),
    };
    await app.request(`/api/jobs/${job.id}/complete`, { method: "POST" }, { ...env, BUCKET: oversizedBucket });
    const row = await getRow(job.id);
    expect(row.status).toBe("failed");
    expect(row.error_code).toBe("file_too_large");
    expect(await env.BUCKET.get(`audio/${job.id}`)).toBeNull();
    expect(modalCalls).toHaveLength(0);
    expect(discordMessages).toHaveLength(1);
  });
});

describe("POST /internal/callback", () => {
  it("rejects an invalid signature", async () => {
    const id = await startProcessing();
    const response = await sendCallback({ job_id: id, attempt: 1, status: "completed" }, "wrong-secret");
    expect(response.status).toBe(401);
    expect((await getRow(id)).status).toBe("processing");
  });

  it("rejects a stale timestamp", async () => {
    const id = await startProcessing();
    const old = String(Math.floor(Date.now() / 1000) - 3600);
    const response = await sendCallback({ job_id: id, attempt: 1, status: "completed" }, env.CALLBACK_SECRET, old);
    expect(response.status).toBe(401);
  });

  it("completes the job, deletes the audio and notifies with the filename", async () => {
    const id = await startProcessing();
    await env.BUCKET.put(`results/${id}.json`, "{}");
    const response = await sendCallback({ job_id: id, attempt: 1, status: "completed", duration_sec: 5400 });
    expect(response.status).toBe(200);

    const row = await getRow(id);
    expect(row.status).toBe("completed");
    expect(row.duration_sec).toBe(5400);
    expect(new Date(row.expires_at!).getTime()).toBeGreaterThan(Date.now() + 360 * 24 * 3600 * 1000);
    expect(await env.BUCKET.get(`audio/${id}`)).toBeNull();
    expect(discordMessages).toHaveLength(1);
    expect(discordMessages[0]!.content).toContain("講義.mp3");
    expect(discordMessages[0]!.content).toContain(`https://app.example.com/jobs/${id}`);
    expect(discordMessages[0]!.allowed_mentions).toEqual({ parse: [] });
  });

  it("keeps the audio and retries when the reported result is missing", async () => {
    const id = await startProcessing();
    await sendCallback({ job_id: id, attempt: 1, status: "completed" });
    const row = await getRow(id);
    expect(row.status).toBe("processing");
    expect(row.attempt).toBe(2);
    expect(row.error_code).toBe("result_missing");
    expect(await env.BUCKET.head(`audio/${id}`)).not.toBeNull();
  });

  it("retries twice, then fails and notifies once", async () => {
    const id = await startProcessing();
    for (const attempt of [1, 2]) {
      await sendCallback({ job_id: id, attempt, status: "failed", error_code: "transcription_failed" });
      const row = await getRow(id);
      expect(row.status).toBe("processing");
      expect(row.attempt).toBe(attempt + 1);
      expect(discordMessages).toHaveLength(0);
    }
    expect(modalCalls).toHaveLength(3);
    // 実行ごとに署名付き URL を発行し直している
    expect(new Set(modalCalls.map((c) => c.attempt))).toEqual(new Set([1, 2, 3]));

    await sendCallback({ job_id: id, attempt: 3, status: "failed", error_code: "transcription_failed" });
    const row = await getRow(id);
    expect(row.status).toBe("failed");
    expect(row.error_code).toBe("transcription_failed");
    expect(modalCalls).toHaveLength(3);
    expect(discordMessages).toHaveLength(1);
    expect(discordMessages[0]!.content).toContain("講義.mp3");
    expect(discordMessages[0]!.content).toContain("transcription_failed");
  });

  it("ignores a callback from an older attempt", async () => {
    const id = await startProcessing();
    await sendCallback({ job_id: id, attempt: 1, status: "failed", error_code: "download_failed" });
    await env.BUCKET.put(`results/${id}.json`, "{}");
    const response = await sendCallback({ job_id: id, attempt: 1, status: "completed" });
    expect(await response.json()).toEqual({ ok: true, ignored: true });
    expect((await getRow(id)).status).toBe("processing");
    expect(await env.BUCKET.head(`audio/${id}`)).not.toBeNull();
  });

  it("does not let a Discord failure change the job result", async () => {
    const id = await startProcessing();
    await env.BUCKET.put(`results/${id}.json`, "{}");
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error("discord down"));
    const response = await sendCallback({ job_id: id, attempt: 1, status: "completed" });
    expect(response.status).toBe(200);
    expect((await getRow(id)).status).toBe("completed");
  });
});

describe("Modal start failures", () => {
  it("uses up the retries and fails when Modal keeps rejecting", async () => {
    modalStatus = 402;
    const id = await startProcessing();
    const row = await getRow(id);
    expect(row.status).toBe("failed");
    expect(row.attempt).toBe(3);
    expect(row.error_code).toBe("modal_start_failed");
    expect(modalCalls).toHaveLength(3);
    expect(discordMessages).toHaveLength(1);
  });
});

describe("POST /api/jobs/:id/retry", () => {
  async function failJob(): Promise<string> {
    const id = await startProcessing();
    for (const attempt of [1, 2, 3]) {
      await sendCallback({ job_id: id, attempt, status: "failed", error_code: "internal_error" });
    }
    return id;
  }

  it("re-runs with a new attempt number and a fresh retry budget", async () => {
    const id = await failJob();
    const response = await request(`/api/jobs/${id}/retry`, { method: "POST" });
    expect(response.status).toBe(200);
    const row = await getRow(id);
    expect(row.status).toBe("processing");
    expect(row.attempt).toBe(4);
    expect(row.retries_left).toBe(2);
    expect(row.expires_at).toBeNull();
  });

  it("returns 410 once the audio is gone", async () => {
    const id = await failJob();
    await env.BUCKET.delete(`audio/${id}`);
    const response = await request(`/api/jobs/${id}/retry`, { method: "POST" });
    expect(response.status).toBe(410);
    expect((await getRow(id)).status).toBe("failed");
  });

  it("rejects a job that has not failed", async () => {
    const id = await startProcessing();
    expect((await request(`/api/jobs/${id}/retry`, { method: "POST" })).status).toBe(409);
  });
});

describe("cron", () => {
  const setColumn = (id: string, column: "started_at" | "created_at" | "expires_at", value: string) =>
    env.DB.prepare(`UPDATE jobs SET ${column} = ? WHERE id = ?`).bind(value, id).run();
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

  it("treats processing jobs as failed only after 75 minutes", async () => {
    const id = await startProcessing();
    await setColumn(id, "started_at", minutesAgo(74));
    await handleScheduled("*/5 * * * *", env);
    expect((await getRow(id)).attempt).toBe(1);

    await setColumn(id, "started_at", minutesAgo(76));
    await handleScheduled("*/5 * * * *", env);
    const row = await getRow(id);
    expect(row.status).toBe("processing");
    expect(row.attempt).toBe(2);
    expect(row.error_code).toBe("timeout");
  });

  it("fails and notifies after the last attempt times out", async () => {
    const id = await startProcessing();
    for (let i = 0; i < 3; i++) {
      await setColumn(id, "started_at", minutesAgo(76));
      await handleScheduled("*/5 * * * *", env);
    }
    expect((await getRow(id)).status).toBe("failed");
    expect(discordMessages).toHaveLength(1);
  });

  it("dispatches jobs stranded in queued", async () => {
    const { job } = await createJob();
    await env.DB.prepare("UPDATE jobs SET status = 'queued' WHERE id = ?").bind(job.id).run();
    await handleScheduled("*/5 * * * *", env);
    expect((await getRow(job.id)).status).toBe("processing");
  });

  it("deletes expired rows and results, keeping the rest", async () => {
    const expired = await startProcessing();
    const kept = await startProcessing();
    for (const id of [expired, kept]) {
      await env.BUCKET.put(`results/${id}.json`, "{}");
      await sendCallback({ job_id: id, attempt: 1, status: "completed" });
    }
    await setColumn(expired, "expires_at", minutesAgo(1));
    await handleScheduled(DAILY_CLEANUP_CRON, env);
    expect(await env.DB.prepare("SELECT id FROM jobs WHERE id = ?").bind(expired).first()).toBeNull();
    expect(await env.BUCKET.head(`results/${expired}.json`)).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM jobs WHERE id = ?").bind(kept).first()).not.toBeNull();
    expect(await env.BUCKET.head(`results/${kept}.json`)).not.toBeNull();
  });

  it("marks day-old uploads as abandoned", async () => {
    const { job } = await createJob();
    await setColumn(job.id, "created_at", minutesAgo(25 * 60));
    await handleScheduled(DAILY_CLEANUP_CRON, env);
    const row = await getRow(job.id);
    expect(row.status).toBe("failed");
    expect(row.error_code).toBe("upload_abandoned");
  });
});

describe("result and speakers", () => {
  async function completeJob(): Promise<string> {
    const id = await startProcessing();
    await env.BUCKET.put(`results/${id}.json`, JSON.stringify({ version: 1, segments: [] }));
    await sendCallback({ job_id: id, attempt: 1, status: "completed" });
    return id;
  }

  it("returns 409 until completed, then the stored JSON", async () => {
    const id = await startProcessing();
    expect((await request(`/api/jobs/${id}/result`)).status).toBe(409);
    await env.BUCKET.put(`results/${id}.json`, JSON.stringify({ version: 1 }));
    await sendCallback({ job_id: id, attempt: 1, status: "completed" });
    const response = await request(`/api/jobs/${id}/result`);
    expect(await response.json()).toEqual({ version: 1 });
  });

  it("stores names without touching the result and drops blanks", async () => {
    const id = await completeJob();
    const response = await jsonRequest(`/api/jobs/${id}/speakers`, "PATCH", {
      speaker_names: { SPEAKER_00: "田中", SPEAKER_01: "" },
    });
    expect(response.status).toBe(200);
    const { job } = (await response.json()) as { job: { speaker_names: unknown } };
    expect(job.speaker_names).toEqual({ SPEAKER_00: "田中" });
    expect(await (await request(`/api/jobs/${id}/result`)).json()).toEqual({ version: 1, segments: [] });
  });

  it("rejects unknown speaker keys", async () => {
    const id = await completeJob();
    const response = await jsonRequest(`/api/jobs/${id}/speakers`, "PATCH", { speaker_names: { admin: "x" } });
    expect(response.status).toBe(400);
  });
});

describe("Access", () => {
  const protectedEnv = { ...env, DEV_SKIP_ACCESS: undefined };

  it("rejects API requests without a token", async () => {
    expect((await app.request("/api/jobs", {}, protectedEnv)).status).toBe(401);
  });

  it("rejects a malformed token", async () => {
    const response = await app.request("/api/jobs", { headers: { "Cf-Access-Jwt-Assertion": "not-a-jwt" } }, protectedEnv);
    expect(response.status).toBe(401);
  });

  it("does not require a token on the signed callback route", async () => {
    const response = await app.request("/internal/callback", { method: "POST", body: "{}" }, protectedEnv);
    expect(logs.join()).toContain("callback.rejected");
    expect(response.status).toBe(401);
  });
});

describe("logging", () => {
  it("never logs signed URLs or user-supplied terms", async () => {
    const { job } = await createJob({ terms: ["社外秘プロジェクト"] });
    await env.BUCKET.put(`audio/${job.id}`, "x");
    await request(`/api/jobs/${job.id}/complete`, { method: "POST" });
    expect(modalCalls[0]!.options.terms).toEqual(["社外秘プロジェクト"]);
    const output = logs.join("\n");
    expect(output).toContain("job.dispatching");
    expect(output).not.toContain("X-Amz-Signature");
    expect(output).not.toContain("社外秘プロジェクト");
  });
});

describe("verifySignature", () => {
  it("accepts a valid signature and rejects tampering", async () => {
    const now = 1_700_000_000_000;
    const ts = String(now / 1000);
    const signature = await signPayload("s", ts, "body");
    expect(await verifySignature("s", ts, "body", signature, now)).toBe("ok");
    expect(await verifySignature("s", ts, "tampered", signature, now)).toBe("bad_signature");
    expect(await verifySignature("s", ts, "body", "zz", now)).toBe("bad_signature");
    expect(await verifySignature("s", "NaN", "body", signature, now)).toBe("stale_timestamp");
  });
});
