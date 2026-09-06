import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { cred } from "@/lib/config/credentials";

export type ElevenLabsTestResult =
  | {
      ok: true;
      voiceCount: number;
      sampleVoice: { id: string; name: string };
      audioBase64: string;
      mimeType: string;
    }
  | { ok: false; message: string };

export const testElevenLabs = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async (): Promise<ElevenLabsTestResult> => {
    const apiKey = (await cred("ELEVENLABS_API_KEY"));
    if (!apiKey) {
      return { ok: false, message: "ELEVENLABS_API_KEY is not configured on the server." };
    }

    // 1. Validate the key by listing voices
    const voicesRes = await fetch("https://api.elevenlabs.io/v2/voices?page_size=50", {
      method: "GET",
      headers: { "xi-api-key": apiKey },
    });

    if (!voicesRes.ok) {
      const body = await voicesRes.text().catch(() => "");
      if (voicesRes.status === 401) {
        return { ok: false, message: "Invalid ElevenLabs API key (401 unauthorized)." };
      }
      return { ok: false, message: `ElevenLabs voices call failed [${voicesRes.status}]: ${body.slice(0, 200)}` };
    }

    const voicesJson = (await voicesRes.json()) as { voices?: Array<{ voice_id: string; name: string }> };
    const voices = voicesJson.voices ?? [];
    if (voices.length === 0) {
      return { ok: false, message: "API key works but no voices are available on this account." };
    }

    // Prefer well-known "Sarah" if present, else first
    const preferredId = "EXAVITQu4vr4xnSDxMaL";
    const sample = voices.find((v) => v.voice_id === preferredId) ?? voices[0];

    // 2. Run a short TTS sample
    const ttsRes = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${sample.voice_id}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: "ElevenLabs is connected. Your Medical Calling AI voice is ready.",
          model_id: "eleven_multilingual_v2",
        }),
      },
    );

    if (!ttsRes.ok) {
      const body = await ttsRes.text().catch(() => "");
      return { ok: false, message: `TTS sample failed [${ttsRes.status}]: ${body.slice(0, 200)}` };
    }

    const audioBuf = await ttsRes.arrayBuffer();
    const audioBase64 = Buffer.from(audioBuf).toString("base64");

    return {
      ok: true,
      voiceCount: voices.length,
      sampleVoice: { id: sample.voice_id, name: sample.name },
      audioBase64,
      mimeType: "audio/mpeg",
    };
  });
