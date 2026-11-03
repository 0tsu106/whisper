import { log } from "./logger";
import type { Job, JobOptions, TranscriptResult } from "./types";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`API error ${status}: ${code}`);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = init?.method ?? "GET";
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (err) {
    log.error("api.network_error", { method, path, error: String(err) });
    throw err;
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    const code = body?.error ?? "unknown_error";
    log.error("api.request_failed", { method, path, status: response.status, code });
    throw new ApiError(response.status, code);
  }
  return (await response.json()) as T;
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export async function listJobs(): Promise<Job[]> {
  return (await request<{ jobs: Job[] }>("/api/jobs")).jobs;
}

export async function getJob(id: string): Promise<Job> {
  return (await request<{ job: Job }>(`/api/jobs/${id}`)).job;
}

export function createJob(filename: string, sizeBytes: number, options: JobOptions) {
  return request<{ job: Job; upload_url: string }>(
    "/api/jobs",
    jsonInit("POST", { filename, size_bytes: sizeBytes, options }),
  );
}

export async function completeUpload(id: string): Promise<Job> {
  return (await request<{ job: Job }>(`/api/jobs/${id}/complete`, { method: "POST" })).job;
}

export async function retryJob(id: string): Promise<Job> {
  return (await request<{ job: Job }>(`/api/jobs/${id}/retry`, { method: "POST" })).job;
}

export function getResult(id: string): Promise<TranscriptResult> {
  return request<TranscriptResult>(`/api/jobs/${id}/result`);
}

export async function updateSpeakers(id: string, names: Record<string, string>): Promise<Job> {
  return (await request<{ job: Job }>(`/api/jobs/${id}/speakers`, jsonInit("PATCH", { speaker_names: names }))).job;
}

// fetch では進捗を取得できないため XMLHttpRequest を使う
export function uploadFile(url: string, file: File, onProgress: (fraction: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        log.error("upload.rejected", { status: xhr.status });
        reject(new Error(`Upload failed with status ${xhr.status}`));
      }
    };
    xhr.onerror = () => {
      log.error("upload.network_error");
      reject(new Error("Upload failed"));
    };
    xhr.send(file);
  });
}
