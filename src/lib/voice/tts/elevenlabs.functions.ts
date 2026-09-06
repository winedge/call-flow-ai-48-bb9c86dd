import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { cred } from "@/lib/config/credentials";

export type ElevenLabsVoice = {
  voice_id: string;
  name: string;
  category?: string;
  labels?: Record<string, string>;
  preview_url?: string;
};

export type ListVoicesResult =
  | { ok: true; voices: ElevenLabsVoice[] }
  | { ok: false; message: string };

export const listElevenLabsVoices = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async (): Promise<ListVoicesResult> => {
    const apiKey = (await cred("ELEVENLABS_API_KEY"));
    if (!apiKey) return { ok: false, message: "ELEVENLABS_API_KEY is not configured." };

    const res = await fetch("https://api.elevenlabs.io/v2/voices?page_size=100", {
      headers: { "xi-api-key": apiKey },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, message: `ElevenLabs voices call failed [${res.status}]: ${body.slice(0, 200)}` };
    }
    const json = (await res.json()) as { voices?: ElevenLabsVoice[] };
    return { ok: true, voices: json.voices ?? [] };
  });

export type PreviewResult =
  | { ok: true; audioBase64: string; mimeType: string }
  | { ok: false; message: string };

export const previewElevenLabsVoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => {
    const i = input as { voiceId?: unknown; text?: unknown };
    if (typeof i.voiceId !== "string" || !i.voiceId) throw new Error("voiceId required");
    const text = typeof i.text === "string" && i.text.trim().length > 0
      ? i.text.slice(0, 400)
      : "Hi, this is a quick voice sample so you can hear how I sound.";
    return { voiceId: i.voiceId, text };
  })
  .handler(async ({ data }): Promise<PreviewResult> => {
    const apiKey = (await cred("ELEVENLABS_API_KEY"));
    if (!apiKey) return { ok: false, message: "ELEVENLABS_API_KEY is not configured." };

    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${data.voiceId}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ text: data.text, model_id: "eleven_multilingual_v2" }),
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, message: `TTS failed [${res.status}]: ${body.slice(0, 200)}` };
    }
    const buf = await res.arrayBuffer();
    return { ok: true, audioBase64: Buffer.from(buf).toString("base64"), mimeType: "audio/mpeg" };
  });
