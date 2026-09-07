/**
 * Deepgram streaming STT over WebSocket.
 *
 * We send raw μ-law/8k audio (same format Twilio gives us - zero
 * conversion). Deepgram sends back interim + final transcripts.
 *
 * Utterance assembly: `is_final` marks the end of a *segment*, not of the
 * caller's sentence. Firing a dialog turn per segment made the agent reply
 * to half-sentences and lose the thread. We instead buffer `is_final`
 * segments and only emit `onFinal` once Deepgram signals end-of-speech
 * (`speech_final`) or sends `UtteranceEnd`. Interims carry a confidence so
 * the caller can ignore background chatter for barge-in.
 */
export function openDeepgram(apiKey, cb) {
    const url = new URL("wss://api.deepgram.com/v1/listen");
    url.searchParams.set("encoding", "mulaw");
    url.searchParams.set("sample_rate", "8000");
    url.searchParams.set("channels", "1");
    url.searchParams.set("model", "nova-2-phonecall");
    url.searchParams.set("smart_format", "true");
    url.searchParams.set("punctuate", "true");
    url.searchParams.set("interim_results", "true");
    // Longer endpointing + explicit utterance end: gives the caller room to
    // finish a thought instead of the agent jumping in after every pause.
    url.searchParams.set("endpointing", "500");
    url.searchParams.set("utterance_end_ms", "1200");
    url.searchParams.set("vad_events", "true");
    // Drop background speech/noise picked up on the far side.
    url.searchParams.set("filler_words", "false");
    const ws = new WebSocket(url.toString(), ["token", apiKey]);
    let closed = false;
    // Buffered `is_final` segments of the current utterance.
    let buffer = [];
    let lastConfidence = 0;
    function flush() {
        const text = buffer.join(" ").replace(/\s+/g, " ").trim();
        buffer = [];
        if (!text)
            return;
        cb.onFinal(text, lastConfidence);
        lastConfidence = 0;
    }
    ws.addEventListener("message", (ev) => {
        try {
            const msg = JSON.parse(ev.data);
            if (msg.type === "UtteranceEnd") {
                flush();
                return;
            }
            if (msg.type !== "Results")
                return;
            const alt = msg.channel?.alternatives?.[0];
            const text = (alt?.transcript ?? "").trim();
            const confidence = typeof alt?.confidence === "number" ? alt.confidence : 0;
            if (msg.is_final) {
                if (text) {
                    buffer.push(text);
                    lastConfidence = confidence || lastConfidence;
                }
                if (msg.speech_final)
                    flush();
                return;
            }
            if (text)
                cb.onInterim(text, confidence);
        }
        catch (e) {
            cb.onError(e);
        }
    });
    ws.addEventListener("close", () => {
        closed = true;
        cb.onClose();
    });
    ws.addEventListener("error", (e) => cb.onError(e));
    return {
        send: (mu) => {
            if (closed || ws.readyState !== WebSocket.OPEN)
                return;
            ws.send(mu);
        },
        close: () => {
            if (closed)
                return;
            try {
                ws.send(JSON.stringify({ type: "CloseStream" }));
            }
            catch {
                /* ignore */
            }
            ws.close();
        },
    };
}
