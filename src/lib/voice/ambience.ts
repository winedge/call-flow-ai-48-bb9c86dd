/**
 * μ-law mixing helpers for the phone bridge.
 *
 * Twilio's PSTN wire format is μ-law 8kHz mono, and ElevenLabs returns the
 * same format directly, so the whole mix stays in-band with no resampling.
 */
import ambienceAsset from "@/assets/office-ambience.ulaw.asset.json";
import { cred } from "@/lib/config/credentials";

// ---- μ-law ↔ linear PCM ----------------------------------------------------

function mulawToLinear(u: number): number {
  u = ~u & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  return sign ? -sample : sample;
}

function linearToMulaw(sample: number): number {
  const BIAS = 0x84;
  const CLIP = 32635;
  let sign = 0;
  if (sample < 0) {
    sample = -sample;
    sign = 0x80;
  }
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

// ---- Ambience buffer (μ-law 8kHz, cached in module scope) ------------------

let ambienceMulaw: Uint8Array | null = null;
let ambiencePromise: Promise<Uint8Array | null> | null = null;

async function fetchAmbience(originHint?: string): Promise<Uint8Array | null> {
  if (ambienceMulaw) return ambienceMulaw;
  if (ambiencePromise) return ambiencePromise;
  ambiencePromise = (async () => {
    // Assets are served same-origin at /__l5e/… - build an absolute URL from
    // the request so the Worker fetch can resolve it.
    const base =
      originHint ??
      (await cred("PUBLIC_APP_URL")) ??
      "https://call-flow-ai-48.lovable.app";
    const url = new URL(ambienceAsset.url, base).toString();
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const buf = new Uint8Array(await res.arrayBuffer());
      ambienceMulaw = buf;
      return buf;
    } catch {
      return null;
    } finally {
      ambiencePromise = null;
    }
  })();
  return ambiencePromise;
}

/**
 * Mix a low-level office ambience under a μ-law speech buffer. Ambience loops
 * with a random start offset so successive turns don't feel identical. If the
 * ambience can't be loaded, returns `speech` unchanged.
 *
 * @param speech μ-law 8kHz mono speech (from ElevenLabs)
 * @param originHint Absolute origin used to fetch the ambience asset
 * @param gain Amplitude multiplier for ambience (~0.10 ≈ -20 dB)
 */
export async function mixOfficeAmbience(
  speech: Uint8Array,
  originHint?: string,
  gain = 0.1,
): Promise<Uint8Array> {
  const amb = await fetchAmbience(originHint);
  if (!amb || amb.length === 0) return speech;

  const out = new Uint8Array(speech.length);
  // Random loop offset so the bed doesn't repeat identically each turn.
  const offset = Math.floor(Math.random() * amb.length);
  // Gentle 40ms fades on the ambience edges (8kHz → 320 samples).
  const FADE = 320;

  for (let i = 0; i < speech.length; i++) {
    const s = mulawToLinear(speech[i]);
    const a = mulawToLinear(amb[(offset + i) % amb.length]);
    let fade = 1;
    if (i < FADE) fade = i / FADE;
    else if (i > speech.length - FADE) fade = Math.max(0, (speech.length - i) / FADE);
    const mixed = s + a * gain * fade;
    const clamped = mixed > 32767 ? 32767 : mixed < -32768 ? -32768 : mixed;
    out[i] = linearToMulaw(clamped | 0);
  }
  return out;
}
