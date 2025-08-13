// offscreen.js — runs in OffscreenDocument for audio + Web Speech
// Receives messages from background and replies or emits progress/ended events

let audioEl = null;
let progressTimer = null;
let audioCtx = null;
let bufferSource = null;
// Track WebAudio state for pause/resume
let waBuffer = null;           // AudioBuffer
let waOffset = 0;              // seconds into buffer
let waStartedAt = 0;           // audioCtx.currentTime at (re)start
// MSE streaming state
let mediaSource = null;
let sourceBuffer = null;
let mseUrl = '';
let mseQueue = [];
let mseOpen = false;
let mseAppending = false;
let mseStarted = false;
let mseHadBuffered = false; // whether any time ranges were buffered
let mseClosed = false;     // whether MSE has been closed/ended

// ---- Helpers ----
function clearProgressTimer() {
  if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
}

function emit(type, payload = {}) {
  chrome.runtime.sendMessage({ from: 'offscreen', type, ...payload }).catch(() => {});
}

function normalizeMime(mime) {
  if (!mime || typeof mime !== 'string') return 'audio/mpeg';
  const lower = mime.toLowerCase().split(';')[0].trim();
  return lower.startsWith('audio/') ? lower : 'audio/mpeg';
}

async function playViaWebAudio(arrayBuffer) {
  try {
    if (!audioCtx) {
      audioCtx = new (self.AudioContext || self.webkitAudioContext)();
      emit('offscreen:log', { message: `AudioContext created sr=${audioCtx.sampleRate}` });
    }
    if (audioCtx.state === 'suspended') {
      await audioCtx.resume().catch(() => {});
    }
    const decoded = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
    waBuffer = decoded; // store for resume
    // Stop any old source
    try { if (bufferSource) bufferSource.stop(0); } catch {}
    bufferSource = audioCtx.createBufferSource();
    bufferSource.buffer = decoded;
    bufferSource.connect(audioCtx.destination);
    waStartedAt = audioCtx.currentTime; // (re)start anchor
    bufferSource.onended = () => {
      clearProgressTimer();
      emit('offscreen:log', { message: 'webaudio ended' });
      emit('offscreen:ended');
      bufferSource = null;
      waBuffer = null;
      waOffset = 0;
      waStartedAt = 0;
    };
    bufferSource.start(0, waOffset);

    clearProgressTimer();
    progressTimer = setInterval(() => {
      // WebAudio has no currentTime per source; emit heartbeat
      emit('offscreen:elapsed', { elapsedMs: 0 });
    }, 1000);
    return true;
  } catch (e) {
    emit('offscreen:log', { message: `webaudio decode/play failed: ${e?.message || e}` });
    return false;
  }
}

async function playArrayBuffer(arrayBuffer, mime = 'audio/mpeg') {
  const size = arrayBuffer ? arrayBuffer.byteLength : 0;
  const normMime = normalizeMime(mime);
  emit('offscreen:log', { message: `playArrayBuffer: size=${size} mime=${normMime}` });

  const tryPlayHtmlAudio = async (useMime) => {
    try {
      // Stop any previous playback
      if (audioEl) {
        try { audioEl.pause(); } catch {}
        try { URL.revokeObjectURL(audioEl.src); } catch {}
      }
      const blob = new Blob([new Uint8Array(arrayBuffer)], { type: useMime });
      const url = URL.createObjectURL(blob);

      audioEl = new Audio();
      audioEl.src = url;
      audioEl.preload = 'auto';

      // Wrap playback in a promise that resolves true on start, false on error
      const started = await new Promise(async (resolve) => {
        let resolved = false;
        audioEl.onended = () => {
          clearProgressTimer();
          emit('offscreen:log', { message: 'audio ended' });
          emit('offscreen:ended');
          try { URL.revokeObjectURL(url); } catch {}
          audioEl = null;
          if (!resolved) { resolved = true; /* ended after start: keep as started */ }
        };
        audioEl.onerror = () => {
          clearProgressTimer();
          emit('offscreen:log', { message: `audio error for ${useMime}: code=${audioEl?.error?.code}` });
          try { URL.revokeObjectURL(url); } catch {}
          audioEl = null;
          if (!resolved) { resolved = true; resolve(false); }
        };
        audioEl.onplay = () => {
          // Playback successfully started
          if (!resolved) {
            // Start progress timer on first play
            clearProgressTimer();
            progressTimer = setInterval(() => {
              if (!audioEl) return;
              emit('offscreen:elapsed', { elapsedMs: Math.floor((audioEl.currentTime || 0) * 1000) });
            }, 500);
            resolved = true;
            resolve(true);
          }
        };

        // Kick off playback
        try {
          const p = audioEl.play();
          if (p && typeof p.then === 'function') {
            await p.catch(() => {});
          }
          // If the browser doesn't fire onplay synchronously, we'll wait for it
          // The onerror or onplay handler will resolve the promise
        } catch (e) {
          // play() itself rejected
          if (!resolved) { resolved = true; resolve(false); }
        }
      });

      if (!started) return false;
      return true;
    } catch (e) {
      return false;
    }
  };

  // 1) Try HTMLAudio with server mime then common fallbacks
  const candidates = [
    normMime,
    'audio/mpeg',
    'audio/wav',
    'audio/x-wav',
    'audio/ogg',
    'audio/webm'
  ];
  for (const m of candidates) {
    const ok = await tryPlayHtmlAudio(m);
    if (ok) return;
  }

  // 2) Fallback: try WebAudio decode/play
  const waOk = await playViaWebAudio(arrayBuffer);
  if (waOk) return;

  // If none worked, emit ended and log
  emit('offscreen:log', { message: 'all playback attempts failed' });
  emit('offscreen:ended');
}

function stopAll() {
  clearProgressTimer();
  // HTMLAudio (file/blob/MSE) path
  try { if (audioEl) { audioEl.pause(); if (audioEl.src && audioEl.src.startsWith('blob:')) URL.revokeObjectURL(audioEl.src); } } catch {}
  audioEl = null;
  // WebAudio path
  try { if (bufferSource) { bufferSource.stop(0); } } catch {}
  bufferSource = null;
  waBuffer = null;
  waOffset = 0;
  waStartedAt = 0;
  // MSE cleanup
  try {
    if (sourceBuffer) {
      try { if (mediaSource && mediaSource.readyState === 'open') mediaSource.endOfStream(); } catch {}
      sourceBuffer.onupdateend = null;
      sourceBuffer = null;
    }
    if (mediaSource) {
      mediaSource.onsourceopen = null;
      mediaSource = null;
    }
    if (mseUrl) { try { URL.revokeObjectURL(mseUrl); } catch {} mseUrl = ''; }
  } catch {}
  try { if (audioCtx) { /* keep context for reuse to avoid startup cost */ } } catch {}
  try { window.speechSynthesis.cancel(); } catch {}
}

function ensureAudioEl() {
  if (!audioEl) {
    audioEl = new Audio();
    audioEl.preload = 'auto';
    audioEl.autoplay = true;
    audioEl.onended = () => {
      clearProgressTimer();
      emit('offscreen:log', { message: 'audio ended' });
      emit('offscreen:ended');
    };
    audioEl.onerror = () => {
      clearProgressTimer();
      emit('offscreen:log', { message: `audio error: code=${audioEl?.error?.code}` });
      emit('offscreen:ended');
    };
  }
  return audioEl;
}

// ---- MSE helpers ----
function b64ToBytes(b64) {
  const comma = String(b64).indexOf(',');
  const rawB64 = comma >= 0 ? String(b64).slice(comma + 1) : String(b64);
  const bin = atob(rawB64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function mseStart(mimeType) {
  stopAll(); // clean slate
  mseQueue = [];
  mseOpen = false;
  mseAppending = false;
  mseStarted = false;
  mseHadBuffered = false;
  mseClosed = false;
  mediaSource = new MediaSource();
  const el = ensureAudioEl();
  mseUrl = URL.createObjectURL(mediaSource);
  el.src = mseUrl;

  mediaSource.onsourceopen = () => {
    try {
      // Keep the duration open-ended for streaming
      try { mediaSource.duration = Infinity; } catch {}
      sourceBuffer = mediaSource.addSourceBuffer(mimeType);
      sourceBuffer.mode = 'sequence';
      sourceBuffer.onupdateend = () => {
        mseAppending = false;
        // Diagnostics: buffered/readyState
        try {
          const br = [];
          for (let i = 0; i < (el.buffered?.length || 0); i++) {
            const s = el.buffered.start(i), e = el.buffered.end(i);
            br.push([s, e]);
          }
          if (br.length > 0) mseHadBuffered = true;
          emit('offscreen:log', { message: `mse updateend buffered=${JSON.stringify(br)} rs=${el.readyState}` });
        } catch {}

        // Start playback once we have a tiny buffer
        if (!mseStarted) {
          let have = 0;
          try { if (el.buffered && el.buffered.length) have = el.buffered.end(0) - el.buffered.start(0); } catch {}
          if (have >= 0.15 || el.readyState >= 2 /* HAVE_CURRENT_DATA */) {
            mseStarted = true;
            el.play().catch(()=>{});
          }
        }
        if (mseQueue.length > 0 && !sourceBuffer.updating) {
          const chunk = mseQueue.shift();
          sourceBuffer.appendBuffer(chunk);
          mseAppending = true;
        }
      };
      sourceBuffer.onerror = (e) => {
        emit('offscreen:log', { message: `mse sourceBuffer error: ${e?.message || e}` });
      };
      mseOpen = true;
      // If chunks arrived before sourceopen, append first one immediately
      if (mseQueue.length > 0 && !sourceBuffer.updating) {
        const first = mseQueue.shift();
        sourceBuffer.appendBuffer(first);
        mseAppending = true;
      }
      // Start basic heartbeat early; will reflect currentTime once data buffered
      clearProgressTimer();
      progressTimer = setInterval(() => {
        emit('offscreen:elapsed', { elapsedMs: Math.floor((el.currentTime || 0) * 1000) });
      }, 500);
    } catch (e) {
      emit('offscreen:log', { message: `mse sourceopen failed: ${e?.message || e}` });
      emit('offscreen:ended');
    }
  };
  mediaSource.onsourceended = () => {
    mseOpen = false; mseClosed = true;
  };
  mediaSource.onsourceclose = () => {
    mseOpen = false; mseClosed = true;
  };
}

async function mseAppend(b64) {
  // If not ready yet and not closed, queue until sourceopen
  if ((!sourceBuffer || !mseOpen) && !mseClosed) {
    // Queue until sourceopen
    mseQueue.push(b64ToBytes(b64));
    return;
  }
  // If closed/ended, ignore further appends
  if (mseClosed || !mediaSource || mediaSource.readyState !== 'open' || !sourceBuffer) {
    emit('offscreen:log', { message: 'mse append skipped: source closed' });
    return;
  }
  try {
    const bytes = b64ToBytes(b64);
    if (sourceBuffer.updating || mseAppending) {
      mseQueue.push(bytes);
    } else {
      sourceBuffer.appendBuffer(bytes);
      mseAppending = true;
    }
  } catch (e) {
    emit('offscreen:log', { message: `mse append failed: ${e?.message || e}` });
  }
}

async function mseEnd() {
  try {
    if (!mediaSource) return;
    const finalize = () => {
      try { if (mediaSource.readyState === 'open') mediaSource.endOfStream(); } catch {}
      mseOpen = false; mseClosed = true;
      try { sourceBuffer && (sourceBuffer.onupdateend = null); } catch {}
      sourceBuffer = null;
    };
    if (sourceBuffer && (sourceBuffer.updating || mseAppending)) {
      const sb = sourceBuffer;
      const onEnd = () => { try { sb.removeEventListener('updateend', onEnd); } catch {}; finalize(); };
      try { sb.addEventListener('updateend', onEnd); } catch { finalize(); }
    } else {
      finalize();
    }
  } catch (e) {
    // ignore
  }
}

// ---- Web Speech ----
async function webspeechSpeak({ text, rate = 1.0, pitch = 1.0, voiceName = '' }) {
  return new Promise(async (resolve) => {
    try {
      stopAll();
      const utter = new SpeechSynthesisUtterance(text);
      utter.rate = rate; utter.pitch = pitch;
      const chooseVoice = () => {
        const voices = window.speechSynthesis.getVoices() || [];
        if (voiceName) {
          const v = voices.find(v => v.name === voiceName || v.voiceURI === voiceName);
          if (v) utter.voice = v;
        }
      };
      chooseVoice();
      if (!utter.voice) { await new Promise(r => setTimeout(r, 150)); chooseVoice(); }
      utter.onend = () => { clearProgressTimer(); emit('offscreen:ended'); resolve(); };
      utter.onerror = (ev) => { clearProgressTimer(); emit('offscreen:log', { message: `utterance error: ${ev?.error}` }); emit('offscreen:ended'); resolve(); };
      utter.onstart = () => { clearProgressTimer(); progressTimer = setInterval(() => emit('offscreen:elapsed', { elapsedMs: 0 }), 1000); };
      window.speechSynthesis.speak(utter);
    } catch (e) { clearProgressTimer(); emit('offscreen:ended'); resolve(); }
  });
}

// ---- Voices list ----
async function getVoices() {
  try {
    window.speechSynthesis.getVoices();
    await new Promise(r => setTimeout(r, 100));
    return (window.speechSynthesis.getVoices() || []).map(v => ({ name: v.name, lang: v.lang, default: !!v.default }));
  } catch { return []; }
}

// ---- Message router ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  let willRespondAsync = false;
  (async () => {
    switch (msg.type) {
      case 'offscreen:playAudio': {
        // Immediately acknowledge to avoid sender awaiting a response
        try { sendResponse?.({ ok: true }); } catch {}
        try {
          let arrayBuffer = msg.arrayBuffer;
          if (!arrayBuffer && msg.b64) {
            // Decode base64 → ArrayBuffer
            const bytes = b64ToBytes(msg.b64);
            arrayBuffer = bytes.buffer;
          }
          await playArrayBuffer(arrayBuffer, msg.mimeType);
        } catch (e) {
          emit('offscreen:log', { message: `handler playAudio exception: ${e?.message || e}` });
          emit('offscreen:ended');
        }
        break;
      }
      case 'offscreen:playUrl': {
        try { sendResponse?.({ ok: true }); } catch {}
        try {
          stopAll();
          const el = ensureAudioEl();
          el.src = msg.url;
          // Heartbeat while buffering/playing
          clearProgressTimer();
          progressTimer = setInterval(() => {
            try {
              const br = [];
              for (let i = 0; i < (el.buffered?.length || 0); i++) {
                br.push([el.buffered.start(i), el.buffered.end(i)]);
              }
              emit('offscreen:log', { message: `url play buffered=${JSON.stringify(br)} rs=${el.readyState}` });
            } catch {}
            emit('offscreen:elapsed', { elapsedMs: Math.floor((el.currentTime || 0) * 1000) });
          }, 500);
          await el.play().catch(()=>{});
        } catch (e) {
          emit('offscreen:log', { message: `playUrl failed: ${e?.message || e}` });
          emit('offscreen:ended');
        }
        break;
      }
      case 'offscreen:webspeechSpeak': {
        try { sendResponse?.({ ok: true }); } catch {}
        await webspeechSpeak(msg.payload || {});
        break;
      }
      case 'offscreen:stop': {
        stopAll();
        try { sendResponse?.({ ok: true }); } catch {}
        break;
      }
      case 'offscreen:pause': {
        // Pause HTMLAudio or WebAudio
        try {
          if (audioEl) {
            audioEl.pause();
          } else if (audioCtx) {
            if (bufferSource) {
              try {
                // accumulate elapsed into offset and stop source
                const elapsed = Math.max(0, audioCtx.currentTime - waStartedAt);
                waOffset += elapsed;
              } catch {}
              try { bufferSource.stop(0); } catch {}
              bufferSource = null;
            }
            // Leave waBuffer/waOffset so resume can restart
          }
        } catch {}
        try { sendResponse?.({ ok: true }); } catch {}
        break;
      }
      case 'offscreen:resume': {
        try {
          if (audioEl) {
            // resume HTMLAudio
            await audioEl.play().catch(()=>{});
          } else if (audioCtx && waBuffer) {
            if (audioCtx.state === 'suspended') {
              await audioCtx.resume().catch(()=>{});
            }
            // create a new source starting from waOffset
            try { if (bufferSource) bufferSource.stop(0); } catch {}
            bufferSource = audioCtx.createBufferSource();
            bufferSource.buffer = waBuffer;
            bufferSource.connect(audioCtx.destination);
            waStartedAt = audioCtx.currentTime;
            bufferSource.onended = () => {
              clearProgressTimer();
              emit('offscreen:log', { message: 'webaudio ended' });
              emit('offscreen:ended');
              bufferSource = null;
              waBuffer = null;
              waOffset = 0;
              waStartedAt = 0;
            };
            bufferSource.start(0, waOffset);
            // restart timer
            clearProgressTimer();
            progressTimer = setInterval(() => emit('offscreen:elapsed', { elapsedMs: 0 }), 1000);
          }
        } catch {}
        try { sendResponse?.({ ok: true }); } catch {}
        break;
      }
      case 'offscreen:getVoices': {
        willRespondAsync = true;
        const voices = await getVoices();
        try { sendResponse?.(voices); } catch {}
        break;
      }
      case 'offscreen:mseStart': {
        try { sendResponse?.({ ok: true }); } catch {}
        await mseStart(msg.mimeType || 'audio/webm');
        break;
      }
      case 'offscreen:mseAppend': {
        try { sendResponse?.({ ok: true }); } catch {}
        await mseAppend(msg.b64);
        break;
      }
      case 'offscreen:mseEnd': {
        try { sendResponse?.({ ok: true }); } catch {}
        await mseEnd();
        break;
      }
      case 'offscreen:getMseStatus': {
        // Report whether we have buffered any data
        try {
          const el = ensureAudioEl();
          const br = [];
          for (let i = 0; i < (el.buffered?.length || 0); i++) {
            br.push([el.buffered.start(i), el.buffered.end(i)]);
          }
          sendResponse?.({ ok: true, hadBuffered: mseHadBuffered || (br.length > 0), buffered: br, readyState: el.readyState });
        } catch {
          try { sendResponse?.({ ok: false, hadBuffered: false }); } catch {}
        }
        break;
      }
      default:
        break;
    }
  })();
  // Only return true (async) for getVoices where we respond later
  return willRespondAsync;
});