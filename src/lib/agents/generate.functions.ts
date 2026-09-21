/**
 * Prompt-to-agent generator.
 *
 * Takes a plain-English brief ("I sell solar in Texas, book a rooftop
 * inspection with homeowners") and returns a full AIAgent config the
 * launch wizard hands straight to `addAgent`.
 *
 * Uses the Lovable AI Gateway (OpenAI-compatible) with Gemini 2.5 Flash
 * for speed/cost. No user API key needed.
 */
import { createServerFn } from "@tanstack/react-start";
import { chatCompletion } from "@/lib/ai/llm.server";

export type GeneratedAgent = {
  name: string;
  greeting: string;
  system_prompt: string;
  prompt: string;
  business_knowledge: string;
  personality: string;
  objective: string;
  qualification_questions: string[];
  voicemail_message: string;
  end_call_conditions: string[];
  temperature: number;
  language: string;
  voice_id: string;
  voice_name: string;
  suggested_campaign_name: string;
};

const SYSTEM = `You design AI voice agents that run outbound phone calls.
Given a short business brief, return a complete agent configuration as
strict JSON matching this shape (no extra keys, no prose):

{
  "name": "short human name, e.g. 'Sarah'",
  "greeting": "the first line the agent says (<= 25 words, conversational, mentions the caller's name/company)",
  "system_prompt": "the master instruction the LLM follows on every turn - includes role, tone, boundaries, hard rules; 4-8 sentences",
  "prompt": "the specific objective for THIS call in one sentence",
  "business_knowledge": "concise facts, offering, pricing, differentiators the agent MAY reference; 3-8 bullet-style lines",
  "personality": "3-5 adjectives",
  "objective": "one-line success metric",
  "qualification_questions": ["2-5 short questions the agent asks to qualify"],
  "voicemail_message": "the message to leave if voicemail is detected (<= 30 words)",
  "end_call_conditions": ["3-6 short conditions that mean the call should wrap"],
  "temperature": 0.5,
  "language": "BCP-47 code, default 'en'",
  "voice_id": "one of: af_bella, af_sarah, am_michael, am_adam, bf_emma, bm_george",
  "voice_name": "human label matching the voice_id",
  "suggested_campaign_name": "short campaign title tied to the brief"
}

Rules:
- Never invent capabilities beyond the brief.
- Keep replies punchy: this is a phone call, not an email.
- Pick a female voice for friendly/sales, male for authoritative/technical, matching the brief.
- Temperature: 0.35 for surveys, 0.55 for sales/booking, 0.7 for casual.
- Return ONLY the JSON object.`;

export const generateAgentFromBrief = createServerFn({ method: "POST" })
  .inputValidator(
    (d: { brief: string; audience?: string; goal?: string }) => {
      if (!d?.brief || d.brief.trim().length < 8) {
        throw new Error("Brief is too short - describe what the agent should do.");
      }
      if (d.brief.length > 4000) throw new Error("Brief too long (max 4000 chars).");
      return {
        brief: d.brief.trim(),
        audience: (d.audience ?? "").trim().slice(0, 500),
        goal: (d.goal ?? "").trim().slice(0, 500),
      };
    },
  )
  .handler(async ({ data }) => {
    const userMsg = [
      `Business brief:\n${data.brief}`,
      data.audience ? `Target audience:\n${data.audience}` : null,
      data.goal ? `Call goal:\n${data.goal}` : null,
      `\nReturn strict JSON only.`,
    ]
      .filter(Boolean)
      .join("\n\n");

    const ai = await chatCompletion({
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: userMsg },
      ],
      fallbackModel: "google/gemini-2.5-flash",
      temperature: 0.4,
      json: true,
    });

    if (!ai.ok) {
      if (ai.status === 429) {
        throw new Error("AI is rate-limited - please try again in a moment.");
      }
      if (ai.status === 402) {
        throw new Error(
          "AI credits exhausted. Top up, or add an OpenRouter key in Settings → Credentials.",
        );
      }
      throw new Error(ai.error ?? "AI generation failed");
    }

    const content = ai.content;
    let parsed: GeneratedAgent;
    try {
      parsed = JSON.parse(content);
    } catch {
      // Fall back: try to extract the first {...} block
      const m = content.match(/\{[\s\S]*\}/);
      if (!m) throw new Error("AI returned an unparseable response.");
      parsed = JSON.parse(m[0]);
    }

    // Server-side clamps so the client can trust it.
    return {
      name: str(parsed.name, "AI Agent", 40),
      greeting: str(parsed.greeting, "Hello, do you have a quick moment?", 400),
      system_prompt: str(parsed.system_prompt, "You are a polite outbound agent.", 4000),
      prompt: str(parsed.prompt, "Qualify the prospect.", 800),
      business_knowledge: str(parsed.business_knowledge, "", 2000),
      personality: str(parsed.personality, "Friendly, concise.", 200),
      objective: str(parsed.objective, "Advance the prospect one step.", 200),
      qualification_questions: arr(parsed.qualification_questions, 6, 200),
      voicemail_message: str(parsed.voicemail_message, "", 400),
      end_call_conditions: arr(parsed.end_call_conditions, 8, 200),
      temperature: clamp(parsed.temperature ?? 0.5, 0, 1),
      language: str(parsed.language, "en", 8),
      voice_id: pickVoice(parsed.voice_id),
      voice_name: str(parsed.voice_name, "Bella (American Female, warm)", 80),
      suggested_campaign_name: str(
        parsed.suggested_campaign_name,
        "Outbound Campaign",
        80,
      ),
    } satisfies GeneratedAgent;
  });

function str(v: unknown, fallback: string, max: number): string {
  const s = typeof v === "string" ? v.trim() : "";
  return (s || fallback).slice(0, max);
}
function arr(v: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    .map((x) => x.trim().slice(0, maxLen))
    .slice(0, maxItems);
}
function clamp(n: number, lo: number, hi: number): number {
  if (typeof n !== "number" || Number.isNaN(n)) return (lo + hi) / 2;
  return Math.max(lo, Math.min(hi, n));
}
const VOICES = ["af_bella", "af_sarah", "am_michael", "am_adam", "bf_emma", "bm_george"];
function pickVoice(v: unknown): string {
  return typeof v === "string" && VOICES.includes(v) ? v : "af_bella";
}
