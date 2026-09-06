/**
 * Twilio Programmable Voice - outbound call initiation.
 *
 * Uses standard Twilio REST (Account SID + Auth Token, HTTP Basic).
 * On connect, Twilio hits our TwiML endpoint at
 *   POST {PUBLIC_APP_URL}/api/public/twilio/voice?agent_id=...
 * which returns `<Connect><Stream url="wss://{BRIDGE_URL}/twilio?..." />`.
 *
 * Persists a row in public.calls (as the signed-in user) BEFORE returning,
 * so every Twilio status callback and bridge event can update the row by
 * twilio_call_sid.
 *
 * Required env (set in Lovable admin secrets):
 *   TWILIO_ACCOUNT_SID     – ACxxxxxxxx
 *   TWILIO_AUTH_TOKEN      – 32-char token
 *   TWILIO_FROM_NUMBER     – +15551234567 (Twilio-owned)
 *   PUBLIC_APP_URL         – https://<your-app>.lovable.app (no trailing slash)
 *   BRIDGE_URL             – wss://<bridge-host> (no trailing slash)
 *   BRIDGE_SHARED_SECRET   – auto-generated; shared with the bridge
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { cred } from "@/lib/config/credentials";

const InputSchema = z.object({
  to: z.string().regex(/^\+\d{8,15}$/, "E.164 phone number required"),
  agentId: z.string().min(1),
  campaignId: z.string().uuid().optional(),
  contactId: z.string().uuid().optional(),
});

export const initiateCall = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => InputSchema.parse(data))
  .handler(async ({ data, context }): Promise<{ callSid: string; callId: string }> => {
    const sid = (await cred("TWILIO_ACCOUNT_SID"));
    const token = (await cred("TWILIO_AUTH_TOKEN"));
    const from = (await cred("TWILIO_FROM_NUMBER"));
    const publicUrl = (await cred("PUBLIC_APP_URL"));
    const bridgeUrl = (await cred("BRIDGE_URL"));
    const missing = [
      ["TWILIO_ACCOUNT_SID", sid],
      ["TWILIO_AUTH_TOKEN", token],
      ["TWILIO_FROM_NUMBER", from],
      ["PUBLIC_APP_URL", publicUrl],
      ["BRIDGE_URL", bridgeUrl],
    ]
      .filter(([, v]) => !v)
      .map(([k]) => k);
    if (missing.length) {
      throw new Error(
        `Missing env vars: ${missing.join(", ")} - set them in the admin secrets.`,
      );
    }

    const voiceUrl = new URL(`${publicUrl}/api/public/twilio/voice`);
    voiceUrl.searchParams.set("agent_id", data.agentId);
    const { data: agentBootstrap } = await context.supabase
      .from("agents")
      .select("name,greeting,voice_id,language,tts_engine,speak_first,voice_stability,voice_similarity_boost,voice_style,voice_speaker_boost")
      .eq("id", data.agentId)
      .maybeSingle<{
        name: string | null;
        greeting: string | null;
        voice_id: string | null;
        language: string | null;
        tts_engine: string | null;
        speak_first: boolean | null;
        voice_stability: number | null;
        voice_similarity_boost: number | null;
        voice_style: number | null;
        voice_speaker_boost: boolean | null;
      }>();
    if (agentBootstrap) {
      const toBridgeBootstrapParam = (value: unknown) => {
        const bytes = new TextEncoder().encode(JSON.stringify(value));
        let bin = "";
        for (const byte of bytes) bin += String.fromCharCode(byte);
        return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
      };
      voiceUrl.searchParams.set("b", toBridgeBootstrapParam({
        name: agentBootstrap.name ?? "",
        greeting: (agentBootstrap.greeting ?? "").slice(0, 260),
        voice_id: agentBootstrap.voice_id ?? "af_bella",
        language: agentBootstrap.language ?? "en",
        tts_engine: agentBootstrap.tts_engine ?? "elevenlabs",
        speak_first: agentBootstrap.speak_first ?? true,
        voice_settings: {
          stability: agentBootstrap.voice_stability ?? undefined,
          similarity_boost: agentBootstrap.voice_similarity_boost ?? undefined,
          style: agentBootstrap.voice_style ?? undefined,
          use_speaker_boost: agentBootstrap.voice_speaker_boost ?? undefined,
        },
      }));
    }

    const statusUrl = `${publicUrl}/api/public/webhooks/twilio`;
    const recordingUrl = `${publicUrl}/api/public/webhooks/twilio-recording`;
    const amdUrl = `${publicUrl}/api/public/twilio/amd?agent_id=${encodeURIComponent(data.agentId)}`;
    const body = new URLSearchParams({
      To: data.to,
      From: from!,
      Url: voiceUrl.toString(),
      Method: "POST",
      // Ring timeout - stop ringing an unreachable phone after 30s and
      // report `no-answer` via the status callback so the UI can move on.
      Timeout: "30",
      StatusCallback: statusUrl,
      StatusCallbackMethod: "POST",
      StatusCallbackEvent: "initiated ringing answered completed",
      Record: "true",
      RecordingChannels: "dual",
      RecordingStatusCallback: recordingUrl,
      RecordingStatusCallbackMethod: "POST",
      RecordingStatusCallbackEvent: "completed",
      // MachineDetection=Enable fires the AMD callback as soon as Twilio
      // classifies human vs machine (usually <2s). DetectMessageEnd would
      // wait for the voicemail beep, which is too slow — we want to hang
      // up the moment it's a machine.
      MachineDetection: "Enable",
      AsyncAmd: "true",
      AsyncAmdStatusCallback: amdUrl,
      AsyncAmdStatusCallbackMethod: "POST",
      MachineDetectionTimeout: "10",
      MachineDetectionSpeechThreshold: "1800",
      MachineDetectionSpeechEndThreshold: "800",
      MachineDetectionSilenceTimeout: "3000",
    });

    const basic = btoa(`${sid}:${token}`);
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${basic}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      },
    );
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Twilio ${res.status}: ${txt.slice(0, 300)}`);
    }
    const twilioJson = (await res.json()) as { sid: string };
    const callSid = twilioJson.sid;

    // Persist the call row so status callbacks + bridge events can update it.
    const { data: inserted, error: insErr } = await context.supabase
      .from("calls")
      .insert({
        user_id: context.userId,
        agent_id: data.agentId,
        campaign_id: data.campaignId ?? null,
        contact_id: data.contactId ?? null,
        phone_from: from!,
        phone_to: data.to,
        twilio_call_sid: callSid,
        status: "queued",
      })
      .select("id")
      .single();
    if (insErr) {
      // Don't fail the call - the Twilio dial already succeeded. Log and
      // continue; the row can still be reconciled later via the SID.
      console.error("[initiateCall] calls insert failed:", insErr.message);
      return { callSid, callId: "" };
    }
    return { callSid, callId: inserted.id };
  });
