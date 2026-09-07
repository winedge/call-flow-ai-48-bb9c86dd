/**
 * μ-law <-> 16-bit PCM helpers + 24 kHz -> 8 kHz downsampling.
 *
 * Twilio Media Streams: 8 kHz mono μ-law (G.711), 20 ms frames of 160 bytes,
 * base64 in `{event:"media", media:{payload}}`.
 *
 * Kokoro (Replicate) returns 24 kHz mono 16-bit PCM WAV. We downsample by
 * decimation with a light box filter - good enough for a phone call and
 * avoids DSP dependencies.
 */
// μ-law encode a single 16-bit signed sample (ITU G.711).
export function linearToMuLaw(sample) {
    const MU = 0xff;
    const BIAS = 0x84;
    let sign = 0;
    if (sample < 0) {
        sample = -sample;
        sign = 0x80;
    }
    if (sample > 32635)
        sample = 32635;
    sample += BIAS;
    let exponent = 7;
    for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1)
        exponent--;
    const mantissa = (sample >> (exponent + 3)) & 0x0f;
    return (~(sign | (exponent << 4) | mantissa)) & MU;
}
export function muLawToLinear(u) {
    u = ~u & 0xff;
    const sign = u & 0x80;
    const exponent = (u >> 4) & 0x07;
    const mantissa = u & 0x0f;
    let sample = ((mantissa << 3) + 0x84) << exponent;
    sample -= 0x84;
    return sign ? -sample : sample;
}
/**
 * Downsample mono 16-bit PCM from srcRate to 8000 Hz using linear averaging.
 * Returns Int16Array at 8 kHz.
 */
export function downsampleTo8k(pcm, srcRate) {
    if (srcRate === 8000)
        return pcm;
    const ratio = srcRate / 8000;
    const outLen = Math.floor(pcm.length / ratio);
    const out = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
        const startF = i * ratio;
        const endF = (i + 1) * ratio;
        const start = Math.floor(startF);
        const end = Math.min(pcm.length, Math.floor(endF));
        let sum = 0;
        let n = 0;
        for (let j = start; j < end; j++) {
            sum += pcm[j];
            n++;
        }
        out[i] = n ? Math.max(-32768, Math.min(32767, Math.round(sum / n))) : 0;
    }
    return out;
}
/** PCM (Int16Array, 8k mono) → μ-law bytes. */
export function pcm8kToMuLaw(pcm) {
    const out = new Uint8Array(pcm.length);
    for (let i = 0; i < pcm.length; i++)
        out[i] = linearToMuLaw(pcm[i]);
    return out;
}
/** μ-law bytes → PCM Int16Array. */
export function muLawToPcm(mu) {
    const out = new Int16Array(mu.length);
    for (let i = 0; i < mu.length; i++)
        out[i] = muLawToLinear(mu[i]);
    return out;
}
/**
 * Chunk μ-law bytes into 20 ms frames (160 bytes @ 8 kHz).
 * Pads the last frame with silence (0xff = μ-law zero) if needed.
 */
export function chunk20ms(mu) {
    const size = 160;
    const frames = [];
    for (let i = 0; i < mu.length; i += size) {
        const end = Math.min(i + size, mu.length);
        if (end - i === size) {
            frames.push(mu.subarray(i, end));
        }
        else {
            const last = new Uint8Array(size).fill(0xff);
            last.set(mu.subarray(i, end));
            frames.push(last);
        }
    }
    return frames;
}
