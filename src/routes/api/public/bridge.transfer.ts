/**
 * Bridge → Lovable: transfer a live Twilio call to another number.
 *
 * The voice-bridge cannot hold Twilio credentials, so it POSTs here (HMAC
 * signed) with { call_sid, transfer_number }. We then use the Twilio REST
 * API to modify the in-flight call so its next TwiML is served by
 * `/api/public/twilio/transfer`, which returns a <Dial> that warm-bridges
 * the caller to the target number.
 *
 * Modifying the call causes Twilio to end the current <Stream>, which
 * closes the bridge WebSocket - the bridge treats that as normal cleanup.
 */
import { createFileRoute } from "@tanstack/react-router";
import { verifyBridge } from "@/lib/voice/bridge-auth";
import { errorJson, json, preflight } from "@/lib/api/cors";
import { cred } from "@/lib/config/credentials";

export const Route = createFileRoute("/api/public/bridge/transfer")({
  server: {
    handlers: {
      OPTIONS: async () => preflight(),
      POST: async ({ request }) => {
        const raw = await request.text();
        if (!(await verifyBridge(request, raw))) {
          return errorJson(401, "Invalid bridge signature");
        }
        let body: { call_sid?: string; transfer_number?: string };
        try {
          body = JSON.parse(raw);
        } catch {
          return errorJson(400, "Invalid JSON");
        }
        const callSid = body.call_sid?.trim();
        const to = body.transfer_number?.trim();
        if (!callSid || !to) {
          return errorJson(400, "call_sid and transfer_number are required");
        }
        if (!/^\+\d{8,15}$/.test(to)) {
          return errorJson(400, "transfer_number must be E.164 (+15551234567)");
        }

        const sid = (await cred("TWILIO_ACCOUNT_SID"));
        const token = (await cred("TWILIO_AUTH_TOKEN"));
        const publicUrl = (await cred("PUBLIC_APP_URL"));
        if (!sid || !token || !publicUrl) {
          return errorJson(
            500,
            "Twilio not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / PUBLIC_APP_URL)",
          );
        }

        const twimlUrl = new URL(`${publicUrl}/api/public/twilio/transfer`);
        twimlUrl.searchParams.set("to", to);

        const basic = btoa(`${sid}:${token}`);
        const res = await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls/${encodeURIComponent(callSid)}.json`,
          {
            method: "POST",
            headers: {
              Authorization: `Basic ${basic}`,
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
              Url: twimlUrl.toString(),
              Method: "POST",
            }),
          },
        );
        if (!res.ok) {
          const t = await res.text().catch(() => "");
          return errorJson(res.status, `Twilio modify ${res.status}: ${t.slice(0, 200)}`);
        }
        return json({ ok: true });
      },
    },
  },
});
