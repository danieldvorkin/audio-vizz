// State
let tracks = [];
let currentIndex = -1;
let audioCtx = null;
let analyser = null;
let inputAnalyser = null;
let source = null;
let gainNode = null;
let analysisRunId = 0;
let backgroundAnalysisRunId = 0;
let referenceIndex = -1;

let loudnessMatchEnabled = false;
let loudnessMatchDeltaDb = null;

// Persistence (IndexedDB)
// localStorage/sessionStorage can't reliably store large audio files.
// IndexedDB supports Blob storage and survives refresh.
const TRACK_DB_NAME = 'meterlab';
const TRACK_DB_VERSION = 1;
const TRACK_STORE = 'tracks';
let trackDbPromise = null;

function openTrackDb() {
  if (trackDbPromise) return trackDbPromise;
  trackDbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB not available in this browser.'));
      return;
    }
    const req = indexedDB.open(TRACK_DB_NAME, TRACK_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(TRACK_STORE)) {
        const store = db.createObjectStore(TRACK_STORE, { keyPath: 'id' });
        store.createIndex('fingerprint', 'fingerprint', { unique: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Failed to open IndexedDB'));
  });
  return trackDbPromise;
}

function createId() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  } catch {
    /* ignore */
  }
  return `t_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function toFingerprint(file) {
  const name = file?.name || '';
  const size = Number.isFinite(file?.size) ? file.size : 0;
  const lastModified = Number.isFinite(file?.lastModified) ? file.lastModified : 0;
  return `${name}|${size}|${lastModified}`;
}

async function dbPutTrackRecord(record) {
  const db = await openTrackDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TRACK_STORE, 'readwrite');
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
    tx.objectStore(TRACK_STORE).put(record);
  });
}

async function dbDeleteTrackRecord(id) {
  const db = await openTrackDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TRACK_STORE, 'readwrite');
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
    tx.objectStore(TRACK_STORE).delete(id);
  });
}

async function dbGetAllTrackRecords() {
  const db = await openTrackDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TRACK_STORE, 'readonly');
    const req = tx.objectStore(TRACK_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error || new Error('Failed to read tracks from IndexedDB'));
  });
}

async function dbGetTrackRecordByFingerprint(fingerprint) {
  if (!fingerprint) return null;
  const db = await openTrackDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TRACK_STORE, 'readonly');
    const store = tx.objectStore(TRACK_STORE);
    let index;
    try {
      index = store.index('fingerprint');
    } catch (err) {
      resolve(null);
      return;
    }
    const req = index.get(fingerprint);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error || new Error('Failed to read track by fingerprint'));
  });
}

async function persistTrack(track) {
  if (!track?.file) return;
  const blob = track.file instanceof Blob ? track.file : null;
  if (!blob) return;

  if (!track.id) track.id = createId();
  if (!track.fingerprint) track.fingerprint = toFingerprint(track.file);
  if (!track.name && track.file?.name) track.name = track.file.name;
  if (!track.size && Number.isFinite(track.file?.size)) track.size = track.file.size;
  if (!track.type && track.file?.type) track.type = track.file.type;
  if (!track.lastModified && Number.isFinite(track.file?.lastModified)) track.lastModified = track.file.lastModified;

  const fingerprint = track.fingerprint;
  try {
    // If this file was already saved before, reuse the existing record id.
    // Prevents failing writes due to the unique fingerprint index.
    const existing = await dbGetTrackRecordByFingerprint(fingerprint);
    if (existing?.id && existing.id !== track.id) {
      track.id = existing.id;
    }

    await dbPutTrackRecord({
      id: track.id,
      fingerprint,
      name: track.name,
      size: track.size,
      type: blob.type || track.type || '',
      lastModified: Number.isFinite(track.lastModified) ? track.lastModified : (track.file?.lastModified || 0),
      blob,
      analysis: track.analysis || null,
      savedAt: Date.now()
    });
    console.debug('[MeterLab] Persisted track:', track.name);
  } catch (err) {
    console.warn('Failed to persist track:', err);
  }
}

async function restoreTracksFromDb() {
  try {
    const records = await dbGetAllTrackRecords();
    if (!Array.isArray(records) || records.length === 0) {
      console.debug('[MeterLab] No persisted tracks found');
      return;
    }

    records.sort((a, b) => (a?.savedAt || 0) - (b?.savedAt || 0));

    for (const r of records) {
      if (!r || !r.blob || !r.name) continue;
      const file = new File([r.blob], r.name, {
        type: r.type || r.blob.type || '',
        lastModified: r.lastModified || Date.now()
      });
      const fingerprint = r.fingerprint || toFingerprint(file);
      if (tracks.some(t => (t.fingerprint && t.fingerprint === fingerprint) || t.id === r.id)) continue;
      tracks.push({
        id: r.id,
        fingerprint,
        name: r.name,
        size: r.size || file.size,
        type: r.type || file.type || '',
        lastModified: r.lastModified || file.lastModified || 0,
        file,
        analysis: r.analysis || null
      });
    }

    if (tracks.length) {
      renderPlaylist();
      updateReferenceUi();
      updateDeltas();
      applyLoudnessMatchGain();
      console.debug('[MeterLab] Restored tracks:', tracks.length);
    }
  } catch (err) {
    console.warn('Failed to restore tracks from IndexedDB:', err);
  }
}

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
const referenceNameEl = document.getElementById('referenceName');
const bpmDeltaEl = document.getElementById('bpmDelta');
const loudnessDeltaEl = document.getElementById('loudnessDelta');
const crestDeltaEl = document.getElementById('crestDelta');
const brightnessDeltaEl = document.getElementById('brightnessDelta');
const rolloffDeltaEl = document.getElementById('rolloffDelta');
const brightnessSummaryEl = document.getElementById('brightnessSummary');
const tonalSummaryEl = document.getElementById('tonalSummary');
const dynamicsSummaryEl = document.getElementById('dynamicsSummary');
const waveformCanvas = document.getElementById('waveform');
const spectrumCanvas = document.getElementById('spectrum');
const spectrogramCanvas = document.getElementById('spectrogram');
const scrollingCanvas = document.getElementById('scrolling');
const meterFill = document.getElementById('meterFill');
const meterText = document.getElementById('meterText');
const inputMeterFill = document.getElementById('inputMeterFill');
const inputMeterText = document.getElementById('inputMeterText');
const outputMeterFill = document.getElementById('outputMeterFill');
const outputMeterText = document.getElementById('outputMeterText');
const meterStack = document.querySelector('.meter-stack');
const canvasStack = document.querySelector('.canvas-stack');
const leftColumn = document.querySelector('.left-column');
const analysisPanel = document.querySelector('.analysis-panel');
const analysisOverlay = document.getElementById('analysisOverlay');
const loudnessMatchToggle = document.getElementById('loudnessMatchToggle');
const loudnessMatchAmountEl = document.getElementById('loudnessMatchAmount');
const loudnessMatchRefreshBtn = document.getElementById('loudnessMatchRefresh');

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

const formatSigned = (value, formatter, unitSuffix = '') => {
  if (!Number.isFinite(value)) return '--';
  const sign = value > 0 ? '+' : (value < 0 ? '−' : '±');
  const abs = Math.abs(value);
  const formatted = formatter(abs);
  return `${sign}${formatted}${unitSuffix}`;
};

const formatSignedHz = (deltaHz) => formatSigned(deltaHz, (v) => {
  if (v >= 1000) return (v / 1000).toFixed(2) + ' kHz';
  return v.toFixed(0) + ' Hz';
});

const formatSignedDb = (deltaDb, unit = ' dB') => formatSigned(deltaDb, (v) => v.toFixed(1), unit);

const formatSignedBpm = (deltaBpm) => formatSigned(deltaBpm, (v) => v.toFixed(0));

function updateReferenceUi() {
  if (!referenceNameEl) return;
  if (referenceIndex >= 0 && tracks[referenceIndex]) {
    referenceNameEl.textContent = tracks[referenceIndex].name;
  } else {
    referenceNameEl.textContent = 'None';
  }
}

function resetDeltas() {
  if (bpmDeltaEl) bpmDeltaEl.textContent = '--';
  if (loudnessDeltaEl) loudnessDeltaEl.textContent = '--';
  if (crestDeltaEl) crestDeltaEl.textContent = '--';
  if (brightnessDeltaEl) brightnessDeltaEl.textContent = '--';
  if (rolloffDeltaEl) rolloffDeltaEl.textContent = '--';
}

function updateDeltas() {
  if (referenceIndex < 0 || !tracks[referenceIndex] || currentIndex < 0 || !tracks[currentIndex]) {
    resetDeltas();
    return;
  }

  const current = tracks[currentIndex].analysis;
  const reference = tracks[referenceIndex].analysis;
  if (!current || !reference) {
    resetDeltas();
    return;
  }

  if (bpmDeltaEl) {
    const delta = (Number.isFinite(current.bpm) && Number.isFinite(reference.bpm)) ? (current.bpm - reference.bpm) : null;
    bpmDeltaEl.textContent = Number.isFinite(delta) ? `Δ ${formatSignedBpm(delta)}` : '--';
  }

  if (loudnessDeltaEl) {
    const delta = (Number.isFinite(current.loudness) && Number.isFinite(reference.loudness)) ? (current.loudness - reference.loudness) : null;
    loudnessDeltaEl.textContent = Number.isFinite(delta) ? `Δ ${formatSignedDb(delta, ' LUFS')}` : '--';
  }

  if (crestDeltaEl) {
    const delta = (Number.isFinite(current.crestDb) && Number.isFinite(reference.crestDb)) ? (current.crestDb - reference.crestDb) : null;
    crestDeltaEl.textContent = Number.isFinite(delta) ? `Δ ${formatSignedDb(delta)}` : '--';
  }

  if (brightnessDeltaEl) {
    const delta = (Number.isFinite(current.brightness) && Number.isFinite(reference.brightness)) ? (current.brightness - reference.brightness) : null;
    brightnessDeltaEl.textContent = Number.isFinite(delta) ? `Δ ${formatSignedHz(delta)}` : '--';
  }

  if (rolloffDeltaEl) {
    const delta = (Number.isFinite(current.rolloff) && Number.isFinite(reference.rolloff)) ? (current.rolloff - reference.rolloff) : null;
    rolloffDeltaEl.textContent = Number.isFinite(delta) ? `Δ ${formatSignedHz(delta)}` : '--';
  }
}

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
    inputAnalyser = audioCtx.createAnalyser();
    gainNode = audioCtx.createGain();
    gainNode.gain.value = 1;
    analyser.fftSize = 2048;
    inputAnalyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.3;
    inputAnalyser.smoothingTimeConstant = 0.3;
    source = audioCtx.createMediaElementSource(audio);
    // Tap input before loudness-match gain.
    source.connect(inputAnalyser);
    source.connect(gainNode);
    gainNode.connect(analyser);
    analyser.connect(audioCtx.destination);
  }
}

function clampDb(valueDb, minDb, maxDb) {
  if (!Number.isFinite(valueDb)) return 0;
  return Math.min(maxDb, Math.max(minDb, valueDb));
}

const MOBILE_METER_MEDIA = '(max-width: 720px)';

function isHorizontalMeters() {
  try {
    return typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia(MOBILE_METER_MEDIA).matches;
  } catch {
    return false;
  }
}

function setMeterFillPercent(fillEl, percent) {
  if (!fillEl) return;
  const clamped = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));
  if (isHorizontalMeters()) {
    fillEl.style.width = clamped + '%';
    fillEl.style.height = '100%';
  } else {
    fillEl.style.height = clamped + '%';
    fillEl.style.width = '100%';
  }
}

function setPlaybackGainLinear(value) {
  if (!audioCtx || !gainNode) return;
  const safe = Number.isFinite(value) ? Math.max(0, Math.min(8, value)) : 1;
  const now = audioCtx.currentTime;
  try {
    gainNode.gain.cancelScheduledValues(now);
    gainNode.gain.setTargetAtTime(safe, now, 0.03);
  } catch {
    gainNode.gain.value = safe;
  }
}

function setLoudnessMatchReadout(deltaDb) {
  if (!loudnessMatchAmountEl) return;
  if (!loudnessMatchEnabled) {
    loudnessMatchAmountEl.textContent = '--';
    return;
  }
  if (!Number.isFinite(deltaDb)) {
    loudnessMatchAmountEl.textContent = '--';
    return;
  }
  const sign = deltaDb > 0 ? '+' : (deltaDb < 0 ? '−' : '±');
  loudnessMatchAmountEl.textContent = `${sign}${Math.abs(deltaDb).toFixed(1)} dB`;
}

function updateOutputMeterUi(outputDbfs) {
  if (!outputMeterFill || !outputMeterText) return;
  const clamped = Number.isFinite(outputDbfs) ? Math.max(-60, Math.min(0, outputDbfs)) : -Infinity;
  const percent = Number.isFinite(clamped) ? ((clamped + 60) / 60) * 100 : 0;

  setMeterFillPercent(outputMeterFill, percent);
  outputMeterText.textContent = Number.isFinite(clamped) ? `${clamped.toFixed(1)}` : '-inf';

  if (clamped > -3) {
    outputMeterFill.style.background = '#f44336';
  } else if (clamped > -12) {
    outputMeterFill.style.background = '#ffeb3b';
  } else {
    outputMeterFill.style.background = '#4caf50';
  }
}

function applyLoudnessMatchGain() {
  if (!loudnessMatchEnabled) {
    setPlaybackGainLinear(1);
    setLoudnessMatchReadout(null);
    loudnessMatchDeltaDb = null;
    return;
  }

  if (referenceIndex < 0 || currentIndex < 0) {
    setPlaybackGainLinear(1);
    setLoudnessMatchReadout(null);
    loudnessMatchDeltaDb = null;
    return;
  }

  const current = tracks[currentIndex]?.analysis;
  const reference = tracks[referenceIndex]?.analysis;
  if (!current || !reference) {
    setPlaybackGainLinear(1);
    setLoudnessMatchReadout(null);
    loudnessMatchDeltaDb = null;
    return;
  }

  const currentLufs = current.loudness;
  const referenceLufs = reference.loudness;
  if (!Number.isFinite(currentLufs) || !Number.isFinite(referenceLufs)) {
    setPlaybackGainLinear(1);
    setLoudnessMatchReadout(null);
    loudnessMatchDeltaDb = null;
    return;
  }

  // Match current playback loudness to reference loudness.
  // Clamp to avoid extreme boosts/cuts and clipping risk.
  const deltaDb = clampDb(referenceLufs - currentLufs, -12, 12);
  const gain = Math.pow(10, deltaDb / 20);
  setPlaybackGainLinear(gain);
  setLoudnessMatchReadout(deltaDb);
  loudnessMatchDeltaDb = deltaDb;
}

if (loudnessMatchToggle) {
  loudnessMatchEnabled = !!loudnessMatchToggle.checked;
  loudnessMatchToggle.addEventListener('change', () => {
    loudnessMatchEnabled = !!loudnessMatchToggle.checked;
    applyLoudnessMatchGain();
  });
}

async function refreshLoudnessMatch() {
  initAudio();
  if (audioCtx && audioCtx.state === 'suspended') {
    try { await audioCtx.resume(); } catch (err) { /* ignore */ }
  }

  if (referenceIndex < 0 || currentIndex < 0) {
    applyLoudnessMatchGain();
    return;
  }

  const currentTrack = tracks[currentIndex];
  const referenceTrack = tracks[referenceIndex];
  if (!currentTrack || !referenceTrack) {
    applyLoudnessMatchGain();
    return;
  }

  const runId = ++backgroundAnalysisRunId;
  const shouldAbort = () => runId !== backgroundAnalysisRunId;

  // Fill missing analyses in the background so gain-match has numbers to use.
  const maybeCompute = async (track) => {
    if (track.analysis) return;
    try {
      const analysis = await computeTrackAnalysis(track, runId, shouldAbort);
      if (shouldAbort()) return;
      if (analysis) track.analysis = analysis;
    } catch (err) {
      console.warn('Refresh analysis failed:', err);
    }
  };

  await maybeCompute(referenceTrack);
  await maybeCompute(currentTrack);
  if (shouldAbort()) return;

  if (currentTrack.analysis && currentIndex >= 0 && tracks[currentIndex] === currentTrack) {
    try { displayAnalysis(currentTrack.analysis); } catch (err) { /* ignore */ }
  }

  applyLoudnessMatchGain();
  updateDeltas();
}

if (loudnessMatchRefreshBtn) {
  loudnessMatchRefreshBtn.addEventListener('click', () => {
    refreshLoudnessMatch();
  });
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
async function handleFiles(files) {
  if (files.length === 0) return;

  const persistPromises = [];

  files.forEach(file => {
    if (!file) return;
    const fingerprint = toFingerprint(file);
    if (tracks.some(t => (t.fingerprint && t.fingerprint === fingerprint) || (t.name === file.name && t.size === file.size))) return;

    const track = {
      id: createId(),
      fingerprint,
      name: file.name,
      size: file.size,
      type: file.type || '',
      lastModified: Number.isFinite(file.lastModified) ? file.lastModified : 0,
      file,
      analysis: null
    };
    tracks.push(track);
    persistPromises.push(persistTrack(track));
  });

  // Best-effort: try to complete the initial DB writes before returning.
  // (If the user refreshes immediately after upload, this reduces the chance
  // that the async transaction hasn't committed yet.)
  try {
    await Promise.all(persistPromises);
  } catch (err) {
    /* ignore */
  }

  renderPlaylist();
}

let playlistPopovers = [];

function initPlaylistPopovers() {
  // Playlist rows are re-rendered often; dispose old popovers to avoid leaks.
  try {
    for (const pop of playlistPopovers) {
      try { pop.dispose(); } catch (err) { /* ignore */ }
    }
  } catch (err) {
    /* ignore */
  }
  playlistPopovers = [];

  if (typeof bootstrap === 'undefined' || !bootstrap?.Popover) return;
  const els = document.querySelectorAll('[data-bs-toggle="popover"]');
  els.forEach((el) => {
    const existing = bootstrap.Popover.getInstance(el);
    if (existing) existing.dispose();
    const pop = new bootstrap.Popover(el, {
      trigger: 'hover focus',
      placement: el.getAttribute('data-bs-placement') || 'top',
      container: 'body'
    });
    playlistPopovers.push(pop);
  });
}

// Initialize any static popovers (e.g., meter controls) on first load.
initPlaylistPopovers();

// Restore persisted playlist tracks (survives refresh).
restoreTracksFromDb();

// Render playlist
function renderPlaylist() {
  if (tracks.length === 0) {
    playlistBody.innerHTML = '<div class="playlist-empty">No tracks loaded. Drop files above to get started.</div>';
    return;
  }

  const playIcon = `
    <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M8 5v14l11-7z"></path>
    </svg>
  `;
  const playingIcon = `
    <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M6 5h4v14H6zM14 5h4v14h-4z"></path>
    </svg>
  `;
  const refIcon = `
    <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"></path>
    </svg>
  `;
  const trashIcon = `
    <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M6 7h12l-1 14H7L6 7zm3-3h6l1 2H8l1-2z"></path>
    </svg>
  `;

  const currentIsPlaying = (i) => {
    if (i !== currentIndex) return false;
    if (!audio) return false;
    return !audio.paused && !audio.ended;
  };

  playlistBody.innerHTML = tracks.map((track, i) => `
    <div class="playlist-item ${i === currentIndex ? 'active' : ''}" data-index="${i}">
      <div>${i + 1}</div>
      <div>${track.name}</div>
      <div class="playlist-actions">
        <button
          class="icon-button ${i === currentIndex ? 'is-active' : ''}"
          onclick="toggleTrackPlayback(${i})"
          aria-label="${currentIsPlaying(i) ? 'Pause' : (i === currentIndex ? 'Resume' : 'Play')} ${track.name}"
          data-bs-toggle="popover"
          data-bs-placement="top"
          data-bs-content="${currentIsPlaying(i) ? 'Pause' : (i === currentIndex ? 'Resume' : 'Play')}"
          type="button"
        >
          ${currentIsPlaying(i) ? playingIcon : playIcon}
        </button>
        <button
          class="icon-button ${i === referenceIndex ? 'is-active' : ''}"
          onclick="setReference(${i})"
          aria-label="${i === referenceIndex ? 'Reference' : 'Set reference'} ${track.name}"
          data-bs-toggle="popover"
          data-bs-placement="top"
          data-bs-content="${i === referenceIndex ? 'Reference' : 'Set reference'}"
          type="button"
        >
          ${refIcon}
        </button>
        <button
          class="icon-button remove-btn"
          onclick="removeTrack(${i})"
          aria-label="Remove ${track.name}"
          data-bs-toggle="popover"
          data-bs-placement="top"
          data-bs-content="Remove"
          type="button"
        >
          ${trashIcon}
        </button>
      </div>
    </div>
  `).join('');

  initPlaylistPopovers();
}

window.toggleTrackPlayback = function(index) {
  initAudio();
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }

  // If it's not the current track, start it.
  if (index !== currentIndex) {
    window.playTrack(index);
    return;
  }

  // If it's the current track, toggle pause/resume without reloading.
  if (!audio.src) {
    window.playTrack(index);
    return;
  }

  if (audio.paused || audio.ended) {
    audio.play().catch(err => {
      console.error('Playback error:', err);
      alert('Could not play audio. Please try again.');
    });
  } else {
    try { audio.pause(); } catch (err) { /* ignore */ }
  }

  renderPlaylist();
};

window.setReference = async function(index) {
  initAudio();
  if (audioCtx && audioCtx.state === 'suspended') {
    try { await audioCtx.resume(); } catch (err) { /* ignore */ }
  }

  if (referenceIndex === index) {
    referenceIndex = -1;
    updateReferenceUi();
    renderPlaylist();
    updateDeltas();
    applyLoudnessMatchGain();
    return;
  }

  referenceIndex = index;
  updateReferenceUi();
  renderPlaylist();

  const track = tracks[index];
  if (!track) {
    updateDeltas();
    return;
  }

  // Ensure analysis exists for the reference, without interrupting the current UI analysis.
  if (!track.analysis) {
    const runId = ++backgroundAnalysisRunId;
    try {
      const analysis = await computeTrackAnalysis(track, runId, () => runId !== backgroundAnalysisRunId);
      if (runId !== backgroundAnalysisRunId) return;
      if (analysis) {
        track.analysis = analysis;
        persistTrack(track);
      }
    } catch (err) {
      console.warn('Reference analysis failed:', err);
    }
  }

  applyLoudnessMatchGain();
  updateDeltas();
};

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

  applyLoudnessMatchGain();

  if (!track.analysis) {
    const runId = ++analysisRunId;
    analyzeTrack(track, runId);
  } else {
    if (analysisPanel) analysisPanel.classList.remove('loading');
    if (analysisOverlay) analysisOverlay.setAttribute('aria-hidden', 'true');
    status.textContent = 'Ready';
    status.className = 'status ready';
    displayAnalysis(track.analysis);
    applyLoudnessMatchGain();
  }
};

window.removeTrack = function(index) {
  const track = tracks[index];
  if (!track) return;

  const wasCurrent = index === currentIndex;
  const wasReference = index === referenceIndex;

  // Remove from list first (indices shift after this).
  tracks.splice(index, 1);

  if (track?.id) {
    dbDeleteTrackRecord(track.id).catch((err) => {
      console.warn('Failed to delete persisted track:', err);
    });
  }

  // Adjust indices to account for the removed element.
  if (wasCurrent) {
    currentIndex = -1;
  } else if (currentIndex > index) {
    currentIndex -= 1;
  }

  if (wasReference) {
    referenceIndex = -1;
  } else if (referenceIndex > index) {
    referenceIndex -= 1;
  }

  // If we removed the currently playing track, stop playback and clear UI.
  if (wasCurrent) {
    try { audio.pause(); } catch (err) { /* ignore */ }
    if (audio.src && audio.src.startsWith('blob:')) {
      try { URL.revokeObjectURL(audio.src); } catch (err) { /* ignore */ }
    }
    audio.removeAttribute('src');
    try { audio.load(); } catch (err) { /* ignore */ }

    // Cancel any in-flight UI analysis and reset panels.
    analysisRunId += 1;
    if (analysisPanel) analysisPanel.classList.remove('loading');
    if (analysisOverlay) analysisOverlay.setAttribute('aria-hidden', 'true');
    if (status) {
      status.textContent = 'Ready';
      status.className = 'status ready';
    }
    resetAnalysis();
  }

  // If we removed the reference track, cancel any in-flight background analysis.
  if (wasReference) {
    backgroundAnalysisRunId += 1;
  }

  updateReferenceUi();
  renderPlaylist();
  updateDeltas();
  applyLoudnessMatchGain();
};

async function computeTrackAnalysis(track, runId, shouldAbort) {
  if (typeof Meyda === 'undefined') {
    throw new Error('Meyda library not loaded. Please refresh the page.');
  }
  if (!audioCtx) {
    throw new Error('AudioContext not initialized.');
  }

  const buffer = await track.file.arrayBuffer();
  if (shouldAbort && shouldAbort()) return null;

  const decoded = await audioCtx.decodeAudioData(buffer);
  if (shouldAbort && shouldAbort()) return null;

  const sampleRate = decoded.sampleRate;
  const maxSamples = Math.min(decoded.length, Math.floor(sampleRate * 120));

  let mono;
  if (decoded.numberOfChannels === 1) {
    const channelData = decoded.getChannelData(0);
    const clampedLength = Math.min(channelData.length, maxSamples);
    mono = channelData.subarray(0, clampedLength);
    if (clampedLength > SAMPLE_YIELD_INTERVAL) {
      await yieldToMain();
      if (shouldAbort && shouldAbort()) return null;
    }
  } else {
    mono = new Float32Array(maxSamples);
    for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
      const data = decoded.getChannelData(ch);
      for (let i = 0; i < maxSamples; i++) {
        mono[i] += data[i];
        if (i > 0 && i % SAMPLE_YIELD_INTERVAL === 0) {
          await yieldToMain();
          if (shouldAbort && shouldAbort()) return null;
        }
      }
    }
    for (let i = 0; i < maxSamples; i++) {
      mono[i] /= decoded.numberOfChannels;
      if (i > 0 && i % SAMPLE_YIELD_INTERVAL === 0) {
        await yieldToMain();
        if (shouldAbort && shouldAbort()) return null;
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
      if (shouldAbort && shouldAbort()) return null;
    }
  }
  const overallRms = mono.length ? Math.sqrt(sumSquares / mono.length) : null;

  const bpmResult = await estimateBpmFromMono(
    mono,
    sampleRate,
    () => (shouldAbort && shouldAbort())
  );
  if (shouldAbort && shouldAbort()) return null;

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
      if (shouldAbort && shouldAbort()) return null;
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

  return {
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
}

// Analyze track (UI)
async function analyzeTrack(track, runId) {
  const thisRunId = runId ?? ++analysisRunId;
  status.textContent = 'Analyzing...';
  status.className = 'status analyzing';
  resetAnalysis();
  if (analysisPanel) analysisPanel.classList.add('loading');
  if (analysisOverlay) analysisOverlay.setAttribute('aria-hidden', 'false');

  try {
    const analysis = await computeTrackAnalysis(track, thisRunId, () => thisRunId !== analysisRunId);
    if (!analysis || thisRunId !== analysisRunId) return;

    track.analysis = analysis;
    persistTrack(track);

    if (track === tracks[currentIndex]) {
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

  const buildScaleTemplate = (intervals) => {
    // Simple non-negative template: emphasize tonic, keep non-scale tones low.
    // Normalization (below) makes templates comparable.
    const inScale = 1.0;
    const outScale = 0.18;
    const tonicBoost = 1.25;
    const template = new Array(12).fill(outScale);
    for (const step of intervals) {
      template[((step % 12) + 12) % 12] = inScale;
    }
    template[0] = Math.max(template[0], tonicBoost);
    return template;
  };

  const SCALE_TEMPLATES = [
    // Existing Krumhansl-style profiles for major/minor.
    { name: 'major', profile: MAJOR },
    { name: 'minor', profile: MINOR },
    // Common diatonic modes (intervals from tonic).
    { name: 'dorian', profile: buildScaleTemplate([0, 2, 3, 5, 7, 9, 10]) },
    { name: 'phrygian', profile: buildScaleTemplate([0, 1, 3, 5, 7, 8, 10]) },
    { name: 'lydian', profile: buildScaleTemplate([0, 2, 4, 6, 7, 9, 11]) },
    { name: 'mixolydian', profile: buildScaleTemplate([0, 2, 4, 5, 7, 9, 10]) },
    { name: 'locrian', profile: buildScaleTemplate([0, 1, 3, 5, 6, 8, 10]) }
  ];

  const normChroma = normalize(chroma);
  let best = { score: -Infinity, name: null, scale: null };

  for (let i = 0; i < 12; i++) {
    for (const template of SCALE_TEMPLATES) {
      const normTemplate = normalize(template.profile);
      const score = dot(normChroma, rotate(normTemplate, i));
      if (score > best.score) {
        best = { score, name: KEY_NAMES[i], scale: template.name };
      }
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
  updateReferenceUi();
  updateDeltas();
  applyLoudnessMatchGain();
}

// Reset analysis
function resetAnalysis() {
  keyEl.textContent = '--';
  scaleEl.textContent = '--';
  confidenceEl.textContent = '--';
  brightnessEl.textContent = '--';
  durationEl.textContent = '--';
  if (bpmEl) bpmEl.textContent = '--';
  updateReferenceUi();
  resetDeltas();
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
  if (!meterStack || !canvasStack) return;
  const isNarrow = window.matchMedia('(max-width: 1100px)').matches;
  if (isNarrow) {
    meterStack.style.height = 'auto';
    if (leftColumn) {
      leftColumn.style.height = 'auto';
      leftColumn.style.maxHeight = 'none';
    }
    return;
  }
  const rect = canvasStack.getBoundingClientRect();
  if (rect.height > 0) {
    const setHeight = (el, targetHeight) => {
      if (!el) return;
      const styles = window.getComputedStyle(el);
      const paddingTop = parseFloat(styles.paddingTop) || 0;
      const paddingBottom = parseFloat(styles.paddingBottom) || 0;
      const borderTop = parseFloat(styles.borderTopWidth) || 0;
      const borderBottom = parseFloat(styles.borderBottomWidth) || 0;
      const extra = paddingTop + paddingBottom + borderTop + borderBottom;
      const boxSizing = styles.boxSizing;
      const height = boxSizing === 'border-box' ? targetHeight : Math.max(0, targetHeight - extra);
      el.style.height = height + 'px';
      el.style.maxHeight = height + 'px';
    };

    setHeight(meterStack, rect.height);
    setHeight(leftColumn, rect.height);
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
let inputTimeDomainBytes = null;

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

  // Input meter (pre loudness-match gain)
  if (inputAnalyser && inputMeterFill && inputMeterText) {
    const inLen = inputAnalyser.fftSize;
    if (!inputTimeDomainBytes || inputTimeDomainBytes.length !== inLen) {
      inputTimeDomainBytes = new Uint8Array(inLen);
    }
    inputAnalyser.getByteTimeDomainData(inputTimeDomainBytes);
    let inSumSq = 0;
    for (let i = 0; i < inLen; i++) {
      const s = (inputTimeDomainBytes[i] - 128) / 128;
      inSumSq += s * s;
    }
    const inRms = Math.sqrt(inSumSq / Math.max(1, inLen));
    const inDbfs = inRms > 1e-6 ? 20 * Math.log10(inRms) : -Infinity;
    const clampedIn = Math.max(-60, Math.min(0, inDbfs));
    const inPercent = ((clampedIn + 60) / 60) * 100;
    setMeterFillPercent(inputMeterFill, inPercent);
    inputMeterText.textContent = Number.isFinite(clampedIn) ? `${clampedIn.toFixed(1)}` : '-inf';

    if (clampedIn > -3) {
      inputMeterFill.style.background = '#f44336';
    } else if (clampedIn > -12) {
      inputMeterFill.style.background = '#ffeb3b';
    } else {
      inputMeterFill.style.background = '#4caf50';
    }
  }

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

  setMeterFillPercent(meterFill, percent);
  meterText.textContent = hasSignal && Number.isFinite(clampedLufs)
    ? clampedLufs.toFixed(1)
    : '-inf';

  if (clampedLufs > -14) {
    meterFill.style.background = '#f44336';
  } else if (clampedLufs > -23) {
    meterFill.style.background = '#ffeb3b';
  } else {
    meterFill.style.background = '#4caf50';
  }

  // Output meter (post gain, dBFS based on RMS)
  const outDbfs = rms > 1e-6 ? 20 * Math.log10(rms) : -Infinity;
  updateOutputMeterUi(outDbfs);


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

  renderPlaylist();
});

audio.addEventListener('pause', () => {
  renderPlaylist();
});

audio.addEventListener('ended', () => {
  renderPlaylist();
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
