/**
 * Twilio Status Callback - persists call state to public.calls.
 *
 * Twilio POSTs here at each lifecycle transition (initiated → ringing →
 * answered → completed / no-answer / busy / failed). We match the row by
 * twilio_call_sid (set at initiateCall) and update status, duration,
 * recording_url, ended_at. If no row exists (e.g. an inbound call not
 * originated by our app) we skip - user_id is required and we can't
 * safely attribute it.
 *
 * After a terminal transition we also fire enabled automations belonging
 * to the call's owner (fetched from public.automations, RLS-bypassed via
 * the admin client because the request is from Twilio, not a user).
 *
 * Signature verification: HMAC-SHA1 X-Twilio-Signature when
 * TWILIO_AUTH_TOKEN is set (skipped in dev/preview when the secret is
 * missing).
 */
import { createFileRoute } from "@tanstack/react-router";
import { errorJson, json, preflight } from "@/lib/api/cors";
import { cred } from "@/lib/config/credentials";

// Twilio -> internal status map
const STATUS: Record<string, string> = {
  queued: "queued",
  ringing: "ringing",
  "in-progress": "in_progress",
  completed: "completed",
  busy: "busy",
  failed: "failed",
  "no-answer": "no_answer",
  canceled: "failed",
};

const TERMINAL = new Set(["completed", "failed", "no_answer", "busy"]);

async function readBody(raw: string, contentType: string): Promise<Record<string, string>> {
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(raw) as Record<string, string>;
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(raw).entries());
}

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
  // Twilio signs the exact URL it POSTs to. Behind a proxy request.url can
  // reflect http:// while Twilio used https:// (or vice-versa). Try both.
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

function triggerForStatus(status: string): string | null {
  if (status === "completed") return "call_completed";
  if (status === "no_answer") return "call_no_answer";
  if (status === "failed" || status === "busy") return "call_failed";
  return null;
}

// Map Twilio's terminal CallStatus / internal status to a canonical end_reason.
// See src/lib/voice/call-end-reasons.ts for the full set.
function twilioEndReason(rawStatus: string | undefined, mapped: string): string | null {
  if (rawStatus === "canceled") return "canceled";
  if (mapped === "no_answer") return "no_answer";
  if (mapped === "busy") return "busy";
  if (mapped === "failed") return "carrier_failed";
  if (mapped === "completed") return "caller_hangup"; // fallback if bridge never wrote one
  return null;
}


export const Route = createFileRoute("/api/public/webhooks/twilio")({
  server: {
    handlers: {
      OPTIONS: async () => preflight(),
      POST: async ({ request }) => {
        const raw = await request.text();
        if (!(await verifyTwilio(request, raw))) {
          return errorJson(401, "Invalid Twilio signature");
        }
        const body = await readBody(raw, request.headers.get("content-type") ?? "");

        const callSid = body.CallSid;
        if (!callSid) return errorJson(400, "CallSid required");

        const status = STATUS[body.CallStatus] ?? "in_progress";
        const nowIso = new Date().toISOString();

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        const { data: existing, error: readErr } = await supabaseAdmin
          .from("calls")
          .select("id, user_id, status, campaign_id, contact_id, agent_id, phone_to, phone_from, started_at, ended_at, duration_sec, recording_url, transcript, end_reason, extracted_data")
          .eq("twilio_call_sid", callSid)
          .maybeSingle<{ id: string; user_id: string; status: string; campaign_id: string | null; contact_id: string | null; agent_id: string | null; phone_to: string; phone_from: string | null; started_at: string | null; ended_at: string | null; duration_sec: number | null; recording_url: string | null; transcript: unknown; end_reason: string | null; extracted_data: Record<string, unknown> | null }>();
        if (readErr) return errorJson(500, `db read: ${readErr.message}`);

        if (!existing) {
          // Inbound or foreign call - nothing to persist without a user_id.
          return json({ ok: true, matched: false });
        }

        const patch: Record<string, unknown> = {
          status,
          updated_at: nowIso,
        };
        if (body.CallDuration) patch.duration_sec = Number(body.CallDuration);
        if (body.RecordingUrl) patch.recording_url = body.RecordingUrl;
        if (TERMINAL.has(status)) {
          patch.ended_at = nowIso;
          // Only stamp end_reason if nothing else has yet (bridge + AMD run
          // independently and are the authoritative source for completed
          // calls). Twilio-terminal states below the bridge get a canonical
          // reason here so every terminal row has one.
          if (!existing.end_reason) {
            const reason = twilioEndReason(body.CallStatus, status);
            if (reason) patch.end_reason = reason;
          }
        }

        const { error: updErr } = await supabaseAdmin
          .from("calls")
          .update(patch as never)
          .eq("id", existing.id);
        if (updErr) return errorJson(500, `db update: ${updErr.message}`);


        // Fire automations on terminal transitions.
        const trig = TERMINAL.has(status) ? triggerForStatus(status) : null;
        if (trig) {
          // Re-read to pick up transcript + extracted_data written by the
          // bridge, which may land just before or after this Twilio callback.
          const { data: fresh } = await supabaseAdmin
            .from("calls")
            .select("transcript, extracted_data")
            .eq("id", existing.id)
            .maybeSingle<{ transcript: unknown; extracted_data: Record<string, unknown> | null }>();
          const extracted =
            (fresh?.extracted_data as Record<string, unknown> | null) ??
            existing.extracted_data ??
            {};
          const transcript = fresh?.transcript ?? existing.transcript ?? null;

          const merged = { ...existing, ...patch };
          const callPayload = {
            id: existing.id,
            twilio_call_sid: callSid,
            user_id: existing.user_id,
            agent_id: existing.agent_id,
            campaign_id: existing.campaign_id,
            contact_id: existing.contact_id,
            direction: "outbound",
            phone_to: existing.phone_to,
            phone_from: existing.phone_from,
            status: merged.status,
            started_at: existing.started_at,
            ended_at: merged.ended_at ?? existing.ended_at,
            duration_sec: merged.duration_sec ?? existing.duration_sec,
            recording_url: merged.recording_url ?? existing.recording_url,
            end_reason: merged.end_reason ?? existing.end_reason,
            transcript,
            extracted_data: extracted,
          };

          const { data: automations } = await supabaseAdmin
            .from("automations")
            .select("id, action, config")
            .eq("user_id", existing.user_id)
            .eq("enabled", true)
            .eq("trigger", trig);
          for (const a of automations ?? []) {
            const cfg = (a.config ?? {}) as { url?: string };
            if (a.action === "webhook" && cfg.url) {
              fetch(cfg.url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  event: trig,
                  call: callPayload,
                  data: extracted,
                  automation: a.id,
                }),
              }).catch(() => {});
            }
          }
        }

        return json({ ok: true, call_id: existing.id });
      },
    },
  },
});
