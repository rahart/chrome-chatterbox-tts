import ttsService from './ttsService.js';

console.log('TTS Extension: Background script loaded');

// Initialize extension on install and update settings
async function initExtension() {
  console.log('TTS Extension: Initializing...');
  
  // Load saved settings
  const settings = await new Promise((resolve) => {
    chrome.storage.sync.get(['apiHost', 'apiToken', 'rate', 'pitch', 'voice', 'chunkSize', 'useLocalModel'], resolve);
  });
  
  // Initialize TTS service with saved settings
  if (settings.apiHost) {
    ttsService.setApiHost(settings.apiHost);
    console.log('TTS: API host set to:', settings.apiHost);
  }
  
  if (settings.apiToken) {
    ttsService.setApiToken(settings.apiToken);
    console.log('TTS: API token set');
  }
  
  // Set default settings if not already set
  const defaultSettings = {
    rate: 1,
    pitch: 1,
    voice: 'default',
    chunkSize: 2000,
    useLocalModel: false,
    ...settings // Keep any existing settings
  };
  
  await chrome.storage.sync.set(defaultSettings);
  
  // Create context menu item
  chrome.contextMenus.create({
    id: 'speakSelectedText',
    title: 'Speak with TTS',
    contexts: ['selection'],
    documentUrlPatterns: ['<all_urls>']
  });
  
  console.log('TTS Extension: Initialization complete');
}

// Initialize the extension
initExtension().catch(console.error);

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener((info, tab) => {
  console.log('Context menu clicked:', info.menuItemId);
  
  if (info.menuItemId === 'speakSelectedText' && info.selectionText) {
    console.log('Processing selected text from context menu');
    processAndPlayText(info.selectionText);
  }
});

// Text processing and playback queue
let isPlaying = false;
let audioQueue = [];
let currentAudio = null;
let activeTabId = null;
let contentScriptInjected = new Set();

// Get the active tab ID
async function getActiveTab() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0] || null;
  } catch (error) {
    console.error('Error getting active tab:', error);
    return null;
  }
}

// Ensure content script is injected and ready
async function ensureContentScriptInjected(tabId) {
  if (contentScriptInjected.has(tabId)) {
    return true;
  }

  try {
    // Check if we can communicate with the content script
    try {
      await chrome.tabs.sendMessage(tabId, { action: 'ping' });
      contentScriptInjected.add(tabId);
      return true;
    } catch (e) {
      console.log('Content script not yet injected, injecting now...');
    }

    // If we can't communicate, inject the content script
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    });
    
    console.log('Content script injected into tab', tabId);
    contentScriptInjected.add(tabId);
    return true;
  } catch (error) {
    console.error('Error injecting content script:', error);
    return false;
  }
}

// Handle tab updates and removals
chrome.tabs.onRemoved.addListener((tabId) => {
  contentScriptInjected.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    contentScriptInjected.delete(tabId);
  }
});

// Send a message to the content script with retry logic
async function sendToContentScript(tabId, message, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      // Ensure the content script is injected
      const injected = await ensureContentScriptInjected(tabId);
      if (!injected) {
        throw new Error('Failed to inject content script');
      }

      // Try to send the message
      const response = await chrome.tabs.sendMessage(tabId, message);
      return response;
    } catch (error) {
      console.log(`Attempt ${i + 1} failed:`, error.message);
      
      if (i === retries - 1) {
        throw error; // Rethrow on last attempt
      }
      
      // Small delay before retry
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
}

async function processAndPlayText(text) {
  console.log('Processing text, length:', text.length);
  
  try {
    const settings = await new Promise((resolve) => {
      chrome.storage.sync.get(['chunkSize', 'useLocalModel', 'voice', 'rate', 'pitch'], resolve);
    });
    
    const chunks = chunkText(text, settings.chunkSize || 2000);
    console.log('Split text into', chunks.length, 'chunks');
    
    // Add chunks to queue
    for (const chunk of chunks) {
      audioQueue.push({
        text: chunk,
        voice: settings.voice,
        options: {
          speed: settings.rate,
          pitch: settings.pitch
        },
        useLocalModel: settings.useLocalModel,
        isLastChunk: false
      });
    }
    
    // Mark the last chunk
    if (audioQueue.length > 0) {
      audioQueue[audioQueue.length - 1].isLastChunk = true;
    }
    
    // Start playback if not already playing
    if (!isPlaying) {
      playNextChunk();
    } else {
      console.log('Added to queue, currently playing');
    }
  } catch (error) {
    console.error('Error processing text:', error);
  }
}

async function playNextChunk() {
  if (audioQueue.length === 0) {
    console.log('Queue empty, stopping playback');
    isPlaying = false;
    return;
  }

  const chunk = audioQueue.shift();
  console.log('Playing chunk, remaining in queue:', audioQueue.length);
  
  try {
    const tab = await getActiveTab();
    if (!tab) {
      console.error('No active tab found');
      return;
    }
    
    activeTabId = tab.id;
    
    // Ensure content script is injected
    await ensureContentScriptInjected(activeTabId);
    
    // Get current settings in case they've changed
    const settings = await new Promise((resolve) => {
      chrome.storage.sync.get(['apiHost', 'apiToken', 'rate', 'pitch', 'voice'], resolve);
    });
    
    // Update TTS service with latest settings
    if (settings.apiHost) {
      ttsService.setApiHost(settings.apiHost);
    }
    
    if (settings.apiToken) {
      ttsService.setApiToken(settings.apiToken);
    }
    
    // Use the voice from settings if not specified in the chunk
    const voiceId = chunk.voice || settings.voice || 'default';
    
    // Use the rate and pitch from settings if not specified in the chunk
    const options = {
      speed: chunk.options?.speed || settings.rate || 1.0,
      pitch: chunk.options?.pitch || settings.pitch || 1.0,
      ...chunk.options
    };
    
    console.log('Generating speech with voice:', voiceId, 'and options:', options);
    
    // Generate speech for the chunk
    const audioData = await ttsService.generateSpeech(chunk.text, voiceId, options);
    
    // Convert ArrayBuffer to base64 for sending to content script
    const base64Audio = arrayBufferToBase64(audioData);
    
    // Send to content script for playback
    await sendToContentScript(activeTabId, {
      action: 'playAudio',
      audioData: base64Audio,
      isLastChunk: chunk.isLastChunk
    });
    
    console.log('Audio sent to content script');
    
    // Play next chunk after a short delay
    setTimeout(playNextChunk, 100);
    
  } catch (error) {
    console.error('Error playing chunk:', error);
    
    // Try to play next chunk even if there was an error
    if (audioQueue.length > 0) {
      setTimeout(playNextChunk, 1000); // Add delay before retrying
    } else {
      isPlaying = false;
    }
  }
}

// Helper function to convert ArrayBuffer to base64
function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Handle messages from content script and popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('Message received:', request.action);
  
  if (request.action === 'processSelectedText' && request.text) {
    console.log('Processing selected text from message');
    processAndPlayText(request.text);
    sendResponse({ status: 'processing' });
  } else if (request.action === 'audioChunkPlaybackComplete') {
    console.log('Audio chunk playback complete, checking for next chunk');
    // If this was the last chunk and the queue is empty, we're done
    if (request.isLastChunk && audioQueue.length === 0) {
      console.log('All audio chunks played');
      isPlaying = false;
    } else if (!request.isLastChunk && audioQueue.length > 0) {
      // If there are more chunks, process the next one
      playNextChunk();
    }
  } else if (request.action === 'checkLocalModel') {
    sendResponse({ available: false });
  }
  
  return true; // Keep the message channel open for async response
});

function chunkText(text, chunkSize) {
  const chunks = [];
  
  // Split by sentences first for better natural breaks
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  
  let currentChunk = '';
  for (const sentence of sentences) {
    if ((currentChunk + sentence).length > chunkSize && currentChunk) {
      chunks.push(currentChunk.trim());
      currentChunk = '';
    }
    currentChunk += ' ' + sentence;
  }
  
  // Add the last chunk if there's any remaining text
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }
  
  return chunks;
}

// Clean up audio when extension is unloaded
chrome.runtime.onSuspend.addListener(() => {
  console.log('Extension suspended, cleaning up...');
  if (currentAudio) {
    if (currentAudio.source) {
      currentAudio.source.stop();
    }
    if (currentAudio.context) {
      currentAudio.context.close();
    }
    currentAudio = null;
  }
  audioQueue = [];
  isPlaying = false;
});

// Log when the service worker is started
console.log('TTS Extension: Service worker started');