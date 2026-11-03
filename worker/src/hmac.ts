const MAX_CLOCK_SKEW_SEC = 300;

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export async function signPayload(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await importKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type VerifyResult = "ok" | "stale_timestamp" | "bad_signature";

export async function verifySignature(
  secret: string,
  timestamp: string,
  body: string,
  signatureHex: string,
  nowMs: number = Date.now(),
): Promise<VerifyResult> {
  const timestampSec = Number(timestamp);
  if (!Number.isFinite(timestampSec) || Math.abs(nowMs / 1000 - timestampSec) > MAX_CLOCK_SKEW_SEC) {
    return "stale_timestamp";
  }
  const signature = hexToBytes(signatureHex);
  if (!signature) return "bad_signature";
  const key = await importKey(secret);
  const valid = await crypto.subtle.verify("HMAC", key, signature, new TextEncoder().encode(`${timestamp}.${body}`));
  return valid ? "ok" : "bad_signature";
}
