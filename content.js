// Check if this script has already been injected
if (!window.__ttsExtensionInitialized) {
  window.__ttsExtensionInitialized = true;
  
  // Audio context for playing audio
  let audioContext = null;
  let currentAudioSource = null;
  let isExtensionContextValid = true;
  let audioQueue = [];
  let isPlaying = false;
  let audioUnlocked = false;

  // Check if extension context is still valid
  function checkExtensionContext() {
    const isValid = !!chrome.runtime?.id;
    if (!isValid && isExtensionContextValid) {
      isExtensionContextValid = false;
      console.log('Extension context invalidated');
      cleanup();
    }
    return isValid;
  }

  // Clean up resources
  function cleanup() {
    stopPlayback();
    hideSelectionIndicator();
    
    // Don't close the audio context, just suspend it
    if (audioContext && audioContext.state !== 'closed') {
      audioContext.suspend();
    }
  }

  function stopPlayback() {
    if (currentAudioSource) {
      try {
        currentAudioSource.stop();
      } catch (e) {
        console.error('Error stopping audio:', e);
      } finally {
        currentAudioSource = null;
      }
    }
    isPlaying = false;
  }

  // Initialize audio context on user interaction
  async function initAudioContext() {
    if (!checkExtensionContext()) return null;
    
    // Create new audio context if needed
    if (!audioContext || audioContext.state === 'closed') {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      console.log('Audio context created');
      audioUnlocked = false;
    }
    
    // Resume the audio context if it's suspended
    if (audioContext.state === 'suspended') {
      try {
        await audioContext.resume();
        console.log('Audio context resumed');
      } catch (error) {
        console.error('Error resuming audio context:', error);
        return null;
      }
    }
    
    return audioContext;
  }

  // Unlock audio on first user interaction
  function unlockAudio() {
    if (audioUnlocked) return;
    
    // Create empty buffer and play it to unlock audio
    const buffer = audioContext.createBuffer(1, 1, 22050);
    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);
    source.start(0);
    
    // Stop immediately
    source.stop(0);
    
    // Mark as unlocked
    audioUnlocked = true;
    console.log('Audio unlocked');
  }

  // Play audio from base64 data
  async function playAudio(base64Data) {
    if (!checkExtensionContext()) return;
    
    try {
      // Initialize audio context if needed
      const context = await initAudioContext();
      if (!context) {
        throw new Error('Could not initialize audio context');
      }
      
      // Unlock audio on first play
      if (!audioUnlocked) {
        unlockAudio();
      }
      
      // Decode base64 to ArrayBuffer
      const binaryString = atob(base64Data);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      
      // Ensure context is running
      if (context.state !== 'running') {
        await context.resume();
      }
      
      // Decode the audio data
      const audioBuffer = await context.decodeAudioData(bytes.buffer);
      
      // Stop any currently playing audio
      stopPlayback();
      
      // Create and configure audio source
      currentAudioSource = context.createBufferSource();
      currentAudioSource.buffer = audioBuffer;
      currentAudioSource.connect(context.destination);
      
      // Set up event handlers
      currentAudioSource.onended = () => {
        console.log('Playback finished');
        currentAudioSource = null;
        isPlaying = false;
      };
      
      currentAudioSource.onerror = (error) => {
        console.error('Playback error:', error);
        currentAudioSource = null;
        isPlaying = false;
      };
      
      // Start playback
      currentAudioSource.start(0);
      isPlaying = true;
      
      console.log('Playback started');
      return true;
      
    } catch (error) {
      console.error('Error playing audio:', error);
      isPlaying = false;
      throw error;
    }
  }

  // Handle incoming messages
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (!checkExtensionContext()) return false;
    
    console.log('Message received in content script:', request.action);
    
    // Handle audio playback
    if (request.action === 'playAudio' && request.audioData) {
      console.log('Received audio data for playback');
      
      playAudio(request.audioData).then(() => {
        sendResponse({ status: 'playing' });
      }).catch(error => {
        console.error('Playback error:', error);
        sendResponse({ status: 'error', error: error.message });
      });
      
      return true; // Keep the message channel open for async response
    }
    
    // Handle ping messages
    if (request.action === 'ping') {
      sendResponse({ status: 'pong' });
      return true;
    }
    
    return false;
  });
  
  // Clean up when the page is unloaded
  window.addEventListener('unload', cleanup);
  
  console.log('TTS content script initialized');
}
