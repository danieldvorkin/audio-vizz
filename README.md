# Audio Mixer / Visualizer

## Overview

This project is a web-based audio mixer and visualizer that allows users to upload, analyze, and visualize audio tracks directly in the browser. It provides real-time audio analysis, musical key detection, and dynamic visualizations, making it useful for musicians, audio engineers, and enthusiasts interested in exploring the characteristics of their audio files.

## Features

- **Drag-and-drop audio upload**: Easily add multiple audio files via drag-and-drop or file picker.
- **Playlist management**: View and play uploaded tracks in a playlist interface.
- **Real-time audio analysis**:
  - Musical key and scale detection (major/minor)
  - Confidence score for key detection
  - Spectral brightness (centroid)
  - Tonal balance (spectral flatness)
  - Dynamic headroom (crest factor, loudness)
  - Duration, loudness (LUFS), RMS, peak, crest factor, roll-off, flatness, zero-crossing rate
- **Visualizations**:
  - Waveform
  - Frequency spectrum
  - Spectrogram (frequency waterfall)
  - Scrolling waveform (time-domain waterfall)
  - Real-time LUFS meter with color-coded loudness
- **Accessible UI**: Tooltips and clear metric explanations for all analysis results.
- **Responsive design**: Works on desktop and mobile browsers.

## Technology Stack

- **Frontend**: HTML, CSS, JavaScript (no frameworks)
- **Audio Analysis**: [Meyda](https://meyda.js.org/) (browser-based audio feature extraction)
- **Backend**: Node.js with Express (for static file serving)
- **Deployment**: Netlify (static hosting)

## File Structure

- `server.js` — Express server for local development and static file serving
- `public/mixer.html` — Main web application UI
- `public/scripts/visualizer.js` — Core logic for audio analysis, visualization, and UI interaction
- `public/styles/main.css` — Styles for the application
- `netlify.toml` — Netlify configuration for static hosting and redirects
- `package.json` — Project metadata and dependencies

## Getting Started

### Prerequisites
- [Node.js](https://nodejs.org/) (for local development)

### Local Development
1. **Install dependencies:**
	```sh
	npm install
	```
2. **Start the server:**
	```sh
	npm start
	```
3. **Open the app:**
	Visit [http://localhost:4444/mixer](http://localhost:4444/mixer) in your browser.

### Deployment
- The app is designed for static hosting (e.g., Netlify). The `netlify.toml` file ensures the root URL and `/mixer` route redirect to the main UI.

## Usage
1. Open the app in your browser.
2. Drag and drop audio files (WAV, MP3, AAC, etc.) into the upload area or use the file picker.
3. Select a track from the playlist to play and analyze it.
4. View real-time metrics and visualizations for the selected track.

## Audio Analysis Details
- **Key Detection**: Uses chroma features and template matching for major/minor keys.
- **Spectral Features**: Brightness (centroid), roll-off, flatness, and zero-crossing rate are computed per frame.
- **Dynamics**: RMS, peak, crest factor, and LUFS are calculated for loudness and headroom.
- **Visualizations**: All visualizations are rendered in real-time using the Web Audio API and Canvas.

## Dependencies
- [Express](https://expressjs.com/) — Local server
- [Meyda](https://meyda.js.org/) — Audio feature extraction (loaded via CDN)
- [Node.js](https://nodejs.org/) — Runtime for local server

## License

This project is licensed under the ISC License.

## Credits
- Audio feature extraction powered by [Meyda](https://meyda.js.org/).
- UI and visualization by Daniel Dvorkin.