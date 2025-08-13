/* MV3 service worker — Chatterbox TTS
 * Owns queue/state, talks to offscreen document for all audio/TTS work.
 * Exposes a small message API for content scripts + popup.
 */

const DEFAULT_SETTINGS = {
  engine: "webspeech",     // "webspeech" | "chatterbox"
  rate: 1.0,
  pitch: 1.0,
  voiceName: "",
  apiBase: "",             // your self-hosted TTS API base
  jwt: "",                  // bearer JWT for your API
  format: "wav",            // "mp3" | "wav" | "m4a"
  temperature: 0.8
};

let state = {
  playing: false,
  queue: [],              // [{ text, meta }]
  current: null,          // { text, … }
  startedAt: 0,
  elapsedMs: 0,
  settings: { ...DEFAULT_SETTINGS },
};
let reqSeq = 0;

// ---------- Offscreen management ----------
async function ensureOffscreen() {
  if (chrome.offscreen && chrome.offscreen.hasDocument) {
    const has = await chrome.offscreen.hasDocument();
    if (has) return;
  }
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["AUDIO_PLAYBACK"],
    justification: "Reliable audio playback and Web Speech synthesis"
  });
}

async function sendToOffscreen(message) {
  await ensureOffscreen();
  return chrome.runtime.sendMessage(message);
}

// ---------- Playback control ----------
async function playNext() {
  if (state.playing || state.queue.length === 0) return;
  state.current = state.queue.shift();
  state.playing = true;
  state.startedAt = Date.now();
  console.log('[TTS] playNext -> playing current len=', (state.current?.text||'').length, 'queue=', state.queue.length);

  broadcastToActiveTabs({ type: "tts:state", playing: true });

  try {
    await speakViaEngine(state.current.text);
    // Offscreen will notify "offscreen:ended" too; this is our fallback.
  } catch (e) {
    console.warn("speakViaEngine error:", e);
    await stopPlayback();
  }
}

async function stopPlayback() {
  console.log('[TTS] stopPlayback called');
  try { await sendToOffscreen({ type: "offscreen:stop" }); } catch {}
  state.playing = false;
  state.current = null;
  state.elapsedMs = 0;
  broadcastToActiveTabs({ type: "tts:state", playing: false });
}

async function pausePlayback() {
  console.log('[TTS] pausePlayback called');
  try { await sendToOffscreen({ type: "offscreen:pause" }); } catch {}
  state.playing = false;
  // keep state.current so we can resume
  broadcastToActiveTabs({ type: "tts:state", playing: false });
}

async function resumePlayback() {
  console.log('[TTS] resumePlayback called');
  try { await sendToOffscreen({ type: "offscreen:resume" }); } catch {}
  state.playing = true;
  broadcastToActiveTabs({ type: "tts:state", playing: true });
}

async function speakViaEngine(text) {
  const { engine, rate, pitch, voiceName, apiBase, jwt, format, temperature } = state.settings;
  const rid = ++reqSeq;
  const t0 = performance.now();
  console.log('[TTS]', rid, 'speakViaEngine start', { engine, rate, pitch, voiceName, apiBase, fmt: 'wav' });

  if (engine === "webspeech") {
    await sendToOffscreen({
      type: "offscreen:webspeechSpeak",
      payload: { text, rate, pitch, voiceName }
    });
  } else if (engine === "chatterbox") {
    // OpenAPI-compatible Chatterbox TTS endpoint
    if (!apiBase) throw new Error("Missing apiBase for chatterbox engine");
    const base = apiBase.replace(/\/+$/, "");
    const fmt = 'wav';
    // Append query param as an extra hint for servers that read it from URL
    const url = `${base}/v1/audio/speech`;
    console.log('[TTS]', rid, 'POST', url);

    const headers = {
      "Content-Type": "application/json",
      // Prefer audio responses; no SSE
      "Accept": "audio/*,application/octet-stream,application/json",
      ...(jwt ? { "Authorization": `Bearer ${jwt}` } : {})
    };

    const body = {
      input: text,
      voice: voiceName || "default",
      //speed: rate ?? 1.0,
      //pitch: pitch ?? 1.0,
      // Request plain WAV for maximum compatibility (no streaming)
      //response_format: fmt,        // 'wav'
      //stream_format: "audio",        // disable streaming
      // keep aliases for broader compatibility
      //format: fmt,
      //audio_format: fmt,
      //response_format_hint: fmt,
      //codec: 'pcm_s16le',
      // tuning
      //temperature: temperature
    };
    console.log('[TTS]', rid, 'headers', headers);
    try { console.log('[TTS]', rid, 'body', JSON.stringify({ ...body, input: (text||'').slice(0,120) + ((text||'').length>120?'…':'') })); } catch {}

    // Fetch audio from API
    const tFetch0 = performance.now();
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });
    const tFetch1 = performance.now();
    console.log('[TTS]', rid, 'response', res.status, 'timeMs=', Math.round(tFetch1 - tFetch0));
    if (!res.ok) {
      const errTxt = await res.text().catch(() => '');
      console.error('TTS API error:', res.status, errTxt?.slice?.(0, 300));
      throw new Error(`TTS API ${res.status}`);
    }

    // Determine content type and forward to offscreen with mime
    const mime = (res.headers.get('content-type') || '').toLowerCase();
    console.log('[TTS]', rid, 'content-type=', mime || '(none)');

    // 1) SSE streaming disabled
    if (false && mime.includes('text/event-stream') && res.body && typeof res.body.getReader === 'function') {
      try {
        const reader = res.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        let started = false;
        let streamMime = (fmt === 'mp3') ? 'audio/mpeg' : (fmt === 'm4a' ? 'audio/mp4' : 'audio/wav');
        const chunkBuf = []; // accumulate for fallback or MP3 path
        let useMse = false;
        let loggedFirstMeta = false;
        let appendedCount = 0;
        let mseChecked = false;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const rawEvent = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const lines = rawEvent.split(/\n/).map(l => l.replace(/\r$/, ''));
            let dataLines = [];
            for (const line of lines) {
              if (line.startsWith('data:')) dataLines.push(line.slice(5));
            }
            const dataStr = dataLines.join('\n').trim();
            if (!dataStr) continue;
            if (dataStr === '[DONE]') { break; }
            let parsed = null; try { parsed = JSON.parse(dataStr); } catch {}
            let b64 = null;
            if (parsed) {
              if (parsed.mime) {
                streamMime = String(parsed.mime);
                if (!loggedFirstMeta) { console.log('SSE meta mime:', streamMime, 'codec:', parsed.codec || ''); loggedFirstMeta = true; }
              }
              if (parsed.codec && !loggedFirstMeta) { console.log('SSE codec:', parsed.codec); loggedFirstMeta = true; }
              if (parsed.url || parsed.audio_url) {
                const playUrl = parsed.url || parsed.audio_url;
                console.log('[TTS]', rid, 'SSE provided URL, ignored (streaming disabled):', playUrl);
              }
              b64 = parsed.audio || parsed.chunk || null;
            } else {
              b64 = dataStr;
            }
            if (!b64) continue;
            chunkBuf.push(b64);
          }
        }
        console.log('[TTS]', rid, 'SSE disabled path completed');
        return;
      } catch (e) {
        console.warn('SSE streaming failed, falling back:', e);
        // fall through
      }
    }

    // 2) MSE streaming disabled
    const mseCapable = false;
    if (res.body && mseCapable && typeof res.body.getReader === 'function') {
      try {
        // Initialize MSE pipeline in offscreen
        await sendToOffscreen({ type: 'offscreen:mseStart', mimeType: mime });
        const reader = res.body.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value && value.byteLength) {
            // Send chunk as base64 to avoid structured-clone issues
            const b64 = bufToBase64(value.buffer);
            await sendToOffscreen({ type: 'offscreen:mseAppend', b64 });
          }
        }
        await sendToOffscreen({ type: 'offscreen:mseEnd' });
        return;
      } catch (e) {
        console.warn('MSE streaming failed, falling back to full buffer:', e);
        // Intentionally fall through to full-buffer path
      }
    }

    // Non-JSON and not MSE-streamable: full-buffer path
    if (!mime.includes('application/json')) {
      const tArr0 = performance.now();
      const buf = await res.arrayBuffer();
      const tArr1 = performance.now();
      const sig = Array.from(new Uint8Array(buf.slice(0, 12))).map(b => b.toString(16).padStart(2,'0')).join(' ');
      console.log('[TTS]', rid, 'bytes', buf.byteLength, 'mime', mime || 'unknown', 'sig', sig, 'arrMs', Math.round(tArr1 - tArr0));
      const b64 = bufToBase64(buf);
      console.log('[TTS]', rid, 'send offscreen:playAudio', 'mimeType=', mime || 'audio/wav');
      await sendToOffscreen({ type: "offscreen:playAudio", b64, mimeType: mime || (fmt === 'mp3' ? 'audio/mpeg' : (fmt === 'm4a' ? 'audio/mp4' : 'audio/wav')) });
    } else {
      // JSON wrapper: attempt to read base64 or audio URL
      const data = await res.json();
      console.log('[TTS]', rid, 'json keys=', Object.keys(data||{}));
      if (data?.audio) {
        console.log('[TTS]', rid, 'json:audio base64 length=', (data.audio||'').length);
        await sendToOffscreen({ type: 'offscreen:playAudio', b64: data.audio, mimeType: data?.mime || (fmt === 'mp3' ? 'audio/mpeg' : (fmt === 'm4a' ? 'audio/mp4' : 'audio/wav')) });
      } else if (data?.audio_url || data?.url) {
        const audioUrl = data.audio_url || data.url;
        console.log('[TTS]', rid, 'json:audio_url', audioUrl);
        // Fetch bytes and play (no progressive/audio element streaming)
        const r2 = await fetch(audioUrl, { headers: jwt ? { 'Authorization': `Bearer ${jwt}` } : undefined });
        if (!r2.ok) throw new Error(`Audio URL fetch ${r2.status}`);
        const mime2 = r2.headers.get('content-type') || 'audio/wav';
        const buf2 = await r2.arrayBuffer();
        const sig2 = Array.from(new Uint8Array(buf2.slice(0, 12))).map(b => b.toString(16).padStart(2,'0')).join(' ');
        console.log('TTS url bytes:', buf2.byteLength, 'mime:', mime2, 'sig:', sig2);
        const b64_2 = bufToBase64(buf2);
        await sendToOffscreen({ type: 'offscreen:playAudio', b64: b64_2, mimeType: mime2 });
      } else {
        console.warn('TTS JSON response without audio/audio_url');
      }
    }
    const t1 = performance.now();
    console.log('[TTS]', rid, 'speakViaEngine done', 'elapsedMs', Math.round(t1 - t0));
  } else {
    throw new Error(`Unknown engine: ${engine}`);
  }
}

// ---------- Helpers ----------
function bufToBase64(buf) {
  let binary = '';
  const bytes = new Uint8Array(buf);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// ---------- Messaging (from content scripts & popup) ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case "tts:enqueue": {
        const text = String(msg.text || "").trim();
        if (!text) return sendResponse({ ok: false, error: "empty" });
        state.queue.push({ text, meta: msg.meta || {} });
        playNext();
        sendResponse({ ok: true, queued: state.queue.length });
        break;
      }
      case "tts:toggle": {
        if (state.playing) {
          // Pause current playback but keep current track to allow resume
          await pausePlayback();
          sendResponse({ playing: false });
        } else if (state.current) {
          // Resume current track
          await resumePlayback();
          sendResponse({ playing: true });
        } else {
          // Nothing current, start next in queue
          playNext();
          sendResponse({ playing: true });
        }
        break;
      }
      case "tts:stop": {
        await stopPlayback();
        state.queue.length = 0;
        sendResponse({ ok: true });
        break;
      }
      case "tts:getState": {
        sendResponse({
          playing: state.playing,
          queue: state.queue.length,
          current: state.current,
          settings: state.settings
        });
        break;
      }
      case "tts:setSettings": {
        state.settings = { ...state.settings, ...(msg.settings || {}) };
        // Keep canonical engine also at root for convenience
        if (msg.settings?.engine) state.settings.engine = msg.settings.engine;
        await chrome.storage.sync.set({ settings: state.settings });
        sendResponse({ ok: true, settings: state.settings });
        break;
      }
      case "settings:getVoices": {
        // Ask offscreen (which has window.speechSynthesis) for voices
        try {
          const voices = await sendToOffscreen({ type: "offscreen:getVoices" });
          sendResponse({ ok: true, voices: voices || [] });
        } catch (e) {
          sendResponse({ ok: false, error: String(e) });
        }
        break;
      }
      default:
        // Messages from offscreen are also delivered here (see below)
        break;
    }
  })();
  // Return true to keep sendResponse async
  return true;
});

// ---------- Messages FROM offscreen ----------
chrome.runtime.onMessage.addListener((msg) => {
  // These originate from offscreen.js
  if (msg?.from !== "offscreen") return;

  if (msg.type === "offscreen:elapsed") {
    state.elapsedMs = msg.elapsedMs || 0;
    broadcastToActiveTabs({ type: "tts:elapsed", elapsedMs: state.elapsedMs });
  } else if (msg.type === "offscreen:ended") {
    console.log('[TTS] offscreen:ended received');
    state.playing = false;
    state.current = null;
    broadcastToActiveTabs({ type: "tts:state", playing: false });
    // Auto-advance
    setTimeout(playNext, 0);
  } else if (msg.type === 'offscreen:log') {
    console.log('[Offscreen]', msg.message || msg);
  } else if (msg.type === 'offscreen:error') {
    console.warn('[OffscreenError]', msg.message || msg);
  }
});

// ---------- Context menus (quality of life) ----------
chrome.runtime.onInstalled.addListener(() => {
  try {
    chrome.contextMenus.create({ id: "read-selection", title: "Read selection", contexts: ["selection"] });
    chrome.contextMenus.create({ id: "read-page", title: "Read page", contexts: ["page"] });
  } catch {}
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === "read-selection" && info.selectionText) {
    chrome.tabs.sendMessage(tab.id, { type: "tts:enqueue", text: info.selectionText });
  } else if (info.menuItemId === "read-page") {
    chrome.tabs.sendMessage(tab.id, { type: "tts:enqueuePage" });
  }
});

// ---------- Commands ----------
chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-play-pause") {
    if (state.playing) stopPlayback(); else playNext();
  }
});

// ---------- Utility ----------
function broadcastToActiveTabs(payload) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    for (const t of tabs) {
      if (t.id) chrome.tabs.sendMessage(t.id, payload).catch?.(() => {});
    }
  });
}

// ---------- Bootstrap: load settings ----------
(async () => {
  const { settings } = await chrome.storage.sync.get("settings");
  state.settings = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  // Proactively spin up offscreen once to avoid first-play latency and gesture issues
  try { await ensureOffscreen(); } catch (e) { console.warn('ensureOffscreen at boot failed:', e); }
})();