/**
 * Shared HMAC auth between this app and the standalone voice-bridge service.
 *
 * Bridge signs: `${timestamp}.${body}` with BRIDGE_SHARED_SECRET (HMAC-SHA256),
 * sends `X-Bridge-Timestamp` + `X-Bridge-Signature` (hex). We verify and
 * reject anything older than 5 minutes to block replay.
 */
import { cred } from "@/lib/config/credentials";

const MAX_SKEW_MS = 5 * 60 * 1000;

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export async function signBridge(
  secret: string,
  body: string,
): Promise<{ timestamp: string; signature: string }> {
  const ts = Date.now().toString();
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${ts}.${body}`),
  );
  return { timestamp: ts, signature: hex(sig) };
}

export async function verifyBridge(request: Request, rawBody: string): Promise<boolean> {
  const secret = (await cred("BRIDGE_SHARED_SECRET"));
  if (!secret) return false;
  const ts = request.headers.get("x-bridge-timestamp");
  const sig = request.headers.get("x-bridge-signature");
  if (!ts || !sig) return false;
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() - tsNum) > MAX_SKEW_MS) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = hex(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${ts}.${rawBody}`)),
  );
  return timingSafeEqual(sig, expected);
}
