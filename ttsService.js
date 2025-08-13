const TTS_API_URL = '';
const VOICES_API_URL = '';

class TTSService {
  constructor() {
    this.voices = [];
    this.apiHost = '';
    this.apiToken = null;
    this.loadVoices().catch(console.error);
  }

  setApiHost(host) {
    // Ensure the host doesn't end with a slash
    this.apiHost = host ? host.replace(/\/+$/, '') : '';
    this.voices = []; // Reset voices when host changes
  }

  setApiToken(token) {
    this.apiToken = token || null;
  }

  getApiHost() {
    return this.apiHost;
  }

  async loadVoices() {
    console.log('TTS: Loading voices...');
    
    if (!this.apiHost) {
      console.error('TTS: No API host configured');
      return [];
    }
    
    const voicesUrl = `${this.apiHost}/v1/voices`;
    
    try {
      const headers = {
        'Content-Type': 'application/json',
      };
      
      // Add auth token if provided
      if (this.apiToken) {
        headers['Authorization'] = `Bearer ${this.apiToken}`;
      }
      
      const response = await fetch(voicesUrl, {
        method: 'GET',
        headers: headers,
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error('TTS: Failed to load voices:', response.status, errorText);
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      this.voices = await response.json();
      console.log('TTS: Loaded voices:', this.voices);
      return this.voices;
    } catch (error) {
      console.error('TTS: Error loading voices:', error);
      // Return default voice if API fails
      this.voices = [{ voice_id: 'default', name: 'Default Voice' }];
      return this.voices;
    }
  }

  async generateSpeech(text, voiceId = 'default', options = {}) {
    console.log('TTS: Generating speech for text:', text.substring(0, 50) + (text.length > 50 ? '...' : ''));
    
    if (!this.apiHost) {
      throw new Error('No API host configured. Please set the API host in settings.');
    }
    
    const ttsUrl = `${this.apiHost}/v1/audio/speech`;
    
    try {
      const headers = {
        'Content-Type': 'application/json',
      };
      
      // Add auth token if provided
      if (this.apiToken) {
        headers['Authorization'] = `Bearer ${this.apiToken}`;
      }
      
      // Prepare request body with options
      const requestBody = {
        input: text,
        voice: voiceId,
        // Map the rate and pitch to the expected API parameters
        // Different TTS APIs might use different parameter names
        speed: options.speed || options.rate || 1.0, // Some APIs use 'speed' instead of 'rate'
        pitch: options.pitch || 1.0,
        // Add any additional options that might be supported by the API
        ...options
      };
      
      // Remove undefined values
      Object.keys(requestBody).forEach(key => {
        if (requestBody[key] === undefined) {
          delete requestBody[key];
        }
      });
      
      console.log('TTS: Sending request to:', ttsUrl);
      console.log('TTS: Request body:', JSON.stringify(requestBody, null, 2));
      
      const response = await fetch(ttsUrl, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('TTS: Error generating speech:', response.status, errorText);
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      // Get the audio data as ArrayBuffer
      const audioData = await response.arrayBuffer();
      if (!audioData || audioData.byteLength === 0) {
        throw new Error('Empty audio response from server');
      }
      
      console.log('TTS: Audio data received, size:', audioData.byteLength, 'bytes');
      return audioData;
    } catch (error) {
      console.error('TTS: Error in generateSpeech:', error);
      throw error;
    }
  }

  getVoices() {
    return this.voices;
  }
}

// Export a singleton instance
const ttsService = new TTSService();
export default ttsService;
