// popup.js — Chatterbox TTS settings UI logic
const $ = (id) => document.getElementById(id);

document.addEventListener("DOMContentLoaded", () => {
  loadSettings();
  $("save").addEventListener("click", saveSettings);
  $("test").addEventListener("click", testVoice);
});

async function loadSettings() {
  const { settings } = await chrome.storage.sync.get("settings");
  const s = Object.assign({
    engine: "webspeech",
    rate: 1.0,
    pitch: 1.0,
    voiceName: "",
    apiBase: "",
    jwt: "",
    format: "wav" // default to wav for compatibility
  }, settings || {});

  $("engine").value = s.engine;
  $("voiceName").value = s.voiceName || "";
  $("rate").value = s.rate;
  $("pitch").value = s.pitch;
  $("apiBase").value = s.apiBase || "";
  $("jwt").value = s.jwt || "";
  const fmtEl = $("format"); if (fmtEl) fmtEl.value = s.format || "wav";

  // Populate voice list from background (offscreen Web Speech)
  try {
    const resp = await chrome.runtime.sendMessage({ type: "settings:getVoices" });
    const voices = (resp && resp.ok) ? resp.voices : [];
    const voiceList = $("voiceList");
    voiceList.innerHTML = "";

    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "(choose a voice)";
    voiceList.appendChild(blank);

    for (const v of voices) {
      const o = document.createElement("option");
      o.value = v.name;
      o.textContent = `${v.name} — ${v.lang}${v.default ? " (default)" : ""}`;
      if (v.name === s.voiceName) o.selected = true;
      voiceList.appendChild(o);
    }

    voiceList.addEventListener("change", () => {
      $("voiceName").value = voiceList.value;
    });
  } catch (e) {
    console.warn("Failed to get voices:", e);
    // User can still type the voice name manually
  }
}

async function saveSettings() {
  const fmtEl = document.getElementById('format');
  const settings = {
    engine: $("engine").value,
    voiceName: $("voiceName").value.trim(),
    rate: parseFloat($("rate").value),
    pitch: parseFloat($("pitch").value),
    apiBase: $("apiBase").value.trim(),
    jwt: $("jwt").value.trim(),
    format: fmtEl ? fmtEl.value : 'wav'
  };
  await chrome.runtime.sendMessage({ type: "tts:setSettings", settings });
  window.close();
}

async function testVoice() {
  const txt = "This is a quick test of your text to speech settings.";
  await chrome.runtime.sendMessage({ type: "tts:enqueue", text: txt });
}