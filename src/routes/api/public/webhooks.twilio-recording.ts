/**
 * Twilio Recording Status Callback - stamps recording_url on the calls row.
 *
 * Twilio POSTs here when a recording finishes. Body includes:
 *   CallSid, RecordingSid, RecordingUrl, RecordingDuration, RecordingStatus.
 *
 * We match by twilio_call_sid and store the .mp3 URL. Twilio's RecordingUrl
 * is a media URL that requires HTTP Basic auth with the Account SID + Auth
 * Token - but the browser can play the public `.mp3` extension without auth
 * for accounts with public recordings, and our audio element accepts the
 * signed media URL directly. We append `.mp3` so the <audio> tag streams it
 * as MP3 instead of the default XML metadata endpoint.
 */
import { createFileRoute } from "@tanstack/react-router";
import { errorJson, json, preflight } from "@/lib/api/cors";
import { cred } from "@/lib/config/credentials";

async function verifyTwilio(request: Request, raw: string): Promise<boolean> {
  const token = (await cred("TWILIO_AUTH_TOKEN"));
  if (!token) return true;
  const signature = request.headers.get("x-twilio-signature");
  if (!signature) return false;
  const params = new URLSearchParams(raw);
  const sorted = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
  const paramStr = sorted.map(([k, v]) => k + v).join("");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(token),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const url = new URL(request.url);
  const candidates = [request.url];
  for (const proto of ["https:", "http:"]) {
    const u = new URL(url.toString());
    u.protocol = proto;
    candidates.push(u.toString());
  }
  for (const candidate of candidates) {
    const payload = candidate + paramStr;
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
    const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));
    if (expected === signature) return true;
  }
  return false;
}

export const Route = createFileRoute("/api/public/webhooks/twilio-recording")({
  server: {
    handlers: {
      OPTIONS: async () => preflight(),
      POST: async ({ request }) => {
        const raw = await request.text();
        if (!(await verifyTwilio(request, raw))) {
          return errorJson(401, "Invalid Twilio signature");
        }
        const body = Object.fromEntries(new URLSearchParams(raw).entries());
        const callSid = body.CallSid;
        const recordingUrl = body.RecordingUrl;
        if (!callSid || !recordingUrl) {
          return json({ ok: true, skipped: true });
        }
        // Twilio's RecordingUrl returns XML metadata by default; append .mp3
        // so <audio> tags stream the media directly.
        const mp3Url = recordingUrl.endsWith(".mp3") ? recordingUrl : `${recordingUrl}.mp3`;

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: existing } = await supabaseAdmin
          .from("calls")
          .select("id")
          .eq("twilio_call_sid", callSid)
          .maybeSingle<{ id: string }>();
        if (!existing) return json({ ok: true, matched: false });

        const patch: Record<string, unknown> = {
          recording_url: mp3Url,
          updated_at: new Date().toISOString(),
        };
        if (body.RecordingDuration) {
          patch.duration_sec = Number(body.RecordingDuration);
        }
        const { error } = await supabaseAdmin
          .from("calls")
          .update(patch as never)
          .eq("id", existing.id);
        if (error) return errorJson(500, `db update: ${error.message}`);

        return json({ ok: true, call_id: existing.id });
      },
    },
  },
});
