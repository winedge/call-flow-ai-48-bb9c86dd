/**
 * Twilio Voice URL - returns TwiML that hands the call's audio to the
 * voice-bridge service via <Connect><Stream>.
 *
 * Handles BOTH:
 *   • Outbound calls we originated - Twilio invokes this URL with
 *     `?agent_id=…` (we pass it in initiateCall). The calls row already
 *     exists.
 *   • Inbound calls to your Twilio number - Twilio invokes this URL with
 *     no query params. We look up the phone_numbers row for the `To`
 *     number and use its `inbound_agent_id` (falling back to the user's
 *     first agent). A calls row is created on the fly so the same
 *     status/end-reason webhooks persist end-to-end.
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

function sayAndHangup(msg: string): Response {
  const twiml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response><Say voice="alice">${escapeXml(msg)}</Say><Hangup/></Response>`;
  return new Response(twiml, {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}

function bridgeStreamUrl(rawBridgeUrl: string): URL {
  const stream = new URL(rawBridgeUrl);
  stream.protocol = "wss:";

  // Older bridge configs used the base project host plus `/twilio`. Lovable
  // Cloud edge functions are served from the functions host at `/voice-bridge`.
  // If that stale shape is still saved, Twilio connects to a non-function URL
  // and hangs up before the bridge can log the call.
  if (
    stream.hostname.endsWith(".supabase.co") &&
    !stream.hostname.endsWith(".functions.supabase.co")
  ) {
    const projectRef = stream.hostname.split(".")[0];
    stream.hostname = `${projectRef}.functions.supabase.co`;
    stream.pathname = "/voice-bridge";
  }

  if (
    stream.hostname.endsWith(".functions.supabase.co") &&
    (!stream.pathname || stream.pathname === "/")
  ) {
    stream.pathname = "/voice-bridge";
  }


  return stream;
}

export const Route = createFileRoute("/api/public/twilio/voice")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const url = new URL(request.url);
        let agentId = url.searchParams.get("agent_id") ?? "";
        const bootstrap = url.searchParams.get("b") ?? "";
        const raw = await request.text().catch(() => "");
        const form = new URLSearchParams(raw);
        const callSid = form.get("CallSid") ?? "";
        const fromNumber = form.get("From") ?? "";
        const toNumber = form.get("To") ?? "";
        const direction = form.get("Direction") ?? "";
        const isInbound =
          !agentId && (direction === "inbound" || direction === "");

        const bridge = (await cred("BRIDGE_URL"));
        if (!bridge) {
          return sayAndHangup("The voice bridge is not configured. Goodbye.");
        }

        // Inbound routing: look up phone_numbers by "To" number to find the
        // owner + configured inbound agent, then insert a persisted call
        // row so status webhooks + end-reason updates land on it.
        if (isInbound) {
          if (!toNumber) return sayAndHangup("Missing destination number.");
          const { supabaseAdmin } = await import(
            "@/integrations/supabase/client.server"
          );
          const { data: phone } = await supabaseAdmin
            .from("phone_numbers")
            .select("user_id, inbound_agent_id")
            .eq("number", toNumber)
            .maybeSingle<{ user_id: string; inbound_agent_id: string | null }>();
          if (!phone) {
            return sayAndHangup(
              "This number is not configured. Goodbye.",
            );
          }
          agentId = phone.inbound_agent_id ?? "";
          if (!agentId) {
            // Fallback: first agent owned by this user
            const { data: fallback } = await supabaseAdmin
              .from("agents")
              .select("id")
              .eq("user_id", phone.user_id)
              .order("created_at", { ascending: true })
              .limit(1)
              .maybeSingle<{ id: string }>();
            agentId = fallback?.id ?? "";
          }
          if (!agentId) {
            return sayAndHangup(
              "No AI agent is assigned to this number. Goodbye.",
            );
          }
          // Persist a call row so twilio status callbacks + bridge events
          // can update it by twilio_call_sid.
          await supabaseAdmin.from("calls").insert({
            user_id: phone.user_id,
            agent_id: agentId,
            phone_from: fromNumber,
            phone_to: toNumber,
            twilio_call_sid: callSid,
            status: "in_progress",
          } as never);
        }

        // Media Streams URL: Twilio does not support query strings on
        // <Stream url="...">. Pass call metadata with nested <Parameter>
        // tags instead; Twilio delivers them in the WebSocket start frame.
        const stream = bridgeStreamUrl(bridge);
        stream.search = "";
        // Twilio forbids query strings on <Stream>, but path segments are
        // allowed. Put metadata in the URL path so the bridge can fetch the
        // agent and pre-synthesize the greeting before Twilio's start frame.
        if (stream.hostname.endsWith(".functions.supabase.co") || stream.pathname.includes("voice-bridge")) {
          const basePath = stream.pathname.replace(/\/+$/, "") || "/voice-bridge";
          stream.pathname = `${basePath}/${encodeURIComponent(agentId)}/${encodeURIComponent(callSid || "unknown")}${bootstrap ? `/${encodeURIComponent(bootstrap)}` : ""}`;
        }
        const wsUrl = escapeXml(stream.toString());
        const agentParam = escapeXml(agentId);
        const callParam = escapeXml(callSid);

        // <Connect><Stream> hands audio to the bridge and holds the call open.
        // Do not add <Start><Record> here: Twilio Voice TwiML does not support
        // <Record> as a <Start> noun, and rejects the response before opening
        // the media stream, which makes the call hang up right after pickup.
        const twiml =
          `<?xml version="1.0" encoding="UTF-8"?>` +
          `<Response><Connect><Stream url="${wsUrl}">` +
          `<Parameter name="agent_id" value="${agentParam}"/>` +
          `<Parameter name="call_sid" value="${callParam}"/>` +
          `</Stream></Connect></Response>`;
        return new Response(twiml, {
          status: 200,
          headers: { "Content-Type": "text/xml" },
        });
      },
    },
  },
});
