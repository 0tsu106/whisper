import { AwsClient } from "aws4fetch";
import type { Env } from "./env";

export const UPLOAD_URL_TTL_SEC = 60 * 60;
// Modal 関数のタイムアウト(60分)より長くする
export const MODAL_URL_TTL_SEC = 90 * 60;

export const audioKey = (jobId: string) => `audio/${jobId}`;
export const resultKey = (jobId: string) => `results/${jobId}.json`;

export async function presignUrl(env: Env, method: "GET" | "PUT", key: string, expiresSec: number): Promise<string> {
  const client = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
  });
  const url = new URL(`https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${key}`);
  url.searchParams.set("X-Amz-Expires", String(expiresSec));
  const signed = await client.sign(new Request(url, { method }), { aws: { signQuery: true } });
  return signed.url;
}
