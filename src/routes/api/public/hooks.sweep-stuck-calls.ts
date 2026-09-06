/**
 * Safety-net sweeper for calls that never reached a terminal state.
 *
 * Twilio normally POSTs a `completed` / `no-answer` / `busy` / `failed`
 * status when a call ends. If that webhook is missed (network hiccup,
 * signature mismatch, phone unreachable + carrier never returned a
 * terminal SIP response) the calls row can sit in `queued`, `ringing`,
 * or `in_progress` forever, which pins it to the Live Calls dashboard.
 *
 * This endpoint first asks Twilio for the current state of stale active calls.
 * If Twilio cannot be reached, old pre-connect rows are marked `no_answer`
 * so campaigns keep moving instead of pinning every concurrency slot.
 */
import { createFileRoute } from "@tanstack/react-router";
import { json } from "@/lib/api/cors";
import { cred } from "@/lib/config/credentials";

const RECONCILE_AFTER_MS = 45 * 1000;
const PRE_CONNECT_TIMEOUT_MS = 2 * 60 * 1000;

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

type StaleCall = {
  id: string;
  status: string;
  started_at: string;
  twilio_call_sid: string | null;
  end_reason: string | null;
};

type TwilioCall = {
  status?: string;
  duration?: string;
  end_time?: string | null;
  date_updated?: string | null;
};

function twilioEndReason(rawStatus: string | undefined, mapped: string): string | null {
  if (rawStatus === "canceled") return "canceled";
  if (mapped === "no_answer") return "no_answer";
  if (mapped === "busy") return "busy";
  if (mapped === "failed") return "carrier_failed";
  if (mapped === "completed") return "caller_hangup";
  return null;
}

async function fetchTwilioCall(callSid: string): Promise<TwilioCall | null> {
  const sid = (await cred("TWILIO_ACCOUNT_SID"));
  const token = (await cred("TWILIO_AUTH_TOKEN"));
  if (!sid || !token || !callSid) return null;

  const basic = btoa(`${sid}:${token}`);
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls/${encodeURIComponent(callSid)}.json`,
    { headers: { Authorization: `Basic ${basic}` } },
  );
  if (!res.ok) return null;
  return (await res.json()) as TwilioCall;
}

export const Route = createFileRoute("/api/public/hooks/sweep-stuck-calls")({
  server: {
    handlers: {
      GET: async () => runSweep(),
      POST: async () => runSweep(),
    },
  },
});

async function runSweep() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const reconcileCutoff = new Date(Date.now() - RECONCILE_AFTER_MS).toISOString();
  const timeoutCutoff = new Date(Date.now() - PRE_CONNECT_TIMEOUT_MS).toISOString();
  const nowIso = new Date().toISOString();

  const { data: stuck, error: readErr } = await supabaseAdmin
    .from("calls")
    .select("id, status, started_at, twilio_call_sid, end_reason")
    .is("ended_at", null)
    .in("status", ["queued", "dialing", "ringing", "in_progress"])
    .lt("started_at", reconcileCutoff)
    .limit(200);

  if (readErr) {
    return json({ ok: false, error: readErr.message }, { status: 500 });
  }

  const rows = (stuck ?? []) as StaleCall[];
  if (rows.length === 0) return json({ ok: true, swept: 0, reconciled: 0 });

  let swept = 0;
  let reconciled = 0;

  for (const call of rows) {
    const twilio = call.twilio_call_sid
      ? await fetchTwilioCall(call.twilio_call_sid).catch(() => null)
      : null;

    if (twilio?.status) {
      const mapped = STATUS[twilio.status] ?? call.status;
      const patch: Record<string, unknown> = {
        status: mapped,
        updated_at: nowIso,
      };
      if (twilio.duration) patch.duration_sec = Number(twilio.duration);
      if (TERMINAL.has(mapped)) {
        patch.ended_at = twilio.end_time ?? twilio.date_updated ?? nowIso;
        if (!call.end_reason) {
          const reason = twilioEndReason(twilio.status, mapped);
          if (reason) patch.end_reason = reason;
        }
      }

      const { error } = await supabaseAdmin
        .from("calls")
        .update(patch as never)
        .eq("id", call.id);
      if (!error) reconciled += 1;
      continue;
    }

    const isPreConnect = call.status === "queued" || call.status === "dialing" || call.status === "ringing";
    if (!isPreConnect || call.started_at >= timeoutCutoff) continue;

    const { error } = await supabaseAdmin
      .from("calls")
      .update({
        status: "no_answer",
        end_reason: "no_answer_timeout",
        ended_at: nowIso,
        updated_at: nowIso,
      } as never)
      .eq("id", call.id);
    if (!error) swept += 1;
  }

  return json({ ok: true, swept, reconciled });
}
