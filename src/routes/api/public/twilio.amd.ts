/**
 * Twilio Answering Machine Detection (AMD) callback.
 *
 * Twilio POSTs this URL once it decides whether a human or a machine
 * (voicemail) answered. Params include CallSid and AnsweredBy:
 *   human | fax | unknown | machine_start
 *   | machine_end_beep | machine_end_silence | machine_end_other
 *
 * If AnsweredBy is a "machine_*" value and the agent's voicemail_handling
 * is "leave_message", we modify the live call so the bridge <Stream> is
 * dropped and Twilio plays the agent's voicemail script instead. In all
 * other machine cases we just hang up. Humans fall through and stay on
 * the bridge.
 *
 * agent_id is passed in the query string when we originate the call.
 */
import { createFileRoute } from "@tanstack/react-router";
import { cred } from "@/lib/config/credentials";

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    '"': "&quot;",
    "'": "&apos;",
  }[c]!));
}

async function loadAgentVoicemail(
  agentId: string,
): Promise<{ handling: string; message: string } | null> {
  if (!agentId) return null;
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("agents")
      .select("voicemail_handling, voicemail_message")
      .eq("id", agentId)
      .maybeSingle();
    if (error || !data) return null;
    return {
      handling: (data.voicemail_handling as string) || "hangup",
      message: (data.voicemail_message as string) || "",
    };
  } catch {
    return null;
  }
}

async function modifyCall(callSid: string, twiml: string): Promise<void> {
  const sid = (await cred("TWILIO_ACCOUNT_SID"));
  const token = (await cred("TWILIO_AUTH_TOKEN"));
  if (!sid || !token) return;
  const basic = btoa(`${sid}:${token}`);
  await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls/${encodeURIComponent(callSid)}.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ Twiml: twiml }),
    },
  ).catch(() => {});
}

export const Route = createFileRoute("/api/public/twilio/amd")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const url = new URL(request.url);
        const agentId = url.searchParams.get("agent_id") ?? "";
        const raw = await request.text().catch(() => "");
        const form = new URLSearchParams(raw);
        const callSid = form.get("CallSid") ?? "";
        const answeredBy = (form.get("AnsweredBy") ?? "").toLowerCase();

        // Not a machine - let the bridge keep talking to the human.
        if (!answeredBy.startsWith("machine")) {
          return new Response("", { status: 204 });
        }
        if (!callSid) return new Response("", { status: 204 });

        const agent = await loadAgentVoicemail(agentId);
        const handling = agent?.handling ?? "hangup";
        const message = agent?.message?.trim() ?? "";
        const willLeave = handling === "leave_message" && !!message;

        const twiml = willLeave
          ? `<?xml version="1.0" encoding="UTF-8"?>` +
            `<Response>` +
            `<Pause length="2"/>` +
            `<Say voice="alice">${escapeXml(message)}</Say>` +
            `<Hangup/>` +
            `</Response>`
          : `<?xml version="1.0" encoding="UTF-8"?>` +
            `<Response><Hangup/></Response>`;

        await modifyCall(callSid, twiml);

        // Record the outcome on the call row (best-effort).
        try {
          const { supabaseAdmin } = await import(
            "@/integrations/supabase/client.server"
          );
          await supabaseAdmin
            .from("calls")
            .update({
              end_reason: willLeave ? "voicemail_left" : "voicemail_hangup",
              ended_at: new Date().toISOString(),
              status: "completed",
            } as never)
            .eq("twilio_call_sid", callSid);
        } catch (e) {
          console.error("amd end_reason write failed", e);
        }

        return new Response("", { status: 204 });
      },
    },
  },
});
