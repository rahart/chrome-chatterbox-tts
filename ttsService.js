// ttsService.js — Optional engine wrapper if you want to keep engines separated.
// In MV3 SW, you *can't* use Web Speech directly; use the offscreen page for both engines.

async function ensureOffscreen() {
    if (chrome.offscreen && chrome.offscreen.hasDocument) {
      const has = await chrome.offscreen.hasDocument();
      if (!has) {
        await chrome.offscreen.createDocument({
          url: "offscreen.html",
          reasons: ["AUDIO_PLAYBACK"],
          justification: "Reliable audio playback and Web Speech synthesis"
        });
      }
    }
  }
  
  async function offscreenMsg(message) {
    await ensureOffscreen();
    return chrome.runtime.sendMessage(message);
  }
  
  export const engines = {
    async webspeech({ text, rate = 1.0, pitch = 1.0, voiceName = "" }) {
      return offscreenMsg({ type: "offscreen:webspeechSpeak", payload: { text, rate, pitch, voiceName } });
    },
    async chatterbox({ text, apiBase, jwt, rate = 1.0, pitch = 1.0, voiceName = "" }) {
      if (!apiBase) throw new Error("Missing apiBase for chatterbox engine");
      const res = await fetch(`${apiBase.replace(/\/+$/,'')}/synthesize`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(jwt ? { "Authorization": `Bearer ${jwt}` } : {})
        },
        body: JSON.stringify({ text, rate, pitch, voice: voiceName || undefined })
      });
      if (!res.ok) throw new Error(`TTS API ${res.status}`);
      const arr = await res.arrayBuffer();
      return offscreenMsg({ type: "offscreen:playAudio", arrayBuffer: arr });
    },
    stop() { return offscreenMsg({ type: "offscreen:stop" }); }
  };
  