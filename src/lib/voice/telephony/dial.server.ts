/**
 * Server-only outbound dialer used by the campaign runner cron.
 *
 * Mirrors the user-scoped `initiateCall` server function but authenticates as
 * the campaign's owner via supabaseAdmin so pg_cron / unauthenticated public
 * hooks can trigger outbound calls.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { cred } from "@/lib/config/credentials";

interface DialArgs {
  userId: string;
  agentId: string;
  campaignId: string;
  contactId: string;
  to: string;
  from: string;
}

interface DialResult {
  callSid: string;
  callId: string;
}

export async function dialOutbound(args: DialArgs): Promise<DialResult> {
  const sid = (await cred("TWILIO_ACCOUNT_SID"));
  const token = (await cred("TWILIO_AUTH_TOKEN"));
  const publicUrl = (await cred("PUBLIC_APP_URL"));
  const bridgeUrl = (await cred("BRIDGE_URL"));
  const missing = [
    ["TWILIO_ACCOUNT_SID", sid],
    ["TWILIO_AUTH_TOKEN", token],
    ["PUBLIC_APP_URL", publicUrl],
    ["BRIDGE_URL", bridgeUrl],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    throw new Error(`Missing env vars: ${missing.join(", ")}`);
  }

  const voiceUrl = new URL(`${publicUrl}/api/public/twilio/voice`);
  voiceUrl.searchParams.set("agent_id", args.agentId);

  const { data: agentBootstrap } = await supabaseAdmin
    .from("agents")
    .select(
      "name,greeting,voice_id,language,tts_engine,speak_first,voice_stability,voice_similarity_boost,voice_style,voice_speaker_boost",
    )
    .eq("id", args.agentId)
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
    const encode = (value: unknown) => {
      const bytes = new TextEncoder().encode(JSON.stringify(value));
      let bin = "";
      for (const byte of bytes) bin += String.fromCharCode(byte);
      return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    };
    voiceUrl.searchParams.set(
      "b",
      encode({
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
      }),
    );
  }

  const statusUrl = `${publicUrl}/api/public/webhooks/twilio`;
  const recordingUrl = `${publicUrl}/api/public/webhooks/twilio-recording`;
  const amdUrl = `${publicUrl}/api/public/twilio/amd?agent_id=${encodeURIComponent(args.agentId)}`;
  const body = new URLSearchParams({
    To: args.to,
    From: args.from,
    Url: voiceUrl.toString(),
    Method: "POST",
    // Ring timeout - if the callee's phone is off/unreachable, Twilio will
    // stop ringing after this many seconds and POST a `no-answer` status.
    // Default is 60s; 30s gives a snappier terminal state for the UI.
    Timeout: "30",
    StatusCallback: statusUrl,
    StatusCallbackMethod: "POST",
    StatusCallbackEvent: "initiated ringing answered completed",
    Record: "true",
    RecordingChannels: "dual",
    RecordingStatusCallback: recordingUrl,
    RecordingStatusCallbackMethod: "POST",
    RecordingStatusCallbackEvent: "completed",
    // MachineDetection=Enable fires as soon as Twilio decides human vs
    // machine (usually <2s), instead of waiting for the voicemail beep
    // (DetectMessageEnd). We want to hang up the instant it's a machine.
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

  const { data: inserted, error: insErr } = await supabaseAdmin
    .from("calls")
    .insert({
      user_id: args.userId,
      agent_id: args.agentId,
      campaign_id: args.campaignId,
      contact_id: args.contactId,
      phone_from: args.from,
      phone_to: args.to,
      twilio_call_sid: callSid,
      status: "queued",
    })
    .select("id")
    .single();
  if (insErr) {
    console.error("[dialOutbound] calls insert failed:", insErr.message);
    return { callSid, callId: "" };
  }
  return { callSid, callId: inserted.id };
}
