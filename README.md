# Local TTS Chrome Extension

A Chrome extension that provides text-to-speech functionality using local TTS models. This extension allows you to convert text to speech directly in your browser with customizable voice settings.

## Features

- Text-to-speech conversion using local models (coming soon) or browser's built-in TTS
- Adjustable speech rate and pitch
- Multiple voice selection
- Works offline (with browser's built-in TTS)
- Saves your preferences

## Installation

1. Clone or download this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" (toggle in the top-right corner)
4. Click "Load unpacked" and select the extension directory
5. The extension icon should appear in your Chrome toolbar

## Usage

1. Click the extension icon in your Chrome toolbar
2. Enter or paste the text you want to convert to speech
3. Select a voice (optional)
4. Adjust the rate and pitch sliders as desired
5. Click the "Speak" button to start TTS
6. Use the "Stop" button to stop the speech

## Development

### Project Structure

- `manifest.json` - Extension configuration
- `popup.html` - Main extension interface
- `popup.js` - Handles TTS functionality and UI interactions
- `background.js` - Background script for extension events
- `icons/` - Extension icons in various sizes

### Local TTS Model (Planned)

This extension is designed to support local TTS models in the future. The current version uses the browser's built-in Web Speech API as a fallback.

## License

This project is open source and available under the [MIT License](LICENSE).
