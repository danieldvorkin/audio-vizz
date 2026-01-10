# Audio Mixer / Visualizer

## Overview

This project is a web-based audio mixer and visualizer that allows users to upload, analyze, and visualize audio tracks directly in the browser. It provides real-time audio analysis, musical key detection, and dynamic visualizations, making it useful for musicians, audio engineers, and enthusiasts interested in exploring the characteristics of their audio files.

## Features

- **Drag-and-drop audio upload**: Easily add multiple audio files via drag-and-drop or file picker.
- **Playlist management**: View and play uploaded tracks in a playlist interface.
- **Real-time audio analysis**:
  - Musical key and scale detection (major/minor)
  # Audio Mixer / Visualizer

  ## Overview

  This project is a browser-based audio analysis and visualization tool. It enables users to upload audio files, view a playlist, and analyze each track for musical and technical features. The app provides real-time visual feedback and detailed metrics, making it ideal for musicians, producers, and anyone interested in audio signal analysis.

  ## Features

  - **Drag-and-drop audio upload**: Add multiple audio files via drag-and-drop or file picker. Files are handled entirely in the browser; no upload to a server is required.
  - **Playlist management**: Tracks are listed with play controls. Only one track plays at a time.
  - **Audio analysis pipeline**:
    - **Key and scale detection**: Uses chroma features and template matching to estimate musical key (C, C#, D, etc.) and scale (major/minor) with a confidence score.
    - **Spectral features**: Computes brightness (spectral centroid), tonal balance (spectral flatness), roll-off, and zero-crossing rate per frame.
    - **Dynamics**: Calculates RMS, peak, crest factor, and integrated loudness (LUFS) for each track.
    - **Duration and partial analysis**: Analyzes up to 2 minutes per track for performance; longer files are flagged as partial.
  - **Visualizations**:
    - **Waveform**: Real-time time-domain display.
    - **Frequency spectrum**: Bar graph of frequency bins.
    - **Spectrogram**: Waterfall plot showing frequency content over time.
    - **Scrolling waveform**: Time-domain waterfall with color mapped to spectral content.
    - **LUFS meter**: Real-time loudness meter with color-coded zones (green/yellow/red).
  - **Accessible, informative UI**:
    - Tooltips explain each metric and visualization.
    - Responsive layout for desktop and mobile.
    - Status indicators for analysis progress and errors.

  ## Technical Architecture

  - **Frontend**: Pure HTML, CSS, and JavaScript (no frameworks). All analysis and rendering is client-side.
  - **Audio analysis**: Powered by [Meyda](https://meyda.js.org/) (loaded via CDN). Uses Web Audio API for decoding, feature extraction, and visualization.
  - **Server**: Node.js with Express, used only for static file serving during local development. No backend logic is required for analysis or playback.
  - **Deployment**: Designed for static hosting (e.g., Netlify). The `netlify.toml` file ensures `/` and `/mixer` routes load the main UI.

  ## File Structure

  - `server.js` — Express server for local development/static serving
  - `public/mixer.html` — Main web application UI
  - `public/scripts/visualizer.js` — Audio analysis, visualization, and UI logic
  - `public/styles/main.css` — Application styles
  - `netlify.toml` — Netlify configuration for static hosting and redirects
  - `package.json` — Project metadata and dependencies (for local server only)

  ## Getting Started

  ### Prerequisites
  - [Node.js](https://nodejs.org/) (for local development)

  ### Local Development
  1. **Install dependencies:**
    ```sh
    npm install
    ```
  2. **Run the server:**
    ```sh
    node server.js
    ```
  3. **Open the app:**
    Visit [http://localhost:4444/mixer](http://localhost:4444/mixer) in your browser.

  ### Deployment
  - The app is static and can be deployed to Netlify or any static host. The `netlify.toml` file ensures the root URL and `/mixer` route redirect to the main UI.

  ## Usage
  1. Open the app in your browser.
  2. Drag and drop audio files (WAV, MP3, AAC, etc.) into the upload area or use the file picker.
  3. Select a track from the playlist to play and analyze it.
  4. View real-time metrics and visualizations for the selected track.

  ## Audio Analysis Details

  - **Key Detection**: Uses chroma features and template matching for major/minor keys. Confidence is based on chroma correlation.
  - **Spectral Features**: Brightness (centroid), roll-off, flatness, and zero-crossing rate are computed per frame and averaged.
  - **Dynamics**: RMS, peak, crest factor, and LUFS are calculated for loudness and headroom. LUFS is displayed in real time during playback.
  - **Visualizations**: All visualizations are rendered in real time using the Web Audio API and Canvas. Color mapping in the scrolling waveform reflects spectral energy and band balance.
  - **Performance**: For efficiency, only the first 2 minutes of each track are analyzed. Longer tracks are marked as partial.

  ## Dependencies
  - [Express](https://expressjs.com/) — Local server for development
  - [Meyda](https://meyda.js.org/) — Audio feature extraction (browser, via CDN)
  - [Node.js](https://nodejs.org/) — Runtime for local server

  ## License

  This project is licensed under the ISC License.

  ## Credits
  - Audio feature extraction powered by [Meyda](https://meyda.js.org/).
  - UI and visualization by Daniel Dvorkin.