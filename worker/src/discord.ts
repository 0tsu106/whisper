import type { Env } from "./env";
import { errorFields, log } from "./logger";

const SEND_TIMEOUT_MS = 5_000;

export type JobNotification =
  | { kind: "completed"; jobId: string; filename: string }
  | { kind: "failed"; jobId: string; filename: string; errorCode: string };

function formatMessage(env: Env, notification: JobNotification): string {
  const link = `${env.APP_URL}/jobs/${notification.jobId}`;
  if (notification.kind === "completed") {
    return `✅ 文字起こしが完了しました\nファイル: ${notification.filename}\n${link}`;
  }
  return `❌ 文字起こしに失敗しました\nファイル: ${notification.filename}\n理由: ${notification.errorCode}\n${link}`;
}

// 送信失敗はジョブの結果に影響させないため、例外を外に出さない
export async function notifyDiscord(env: Env, notification: JobNotification): Promise<void> {
  const fields = { job_id: notification.jobId, kind: notification.kind };
  if (!env.DISCORD_WEBHOOK_URL) {
    log.warn("discord.skipped_no_webhook", fields);
    return;
  }
  try {
    const response = await fetch(env.DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: formatMessage(env, notification),
        // ファイル名に @everyone などが含まれていてもメンションさせない
        allowed_mentions: { parse: [] },
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (response.ok) {
      log.info("discord.sent", fields);
    } else {
      log.error("discord.rejected", { ...fields, status: response.status });
    }
  } catch (err) {
    log.error("discord.send_failed", { ...fields, ...errorFields(err) });
  }
}
