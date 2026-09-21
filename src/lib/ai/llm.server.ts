/**
 * Chat-completion resolver.
 *
 * If OPENROUTER_API_KEY is configured (Settings → Credentials, or the server
 * environment) all LLM traffic goes to OpenRouter using OPENROUTER_MODEL.
 * Otherwise the Lovable AI Gateway is used with its default model.
 *
 * Server-side only.
 */
import { creds } from "@/lib/config/credentials";

const LOVABLE_GATEWAY = "https://ai.gateway.lovable.dev/v1/chat/completions";
const OPENROUTER_GATEWAY = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_OPENROUTER_MODEL = "google/gemini-2.5-flash";

export type ChatMessage = { role: string; content: string };

export type ChatRequest = {
  messages: ChatMessage[];
  /** Model used when falling back to the Lovable AI Gateway. */
  fallbackModel: string;
  temperature?: number;
  max_tokens?: number;
  json?: boolean;
};

export type ChatResult = {
  ok: boolean;
  status: number;
  provider: "openrouter" | "lovable";
  content: string;
  error?: string;
};

export async function chatCompletion(req: ChatRequest): Promise<ChatResult> {
  const { OPENROUTER_API_KEY, OPENROUTER_MODEL } = await creds(
    "OPENROUTER_API_KEY",
    "OPENROUTER_MODEL",
  );

  const useOpenRouter = Boolean(OPENROUTER_API_KEY);
  const provider: "openrouter" | "lovable" = useOpenRouter ? "openrouter" : "lovable";

  let url = LOVABLE_GATEWAY;
  let headers: Record<string, string> = { "Content-Type": "application/json" };
  let model = req.fallbackModel;

  if (useOpenRouter) {
    url = OPENROUTER_GATEWAY;
    model = OPENROUTER_MODEL?.trim() || DEFAULT_OPENROUTER_MODEL;
    headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
    };
  } else {
    const key = process.env.LOVABLE_API_KEY;
    if (!key) {
      return {
        ok: false,
        status: 500,
        provider,
        content: "",
        error: "No AI provider configured — add an OpenRouter API key in Settings → Credentials.",
      };
    }
    headers["Lovable-API-Key"] = key;
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: req.messages,
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.max_tokens !== undefined ? { max_tokens: req.max_tokens } : {}),
        ...(req.json ? { response_format: { type: "json_object" } } : {}),
      }),
    });
  } catch (e) {
    return {
      ok: false,
      status: 502,
      provider,
      content: "",
      error: e instanceof Error ? e.message : "network error",
    };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return {
      ok: false,
      status: res.status,
      provider,
      content: "",
      error: `${provider} ${res.status}: ${body.slice(0, 300)}`,
    };
  }

  const payload = (await res.json().catch(() => ({}))) as {
    choices?: { message?: { content?: string } }[];
  };
  return {
    ok: true,
    status: res.status,
    provider,
    content: payload.choices?.[0]?.message?.content?.trim() ?? "",
  };
}
