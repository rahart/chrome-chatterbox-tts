import ttsService from './ttsService.js';

document.addEventListener('DOMContentLoaded', function() {
  // UI Elements
  const apiHostInput = document.getElementById('apiHost');
  const apiTokenInput = document.getElementById('apiToken');
  const voiceSelect = document.getElementById('voiceSelect');
  const rateInput = document.getElementById('rate');
  const rateValue = document.getElementById('rateValue');
  const pitchInput = document.getElementById('pitch');
  const pitchValue = document.getElementById('pitchValue');
  const statusDiv = document.getElementById('status');
  const saveSettingsBtn = document.getElementById('saveSettings');
  const settingsToggle = document.getElementById('settingsToggle');
  const settingsContent = document.getElementById('settingsContent');

  // Toggle settings visibility
  settingsToggle.addEventListener('click', (e) => {
    e.preventDefault();
    settingsContent.classList.toggle('visible');
  });

  // Initialize the UI
  async function init() {
    // Load saved settings
    const settings = await chrome.storage.sync.get([
      'apiHost',
      'apiToken',
      'rate', 
      'pitch', 
      'voice',
      'useLocalModel'
    ]);
    
    // Set default values if not set
    if (settings.apiHost) {
      apiHostInput.value = settings.apiHost;
      ttsService.setApiHost(settings.apiHost);
    }
    
    if (settings.apiToken) {
      apiTokenInput.value = settings.apiToken;
      ttsService.setApiToken(settings.apiToken);
    }
    
    if (settings.rate) {
      rateInput.value = settings.rate;
      rateValue.textContent = settings.rate;
    }
    
    if (settings.pitch) {
      pitchInput.value = settings.pitch;
      pitchValue.textContent = settings.pitch;
    }

    // Load voices
    await loadVoices();
    
    // Select the previously selected voice if available
    if (settings.voice && voiceSelect) {
      voiceSelect.value = settings.voice;
    }
    
    // Update rate and pitch display when sliders change
    rateInput.addEventListener('input', () => {
      rateValue.textContent = rateInput.value;
    });
    
    pitchInput.addEventListener('input', () => {
      pitchValue.textContent = pitchInput.value;
    });
  }

  // Load available voices
  async function loadVoices() {
    try {
      showStatus('Loading voices...', 'info');
      
      // Ensure we have a valid API host
      if (!ttsService.getApiHost()) {
        showStatus('Please set the API host first', 'error');
        return;
      }
      
      const voices = await ttsService.loadVoices();
      
      // Clear existing options
      voiceSelect.innerHTML = '';
      
      // Add a default option
      const defaultOption = document.createElement('option');
      defaultOption.textContent = 'Select a voice...';
      defaultOption.value = '';
      voiceSelect.appendChild(defaultOption);
      
      // Add available voices
      voices.forEach(voice => {
        const option = document.createElement('option');
        option.textContent = voice.name || voice.voice_id;
        option.value = voice.voice_id;
        voiceSelect.appendChild(option);
      });
      
      hideStatus();
    } catch (error) {
      console.error('Error loading voices:', error);
      showStatus('Failed to load voices. Check your API host and try again.', 'error');
    }
  }

  // Save settings
  async function saveSettings() {
    const settings = {
      apiHost: apiHostInput.value.trim(),
      apiToken: apiTokenInput.value.trim() || null,
      rate: parseFloat(rateInput.value) || 1.0,
      pitch: parseFloat(pitchInput.value) || 1.0,
      voice: voiceSelect.value || 'default',
      useLocalModel: false // Always use remote API now
    };
    
    // Validate API host
    if (!settings.apiHost) {
      showStatus('Please enter an API host', 'error');
      return;
    }
    
    try {
      // Update TTS service with new settings
      ttsService.setApiHost(settings.apiHost);
      ttsService.setApiToken(settings.apiToken);
      
      // Save to storage
      await chrome.storage.sync.set(settings);
      
      // Reload voices with new settings
      await loadVoices();
      
      showStatus('Settings saved successfully', 'success');
      
      // Hide settings after a delay
      setTimeout(() => {
        settingsContent.classList.remove('visible');
        hideStatus();
      }, 2000);
      
    } catch (error) {
      console.error('Error saving settings:', error);
      showStatus('Error saving settings: ' + error.message, 'error');
    }
  }

  // Save settings when button is clicked
  saveSettingsBtn.addEventListener('click', saveSettings);
  
  // Also save when pressing Enter in the API host field
  apiHostInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      saveSettings();
    }
  });

  // Show status message
  function showStatus(message, type = 'info') {
    statusDiv.textContent = message;
    statusDiv.className = 'status ' + type;
    statusDiv.style.display = 'block';
  }

  // Hide status message
  function hideStatus() {
    statusDiv.style.display = 'none';
  }

  // Initialize the popup
  init().catch(console.error);
});
