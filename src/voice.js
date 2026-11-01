/** Optional local Whisper HTTP adapter. Deadlines include response body consumption. */
export const AUDIO_MAX_BYTES = 10_000_000;
export const WHISPER_TIMEOUT_MS = 5_000;
export const AUDIO_TYPES = new Set(["audio/webm", "audio/ogg", "audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp4", "audio/flac"]);

export async function transcribeAudio(bytes, mime, url) {
  const signal = AbortSignal.timeout(WHISPER_TIMEOUT_MS);
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mime }), "voice." + ({ "audio/webm": "webm", "audio/ogg": "ogg", "audio/wav": "wav", "audio/x-wav": "wav", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/flac": "flac" }[mime]));
  form.append("model", "whisper-1");
  const response = await fetch(url, { method: "POST", body: form, signal });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Whisper returned HTTP ${response.status}; check WHISPER_URL and its server logs.`); }
  // Bound a malicious/misconfigured upstream response too.
  let text = "", count = 0;
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    count += chunk.byteLength;
    if (count > 1_000_000) throw new Error("Whisper response exceeded 1 MB.");
    text += decoder.decode(chunk, { stream: true });
  }
  text += decoder.decode();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("Whisper returned invalid JSON; check the transcription endpoint."); }
  if (typeof data.text !== "string") throw new Error("Whisper response has no text field; use an OpenAI-compatible transcription endpoint.");
  return data.text;
}

/** HEAD does not submit audio. A 405 proves HTTP reachability, not transcription readiness. */
export async function checkVoice(url) {
  if (!url) return ["skip", "voice: WHISPER_URL not configured — optional server transcription disabled; browser speech recognition is separate"];
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("use an http(s) URL");
    const response = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(WHISPER_TIMEOUT_MS) });
    await response.body?.cancel();
    if (response.ok || response.status === 405) return ["ok", `voice: Whisper HTTP endpoint reachable (HTTP ${response.status}); transcription not verified`];
    return ["warn", `voice: Whisper returned HTTP ${response.status} — check WHISPER_URL, authentication and server logs`];
  } catch {
    return ["warn", "voice: Whisper unreachable or timed out — check WHISPER_URL and start the transcription server"];
  }
}
