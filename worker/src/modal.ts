import type { Env } from "./env";
import { log } from "./logger";

const START_TIMEOUT_MS = 30_000;

export interface ModalStartRequest {
  job_id: string;
  attempt: number;
  audio_url: string;
  result_url: string;
  callback_url: string;
  options: unknown;
}

export async function startModalJob(env: Env, request: ModalStartRequest): Promise<void> {
  const startedAt = Date.now();
  const response = await fetch(env.MODAL_ENDPOINT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Modal-Key": env.MODAL_KEY,
      "Modal-Secret": env.MODAL_SECRET,
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(START_TIMEOUT_MS),
  });
  log.info("modal.start_response", {
    job_id: request.job_id,
    attempt: request.attempt,
    status: response.status,
    elapsed_ms: Date.now() - startedAt,
  });
  if (!response.ok) {
    throw new Error(`Modal returned status ${response.status}`);
  }
}
