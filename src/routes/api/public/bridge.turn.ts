/**
 * Bridge → Lovable: run one LLM turn for a call.
 *
 * Body: { agent: AgentSummary, history: {role:"user"|"assistant",content:string}[] }
 * Returns: { reply: string, end_call: boolean, transfer: boolean }
 *
 * Control tokens the model may prepend to the reply:
 *   [END_CALL]  - hang up after speaking `reply`
 *   [TRANSFER]  - warm-transfer to agent.transfer_number after speaking `reply`
 *
 * Uses the Lovable AI Gateway (Gemini 3 Flash). Keeps LOVABLE_API_KEY server-side.
 * Auth: HMAC via BRIDGE_SHARED_SECRET (see bridge-auth.ts).
 */
import { createFileRoute } from "@tanstack/react-router";

import { chatCompletion } from "@/lib/ai/llm.server";
import { verifyBridge } from "@/lib/voice/bridge-auth";
import { errorJson, json, preflight } from "@/lib/api/cors";

const MODEL = "google/gemini-3.5-flash";

type DataField = { key: string; label: string; type?: string; required?: boolean };

type AgentSummary = {
  name?: string;
  greeting?: string;
  system_prompt?: string;
  prompt?: string;
  business_knowledge?: string;
  personality?: string;
  temperature?: number;
  objective?: string;
  qualification_questions?: string[];
  end_call_conditions?: string[];
  transfer_number?: string;
  data_fields?: DataField[];
  playbook?: string;
};

type Turn = { role: "user" | "assistant"; content: string };

function normalizeVoicemailText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isVoicemailSystemText(value: string): boolean {
  const text = normalizeVoicemailText(value);
  if (!text) return false;
  return (
    /\b(?:to|you(?:'re| are)? (?:being )?(?:forwarded|sent|redirected))\s+(?:voice\s*mail|voicemail)\b/.test(text) ||
    /\b(?:voice\s*mail|voicemail)\s+(?:box|system|message|greeting)\b/.test(text) ||
    /\b(?:the person|the subscriber|the customer|your party|the party|the number|the wireless customer)\b.{0,80}\b(?:not available|unavailable|cannot be reached|is not accepting calls)\b/.test(text) ||
    /\b(?:at|after)\s+the\s+tone\b/.test(text) ||
    /\b(?:please|kindly)?\s*(?:record|leave)\s+(?:your\s+)?(?:message|name and number)\b/.test(text) ||
    /\b(?:leave|record)\s+(?:a\s+)?message\s+(?:after|at)\s+the\s+(?:tone|beep)\b/.test(text) ||
    /\bwhen\s+you\s+are\s+finished\b.{0,80}\b(?:hang up|press|disconnect)\b/.test(text)
  );
}

function historyHasVoicemailSystem(history: Turn[]): boolean {
  return history.some((turn) => turn.role === "user" && isVoicemailSystemText(turn.content));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeName(value: string | undefined): string {
  return (value ?? "")
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{M}\s.'-]/gu, "")
    .trim();
}

function callerExplicitlyGaveName(history: Turn[], agentName: string): boolean {
  if (!agentName) return false;
  const escaped = escapeRegex(agentName);
  const explicitNamePatterns = [
    new RegExp(`\\b(?:my name is|this is|i am|i'm|im|it's|its)\\s+${escaped}\\b`, "i"),
    new RegExp(`\\b(?:call me|you can call me)\\s+${escaped}\\b`, "i"),
  ];
  return history
    .filter((turn) => turn.role === "user")
    .some((turn) => explicitNamePatterns.some((pattern) => pattern.test(turn.content)));
}

// Deterministic pre-TTS post-processor: strip any assistant identity token
// from a customer-name (vocative) position in the reply. Runs unconditionally
// on every generated reply before it is handed to the TTS layer, so the
// caller never hears their name replaced by the agent's own name.
//
// "Customer-name position" = any vocative use of a token: comma-adjacent
// address ("..., Sarah, ..."), sentence-initial or sentence-final direct
// address ("Sarah, got it." / "Got it, Sarah."), or a name tacked onto a
// short acknowledgement ("thanks Sarah", "great Sarah!"). We remove those
// occurrences regardless of surrounding text. Non-vocative mentions
// (e.g. "This is Sarah from Acme") are left intact.
function stripIdentityTokenFromNamePosition(reply: string, token: string): string {
  const name = normalizeName(token);
  if (!name) return reply;
  const escaped = escapeRegex(name);

  // Acknowledgement/greeting words that commonly precede a vocative name.
  const ackWords =
    "hi|hello|hey|thanks|thank you|great|okay|ok|got it|sure|perfect|alright|" +
    "understood|noted|awesome|nice|good|excellent|wonderful|absolutely|" +
    "of course|no problem|welcome|glad to hear that|good to hear|nice to hear|" +
    "happy to hear|sounds good|will do";

  let cleaned = reply
    // "<ack>[,] <Name>[!.?]"  → "<ack><punct>"
    .replace(
      new RegExp(`\\b(${ackWords}),?\\s+${escaped}\\b(\\s*[!.?,])?`, "gi"),
      (_m, phrase: string, punct: string | undefined) => `${phrase}${punct ?? ""}`,
    )
    // Sentence-initial "Name, ..."  → "..."
    .replace(new RegExp(`(^|[.!?]\\s+)${escaped}\\s*[,!?-]+\\s*`, "gi"), "$1")
    // Mid/end vocative ", Name" before punctuation or end of string.
    .replace(new RegExp(`\\s*,\\s*${escaped}(?=\\s*[.!?,]|$)`, "gi"), "")
    // Standalone trailing "... Name!" / "... Name?" / "... Name."
    .replace(new RegExp(`\\s+${escaped}\\s*([!?])`, "g"), "$1")
    // Clean up doubled spaces / stranded punctuation created by removals.
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/([,;:])\1+/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();

  return cleaned || reply;
}

// Strip hallucinated "name coincidence" claims: any sentence in which the
// assistant asserts that the caller's name matches its own (e.g. "my name
// is Sarah too", "I'm Sarah as well", "what a coincidence, we have the
// same name", "we're both Sarah"). These arise when the model mirrors
// filler words like "too/also" from the caller and treats them as a name
// claim. Removing the whole sentence is safe - the assistant already
// introduced itself in the greeting and never needs to restate its name.
function stripNameCoincidenceClaims(reply: string, agentName: string | undefined): string {
  const name = normalizeName(agentName);
  if (!name) return reply;
  const escaped = escapeRegex(name);

  const nameClaim = new RegExp(
    `\\b(?:my name is|i(?:'m| am)|it'?s|this is|call me)\\s+${escaped}\\b\\s*(?:too|also|as well|either)?`,
    "i",
  );
  const coincidence = new RegExp(
    `\\b(?:what a coincidence|same name|(?:we(?:'re| are)|we both are)\\s+both\\s+${escaped}|we have the same name)\\b`,
    "i",
  );

  // Split into sentences, drop any that make a name-coincidence claim.
  const sentences = reply.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [reply];
  const kept = sentences.filter((s) => !nameClaim.test(s) && !coincidence.test(s));
  const cleaned = kept.join(" ").replace(/\s{2,}/g, " ").trim();
  return cleaned || reply;
}

function stripAgentNameAsCaller(reply: string, agentName: string | undefined, history: Turn[]): string {
  const name = normalizeName(agentName);
  if (!name) return reply;
  // Always strip name-coincidence claims - the caller saying "too" is filler,
  // not a name reveal, and the assistant must never claim their names match.
  let out = stripNameCoincidenceClaims(reply, name);
  // If the caller explicitly gave the same name as their own, leave vocatives alone.
  if (callerExplicitlyGaveName(history, name)) return out;
  return stripIdentityTokenFromNamePosition(out, name);
}

function latestUserTurn(history: Turn[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "user") return history[i].content;
  }
  return "";
}

function latestAssistantTurn(history: Turn[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "assistant") return history[i].content;
  }
  return "";
}

function userAskedQuestion(history: Turn[]): boolean {
  const text = latestUserTurn(history).trim();
  return /\?|\b(?:what|why|how|when|where|who|which|can you|could you|would you|do you|are you|is it|tell me)\b/i.test(text);
}

function userTurnCount(history: Turn[]): number {
  return history.filter((turn) => turn.role === "user").length;
}

function stripUnpromptedSelfAnswer(reply: string, history: Turn[]): string {
  if (userAskedQuestion(history)) return reply;
  const cleaned = reply
    .replace(/\b(?:i(?:'m| am) doing (?:well|good|fine)|i(?:'m| am) (?:well|good|fine)),?\s*(?:thank you|thanks)(?: for asking)?[.!?]?\s*/gi, "")
    .replace(/\b(?:thank you|thanks) for asking[.!?]?\s*/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return cleaned || reply;
}

function callerShowsBookingIntent(history: Turn[]): boolean {
  // Only the caller can create booking/contact-collection intent. Assistant
  // words like "demo" or "schedule" must never self-authorize collecting
  // name/phone at the beginning of a call.
  const userDialogue = history
    .filter((turn) => turn.role === "user")
    .map((turn) => turn.content)
    .join("\n");
  if (/\b(?:book|schedule|set up|demo|appointment|meeting|calendar|call me back|follow up|send me|sign me up|interested|let'?s do it|that works|sounds good)\b/i.test(userDialogue)) {
    return true;
  }

  const user = latestUserTurn(history);
  const assistant = latestAssistantTurn(history);
  return /\b(?:yes|yeah|yep|sure|okay|ok|please|sounds good|that works|let'?s do it)\b/i.test(user)
    && /\b(?:book|schedule|demo|appointment|meeting|calendar|follow up|send you|reach you|contact you)\b/i.test(assistant);
}

function asksForPersonalContactDetail(reply: string): boolean {
  const asksBusinessName = /\b(?:business|company|organization|practice)\s+name\b|\bname of (?:your|the) (?:business|company|organization|practice)\b/i.test(reply);
  const asksName = /\b(?:what(?:'s| is)|may i have|can i (?:get|have)|could i (?:get|have)|please (?:tell me|share|provide)|tell me|confirm)\b[^.!?]{0,100}\b(?:your full name|your name|full name|name)\b/i.test(reply)
    || /\b(?:your full name|full name)\b/i.test(reply);
  const asksContact = /\b(?:what(?:'s| is)|may i have|can i (?:get|have)|could i (?:get|have)|please (?:tell me|share|provide)|tell me|confirm)\b[^.!?]{0,100}\b(?:phone|mobile|cell|number|email|e-mail|best number|best phone)\b/i.test(reply)
    || /\b(?:phone number|mobile number|cell number|best number|best phone|email address|e-mail address)\b/i.test(reply)
    || /\b(?:reach|contact|call|text|send)\s+you\s+(?:at|on|by)\b/i.test(reply)
    || /\bwhere should i send\b/i.test(reply);
  return (asksName && !asksBusinessName) || asksContact;
}

function asksForContactField(reply: string, fields: DataField[]): boolean {
  if (!fields.length) return false;
  const lower = reply.toLowerCase();

  const asksForName = /\b(?:what(?:'s| is)|may i have|can i (?:get|have)|could i (?:get|have)|please (?:tell me|share|provide)|tell me|confirm)\b[^.!?]{0,80}\b(?:your full name|your name|full name|who (?:am i|is this)|who (?:am i|are we) speaking with|what should i call you)\b/i.test(reply)
    || /\b(?:your full name|full name)\b/i.test(reply)
    || /\b(?:name)\b[^.!?]{0,40}\b(?:reach you|contact you|book|appointment|demo)\b/i.test(reply);
  const asksForBusinessName = /\b(?:business|company|organization|practice)\s+name\b|\bname of (?:your|the) (?:business|company|organization|practice)\b/i.test(reply);
  const asksForPhone = /\b(?:phone|mobile|cell|contact)\s+(?:number|info|information)\b|\bbest\s+(?:number|phone)\b|\bnumber\s+to\s+(?:reach|contact|call)\s+you\b|\breach you at\b|\bcall you at\b/i.test(reply);
  const asksForEmail = /\b(?:email|e-mail)\b|\bwhere should i send\b/i.test(reply);

  const fieldLabels = fields
    .filter((field) => {
      const label = `${field.key} ${field.label} ${field.type ?? ""}`.toLowerCase();
      return /\b(name|phone|mobile|cell|email|e-mail|contact)\b/.test(label);
    })
    .some((field) => {
      const label = escapeRegex(field.label.toLowerCase()).replace(/\s+/g, "\\s+");
      return new RegExp(`\\b${label}\\b`).test(lower);
    });

  return ((asksForName && !asksForBusinessName) || asksForPhone || asksForEmail || fieldLabels);
}

function extractDiscoveryQuestion(systemPrompt: string | undefined): string | null {
  if (!systemPrompt) return null;
  const lines = systemPrompt.split(/\r?\n/);
  let inDiscovery = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^#{1,6}\s+/.test(line)) inDiscovery = /discovery|qualif/i.test(line);
    if (!inDiscovery) continue;
    const match = line.match(/^-\s*(.+\?)\s*$/);
    if (match?.[1] && !/\b(?:name|phone|mobile|cell|email|e-mail|number)\b/i.test(match[1])) {
      return match[1].trim();
    }
  }
  return null;
}

function earlyConversationFallback(a: AgentSummary): string {
  const discovery = extractDiscoveryQuestion(a.system_prompt);
  if (discovery) return `Glad to hear that. ${discovery}`;
  if (/\b(?:call|calling|sales|demo|appointment|lead|customer|prospect)\b/i.test(`${a.objective ?? ""} ${a.system_prompt ?? ""}`)) {
    return "Glad to hear that. How are you currently handling customer calls right now?";
  }
  return "Glad to hear that. What would be most helpful to talk through first?";
}

function callerProvidedAnyInfo(history: Turn[]): boolean {
  const userDialogue = history.filter((t) => t.role === "user").map((t) => t.content).join("\n");
  if (/\b(?:my name is|this is|i(?:'m| am)|call me)\s+[A-Z][A-Za-z'.\- ]{1,40}/i.test(userDialogue)) return true;
  if (/\b\d[\d\s\-().]{6,}\b/.test(userDialogue)) return true;
  if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(userDialogue)) return true;
  return false;
}

function preventPrematureContactCollection(reply: string, a: AgentSummary, history: Turn[]): string {
  const fields = a.data_fields ?? [];
  const hasRequiredFields = fields.some((f) => f.required !== false);
  // If the agent is configured with required data fields, collecting them IS
  // the objective - do not rewrite the reply.
  if (hasRequiredFields) return reply;
  const contactAsk = asksForPersonalContactDetail(reply) || asksForContactField(reply, fields);
  if (!contactAsk) return reply;
  // Only guard the very first user turn. After that, trust the model -
  // the caller is engaged and the conversation is moving forward.
  if (userTurnCount(history) > 1) return reply;
  if (callerShowsBookingIntent(history)) return reply;
  if (callerProvidedAnyInfo(history)) return reply;
  console.info("bridge prevented premature contact collection", {
    agentName: a.name ?? null,
    userTurns: userTurnCount(history),
  });
  return earlyConversationFallback(a);
}


function describeField(f: DataField): string {
  const req = f.required ? " (required)" : "";
  const hint =
    f.type === "phone" ? " - collect the full phone number with country/area code, then confirm it slowly in 3-4 digit groups"
    : f.type === "email" ? " - spell it back to confirm"
    : "";
  return `${f.label} [${f.key}]${req}${hint}`;
}

// ---------- Conversation state machine ----------

type ConvState = "GREETING" | "INTRO" | "DISCOVERY" | "COLLECTING" | "CONFIRMING" | "CLOSING";

type CollectedField = { field: DataField; value: string };

function fieldSemantic(f: DataField): "name" | "phone" | "email" | "other" {
  if (f.type === "phone") return "phone";
  if (f.type === "email") return "email";
  const label = `${f.key} ${f.label}`.toLowerCase();
  if (/\b(phone|mobile|cell|number|contact number)\b/.test(label)) return "phone";
  if (/\b(email|e-mail)\b/.test(label)) return "email";
  if (/\bname\b/.test(label) && !/\b(business|company|organization|practice)\b/.test(label)) return "name";
  return "other";
}

function extractPhone(text: string): string | null {
  const m = text.match(/(?:\+?\d[\s\-().]*){7,}/);
  if (!m) return null;
  const digits = m[0].replace(/\D/g, "");
  return digits.length >= 7 ? digits : null;
}

function extractEmail(text: string): string | null {
  const m = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  return m ? m[0] : null;
}

function extractName(text: string): string | null {
  const m = text.match(/\b(?:my name is|this is|i(?:'m| am)|call me|it'?s)\s+([A-Z][A-Za-z'.\-]+(?:\s+[A-Z][A-Za-z'.\-]+){0,2})/);
  return m?.[1]?.trim() ?? null;
}

function detectCollectedFields(agent: AgentSummary, history: Turn[]): CollectedField[] {
  const fields = agent.data_fields ?? [];
  if (!fields.length) return [];
  const out: CollectedField[] = [];
  const userDialogue = history.filter((t) => t.role === "user").map((t) => t.content).join("\n");

  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    const sem = fieldSemantic(f);
    let value: string | null = null;

    if (sem === "phone") value = extractPhone(userDialogue);
    else if (sem === "email") value = extractEmail(userDialogue);
    else if (sem === "name") value = extractName(userDialogue);
    else {
      // Generic field: if the immediately-prior assistant turn referenced this field's label,
      // treat the next user reply as its answer.
      const labelRe = new RegExp(`\\b${escapeRegex(f.label)}\\b`, "i");
      for (let j = 0; j < history.length - 1; j++) {
        if (history[j].role === "assistant" && labelRe.test(history[j].content)) {
          const next = history[j + 1];
          if (next?.role === "user" && next.content.trim().length > 0) {
            value = next.content.trim().slice(0, 120);
            break;
          }
        }
      }
    }

    if (value) out.push({ field: f, value });
  }
  return out;
}

function callerSaidGoodbye(history: Turn[]): boolean {
  const user = latestUserTurn(history).toLowerCase().trim();
  if (!user) return false;
  // Explicit farewell words - "thanks" / "thank you" alone are NOT a goodbye
  // (callers often say them mid-conversation). Require an actual bye phrase.
  return /\b(?:bye|goodbye|good bye|see you|talk (?:to you )?later|have a (?:good|great|nice) (?:day|one|evening|night)|that'?s all(?: for now)?|that (?:will|would) be all|nothing else|we'?re (?:all )?done(?: here)?|i'?m (?:all )?done|i (?:gotta|have to|need to) (?:go|run)|hang up|end (?:the )?call)\b/.test(user);
}

function assistantAlreadyConfirmed(history: Turn[]): boolean {
  // True if the assistant's most recent turn already read the collected
  // details back / signalled a wrap-up. Used to advance CONFIRMING → CLOSING.
  const last = latestAssistantTurn(history).toLowerCase();
  if (!last) return false;
  return /\b(?:just to confirm|to confirm|confirming|got everything|all set|we[' ]?re all set|is there anything else|anything else (?:i can help|before we wrap)|i[' ]?ll (?:send|share|pass|make sure)|someone (?:will|from our team) (?:reach|be in touch|follow up)|you[' ]?ll (?:hear|receive|get) (?:from us|a )|next step)\b/.test(last);
}

function assistantAskedQualification(history: Turn[], agent: AgentSummary): number {
  // Count how many prior assistant turns already asked a discovery/qualification
  // question (contains a "?" and is NOT a personal-contact-detail ask).
  const fields = agent.data_fields ?? [];
  let count = 0;
  for (const t of history) {
    if (t.role !== "assistant") continue;
    if (!/\?/.test(t.content)) continue;
    if (asksForPersonalContactDetail(t.content)) continue;
    if (asksForContactField(t.content, fields)) continue;
    count += 1;
  }
  return count;
}

function computeConvState(agent: AgentSummary, history: Turn[]): ConvState {
  const userTurns = userTurnCount(history);
  if (userTurns === 0) return "GREETING";
  const collected = detectCollectedFields(agent, history);
  const required = (agent.data_fields ?? []).filter((f) => f.required !== false);
  const collectedKeys = new Set(collected.map((c) => c.field.key));
  const pendingRequired = required.filter((f) => !collectedKeys.has(f.key));
  const bookingIntent = callerShowsBookingIntent(history);
  const saidBye = callerSaidGoodbye(history);
  const qualTurns = assistantAskedQualification(history, agent);

  if (saidBye) return "CLOSING";

  // All required fields collected → confirm then close.
  if (required.length > 0 && pendingRequired.length === 0) {
    return assistantAlreadyConfirmed(history) ? "CLOSING" : "CONFIRMING";
  }

  // First caller reply is small talk / permission - stay in INTRO, ask a
  // discovery question from the system prompt (NOT a data field).
  if (userTurns <= 1) return "INTRO";

  // Move into COLLECTING only after the caller is qualified via the system
  // prompt's discovery flow, OR they show explicit booking/next-step intent,
  // OR the assistant has already asked at least 2 discovery questions.
  if (required.length > 0 && (bookingIntent || qualTurns >= 2)) return "COLLECTING";

  return "DISCOVERY";
}

function stateGuidance(state: ConvState, agent: AgentSummary, collected: CollectedField[]): string {
  const collectedLines = collected.length
    ? `ALREADY COLLECTED (do NOT ask for these again - treat as final):\n${collected.map((c) => `- ${c.field.label} [${c.field.key}] = "${c.value}"`).join("\n")}`
    : "ALREADY COLLECTED: none.";
  const pending = (agent.data_fields ?? []).filter((f) => !collected.find((c) => c.field.key === f.key));
  const pendingLines = pending.length
    ? `STILL PENDING:\n- ${pending.map(describeField).join("\n- ")}`
    : "STILL PENDING: none.";
  const phase = {
    GREETING: "PHASE = GREETING. The caller has not spoken yet. Say the greeting only.",
    INTRO: "PHASE = INTRO. The caller has just answered your greeting. Briefly acknowledge (one short clause) and immediately ask the FIRST qualification/discovery question from the system prompt or the Qualification questions list. Do NOT ask for name, phone, email, or any personal contact detail yet - the caller must be qualified first. Ask exactly one question.",
    DISCOVERY: "PHASE = DISCOVERY. Continue working through the qualification/discovery questions from the system prompt in order, one at a time. Only after the caller is clearly qualified/interested (or explicitly agrees to next steps) may you begin collecting the personal fields listed under STILL PENDING. Do NOT collect contact details before qualifying.",
    COLLECTING: "PHASE = COLLECTING. The caller is qualified. Now collect the STILL PENDING fields one at a time, in the order listed. Confirm each answer briefly before moving to the next. NEVER re-ask a field listed under ALREADY COLLECTED. Do NOT end the call while any required field is pending.",
    CONFIRMING: "PHASE = CONFIRMING. All required fields are collected. In ONE reply (2-3 sentences): (1) briefly confirm the key details back (name + phone/email if collected), (2) tell the caller the concrete next step (e.g. 'someone from our team will reach out shortly at that number'), (3) thank them by name and give a warm, explicit goodbye that INCLUDES the word 'goodbye' or 'bye' (e.g. 'Thanks so much, <name> - have a great rest of your day. Goodbye!'). Prepend [END_CALL] to the reply. Do NOT ask any more questions. Do NOT end with just 'take care' - the reply MUST contain an explicit 'goodbye' or 'bye' word.",
    CLOSING: "PHASE = CLOSING. Give a warm, complete goodbye in ONE reply (1-2 sentences). Thank the caller (use their name if known), briefly restate the next step if one was set (e.g. 'we'll be in touch shortly'), and finish with an explicit farewell that INCLUDES the word 'goodbye' or 'bye' (e.g. 'Thanks again - have a great day, goodbye!'). Do NOT end with just 'take care' by itself - always include 'goodbye' or 'bye'. Prepend [END_CALL] to the reply. Do NOT ask any more questions. Do NOT re-list all details.",
  }[state];
  return `${phase}\n\n${collectedLines}\n\n${pendingLines}`;
}


function stripFieldReAsks(reply: string, collected: CollectedField[]): string {
  if (!collected.length) return reply;
  const sentences = reply.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [reply];
  const kept = sentences.filter((s) => {
    for (const c of collected) {
      const sem = fieldSemantic(c.field);
      if (sem === "name" && /\b(?:what(?:'s| is)|may i have|can i (?:get|have)|could i (?:get|have)|tell me|confirm)\b[^.!?]{0,60}\bname\b/i.test(s)
          && !/\b(business|company|organization|practice)\s+name\b/i.test(s)) return false;
      if (sem === "phone" && /\b(?:phone|mobile|cell|contact)\s+number\b|\bbest\s+(?:number|phone)\b|\bnumber to (?:reach|contact|call)\b|\breach you at\b/i.test(s)) return false;
      if (sem === "email" && /\b(?:email|e-mail)\s+address\b|\bwhere should i send\b|\bwhat(?:'s| is) your (?:email|e-mail)\b/i.test(s)) return false;
      if (sem === "other") {
        const labelRe = new RegExp(`\\b(?:what(?:'s| is)|may i have|can i (?:get|have)|could i (?:get|have)|tell me|confirm)\\b[^.!?]{0,60}\\b${escapeRegex(c.field.label)}\\b`, "i");
        if (labelRe.test(s)) return false;
      }
    }
    return true;
  });
  const cleaned = kept.join(" ").replace(/\s{2,}/g, " ").trim();
  return cleaned || reply;
}

function buildSystem(a: AgentSummary, state: ConvState, collected: CollectedField[]): string {
  const canTransfer = !!a.transfer_number?.trim();
  const fields = a.data_fields ?? [];
  const hasRequired = fields.some((f) => f.required !== false);
  const parts = [
    "You are operating under a strict conversation state machine. Obey the current PHASE below.",
    stateGuidance(state, a, collected),
    hasRequired
      ? "Conversation flow priority: FIRST follow the configured system prompt to qualify and engage the caller (screening / discovery / qualification questions). ONLY AFTER the caller is clearly qualified or has agreed to next steps do you begin collecting the required data fields listed below, one at a time. NEVER open the call by asking for name, phone, email, or any personal contact detail. Once ALL required fields are collected, immediately move to PHASE = CONFIRMING (confirm + next step + farewell + [END_CALL])."
      : "Conversation flow priority: follow the configured system prompt's conversation order. Do not treat data fields as an opening script. In the opening and early discovery phase, acknowledge the caller and ask the next relevant discovery question from the system prompt. Never jump straight to collecting name, phone, email, or contact details unless the caller explicitly asks to book/schedule, agrees to a demo/appointment/follow-up, or volunteers contact details first.",
    a.system_prompt?.trim(),
    a.name ? `Your name is ${a.name}. This is YOUR name (the assistant's), NOT the caller's. NEVER address the caller as "${a.name}" or use "${a.name}" as if it were their name. The caller has NOT told you their name. Do NOT guess, assume, or invent a name for the caller. Address them neutrally ("you", "there") until they explicitly say their name in this conversation. If unsure, do not use any name at all.` : "You do not know the caller's name. Never invent or assume one. Address them neutrally until they say their name.",
    a.personality ? `Personality: ${a.personality}` : "",
    a.objective ? `Objective: ${a.objective}` : "",
    a.prompt ? `Task: ${a.prompt}` : "",
    a.business_knowledge ? `Reference:\n${a.business_knowledge}` : "",
    a.playbook?.trim()
      ? `LEARNED PLAYBOOK (auto-updated from past calls - obey these rules; they override generic tendencies):\n${a.playbook.trim()}`
      : "",
    fields.length
      ? `Information to collect during this call. Ask one item at a time and confirm each. NEVER re-ask a field that is already listed under ALREADY COLLECTED - treat those as final:\n- ${fields.map(describeField).join("\n- ")}\n\nDo NOT ask for any other personal detail (e.g. address, DOB) unless it is in the list above.`
      : "",
    a.qualification_questions?.length
      ? `Qualification questions:\n- ${a.qualification_questions.join("\n- ")}`
      : "",
    a.end_call_conditions?.length
      ? `End the call ONLY when: ${a.end_call_conditions.join("; ")}. When ending, first give a warm closing line (thank them, confirm next step, say goodbye) and prepend [END_CALL] to that closing reply.`
      : `End the call when all required information has been collected and confirmed, OR when the caller clearly says goodbye/asks to end. When ending, prepend [END_CALL] to a warm closing reply that thanks them and states the next step.`,

    canTransfer
      ? `If the caller asks for a human, a manager, sales, billing, or a topic clearly outside your scope, prepend [TRANSFER] to your reply (e.g. "[TRANSFER] Sure, connecting you now."). Do not use [TRANSFER] otherwise.`
      : `You cannot transfer this call. If a human is requested, apologize and offer to take a message.`,
    "CRITICAL - Control tokens [END_CALL] and [TRANSFER] are SILENT machine signals. They must appear as the very first characters of your reply, in square brackets. NEVER speak the words 'END CALL', 'END_CALL', 'TRANSFER', or read the brackets out loud. To end the call, prepend [END_CALL] to a natural goodbye sentence - never put those words in the sentence itself.",
    "Never use both [END_CALL] and [TRANSFER] in the same reply.",
    "Speak like a warm, calm human on a live phone call: use contractions, brief acknowledgements ('mm-hm', 'got it', 'okay'), and natural punctuation for pauses. Vary your sentence length. Keep tone professional and grounded - do NOT sound overly excited, bubbly, or salesy, especially in the opening line. No exclamation marks. No 'so excited', 'amazing', 'awesome' filler.",
    "Ask one question at a time. Do not rapid-fire confirmations or lists.",
    "When repeating a phone number back, ALWAYS format it in your reply with spaces or commas between small groups so it is read slowly, e.g. '2 1 2 ... 5 5 5 ... 0 1 2 3'. Never say a phone number as one continuous string. State a phone number EXACTLY ONCE per turn - do NOT say the digits, then repeat them in the same reply (no 'that's <digits>', no 'to confirm, <digits>' after already saying it). If the caller confirms, acknowledge with words only (e.g. 'perfect, got it'), never re-state the digits.",
    "After collecting information, acknowledge it naturally and tell the caller the next step before asking anything else.",
    "Caller-name usage: when the caller tells you their name, DO NOT greet them back with it ('hi <name>', 'hello <name>', 'nice to meet you <name>', 'thanks <name>'). That sounds robotic. Just acknowledge naturally ('got it', 'perfect', 'thanks') and move to the next question. Reserve the caller's name for at most ONE moment later in the call - ideally the final confirmation/goodbye - and never in two consecutive turns.",
    "Never claim the caller said something they did not say. Never say 'thanks for asking', 'good question', or similar unless the caller actually asked you a question in their last message. If the caller only answered your question (e.g. you asked 'how are you' and they replied 'good'), acknowledge briefly ('glad to hear that', 'great') and move on - do NOT pretend they asked you back.",
    "Words like 'too', 'also', 'as well', 'either' from the caller are filler agreement, NEVER a name reveal or an identity claim. Do NOT interpret them as the caller sharing a name, and do NOT respond with any 'coincidence' or 'same name' remark. After the greeting, do NOT re-introduce yourself or restate your own name - never say 'my name is …', 'I'm … too', 'we have the same name', or similar. Your name was given once in the greeting and that is enough.",
    a.name ? `Name safety rule: "${a.name}" is the assistant's name only. If the caller has not explicitly said "my name is ${a.name}" or "call me ${a.name}" in this conversation, any reply that addresses the caller as "${a.name}" is wrong. Use no caller name instead.` : "Name safety rule: the caller's name is unknown unless they explicitly say it during this call. Use no caller name by default.",
    "Keep replies short - under 25 spoken words. Never break character. Never mention you are AI unless asked directly.",
  ].filter(Boolean);
  return parts.join("\n\n");
}

export const Route = createFileRoute("/api/public/bridge/turn")({
  server: {
    handlers: {
      OPTIONS: async () => preflight(),
      POST: async ({ request }) => {
        const raw = await request.text();
        if (!(await verifyBridge(request, raw))) {
          return errorJson(401, "Invalid bridge signature");
        }

        let body: { agent: AgentSummary; history: Turn[]; call_sid?: string };
        try {
          body = JSON.parse(raw);
        } catch {
          return errorJson(400, "Invalid JSON");
        }
        if (!body.agent) return errorJson(400, "agent required");

        const history = body.history ?? [];
        if (historyHasVoicemailSystem(history)) {
          return json({
            reply: "",
            end_call: true,
            transfer: false,
            end_reason: "voicemail_hangup",
          });
        }
        const collected = detectCollectedFields(body.agent, history);
        const state = computeConvState(body.agent, history);

        // Look up authoritative phone context for this call so the assistant
        // can accurately answer questions like "what number are you calling
        // me on?" instead of hallucinating a different number.
        let phoneContext = "";
        if (body.call_sid) {
          try {
            const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
            const { data: callRow } = await supabaseAdmin
              .from("calls")
              .select("phone_to, phone_from, agent_id")
              .eq("twilio_call_sid", body.call_sid)
              .maybeSingle<{ phone_to: string | null; phone_from: string | null; agent_id: string | null }>();
            if (callRow) {
              const to = callRow.phone_to?.trim();
              const from = callRow.phone_from?.trim();
              const parts: string[] = [];
              if (to) parts.push(`The caller's phone number (the number you dialed to reach them) is ${to}.`);
              if (from) parts.push(`Your outbound business number (the number showing on their caller ID) is ${from}.`);
              if (parts.length) {
                phoneContext =
                  `CALL CONTEXT - GROUND TRUTH PHONE NUMBERS (use these exact digits, never invent others):\n${parts.join(" ")} ` +
                  `If the caller asks what number you are calling them on, or references "this number", "the number you called", or "my number", answer with the caller's phone number above - never any other digits. ` +
                  `When speaking a phone number aloud, group the digits (e.g. "2 1 2 ... 5 5 5 ... 0 1 2 3").`;
              }
              // Pull the agent's self-improvement playbook (the bridge only
              // forwards a slim agent config; playbook lives in Supabase).
              if (callRow.agent_id && !body.agent.playbook) {
                const { data: agentRow } = await supabaseAdmin
                  .from("agents")
                  .select("playbook, personality, objective, business_knowledge, qualification_questions, end_call_conditions, data_fields, transfer_number")
                  .eq("id", callRow.agent_id)
                  .maybeSingle<{
                    playbook: string | null;
                    personality: string | null;
                    objective: string | null;
                    business_knowledge: string | null;
                    qualification_questions: string[] | null;
                    end_call_conditions: string[] | null;
                    data_fields: DataField[] | null;
                    transfer_number: string | null;
                  }>();
                if (agentRow) {
                  body.agent.playbook = agentRow.playbook || undefined;
                  body.agent.personality = body.agent.personality || agentRow.personality || undefined;
                  body.agent.objective = body.agent.objective || agentRow.objective || undefined;
                  body.agent.business_knowledge = body.agent.business_knowledge || agentRow.business_knowledge || undefined;
                  body.agent.qualification_questions = body.agent.qualification_questions?.length ? body.agent.qualification_questions : (agentRow.qualification_questions ?? undefined);
                  body.agent.end_call_conditions = body.agent.end_call_conditions?.length ? body.agent.end_call_conditions : (agentRow.end_call_conditions ?? undefined);
                  body.agent.data_fields = body.agent.data_fields?.length ? body.agent.data_fields : (agentRow.data_fields ?? undefined);
                  body.agent.transfer_number = body.agent.transfer_number || agentRow.transfer_number || undefined;
                }
              }
            }
          } catch (e) {
            console.warn("bridge.turn phone context lookup failed", e);
          }
        }

        const messages = [
          { role: "system", content: buildSystem(body.agent, state, collected) },
          ...(phoneContext ? [{ role: "system", content: phoneContext }] : []),
          ...history.slice(-20),
          {
            role: "system",
            content: body.agent.name
              ? `Final name check before answering: your assistant name is "${body.agent.name}". Do not address the caller as "${body.agent.name}" unless the caller explicitly gave that as their own name. If no caller name was given, address them with no name.`
              : "Final name check before answering: no caller name is known. Address the caller with no name.",
          },
        ];

        const ai = await chatCompletion({
          messages,
          fallbackModel: MODEL,
          temperature: body.agent.temperature ?? 0.4,
          max_tokens: 140,
        });
        if (!ai.ok) {
          return errorJson(ai.status, ai.error ?? "AI request failed");
        }
        let reply = ai.content;
        let endCall = false;
        let transfer = false;

        // Strip control tokens aggressively - models sometimes emit them
        // without brackets, with different casing, or mid-reply. Any form
        // must be treated as a control signal and never spoken.
        const tokenRe = /\[?\s*(END[_\s-]?CALL|TRANSFER)\s*\]?/gi;
        let m: RegExpExecArray | null;
        while ((m = tokenRe.exec(reply)) !== null) {
          const which = m[1].toUpperCase().replace(/[_\s-]/g, "");
          if (which === "ENDCALL") endCall = true;
          else if (which === "TRANSFER") transfer = true;
        }
        if (endCall || transfer) {
          reply = reply.replace(tokenRe, "").replace(/\s{2,}/g, " ").trim();
        }
        reply = stripAgentNameAsCaller(reply, body.agent.name, history);
        reply = stripUnpromptedSelfAnswer(reply, history);
        reply = stripFieldReAsks(reply, collected);
        reply = preventPrematureContactCollection(reply, body.agent, history);
        // Transfer wins over end_call if both were emitted.
        if (transfer) endCall = false;

        return json({ reply, end_call: endCall, transfer });
      },
    },
  },
});
