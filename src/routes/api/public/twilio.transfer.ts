/**
 * Twilio TwiML endpoint that <Dial>s a transfer target.
 *
 * Reached when the bridge modifies a live call via /api/public/bridge/transfer.
 * The `to` query param carries the E.164 destination (validated upstream).
 * callerId is TWILIO_FROM_NUMBER so the transfer target sees a valid caller.
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

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const to = url.searchParams.get("to") ?? "";
  const from = (await cred("TWILIO_FROM_NUMBER")) ?? "";

  let twiml: string;
  if (!/^\+\d{8,15}$/.test(to)) {
    twiml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<Response><Say voice="alice">Transfer target is invalid. Goodbye.</Say><Hangup/></Response>`;
  } else {
    const callerId = from ? ` callerId="${escapeXml(from)}"` : "";
    twiml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<Response>` +
      `<Say voice="alice">Please hold while I connect you.</Say>` +
      `<Dial${callerId} timeout="25" answerOnBridge="true">${escapeXml(to)}</Dial>` +
      `<Say voice="alice">Sorry, we could not reach anyone. Goodbye.</Say>` +
      `<Hangup/>` +
      `</Response>`;
  }
  return new Response(twiml, {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}

export const Route = createFileRoute("/api/public/twilio/transfer")({
  server: {
    handlers: {
      GET: async ({ request }) => handle(request),
      POST: async ({ request }) => handle(request),
    },
  },
});
