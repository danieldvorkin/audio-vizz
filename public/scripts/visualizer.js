// State
let tracks = [];
let currentIndex = -1;
let audioCtx = null;
let analyser = null;
let source = null;
let analysisRunId = 0;

// Elements
const uploadArea = document.getElementById('uploadArea');
const fileInput = document.getElementById('fileInput');
const playlistBody = document.getElementById('playlistBody');
const audio = document.getElementById('audio');
const status = document.getElementById('status');
const keyEl = document.getElementById('key');
const scaleEl = document.getElementById('scale');
const confidenceEl = document.getElementById('confidence');
const brightnessEl = document.getElementById('brightness');
const durationEl = document.getElementById('duration');
const loudnessEl = document.getElementById('loudness');
const rmsEl = document.getElementById('rms');
const peakEl = document.getElementById('peak');
const crestEl = document.getElementById('crest');
const rolloffEl = document.getElementById('rolloff');
const flatnessEl = document.getElementById('flatness');
const zcrEl = document.getElementById('zcr');
const bpmEl = document.getElementById('bpm');
const brightnessSummaryEl = document.getElementById('brightnessSummary');
const tonalSummaryEl = document.getElementById('tonalSummary');
const dynamicsSummaryEl = document.getElementById('dynamicsSummary');
const waveformCanvas = document.getElementById('waveform');
const spectrumCanvas = document.getElementById('spectrum');
const spectrogramCanvas = document.getElementById('spectrogram');
const scrollingCanvas = document.getElementById('scrolling');
const meterFill = document.getElementById('meterFill');
const meterText = document.getElementById('meterText');
const meter = document.querySelector('.meter');
const canvasStack = document.querySelector('.canvas-stack');
const leftColumn = document.querySelector('.left-column');
const analysisPanel = document.querySelector('.analysis-panel');
const analysisOverlay = document.getElementById('analysisOverlay');

// Constants
const KEY_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const SAMPLE_YIELD_INTERVAL = 131072;
const FRAME_YIELD_INTERVAL = 32;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const yieldToMain = () => new Promise(resolve => {
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => resolve());
  } else {
    setTimeout(resolve, 0);
  }
});

const formatHz = (value) => {
  if (!Number.isFinite(value)) return '--';
  return value >= 1000 ? (value / 1000).toFixed(2) + ' kHz' : value.toFixed(0) + ' Hz';
};

const formatDbfs = (value) => {
  if (!Number.isFinite(value)) return '--';
  return value.toFixed(1) + ' dBFS';
};

const formatLoudness = (value) => {
  if (!Number.isFinite(value)) return '--';
  return value.toFixed(1) + ' LUFS';
};

const formatPercent = (value) => {
  if (!Number.isFinite(value)) return '--';
  return (value * 100).toFixed(0) + '%';
};

const formatBpm = (bpm, confidence) => {
  if (!Number.isFinite(bpm)) return '--';
  const rounded = Math.round(bpm);
  if (!Number.isFinite(confidence)) return `${rounded}`;
  return `${rounded} (${Math.round(clamp(confidence, 0, 1) * 100)}%)`;
};

const describeBrightness = (centroid) => {
  if (!Number.isFinite(centroid)) return '--';
  if (centroid < 1500) return `Warm (${formatHz(centroid)})`;
  if (centroid < 3500) return `Balanced (${formatHz(centroid)})`;
  return `Bright (${formatHz(centroid)})`;
};

const describeFlatness = (flatness) => {
  if (!Number.isFinite(flatness)) return '--';
  if (flatness < 0.2) return `Harmonic (${formatPercent(flatness)})`;
  if (flatness < 0.4) return `Balanced (${formatPercent(flatness)})`;
  if (flatness < 0.6) return `Mixed (${formatPercent(flatness)})`;
  return `Noisy (${formatPercent(flatness)})`;
};

const describeDynamics = (crestDb, loudness) => {
  if (!Number.isFinite(crestDb)) return '--';
  const loudnessText = Number.isFinite(loudness) ? loudness.toFixed(1) + ' LUFS' : 'n/a';
  if (crestDb >= 14) return `Very open (${crestDb.toFixed(1)} dB crest, ${loudnessText})`;
  if (crestDb >= 10) return `Dynamic (${crestDb.toFixed(1)} dB crest, ${loudnessText})`;
  if (crestDb >= 6) return `Modern (${crestDb.toFixed(1)} dB crest, ${loudnessText})`;
  return `Tight (${crestDb.toFixed(1)} dB crest, ${loudnessText})`;
};

const average = (arr) => (arr && arr.length ? arr.reduce((sum, value) => sum + value, 0) / arr.length : null);

async function estimateBpmFromMono(mono, sampleRate, shouldAbort) {
  if (!mono || mono.length < sampleRate * 2) {
    return { bpm: null, confidence: 0 };
  }

  // Energy envelope + positive differences (simple onset strength function).
  const hopSize = 512;
  const windowSize = 1024;
  const frameCount = Math.floor((mono.length - windowSize) / hopSize);
  if (frameCount < 64) return { bpm: null, confidence: 0 };

  const envelope = new Float32Array(frameCount);
  let envMax = 0;
  let envSum = 0;

  for (let f = 0; f < frameCount; f++) {
    if (shouldAbort && shouldAbort()) return { bpm: null, confidence: 0 };
    const start = f * hopSize;
    let sumSq = 0;
    for (let i = 0; i < windowSize; i++) {
      const s = mono[start + i] || 0;
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / windowSize);
    // Log-compress to reduce dominance of loud sections.
    const value = Math.log10(1e-8 + rms);
    envelope[f] = value;
    envSum += value;
    if (value > envMax) envMax = value;

    if (f > 0 && f % 2048 === 0) {
      await yieldToMain();
    }
  }

  const envMean = envSum / frameCount;
  const onset = new Float32Array(frameCount);
  let onsetMax = 0;
  let onsetSum = 0;
  for (let i = 1; i < frameCount; i++) {
    if (shouldAbort && shouldAbort()) return { bpm: null, confidence: 0 };
    const diff = (envelope[i] - envMean) - (envelope[i - 1] - envMean);
    const v = diff > 0 ? diff : 0;
    onset[i] = v;
    onsetSum += v;
    if (v > onsetMax) onsetMax = v;
    if (i % 4096 === 0) {
      await yieldToMain();
    }
  }

  // If there's basically no rhythmic activity, bail.
  const onsetMean = onsetSum / frameCount;
  if (!Number.isFinite(onsetMean) || onsetMean < 1e-4 || onsetMax < 1e-3) {
    return { bpm: null, confidence: 0 };
  }

  // Autocorrelation of onset strength within a plausible tempo range.
  const minBpm = 60;
  const maxBpm = 200;
  const minLag = Math.floor((60 * sampleRate) / (maxBpm * hopSize));
  const maxLag = Math.ceil((60 * sampleRate) / (minBpm * hopSize));
  const safeMinLag = Math.max(1, minLag);
  const safeMaxLag = Math.min(frameCount - 2, Math.max(safeMinLag + 1, maxLag));

  let bestLag = null;
  let bestScore = -Infinity;
  let secondScore = -Infinity;

  for (let lag = safeMinLag; lag <= safeMaxLag; lag++) {
    if (shouldAbort && shouldAbort()) return { bpm: null, confidence: 0 };
    let sum = 0;
    // Skip the first chunk where onset is often zero.
    for (let i = lag; i < frameCount; i++) {
      sum += onset[i] * onset[i - lag];
    }

    if (sum > bestScore) {
      secondScore = bestScore;
      bestScore = sum;
      bestLag = lag;
    } else if (sum > secondScore) {
      secondScore = sum;
    }
  }

  if (!Number.isFinite(bestScore) || bestLag == null || bestScore <= 0) {
    return { bpm: null, confidence: 0 };
  }

  let bpm = (60 * sampleRate) / (bestLag * hopSize);

  // Basic octave correction (common half/double tempo ambiguity).
  if (bpm < 80) bpm *= 2;
  else if (bpm > 180) bpm /= 2;

  if (!Number.isFinite(bpm)) return { bpm: null, confidence: 0 };
  bpm = clamp(bpm, minBpm, maxBpm);

  const confidence = Number.isFinite(secondScore) && bestScore > 0
    ? clamp((bestScore - secondScore) / bestScore, 0, 1)
    : 0;

  return { bpm, confidence };
}

// Initialize audio context
function initAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.3;
    source = audioCtx.createMediaElementSource(audio);
    source.connect(analyser);
    analyser.connect(audioCtx.destination);
  }
}

// Upload handlers
uploadArea.addEventListener('click', (event) => {
  if (event.target === fileInput) return;
  fileInput.click();
});

fileInput.addEventListener('change', (e) => {
  const selected = [];
  const { files } = e.target;
  if (files && files.length) {
    for (let i = 0; i < files.length; i++) {
      const file = files.item(i);
      if (file) selected.push(file);
    }
  }
  handleFiles(selected);
  setTimeout(() => {
    e.target.value = '';
  }, 0);
});

uploadArea.addEventListener('dragover', (e) => {
  e.preventDefault();
  uploadArea.classList.add('drag-over');
});

uploadArea.addEventListener('dragleave', () => {
  uploadArea.classList.remove('drag-over');
});

uploadArea.addEventListener('drop', (e) => {
  e.preventDefault();
  uploadArea.classList.remove('drag-over');
  const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('audio/'));
  handleFiles(files);
});

// Handle files
function handleFiles(files) {
  if (files.length === 0) return;

  files.forEach(file => {
    if (!tracks.some(t => t.name === file.name && t.size === file.size)) {
      tracks.push({
        name: file.name,
        size: file.size,
        file: file,
        analysis: null
      });
    }
  });

  renderPlaylist();
}

// Render playlist
function renderPlaylist() {
  if (tracks.length === 0) {
    playlistBody.innerHTML = '<div class="playlist-empty">No tracks loaded. Drop files above to get started.</div>';
    return;
  }

  playlistBody.innerHTML = tracks.map((track, i) => `
    <div class="playlist-item ${i === currentIndex ? 'active' : ''}" data-index="${i}">
      <div>${i + 1}</div>
      <div>${track.name}</div>
      <div><button onclick="playTrack(${i})">${i === currentIndex ? '▶ Playing' : 'Play'}</button></div>
    </div>
  `).join('');
}

// Play track
window.playTrack = function(index) {
  initAudio();
  if (audioCtx.state === 'suspended') audioCtx.resume();

  currentIndex = index;
  const track = tracks[index];

  // Revoke old URL if exists
  if (audio.src && audio.src.startsWith('blob:')) {
    URL.revokeObjectURL(audio.src);
  }

  audio.src = URL.createObjectURL(track.file);
  audio.play().catch(err => {
    console.error('Playback error:', err);
    alert('Could not play audio. Please try again.');
  });
  renderPlaylist();

  if (!track.analysis) {
    const runId = ++analysisRunId;
    analyzeTrack(track, runId);
  } else {
    if (analysisPanel) analysisPanel.classList.remove('loading');
    if (analysisOverlay) analysisOverlay.setAttribute('aria-hidden', 'true');
    status.textContent = 'Ready';
    status.className = 'status ready';
    displayAnalysis(track.analysis);
  }
};

// Analyze track
async function analyzeTrack(track, runId) {
  const thisRunId = runId ?? ++analysisRunId;
  status.textContent = 'Analyzing...';
  status.className = 'status analyzing';
  resetAnalysis();
  if (analysisPanel) analysisPanel.classList.add('loading');
  if (analysisOverlay) analysisOverlay.setAttribute('aria-hidden', 'false');

  try {
    if (typeof Meyda === 'undefined') {
      throw new Error('Meyda library not loaded. Please refresh the page.');
    }

    const buffer = await track.file.arrayBuffer();
    if (thisRunId !== analysisRunId) return;

    const decoded = await audioCtx.decodeAudioData(buffer);
    if (thisRunId !== analysisRunId) return;

    const sampleRate = decoded.sampleRate;
    const maxSamples = Math.min(decoded.length, Math.floor(sampleRate * 120));

    let mono;
    if (decoded.numberOfChannels === 1) {
      const channelData = decoded.getChannelData(0);
      const clampedLength = Math.min(channelData.length, maxSamples);
      mono = channelData.subarray(0, clampedLength);
      if (clampedLength > SAMPLE_YIELD_INTERVAL) {
        await yieldToMain();
        if (thisRunId !== analysisRunId) return;
      }
    } else {
      mono = new Float32Array(maxSamples);
      for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
        const data = decoded.getChannelData(ch);
        for (let i = 0; i < maxSamples; i++) {
          mono[i] += data[i];
          if (i > 0 && i % SAMPLE_YIELD_INTERVAL === 0) {
            await yieldToMain();
            if (thisRunId !== analysisRunId) return;
          }
        }
      }
      for (let i = 0; i < maxSamples; i++) {
        mono[i] /= decoded.numberOfChannels;
        if (i > 0 && i % SAMPLE_YIELD_INTERVAL === 0) {
          await yieldToMain();
          if (thisRunId !== analysisRunId) return;
        }
      }
    }

    let peakSample = 0;
    let sumSquares = 0;
    for (let i = 0; i < mono.length; i++) {
      const sample = mono[i];
      const abs = Math.abs(sample);
      if (abs > peakSample) peakSample = abs;
      sumSquares += sample * sample;

      if (i > 0 && i % SAMPLE_YIELD_INTERVAL === 0) {
        await yieldToMain();
        if (thisRunId !== analysisRunId) return;
      }
    }
    const overallRms = mono.length ? Math.sqrt(sumSquares / mono.length) : null;

    const bpmResult = await estimateBpmFromMono(
      mono,
      sampleRate,
      () => thisRunId !== analysisRunId
    );
    if (thisRunId !== analysisRunId) return;

    const frameSize = 4096;
    const hopSize = 2048;
    const chromaSum = new Array(12).fill(0);
    let chromaCount = 0;
    const centroids = [];
    const rolloffValues = [];
    const flatnessValues = [];
    const zcrValues = [];
    const loudnessValues = [];
    const rmsValues = [];
    const featureOptions = {
      bufferSize: frameSize,
      sampleRate: sampleRate,
      windowingFunction: 'hann'
    };
    const availableFeatures = new Set(
      typeof Meyda.featureExtractors === 'object'
        ? Object.keys(Meyda.featureExtractors)
        : []
    );
    const extractFeature = (name, frame) => {
      if (!availableFeatures.has(name)) return null;
      try {
        return Meyda.extract(name, frame, featureOptions);
      } catch (err) {
        console.debug(`Meyda feature "${name}" unavailable`, err);
        availableFeatures.delete(name);
        return null;
      }
    };

    let frameCount = 0;
    for (let i = 0; i + frameSize <= mono.length; i += hopSize) {
      const frame = mono.subarray(i, i + frameSize);
      const chroma = extractFeature('chroma', frame);
      const rms = extractFeature('rms', frame);
      const centroid = extractFeature('spectralCentroid', frame);
      const rolloff = extractFeature('spectralRolloff', frame);
      const flatness = extractFeature('spectralFlatness', frame);
      const zcr = extractFeature('zeroCrossingRate', frame);
      const loudness = extractFeature('loudness', frame);

      if (chroma && rms && rms > 0.003) {
        for (let c = 0; c < 12; c++) chromaSum[c] += chroma[c];
        chromaCount++;
      }

      if (typeof centroid === 'number') centroids.push(centroid);
      if (typeof rolloff === 'number') rolloffValues.push(rolloff);
      if (typeof flatness === 'number') flatnessValues.push(flatness);
      if (typeof zcr === 'number') zcrValues.push(zcr);
      if (typeof rms === 'number') rmsValues.push(rms);
      if (loudness && typeof loudness.total === 'number') {
        loudnessValues.push(loudness.total);
      }

      frameCount++;
      if (frameCount % FRAME_YIELD_INTERVAL === 0) {
        await yieldToMain();
        if (thisRunId !== analysisRunId) return;
      }
    }

    let key = null;
    if (chromaCount > 0) {
      const avgChroma = chromaSum.map(v => v / chromaCount);
      key = detectKey(avgChroma);
    }

    const avgCentroid = average(centroids);
    const avgRolloff = average(rolloffValues);
    const avgFlatness = average(flatnessValues);
    const avgZcr = average(zcrValues);
    const avgLoudness = average(loudnessValues);
    const avgFrameRms = average(rmsValues);
    const dominantRms = Number.isFinite(overallRms) ? overallRms : avgFrameRms;
    const rmsDb = dominantRms && dominantRms > 0 ? 20 * Math.log10(dominantRms) : null;
    const peakDb = peakSample && peakSample > 0 ? 20 * Math.log10(peakSample) : null;
    const crestFactor = dominantRms && dominantRms > 0 ? peakSample / dominantRms : null;
    const crestDb = crestFactor && crestFactor > 0 ? 20 * Math.log10(crestFactor) : null;
    const loudnessLufs = avgLoudness && avgLoudness > 0
      ? -0.691 + 10 * Math.log10(avgLoudness)
      : (dominantRms && dominantRms > 0 ? -0.691 + 20 * Math.log10(dominantRms) : null);
    const zcrFrequency = Number.isFinite(avgZcr) ? (avgZcr * sampleRate) / 2 : null;

    const analysis = {
      key: key?.name || '--',
      scale: key?.scale || '--',
      confidence: key?.confidence || 0,
      brightness: avgCentroid,
      duration: mono.length / sampleRate,
      partial: decoded.length > maxSamples,
      bpm: bpmResult?.bpm ?? null,
      bpmConfidence: bpmResult?.confidence ?? 0,
      loudness: loudnessLufs,
      rms: dominantRms,
      rmsDb,
      peak: peakSample,
      peakDb,
      crestFactor,
      crestDb,
      rolloff: avgRolloff,
      flatness: avgFlatness,
      zcr: avgZcr,
      zcrFrequency
    };

    track.analysis = analysis;

    if (thisRunId === analysisRunId && track === tracks[currentIndex]) {
      displayAnalysis(analysis);
      status.textContent = 'Ready';
      status.className = 'status ready';
    }
  } catch (err) {
    console.error('Analysis failed:', err);
    if (thisRunId === analysisRunId && track === tracks[currentIndex]) {
      status.textContent = 'Error';
      status.className = 'status error';
    }
    alert(`Analysis failed: ${err.message}`);
  } finally {
    if (thisRunId === analysisRunId) {
      if (analysisPanel) analysisPanel.classList.remove('loading');
      if (analysisOverlay) analysisOverlay.setAttribute('aria-hidden', 'true');
    }
  }
}

// Detect key
function detectKey(chroma) {
  const normalize = (arr) => {
    const mag = Math.sqrt(arr.reduce((s, v) => s + v * v, 0));
    return mag > 0 ? arr.map(v => v / mag) : arr;
  };

  const rotate = (arr, n) => {
    const offset = ((n % 12) + 12) % 12;
    return arr.slice(offset).concat(arr.slice(0, offset));
  };

  const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);

  const normChroma = normalize(chroma);
  const normMajor = normalize(MAJOR);
  const normMinor = normalize(MINOR);

  let best = { score: -Infinity, name: null, scale: null };

  for (let i = 0; i < 12; i++) {
    const majorScore = dot(normChroma, rotate(normMajor, i));
    if (majorScore > best.score) {
      best = { score: majorScore, name: KEY_NAMES[i], scale: 'major' };
    }

    const minorScore = dot(normChroma, rotate(normMinor, i));
    if (minorScore > best.score) {
      best = { score: minorScore, name: KEY_NAMES[i], scale: 'minor' };
    }
  }

  return {
    name: best.name,
    scale: best.scale,
    confidence: Math.max(0, Math.min(1, best.score))
  };
}

// Display analysis
function displayAnalysis(analysis) {
  keyEl.textContent = analysis.key;
  scaleEl.textContent = analysis.scale.charAt(0).toUpperCase() + analysis.scale.slice(1);
  confidenceEl.textContent = Math.round(analysis.confidence * 100) + '%';
  brightnessEl.textContent = Number.isFinite(analysis.brightness) ? formatHz(analysis.brightness) : '--';

  const mins = Math.floor(analysis.duration / 60);
  const secs = Math.floor(analysis.duration % 60);
  durationEl.textContent = `${mins}:${secs.toString().padStart(2, '0')}${analysis.partial ? ' (partial)' : ''}`;

  if (bpmEl) {
    bpmEl.textContent = formatBpm(analysis.bpm, analysis.bpmConfidence);
  }

  loudnessEl.textContent = formatLoudness(analysis.loudness);
  rmsEl.textContent = formatDbfs(analysis.rmsDb);
  peakEl.textContent = formatDbfs(analysis.peakDb);
  crestEl.textContent = Number.isFinite(analysis.crestDb) ? analysis.crestDb.toFixed(1) + ' dB' : '--';
  rolloffEl.textContent = formatHz(analysis.rolloff);
  flatnessEl.textContent = formatPercent(analysis.flatness);

  if (Number.isFinite(analysis.zcr)) {
    const approx = Number.isFinite(analysis.zcrFrequency)
      ? ` (≈ ${Math.round(analysis.zcrFrequency)} Hz fundamental)`
      : '';
    zcrEl.textContent = analysis.zcr.toFixed(3) + approx;
  } else {
    zcrEl.textContent = '--';
  }

  brightnessSummaryEl.textContent = describeBrightness(analysis.brightness);
  tonalSummaryEl.textContent = describeFlatness(analysis.flatness);
  dynamicsSummaryEl.textContent = describeDynamics(analysis.crestDb, analysis.loudness);

  syncMeterHeight();
}

// Reset analysis
function resetAnalysis() {
  keyEl.textContent = '--';
  scaleEl.textContent = '--';
  confidenceEl.textContent = '--';
  brightnessEl.textContent = '--';
  durationEl.textContent = '--';
  if (bpmEl) bpmEl.textContent = '--';
  loudnessEl.textContent = '--';
  rmsEl.textContent = '--';
  peakEl.textContent = '--';
  crestEl.textContent = '--';
  rolloffEl.textContent = '--';
  flatnessEl.textContent = '--';
  zcrEl.textContent = '--';
  brightnessSummaryEl.textContent = '--';
  tonalSummaryEl.textContent = '--';
  dynamicsSummaryEl.textContent = '--';
}

// Visualization helpers
function configureCanvas(canvas, options) {
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(rect.width));
  canvas.height = Math.max(1, Math.floor(rect.height));
  return canvas.getContext('2d', options || undefined);
}

let waveCtx = null;
let specCtx = null;
let spectrogramCtx = null;
let scrollCtx = null;

function initCanvasContexts() {
  waveCtx = configureCanvas(waveformCanvas);
  specCtx = configureCanvas(spectrumCanvas);
  spectrogramCtx = spectrogramCanvas ? configureCanvas(spectrogramCanvas, { willReadFrequently: true }) : null;
  scrollCtx = configureCanvas(scrollingCanvas, { willReadFrequently: true });
}

function registerHoverCanvas(canvas, options) {
  if (!canvas) return;
  const wrapper = canvas.closest('.canvas-wrapper');
  if (!wrapper) return;

  let overlay = wrapper.querySelector('.hover-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'hover-overlay';
    overlay.style.display = 'none';
    wrapper.appendChild(overlay);
  }

  let label = wrapper.querySelector('.hover-label');
  if (!label) {
    label = document.createElement('div');
    label.className = 'hover-label';
    label.setAttribute('aria-hidden', 'true');
    wrapper.appendChild(label);
  }

  let line = overlay.querySelector('.hover-overlay-line');
  if (!line) {
    line = document.createElement('div');
    line.className = 'hover-overlay-line';
    line.style.display = 'none';
    overlay.appendChild(line);
  }

  const interaction = {
    canvas,
    valueForY: options.valueForY,
    formatValue: options.formatValue,
    label,
    overlay,
    line
  };

  const handleMove = (event) => {
    const rect = canvas.getBoundingClientRect();
    if (rect.height === 0) return;
    const cssY = clamp(event.clientY - rect.top, 0, Math.max(0, rect.height - 0.5));
    const scaleY = canvas.height / rect.height;
    const value = interaction.valueForY(clamp(cssY * scaleY, 0, canvas.height), canvas);
    const formatted = interaction.formatValue(value);

    label.textContent = formatted;
    label.style.display = 'block';
    label.style.top = `${cssY}px`;
    label.style.transform = 'translateY(-50%)';
    label.setAttribute('aria-hidden', 'false');

    overlay.style.display = 'block';
    interaction.line.style.display = 'block';
    interaction.line.style.top = `${cssY}px`;
    interaction.line.style.transform = 'translateY(-0.5px)';
    canvas.classList.add('hover-crosshair');
  };

  const handleLeave = () => {
    label.style.display = 'none';
    label.setAttribute('aria-hidden', 'true');
    overlay.style.display = 'none';
    interaction.line.style.display = 'none';
    canvas.classList.remove('hover-crosshair');
  };

  canvas.addEventListener('mousemove', handleMove);
  canvas.addEventListener('mouseleave', handleLeave);
}

function setupHoverInteractions() {
  registerHoverCanvas(
    spectrumCanvas,
    {
      valueForY: (y, canvas) => {
        if (!analyser || !canvas || canvas.height === 0) return null;
        const minDb = Number.isFinite(analyser.minDecibels) ? analyser.minDecibels : -100;
        const maxDb = Number.isFinite(analyser.maxDecibels) ? analyser.maxDecibels : -30;
        const ratio = 1 - (y / canvas.height);
        return minDb + ratio * (maxDb - minDb);
      },
      formatValue: (value) => Number.isFinite(value) ? `${value.toFixed(1)} dBFS` : '-inf dBFS'
    }
  );

  registerHoverCanvas(
    scrollingCanvas,
    {
      valueForY: (y, canvas) => {
        if (!canvas || canvas.height === 0) return null;
        const centerY = canvas.height / 2;
        if (centerY === 0) return null;
        const sample = (y - centerY) / centerY;
        const magnitude = Math.max(Math.abs(sample), 1e-6);
        return 20 * Math.log10(magnitude);
      },
      formatValue: (value) => Number.isFinite(value) ? `${value.toFixed(1)} dBFS` : '-inf dBFS'
    }
  );
}

function syncMeterHeight() {
  if (!meter || !canvasStack) return;
  const isNarrow = window.matchMedia('(max-width: 960px)').matches;
  if (isNarrow) {
    meter.style.height = 'auto';
    if (leftColumn) {
      leftColumn.style.height = 'auto';
      leftColumn.style.maxHeight = 'none';
    }
    return;
  }
  const rect = canvasStack.getBoundingClientRect();
  if (rect.height > 0) {
    meter.style.height = rect.height + 'px';
    if (leftColumn) {
      leftColumn.style.height = rect.height + 'px';
      leftColumn.style.maxHeight = rect.height + 'px';
    }
  }
}

function handleResize() {
  initCanvasContexts();
  syncMeterHeight();
}

window.addEventListener('resize', handleResize);
handleResize();
setupHoverInteractions();

let smoothLufs = -60;
let timeDomainBytes = null;
let timeDomainFloats = null;
let freqBuffer = null;

function draw() {
  requestAnimationFrame(draw);

  if (!analyser || !waveCtx || !specCtx || !scrollCtx) return;
  if (spectrogramCanvas && !spectrogramCtx) return;

  const bufferLength = analyser.fftSize;
  const freqLength = analyser.frequencyBinCount;

  if (bufferLength === 0) return;

  if (!timeDomainBytes || timeDomainBytes.length !== bufferLength) {
    timeDomainBytes = new Uint8Array(bufferLength);
    timeDomainFloats = new Float32Array(bufferLength);
  }

  analyser.getByteTimeDomainData(timeDomainBytes);

  let sumSq = 0;
  for (let i = 0; i < bufferLength; i++) {
    const sample = (timeDomainBytes[i] - 128) / 128;
    timeDomainFloats[i] = sample;
    sumSq += sample * sample;
  }

  if (!freqBuffer || freqBuffer.length !== freqLength) {
    freqBuffer = new Uint8Array(freqLength);
  }

  analyser.getByteFrequencyData(freqBuffer);


  let dominantHue = 150;
  let spectralEnergy = 0;
  if (freqLength > 0) {
    let weightedIndex = 0;
    let magnitudeTotal = 0;
    for (let i = 0; i < freqLength; i++) {
      const magnitude = freqBuffer[i];
      magnitudeTotal += magnitude;
      weightedIndex += magnitude * i;
    }
    if (magnitudeTotal > 0) {
      const averageIndex = weightedIndex / magnitudeTotal;
      const normalized = averageIndex / freqLength;
      dominantHue = normalized * 260;
      spectralEnergy = Math.min(1, magnitudeTotal / (freqLength * 255));
    }
  }

  // LUFS meter
  const meanSquare = sumSq / bufferLength;
  const rms = Math.sqrt(meanSquare);

  const lufsRaw = rms > 1e-5 ? -0.691 + 20 * Math.log10(rms) : -60;
  smoothLufs = 0.8 * smoothLufs + 0.2 * lufsRaw;
  const clampedLufs = Math.max(-60, Math.min(0, smoothLufs));
  const percent = ((clampedLufs + 60) / 60) * 100;
  const hasSignal = Number.isFinite(rms) && rms > 1e-5;

  meterFill.style.height = Math.max(0, Math.min(100, percent)) + '%';
  meterText.textContent = hasSignal && Number.isFinite(clampedLufs)
    ? clampedLufs.toFixed(1) + ' LUFS'
    : '-inf LUFS';

  if (clampedLufs > -14) {
    meterFill.style.background = '#f44336';
  } else if (clampedLufs > -23) {
    meterFill.style.background = '#ffeb3b';
  } else {
    meterFill.style.background = '#4caf50';
  }

  // Waveform
  waveCtx.fillStyle = '#000';
  waveCtx.fillRect(0, 0, waveformCanvas.width, waveformCanvas.height);
  waveCtx.strokeStyle = '#0f0';
  waveCtx.lineWidth = 2;
  waveCtx.beginPath();

  const sliceCount = Math.max(1, bufferLength - 1);
  const sliceWidth = waveformCanvas.width / sliceCount;
  let x = 0;

  for (let i = 0; i < bufferLength; i++) {
    const sample = timeDomainFloats[i];
    const y = (0.5 - sample / 2) * waveformCanvas.height;
    if (i === 0) {
      waveCtx.moveTo(x, y);
    } else {
      waveCtx.lineTo(x, y);
    }
    x += sliceWidth;
  }

  waveCtx.stroke();

  // Spectrum
  specCtx.fillStyle = '#000';
  specCtx.fillRect(0, 0, spectrumCanvas.width, spectrumCanvas.height);

  const barWidth = freqLength > 0 ? (spectrumCanvas.width / freqLength) * 2.5 : spectrumCanvas.width;
  x = 0;

  for (let i = 0; i < freqLength; i++) {
    const barHeight = freqBuffer[i] / 2;
    specCtx.fillStyle = `rgb(${barHeight + 100}, 50, ${255 - barHeight})`;
    specCtx.fillRect(x, spectrumCanvas.height - barHeight, barWidth, barHeight);
    x += barWidth + 1;
  }

  // Spectrogram (frequency waterfall)
  if (spectrogramCtx && spectrogramCanvas) {
    const specWidth = spectrogramCanvas.width;
    const specHeight = spectrogramCanvas.height;
    const image = spectrogramCtx.getImageData(0, 0, specWidth, specHeight);
    spectrogramCtx.clearRect(0, 0, specWidth, specHeight);
    spectrogramCtx.putImageData(image, -1, 0);
    const columnX = specWidth - 1;
    spectrogramCtx.fillStyle = 'rgba(0, 0, 0, 0.28)';
    spectrogramCtx.fillRect(columnX, 0, 1, specHeight);

    const binHeight = freqLength > 0 ? specHeight / freqLength : specHeight;
    for (let i = 0; i < freqLength; i++) {
      const magnitude = freqBuffer[i] / 255;
      if (magnitude <= 0.02) continue;

      const normalizedFreq = i / freqLength;
      const hue = normalizedFreq * 260;
      const lightness = 18 + magnitude * 55;
      const alpha = Math.min(0.95, 0.18 + magnitude * 0.9);
      const y = Math.round(specHeight - (i + 1) * binHeight);

      spectrogramCtx.fillStyle = `hsla(${hue}, 90%, ${lightness}%, ${alpha})`;
      spectrogramCtx.fillRect(columnX, y, 1, Math.max(1, Math.ceil(binHeight)));
    }
  }

  // Scrolling waveform (time-domain waterfall)
  if (scrollCtx) {
    const scrollWidth = scrollingCanvas.width;
    const scrollHeight = scrollingCanvas.height;
    const temp = scrollCtx.getImageData(0, 0, scrollWidth, scrollHeight);
    scrollCtx.clearRect(0, 0, scrollWidth, scrollHeight);
    scrollCtx.putImageData(temp, -1, 0);
    const columnX = scrollWidth - 1;
    scrollCtx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    scrollCtx.fillRect(columnX, 0, 1, scrollHeight);

    const centerY = scrollHeight / 2;
    const nyquist = (audioCtx && audioCtx.sampleRate) ? audioCtx.sampleRate / 2 : ((analyser.context && analyser.context.sampleRate) ? analyser.context.sampleRate / 2 : 22050);
    const lowCut = 200;
    const midCut = 2000;
    let lowEnergy = 0;
    let midEnergy = 0;
    let highEnergy = 0;
    for (let i = 0; i < freqLength; i++) {
      const magnitude = freqBuffer[i];
      if (magnitude <= 0) continue;
      const freq = (i / Math.max(1, freqLength - 1)) * nyquist;
      if (freq < lowCut) {
        lowEnergy += magnitude;
      } else if (freq < midCut) {
        midEnergy += magnitude;
      } else {
        highEnergy += magnitude;
      }
    }

    const totalEnergy = lowEnergy + midEnergy + highEnergy;
    const lowRatio = totalEnergy > 0 ? lowEnergy / totalEnergy : 0;
    const midRatio = totalEnergy > 0 ? midEnergy / totalEnergy : 0;
    const highRatio = totalEnergy > 0 ? highEnergy / totalEnergy : 0;

    let blendedHue = dominantHue;
    if (totalEnergy > 0) {
      const lowHue = 28;
      const midHue = 140;
      const highHue = 255;
      const bandHue = (lowHue * lowRatio) + (midHue * midRatio) + (highHue * highRatio);
      blendedHue = (dominantHue * 0.55) + (bandHue * 0.45);
    }

    let slopeSum = 0;
    for (let i = 1; i < bufferLength; i++) {
      slopeSum += Math.abs(timeDomainFloats[i] - timeDomainFloats[i - 1]);
    }
    const slopeAvg = bufferLength > 1 ? slopeSum / (bufferLength - 1) : 0;
    const slopeHueShift = Math.min(45, slopeAvg * 640);
    const finalHue = (blendedHue + slopeHueShift) % 360;

    const saturation = Math.min(100, 55 + spectralEnergy * 30 + highRatio * 18);
    const baseLightness = Math.min(70, 26 + spectralEnergy * 28 + midRatio * 14);
    const alphaBase = 0.18 + spectralEnergy * 0.4;

    // Blend frequency bands and waveform motion to drive richer color variation.
    for (let i = 0; i < bufferLength; i++) {
      const sample = timeDomainFloats[i];
      const magnitude = Math.abs(sample);
      const hueOffset = sample >= 0 ? highRatio * 35 : -lowRatio * 28;
      const hue = (finalHue + hueOffset + 360) % 360;
      const lightness = Math.max(16, Math.min(88, baseLightness + magnitude * 42 + highRatio * 6));
      const alpha = Math.min(0.95, alphaBase + magnitude * 0.85);
      const y = centerY + sample * centerY;

      scrollCtx.fillStyle = `hsla(${hue}, ${saturation}%, ${lightness}%, ${alpha})`;
      scrollCtx.fillRect(columnX, y, 1, 2);
    }
  }

}

audio.addEventListener('play', () => {
  initAudio();
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(err => console.warn('AudioContext resume failed:', err));
  }
});

// Wait for Meyda to load
window.addEventListener('load', () => {
  if (typeof Meyda !== 'undefined') {
    console.log('Meyda loaded successfully');
    return;
  }

  const fallbackScript = document.createElement('script');
  fallbackScript.src = 'https://cdn.jsdelivr.net/npm/meyda@5.6.3/dist/web/meyda.min.js';
  fallbackScript.crossOrigin = 'anonymous';
  fallbackScript.onload = () => {
    if (typeof Meyda !== 'undefined') {
      console.log('Meyda loaded via fallback CDN');
      status.textContent = 'Idle';
      status.className = 'status';
    } else {
      console.error('Meyda failed to initialize after fallback');
      status.textContent = 'Library Error';
      status.className = 'status error';
    }
  };
  fallbackScript.onerror = () => {
    console.error('Meyda failed to load');
    status.textContent = 'Library Error';
    status.className = 'status error';
  };
  document.head.appendChild(fallbackScript);
});

draw();
