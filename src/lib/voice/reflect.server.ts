/**
 * Self-improvement loop with durable, idempotent, retryable jobs.
 *
 * Flow:
 *   1. Deterministically score the call from concrete signals.
 *   2. Upsert a `call_reflections` row keyed by call_id (unique).
 *      - Status starts at `pending`. Reflection NEVER silently no-ops:
 *        every completed call ends up with a row we can see.
 *   3. Ask Gemini to analyze the transcript -> structured lessons.
 *   4. Ask Gemini to fold the lessons into the agent's rolling playbook.
 *   5. On any failure inside 3/4, mark the row `failed` with the error
 *      message and a `next_attempt_at` for the retry cron. `attempts`
 *      is incremented every try. Skipped (nothing to learn) rows are
 *      marked `skipped` so we don't keep retrying.
 *
 * The retry cron endpoint (`/api/public/hooks/retry-reflections`) picks
 * up `pending`/`failed` rows whose `next_attempt_at` has passed and
 * re-invokes this function.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const MODEL = "google/gemini-3.5-flash";
const GATEWAY = "https://ai.gateway.lovable.dev/v1/chat/completions";
const PLAYBOOK_MAX_CHARS = 3500;

export const MAX_ATTEMPTS = 5;
// Exponential backoff schedule (seconds): 30s, 2m, 10m, 45m, 3h.
const BACKOFF_SECONDS = [30, 120, 600, 2700, 10800];

type Transcript = { speaker: "ai" | "human"; text: string; at?: number }[];

type ReflectInput = {
  callId: string;
};

type CallRow = {
  id: string;
  user_id: string;
  agent_id: string | null;
  status: string;
  duration_sec: number | null;
  transcript: unknown;
  extracted_data: Record<string, unknown> | null;
  end_reason: string | null;
  sentiment: string | null;
  appointment_booked: boolean | null;
  outcome: string | null;
};

type AgentRow = {
  id: string;
  name: string | null;
  objective: string | null;
  system_prompt: string | null;
  data_fields: unknown;
  playbook: string | null;
  playbook_calls_analyzed: number | null;
};

type Reflection = {
  what_worked: string[];
  what_failed: string[];
  objections: string[];
  key_learnings: string[];
  summary: string;
  sentiment: "positive" | "neutral" | "negative";
};

type ReflectionRow = {
  id: string;
  attempts: number;
  status: string;
};

// ---------------------------------------------------------------------------

function normalizeTranscript(v: unknown): Transcript {
  if (!Array.isArray(v)) return [];
  return v.flatMap((t): Transcript => {
    if (!t || typeof t !== "object") return [];
    const o = t as Record<string, unknown>;
    // Support both {speaker, text} and {role, content} shapes.
    let speaker: "ai" | "human" | null = null;
    if (o.speaker === "ai" || o.speaker === "human") {
      speaker = o.speaker;
    } else if (o.role === "assistant" || o.role === "ai") {
      speaker = "ai";
    } else if (o.role === "user" || o.role === "human" || o.role === "caller") {
      speaker = "human";
    }
    const text =
      typeof o.text === "string" ? o.text : typeof o.content === "string" ? o.content : "";
    if (!speaker || !text) return [];
    return [{ speaker, text }];
  });
}

function computeSuccess(call: CallRow, agent: AgentRow): { score: number; label: string } {
  let s = 0;
  const fields = Array.isArray(agent.data_fields) ? (agent.data_fields as { key: string; required?: boolean }[]) : [];
  const required = fields.filter((f) => f.required !== false);
  if (required.length > 0 && call.extracted_data) {
    const filled = required.filter((f) => {
      const v = call.extracted_data![f.key];
      if (v === null || v === undefined) return false;
      if (typeof v === "string") return v.trim().length > 0;
      return true;
    }).length;
    s += Math.round((filled / required.length) * 45);
  } else if (call.extracted_data) {
    const entries = Object.entries(call.extracted_data);
    const filled = entries.filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== "").length;
    if (entries.length > 0) s += Math.round((filled / entries.length) * 25);
  }
  const turns = normalizeTranscript(call.transcript).length;
  if (turns >= 6) s += 6;
  if (turns >= 14) s += 8;
  if (turns >= 24) s += 6;
  if ((call.duration_sec ?? 0) >= 60) s += 3;
  if ((call.duration_sec ?? 0) >= 180) s += 2;
  const reason = (call.end_reason || "").toLowerCase();
  if (reason === "agent_ended") s += 12;
  else if (reason === "caller_hangup" && turns < 6) s -= 20;
  else if (["no_answer", "voicemail", "busy", "failed"].includes(reason)) s -= 15;
  if (call.appointment_booked) s += 10;
  if (call.sentiment === "positive") s += 5;
  if (call.sentiment === "negative") s -= 8;
  const score = Math.max(0, Math.min(100, s));
  const label = score >= 70 ? "success" : score >= 40 ? "partial" : "failure";
  return { score, label };
}

async function callGeminiJSON<T>(system: string, user: string): Promise<T> {
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey) throw new Error("LOVABLE_API_KEY missing");
  const res = await fetch(GATEWAY, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Lovable-API-Key": apiKey },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`gateway ${res.status}: ${body.slice(0, 300)}`);
  }
  const p = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = p.choices?.[0]?.message?.content ?? "";
  return JSON.parse(text) as T;
}

async function callGeminiText(system: string, user: string): Promise<string> {
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey) throw new Error("LOVABLE_API_KEY missing");
  const res = await fetch(GATEWAY, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Lovable-API-Key": apiKey },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`gateway ${res.status}: ${body.slice(0, 300)}`);
  }
  const p = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const out = p.choices?.[0]?.message?.content?.trim() ?? "";
  if (!out) throw new Error("empty completion");
  return out;
}

function toStringArray(v: unknown, cap = 6): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    .map((x) => x.trim())
    .slice(0, cap);
}

function backoffFor(attempts: number): string {
  const idx = Math.min(attempts, BACKOFF_SECONDS.length - 1);
  return new Date(Date.now() + BACKOFF_SECONDS[idx] * 1000).toISOString();
}

/**
 * Insert-or-fetch a reflection row keyed by call_id. Idempotent across
 * concurrent invocations because call_id is unique.
 */
async function ensureReflectionRow(call: CallRow): Promise<ReflectionRow | null> {
  const { data: existing } = await supabaseAdmin
    .from("call_reflections")
    .select("id, attempts, status")
    .eq("call_id", call.id)
    .maybeSingle<ReflectionRow>();
  if (existing) return existing;

  const { data: inserted, error } = await supabaseAdmin
    .from("call_reflections")
    .insert({
      user_id: call.user_id,
      agent_id: call.agent_id,
      call_id: call.id,
      status: "pending",
      attempts: 0,
    } as never)
    .select("id, attempts, status")
    .maybeSingle<ReflectionRow>();

  if (error) {
    // Unique-violation race: another worker inserted first. Read it back.
    const { data: race } = await supabaseAdmin
      .from("call_reflections")
      .select("id, attempts, status")
      .eq("call_id", call.id)
      .maybeSingle<ReflectionRow>();
    return race ?? null;
  }
  return inserted;
}

async function markFailed(rowId: string, attempts: number, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const nextAttempts = attempts + 1;
  const done = nextAttempts >= MAX_ATTEMPTS;
  await supabaseAdmin
    .from("call_reflections")
    .update({
      status: "failed",
      attempts: nextAttempts,
      last_error: message.slice(0, 1000),
      next_attempt_at: done ? null : backoffFor(nextAttempts - 1),
    } as never)
    .eq("id", rowId);
  console.error(
    `[reflect] attempt ${nextAttempts}/${MAX_ATTEMPTS} failed:`,
    message,
    done ? "(exhausted)" : "(will retry)",
  );
}

async function markSkipped(rowId: string, reason: string) {
  await supabaseAdmin
    .from("call_reflections")
    .update({
      status: "skipped",
      last_error: reason,
      next_attempt_at: null,
    } as never)
    .eq("id", rowId);
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function reflectOnCall({ callId }: ReflectInput): Promise<void> {
  const { data: callRaw, error: callErr } = await supabaseAdmin
    .from("calls")
    .select(
      "id, user_id, agent_id, status, duration_sec, transcript, extracted_data, end_reason, sentiment, appointment_booked, outcome",
    )
    .eq("id", callId)
    .maybeSingle();
  if (callErr || !callRaw) {
    console.warn("[reflect] call not found", callId, callErr?.message);
    return;
  }
  const call = callRaw as unknown as CallRow;
  if (!call.agent_id || call.status !== "completed") return;

  // Learning loop is opt-in per workspace (Settings → Workspace defaults).
  if (!(await isLearningEnabled(call.user_id))) return;


  const row = await ensureReflectionRow(call);
  if (!row) {
    console.error("[reflect] could not create reflection row for", callId);
    return;
  }
  if (row.status === "success" || row.status === "skipped") return;
  if (row.attempts >= MAX_ATTEMPTS) return;

  const transcript = normalizeTranscript(call.transcript);
  if (transcript.length < 3) {
    await markSkipped(row.id, "transcript too short");
    return;
  }

  try {
    const { data: agentRaw, error: agentErr } = await supabaseAdmin
      .from("agents")
      .select("id, name, objective, system_prompt, data_fields, playbook, playbook_calls_analyzed")
      .eq("id", call.agent_id)
      .maybeSingle();
    if (agentErr) throw new Error(`agent read: ${agentErr.message}`);
    if (!agentRaw) throw new Error("agent not found");
    const agent = agentRaw as unknown as AgentRow;

    const { score, label } = computeSuccess(call, agent);

    const dialogue = transcript
      .map((t) => `${t.speaker === "ai" ? "Agent" : "Caller"}: ${t.text}`)
      .join("\n");

    const requiredFields = Array.isArray(agent.data_fields)
      ? (agent.data_fields as { key: string; label?: string; required?: boolean }[])
          .filter((f) => f.required !== false)
          .map((f) => f.label || f.key)
      : [];

    const extractedSummary = call.extracted_data
      ? Object.entries(call.extracted_data)
          .map(([k, v]) => `${k}=${v === null || v === undefined ? "(missing)" : v}`)
          .join(", ")
      : "(none)";

    // ---- 1. Structured reflection -----------------------------------------

    const reflectionSystem = [
      "You are a sales-coaching analyst. Given ONE phone-call transcript plus its outcome, return JSON with concrete, agent-actionable lessons.",
      "Return ONLY this JSON shape:",
      `{
  "what_worked": string[],
  "what_failed": string[],
  "objections": string[],
  "key_learnings": string[],
  "summary": string,
  "sentiment": "positive" | "neutral" | "negative"
}`,
      "Rules: be specific (quote or paraphrase the moment), name techniques not vibes, no praise-only fluff, no generic advice. If nothing failed / no objections, return empty arrays.",
      "Sentiment reflects the CALLER's overall tone toward the offer/agent: positive = interested/agreed/booked, neutral = polite but non-committal or short call, negative = annoyed/refused/hostile/voicemail-only.",
    ].join("\n\n");

    const reflectionUser = [
      `Agent name: ${agent.name || "(unnamed)"}`,
      agent.objective ? `Agent objective: ${agent.objective}` : "",
      requiredFields.length ? `Required fields to collect: ${requiredFields.join(", ")}` : "",
      `Call score: ${score}/100 (${label})`,
      `Duration: ${call.duration_sec ?? 0}s, End reason: ${call.end_reason ?? "unknown"}, Sentiment: ${call.sentiment ?? "unknown"}`,
      `Extracted data: ${extractedSummary}`,
      "",
      "Transcript:",
      dialogue,
    ]
      .filter(Boolean)
      .join("\n");

    const reflection = await callGeminiJSON<Reflection>(reflectionSystem, reflectionUser);

    const rawSentiment = typeof reflection.sentiment === "string" ? reflection.sentiment.toLowerCase().trim() : "";
    const sentiment: "positive" | "neutral" | "negative" =
      rawSentiment === "positive" || rawSentiment === "negative" ? rawSentiment : "neutral";

    const cleaned: Reflection = {
      what_worked: toStringArray(reflection.what_worked),
      what_failed: toStringArray(reflection.what_failed),
      objections: toStringArray(reflection.objections),
      key_learnings: toStringArray(reflection.key_learnings, 3),
      summary: typeof reflection.summary === "string" ? reflection.summary.slice(0, 500) : "",
      sentiment,
    };

    // Persist sentiment on the call row so list/detail views can display it.
    const { error: sentErr } = await supabaseAdmin
      .from("calls")
      .update({ sentiment } as never)
      .eq("id", call.id);
    if (sentErr) console.warn("[reflect] sentiment update failed", sentErr.message);

    // ---- 2. Playbook update -----------------------------------------------

    const hasSignal =
      cleaned.key_learnings.length > 0 ||
      cleaned.what_failed.length > 0 ||
      cleaned.what_worked.length > 0;

    let playbookUpdated = false;
    if (hasSignal) {
      const currentPlaybook = (agent.playbook ?? "").trim();
      const playbookSystem = [
        "You maintain a rolling PLAYBOOK for a voice AI sales/qualification agent.",
        "The playbook is compact markdown (headings + bullets) that will be pasted directly into the agent's system prompt on every future call.",
        "Your job: take the CURRENT playbook and the LATEST call's learnings, and return the UPDATED playbook.",
        "",
        "Hard rules:",
        "- Keep it under ~" + PLAYBOOK_MAX_CHARS + " characters. Prune ruthlessly - if two bullets say the same thing, keep the sharper one.",
        "- Sections MUST be exactly (in this order): `## What works`, `## What to avoid`, `## Objection playbook`, `## Style guardrails`. Omit a section only if truly empty.",
        "- Bullets are imperative, concrete, and phone-call-specific.",
        "- Reinforce items that show up repeatedly across calls; drop items contradicted by newer high-score calls.",
        "- Never add legal, compliance, or safety loosening. Never add scripted lies.",
        "- Return ONLY the updated markdown playbook. No preface, no code fences, no commentary.",
      ].join("\n");

      const playbookUser = [
        `Agent: ${agent.name || "(unnamed)"} - objective: ${agent.objective || "(none)"}`,
        `Calls analyzed so far: ${(agent.playbook_calls_analyzed ?? 0) + 1}`,
        "",
        "=== CURRENT PLAYBOOK ===",
        currentPlaybook || "(empty - this is the first call)",
        "",
        "=== LATEST CALL ===",
        `Score: ${score}/100 (${label})`,
        `Summary: ${cleaned.summary || "(none)"}`,
        `What worked: ${cleaned.what_worked.join(" | ") || "(none)"}`,
        `What failed: ${cleaned.what_failed.join(" | ") || "(none)"}`,
        `Objections: ${cleaned.objections.join(" | ") || "(none)"}`,
        `Key learnings: ${cleaned.key_learnings.join(" | ") || "(none)"}`,
      ].join("\n");

      const updated = await callGeminiText(playbookSystem, playbookUser);
      const trimmed = updated
        .replace(/^```(?:markdown|md)?\n?|```$/g, "")
        .trim()
        .slice(0, PLAYBOOK_MAX_CHARS);
      if (trimmed) {
        const { error: updErr } = await supabaseAdmin
          .from("agents")
          .update({
            playbook: trimmed,
            playbook_calls_analyzed: (agent.playbook_calls_analyzed ?? 0) + 1,
            playbook_updated_at: new Date().toISOString(),
          } as never)
          .eq("id", agent.id);
        if (updErr) throw new Error(`playbook update: ${updErr.message}`);
        playbookUpdated = true;
      }
    }

    // ---- 3. Persist success -----------------------------------------------

    const { error: saveErr } = await supabaseAdmin
      .from("call_reflections")
      .update({
        status: "success",
        attempts: row.attempts + 1,
        success_score: score,
        success_label: label,
        what_worked: cleaned.what_worked,
        what_failed: cleaned.what_failed,
        objections: cleaned.objections,
        key_learnings: cleaned.key_learnings,
        summary: cleaned.summary,
        last_error: null,
        next_attempt_at: null,
      } as never)
      .eq("id", row.id);
    if (saveErr) throw new Error(`reflection save: ${saveErr.message}`);

    console.log(
      `[reflect] ok call=${callId} score=${score} playbook=${playbookUpdated ? "updated" : "unchanged"}`,
    );
  } catch (e) {
    await markFailed(row.id, row.attempts, e);
  }
}

/**
 * Retry pass invoked by the cron endpoint. Picks up rows in `pending` or
 * `failed` whose next_attempt_at has elapsed (or is null for a fresh row).
 */
export async function retryStalledReflections(limit = 20): Promise<{
  picked: number;
  finished: number;
}> {
  const nowIso = new Date().toISOString();
  const { data: rows, error } = await supabaseAdmin
    .from("call_reflections")
    .select("id, call_id, attempts, status, next_attempt_at, created_at")
    .in("status", ["pending", "failed"])
    .lt("attempts", MAX_ATTEMPTS)
    .or(`next_attempt_at.is.null,next_attempt_at.lte.${nowIso}`)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) {
    console.error("[reflect.retry] query failed", error.message);
    return { picked: 0, finished: 0 };
  }
  const list = (rows ?? []) as { id: string; call_id: string }[];
  let finished = 0;
  for (const r of list) {
    try {
      await reflectOnCall({ callId: r.call_id });
      finished++;
    } catch (e) {
      console.error("[reflect.retry] iteration failed", r.call_id, e);
    }
  }
  return { picked: list.length, finished };
}
