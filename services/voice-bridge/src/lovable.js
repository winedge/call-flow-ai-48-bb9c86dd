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
const APP = process.env.LOVABLE_APP_URL;
const SECRET = process.env.BRIDGE_SHARED_SECRET;
if (!APP || !SECRET) {
    throw new Error("LOVABLE_APP_URL and BRIDGE_SHARED_SECRET are required");
}
function sign(body) {
    const ts = Date.now().toString();
    const sig = createHmac("sha256", SECRET).update(`${ts}.${body}`).digest("hex");
    return { ts, sig };
}
async function post(path, payload) {
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
    return (await res.json());
}
async function get(path) {
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
    return (await res.json());
}
export function fetchAgent(id) {
    return get(`/api/public/bridge/agent?id=${encodeURIComponent(id)}`);
}
export function runTurn(agent, history, callSid) {
    return post("/api/public/bridge/turn", { agent, history, call_sid: callSid });
}
export function synthTts(text, voice, language, engine, voiceSettings) {
    return post("/api/public/bridge/tts", {
        text,
        voice,
        language,
        engine,
        voice_settings: voiceSettings,
    });
}
