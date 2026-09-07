/**
 * Signed HTTP client back to the Lovable app.
 *
 * All requests carry `X-Bridge-Timestamp` + `X-Bridge-Signature =
 * HEX(HMAC-SHA256(BRIDGE_SHARED_SECRET, `${ts}.${body}`))`.
 *
 * Env:
 *   LOVABLE_APP_URL       - https://<app>.lovable.app
 *   BRIDGE_SHARED_SECRET  - same value the Lovable app has
 */
import { createHmac } from "node:crypto";

const APP = process.env.LOVABLE_APP_URL!;
const SECRET = process.env.BRIDGE_SHARED_SECRET!;

if (!APP || !SECRET) {
  throw new Error("LOVABLE_APP_URL and BRIDGE_SHARED_SECRET are required");
}

function sign(body: string): { ts: string; sig: string } {
  const ts = Date.now().toString();
  const sig = createHmac("sha256", SECRET).update(`${ts}.${body}`).digest("hex");
  return { ts, sig };
}

async function post<T>(path: string, payload: unknown): Promise<T> {
  const body = JSON.stringify(payload);
  const { ts, sig } = sign(body);
  const res = await fetch(`${APP}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Bridge-Timestamp": ts,
      "X-Bridge-Signature": sig,
    },
    body,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`${path} ${res.status}: ${t.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

async function get<T>(path: string): Promise<T> {
  const url = new URL(path, APP);
  const { ts, sig } = sign(url.pathname + url.search);
  const res = await fetch(url, {
    headers: {
      "X-Bridge-Timestamp": ts,
      "X-Bridge-Signature": sig,
    },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`${path} ${res.status}: ${t.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export type VoiceSettings = {
  stability?: number;
  similarity_boost?: number;
  style?: number;
  use_speaker_boost?: boolean;
};

export type AgentConfig = {
  id: string;
  name: string;
  voice_id: string;
  language: string;
  greeting: string;
  system_prompt: string;
  temperature: number;
  speak_first?: boolean;
  tts_engine?: string;
  voice_settings?: VoiceSettings;
};


export function fetchAgent(id: string): Promise<AgentConfig> {
  return get<AgentConfig>(`/api/public/bridge/agent?id=${encodeURIComponent(id)}`);
}

export function runTurn(
  agent: AgentConfig,
  history: { role: "user" | "assistant"; content: string }[],
  callSid?: string,
): Promise<{ reply: string; end_call: boolean; transfer?: boolean; end_reason?: string }> {
  return post("/api/public/bridge/turn", { agent, history, call_sid: callSid });
}

export function synthTts(
  text: string,
  voice: string,
  language: string,
  engine?: string,
  voiceSettings?: VoiceSettings,
): Promise<{ audio_url: string }> {
  return post("/api/public/bridge/tts", {
    text,
    voice,
    language,
    engine,
    voice_settings: voiceSettings,
  });
}

