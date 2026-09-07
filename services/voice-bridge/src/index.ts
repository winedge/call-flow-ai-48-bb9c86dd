/**
 * Voice-bridge entry point.
 *
 * A single Bun server exposes:
 *   - GET /healthz             - liveness probe
 *   - GET /metrics             - active sessions, uptime, counters (JSON)
 *   - WS  /twilio?agent_id&call_sid - Twilio Media Streams endpoint
 *
 * Per call we run a full-duplex loop:
 *   Twilio μ-law/8k → Deepgram STT → Gemini turn → Kokoro TTS →
 *   downsample+μ-law → Twilio.
 *
 * Production hardening notes (each addresses a specific requirement):
 *
 *   1. 100+ concurrent WebSocket sessions - MAX_SESSIONS cap (env, default
 *      100). Upgrades over the cap are rejected with HTTP 503 so the
 *      caller / load balancer can route to another machine.
 *
 *   2. No global call state - per-call state lives in a Session object
 *      owned by its ws.data. The `sessions` Map is a per-process registry
 *      used only for lifecycle (cleanup on shutdown) and metrics; it is
 *      never read from another call's turn logic.
 *
 *   3. Immediate session cleanup - cleanup() runs on `stop`, `close`, or
 *      any fatal error. It cancels TTS playback, closes the Deepgram
 *      socket, and removes the session from the registry.
 *
 *   4. Graceful upstream reconnect - the Deepgram STT socket auto-
 *      reconnects with exponential backoff (up to 3 attempts) if it
 *      drops mid-call. The turn / TTS calls are short-lived HTTPs;
 *      they surface errors and the caller is prompted to retry.
 *
 *   5. Structured logs - every log line includes connection_id + call_sid
 *      + agent_id so a single call can be grep'd end-to-end.
 *
 *   6. Metrics - GET /metrics returns { active, opened, closed, uptime_s,
 *      max_sessions, memory }.
 *
 *   7. Clean Twilio disconnects - Twilio can close the ws at any time
 *      (caller hung up, network blip, `stop` frame). All three paths run
 *      through cleanup() exactly once.
 *
 * Env (all required unless noted):
 *   LOVABLE_APP_URL       https://<app>.lovable.app
 *   BRIDGE_SHARED_SECRET  matches Lovable
 *   DEEPGRAM_API_KEY      Deepgram Nova-2 key
 *   PORT                  optional, defaults 8080
 *   MAX_SESSIONS          optional, defaults 100
 */
import { WaveFile } from "wavefile";
import { openDeepgram } from "./deepgram";
import { chunk20ms, downsampleTo8k, pcm8kToMuLaw } from "./audio";
import { fetchAgent, runTurn, synthTts, type AgentConfig } from "./lovable";

const PORT = Number(process.env.PORT ?? 8080);
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS ?? 100);
const DEEPGRAM_KEY = process.env.DEEPGRAM_API_KEY!;
if (!DEEPGRAM_KEY) throw new Error("DEEPGRAM_API_KEY is required");

// ---------- process-level state (metrics + registry only) ----------

const START_TIME = Date.now();
const sessions = new Map<string, Session>();
let totalOpened = 0;
let totalClosed = 0;

function nextConnectionId(): string {
  // 12-hex-char id; enough entropy for logs, short enough to scan.
  return Array.from(crypto.getRandomValues(new Uint8Array(6)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function log(
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown> = {},
) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

// ---------- types ----------

type Twilio = {
  event: string;
  streamSid?: string;
  media?: { payload: string };
  start?: { streamSid: string; callSid: string };
};

type Session = {
  connectionId: string;
  callSid: string;
  agentId: string;
  ws: import("bun").ServerWebSocket<Ctx>;
  streamSid: string | null;
  agent: AgentConfig | null;
  dg: ReturnType<typeof openDeepgram> | null;
  dgReconnects: number;
  history: { role: "user" | "assistant"; content: string }[];
  speaking: boolean;
  pendingUser: string;
  turnLock: boolean;
  queuedUser: string;

  cancelSpeech: () => void;
  closed: boolean;
  openedAt: number;
};

type Ctx = { agentId: string; callSid: string; connectionId: string; session?: Session };

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

// ---------- Bun server ----------

const server = Bun.serve<Ctx>({
  port: PORT,
  async fetch(req, srv) {
    const url = new URL(req.url);

    if (url.pathname === "/healthz") {
      return new Response("ok", { status: 200 });
    }

    if (url.pathname === "/metrics") {
      const mem = process.memoryUsage?.() ?? { rss: 0, heapUsed: 0 };
      return Response.json({
        active: sessions.size,
        max_sessions: MAX_SESSIONS,
        opened: totalOpened,
        closed: totalClosed,
        uptime_s: Math.floor((Date.now() - START_TIME) / 1000),
        memory: {
          rss_mb: Math.round(mem.rss / 1024 / 1024),
          heap_mb: Math.round(mem.heapUsed / 1024 / 1024),
        },
      });
    }

    if (url.pathname === "/twilio") {
      if (sessions.size >= MAX_SESSIONS) {
        log("warn", "upgrade_rejected_capacity", {
          active: sessions.size,
          max: MAX_SESSIONS,
        });
        return new Response("capacity", { status: 503 });
      }
      const agentId = url.searchParams.get("agent_id") ?? "";
      const callSid = url.searchParams.get("call_sid") ?? "";
      const connectionId = nextConnectionId();
      const ok = srv.upgrade(req, {
        data: { agentId, callSid, connectionId },
      });
      if (ok) return undefined as unknown as Response;
      return new Response("upgrade failed", { status: 400 });
    }

    return new Response("voice-bridge", { status: 200 });
  },

  websocket: {
    open(ws) {
      const { connectionId, callSid, agentId } = ws.data;
      const session: Session = {
        connectionId,
        callSid,
        agentId,
        ws,
        streamSid: null,
        agent: null,
        dg: null,
        dgReconnects: 0,
        history: [],
        speaking: false,
        pendingUser: "",
        turnLock: false,
        queuedUser: "",

        cancelSpeech: () => {},
        closed: false,
        openedAt: Date.now(),
      };
      ws.data.session = session;
      sessions.set(connectionId, session);
      totalOpened += 1;
      log("info", "ws_open", {
        connection_id: connectionId,
        call_sid: callSid,
        agent_id: agentId,
        active: sessions.size,
      });

      if (agentId) {
        fetchAgent(agentId)
          .then((a) => {
            session.agent = a;
          })
          .catch((e) => {
            log("error", "agent_fetch_failed", {
              connection_id: connectionId,
              call_sid: callSid,
              agent_id: agentId,
              error: String(e),
            });
            ws.close(1011, "agent config unavailable");
          });
      }
    },

    async message(ws, raw) {
      const session = ws.data.session!;
      if (session.closed) return;
      let msg: Twilio;
      try {
        msg = JSON.parse(
          typeof raw === "string" ? raw : new TextDecoder().decode(raw),
        );
      } catch {
        return;
      }

      if (msg.event === "start") {
        session.streamSid = msg.start!.streamSid;
        for (let i = 0; i < 50 && !session.agent; i++) {
          await new Promise((r) => setTimeout(r, 40));
        }
        if (!session.agent) {
          log("error", "agent_not_loaded", {
            connection_id: session.connectionId,
            call_sid: session.callSid,
          });
          ws.close(1011, "agent not loaded");
          return;
        }
        openDg(session);
        log("info", "call_started", {
          connection_id: session.connectionId,
          call_sid: session.callSid,
          agent_id: session.agentId,
          stream_sid: session.streamSid,
        });

        // Wait for the callee to speak first ("Hello?") before the agent
        // greets. Twilio's `start` fires the instant the media stream opens,
        // which on outbound calls is essentially at pickup — greeting there
        // means the agent talks over the human's hello (and over the first
        // second of a voicemail intro). Delay 1500ms so the human leads;
        // any interim STT during the wait cancels the greeting so the agent
        // can respond to what they said instead of barrelling in.
        const speakFirst = session.agent.speak_first ?? true;
        if (!speakFirst) return; // agent stays silent until user speaks
        const greeting = session.agent.greeting || "Hello, this is your AI assistant.";
        let aborted = false;
        const prevCancel = session.cancelSpeech;
        session.cancelSpeech = () => { aborted = true; prevCancel(); };
        await new Promise((r) => setTimeout(r, 1500));
        session.cancelSpeech = prevCancel;
        if (aborted || session.closed || session.pendingUser.trim().length > 0) {
          // Human already started talking — let the STT final drive the first turn.
          return;
        }
        void speak(session, greeting);

      } else if (msg.event === "media" && session.dg && msg.media) {
        const bytes = Uint8Array.from(atob(msg.media.payload), (c) =>
          c.charCodeAt(0),
        );
        session.dg.send(bytes);
      } else if (msg.event === "stop") {
        log("info", "twilio_stop", {
          connection_id: session.connectionId,
          call_sid: session.callSid,
        });
        cleanup(session, "twilio_stop");
      }
    },

    close(ws, code, reason) {
      const s = ws.data.session;
      if (!s) return;
      log("info", "ws_close", {
        connection_id: s.connectionId,
        call_sid: s.callSid,
        code,
        reason: reason || undefined,
      });
      cleanup(s, "ws_close");
    },
  },
});

log("info", "listening", { port: PORT, max_sessions: MAX_SESSIONS });

// ---------- Deepgram lifecycle (with reconnect) ----------

/** Words that alone are almost always noise, echo, or a filler grunt. */
const NOISE_ONLY = new Set([
  "uh", "uhh", "um", "umm", "mm", "mhm", "hmm", "huh", "ah", "oh", "eh",
  "hm", "erm", "er", "yeah", "yep", "yup", "ok", "okay", "hello", "hi",
]);

/** True when a transcript is too thin / too unsure to act on. */
function isNoise(text: string, confidence: number): boolean {
  const clean = text.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").trim();
  if (!clean) return true;
  const words = clean.split(/\s+/);
  // Very low confidence on a short phrase = far-end background speech.
  if (confidence > 0 && confidence < 0.5 && words.length < 4) return true;
  if (words.length === 1) {
    // A lone greeting/acknowledgement is real input; a lone grunt is not.
    if (NOISE_ONLY.has(words[0]) && !["hello", "hi", "yes", "no"].includes(words[0])) return true;
    if (words[0].length <= 2) return true;
  }
  return false;
}

function openDg(session: Session) {
  session.dg = openDeepgram(DEEPGRAM_KEY, {
    onInterim: (t, confidence) => {
      const words = t.trim().split(/\s+/).filter(Boolean);
      session.pendingUser = t;
      // Barge-in only for a confident, multi-word interruption. A single
      // stray word or low-confidence background voice used to cut the agent
      // off mid-sentence, which is what made calls fall apart.
      if (
        session.speaking &&
        words.length >= 2 &&
        t.trim().length > 6 &&
        (confidence === 0 || confidence >= 0.6)
      ) {
        session.cancelSpeech();
      }
    },
    onFinal: (t, confidence) => {
      const text = t.trim();
      session.pendingUser = "";
      if (!text) return;
      if (isNoise(text, confidence)) {
        log("info", "stt_ignored_noise", {
          connection_id: session.connectionId,
          call_sid: session.callSid,
          confidence,
        });
        return;
      }
      // Ignore transcripts captured while our own audio is still playing
      // unless they are substantial - that is usually line echo of the agent.
      if (session.speaking && text.split(/\s+/).length < 3) return;
      void handleUserTurn(session, text);
    },

    onClose: () => {
      if (session.closed) return;
      // Unexpected drop mid-call. Reconnect with exponential backoff.
      if (session.dgReconnects >= 3) {
        log("error", "deepgram_reconnect_giveup", {
          connection_id: session.connectionId,
          call_sid: session.callSid,
          attempts: session.dgReconnects,
        });
        try {
          session.ws.close(1011, "stt unavailable");
        } catch {
          /* ignore */
        }
        return;
      }
      const attempt = session.dgReconnects + 1;
      session.dgReconnects = attempt;
      const delay = Math.min(2000, 200 * 2 ** (attempt - 1));
      log("warn", "deepgram_reconnect", {
        connection_id: session.connectionId,
        call_sid: session.callSid,
        attempt,
        delay_ms: delay,
      });
      setTimeout(() => {
        if (!session.closed) openDg(session);
      }, delay);
    },
    onError: (e) =>
      log("error", "deepgram_error", {
        connection_id: session.connectionId,
        call_sid: session.callSid,
        error: String(e),
      }),
  });
}

// ---------- turn loop ----------

async function handleUserTurn(session: Session, userText: string) {
  if (!session.agent) return;
  if (session.turnLock) {
    // A turn is already in flight. Queue the text so it is answered right
    // after, instead of silently dropping it (the old behaviour pushed it to
    // history with no reply, so the agent looked like it ignored the caller).
    session.queuedUser = [session.queuedUser, userText].filter(Boolean).join(" ");
    return;
  }
  session.turnLock = true;
  session.history.push({ role: "user", content: userText });
  if (isVoicemailSystemText(userText)) {
    hangup(session);
    return;
  }
  try {
    const { reply, end_call, end_reason } = await runTurn(session.agent, session.history, session.callSid) as { reply: string; end_call: boolean; end_reason?: string };
    if (!reply) return;
    session.history.push({ role: "assistant", content: reply });
    await speak(session, reply);
    if (end_call) {
      if (end_reason === "voicemail_hangup") {
        hangup(session);
        return;
      }
      await new Promise((r) => setTimeout(r, 400));
      hangup(session);
    }
  } catch (e) {
    log("error", "turn_failed", {
      connection_id: session.connectionId,
      call_sid: session.callSid,
      error: String(e),
    });
    await speak(
      session,
      "Sorry, I had a technical issue. Could you say that again?",
    );
  } finally {
    session.turnLock = false;
    const queued = session.queuedUser.trim();
    session.queuedUser = "";
    if (queued && !session.closed) void handleUserTurn(session, queued);
  }
}

async function speak(session: Session, text: string) {
  if (!session.agent || !session.streamSid || session.closed) return;
  let cancelled = false;
  session.cancelSpeech = () => {
    cancelled = true;
  };
  session.speaking = true;
  try {
    const { audio_url } = await synthTts(
      text,
      session.agent.voice_id,
      session.agent.language,
      session.agent.tts_engine,
      session.agent.voice_settings,
    );

    if (cancelled || session.closed) return;
    const buf = await fetch(audio_url).then((r) => r.arrayBuffer());
    if (cancelled || session.closed) return;

    let mu: Uint8Array;
    if (audio_url.startsWith("data:audio/mulaw")) {
      // Already 8k μ-law (ElevenLabs path) - forward bytes untouched.
      mu = new Uint8Array(buf);
    } else {
      const wav = new WaveFile(new Uint8Array(buf));
      wav.toBitDepth("16");
      const sampleRate = (wav.fmt as { sampleRate: number }).sampleRate;
      const rawSamples = wav.getSamples(false) as Float64Array | Float64Array[];
      const mono = Array.isArray(rawSamples) ? rawSamples[0] : rawSamples;
      const pcm = new Int16Array(mono.length);
      for (let i = 0; i < mono.length; i++) {
        const v = mono[i];
        pcm[i] = Math.max(-32768, Math.min(32767, Math.round(v)));
      }
      mu = pcm8kToMuLaw(downsampleTo8k(pcm, sampleRate));
    }
    const frames = chunk20ms(mu);


    for (const frame of frames) {
      if (cancelled || session.closed) break;
      const payload = btoa(String.fromCharCode(...frame));
      session.ws.send(
        JSON.stringify({
          event: "media",
          streamSid: session.streamSid,
          media: { payload },
        }),
      );
      await new Promise((r) => setTimeout(r, 20));
    }
    if (!cancelled && !session.closed) {
      session.ws.send(
        JSON.stringify({
          event: "mark",
          streamSid: session.streamSid,
          mark: { name: "utterance-end" },
        }),
      );
    }
  } catch (e) {
    log("error", "tts_failed", {
      connection_id: session.connectionId,
      call_sid: session.callSid,
      error: String(e),
    });
  } finally {
    session.speaking = false;
    session.cancelSpeech = () => {};
  }
}

function hangup(session: Session) {
  try {
    session.ws.send(
      JSON.stringify({ event: "clear", streamSid: session.streamSid }),
    );
  } catch {
    /* ignore */
  }
  try {
    session.ws.close(1000, "agent ended call");
  } catch {
    /* ignore */
  }
  cleanup(session, "agent_hangup");
}

function cleanup(session: Session, reason: string) {
  if (session.closed) return;
  session.closed = true;
  session.speaking = false;
  try {
    session.cancelSpeech();
  } catch {
    /* ignore */
  }
  try {
    session.dg?.close();
  } catch {
    /* ignore */
  }
  session.dg = null;
  if (sessions.delete(session.connectionId)) {
    totalClosed += 1;
  }
  log("info", "session_cleanup", {
    connection_id: session.connectionId,
    call_sid: session.callSid,
    reason,
    duration_s: Math.floor((Date.now() - session.openedAt) / 1000),
    active: sessions.size,
  });
}

// ---------- graceful shutdown ----------

function shutdown(signal: string) {
  log("warn", "shutdown_signal", { signal, active: sessions.size });
  for (const s of Array.from(sessions.values())) {
    try {
      s.ws.close(1001, "server shutdown");
    } catch {
      /* ignore */
    }
    cleanup(s, "shutdown");
  }
  setTimeout(() => process.exit(0), 200);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Suppress unused warning
void server;
