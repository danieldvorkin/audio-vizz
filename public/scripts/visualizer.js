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
const reanalyzeBtn = document.getElementById('reanalyzeBtn');
const loudnessMatchToggle = document.getElementById('loudnessMatchToggle');
const loudnessMatchAmountEl = document.getElementById('loudnessMatchAmount');
const loudnessMatchRefreshBtn = document.getElementById('loudnessMatchRefresh');

// Song score elements
const genreSelect = document.getElementById('genreSelect');
const songScoreValueEl = document.getElementById('songScoreValue');
const songScoreLabelEl = document.getElementById('songScoreLabel');
const songScoreBreakdownEl = document.getElementById('songScoreBreakdown');
const songScoreDetailsEl = document.getElementById('songScoreDetails');
const refreshScoreBtn = document.getElementById('refreshScoreBtn');

// Capture default tooltip text so we can append dynamic hints safely.
const keyMetricTileEl = keyEl?.closest?.('.metric') || null;
const scaleMetricTileEl = scaleEl?.closest?.('.metric') || null;
const confidenceMetricTileEl = confidenceEl?.closest?.('.metric') || null;
const KEY_TOOLTIP_DEFAULT = keyMetricTileEl?.getAttribute?.('data-tooltip') || '';
const SCALE_TOOLTIP_DEFAULT = scaleMetricTileEl?.getAttribute?.('data-tooltip') || '';
const CONFIDENCE_TOOLTIP_DEFAULT = confidenceMetricTileEl?.getAttribute?.('data-tooltip') || '';

function confidenceLabel(confidence01) {
  if (!Number.isFinite(confidence01)) return { label: '--', bucket: 'unknown' };
  if (confidence01 >= 0.72) return { label: 'High', bucket: 'high' };
  if (confidence01 >= 0.45) return { label: 'Medium', bucket: 'medium' };
  return { label: 'Low', bucket: 'low' };
}

// Constants
const KEY_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const SAMPLE_YIELD_INTERVAL = 131072;
const FRAME_YIELD_INTERVAL = 32;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const clamp01 = (value) => clamp(value, 0, 1);

let CHROMA_CALIBRATION_SHIFT = 0;

function rotateLeft12(arr, n) {
  if (!Array.isArray(arr) || arr.length !== 12) return arr;
  const offset = ((n % 12) + 12) % 12;
  return arr.slice(offset).concat(arr.slice(0, offset));
}

function hpcpFromAmplitudeSpectrum(amplitudeSpectrum, sampleRate, bufferSize, minHz, maxHz) {
  const chroma = new Array(12).fill(0);
  if (!Array.isArray(amplitudeSpectrum) || amplitudeSpectrum.length === 0) return chroma;
  if (!Number.isFinite(sampleRate) || !Number.isFinite(bufferSize) || bufferSize <= 0) return chroma;

  const freqPerBin = sampleRate / bufferSize;
  const lo = Number.isFinite(minHz) ? Math.max(0, minHz) : 0;
  const hi = Number.isFinite(maxHz) ? Math.max(lo, maxHz) : sampleRate / 2;

  for (let i = 1; i < amplitudeSpectrum.length; i++) {
    const f = i * freqPerBin;
    if (f < lo || f > hi) continue;
    const mag = amplitudeSpectrum[i];
    if (!Number.isFinite(mag) || mag <= 0) continue;

    // Map frequency to pitch class. Weighted to emphasize lower partials.
    const midi = 69 + 12 * Math.log2(f / 440);
    if (!Number.isFinite(midi)) continue;
    // Soft assignment to adjacent pitch classes (reduces detune/rounding artifacts).
    const pcFloat = ((midi % 12) + 12) % 12;
    const pc0 = Math.floor(pcFloat) % 12;
    const frac = pcFloat - Math.floor(pcFloat);
    const pc1 = (pc0 + 1) % 12;
    const weight = mag / Math.sqrt(Math.max(40, f));
    chroma[pc0] += weight * (1 - frac);
    chroma[pc1] += weight * frac;
  }

  return chroma;
}

function normalizeChromaSum(arr) {
  if (!Array.isArray(arr) || arr.length !== 12) return new Array(12).fill(0);
  const safe = arr.map(v => (Number.isFinite(v) && v > 0 ? v : 0));
  const sum = safe.reduce((s, v) => s + v, 0);
  return sum > 0 ? safe.map(v => v / sum) : safe;
}

function blendChroma(a, b, t) {
  if (!Array.isArray(a) || a.length !== 12) return b;
  if (!Array.isArray(b) || b.length !== 12) return a;
  const mix = clamp01(t);
  const out = new Array(12);
  for (let i = 0; i < 12; i++) {
    const av = Number.isFinite(a[i]) ? a[i] : 0;
    const bv = Number.isFinite(b[i]) ? b[i] : 0;
    out[i] = (1 - mix) * av + mix * bv;
  }
  return out;
}

function calibrateChromaShift() {
  try {
    if (typeof Meyda === 'undefined') return 0;
    if (typeof Meyda.extract !== 'function') return 0;
    if (typeof Meyda.featureExtractors !== 'object' || !Meyda.featureExtractors?.chroma) return 0;

    const sampleRate = 44100;
    const bufferSize = 4096;
    const frame = new Float32Array(bufferSize);

    // A clean synthetic tone helps verify chroma bin ordering.
    // We use C4 + C5 to strengthen the pitch class without adding non-harmonic energy.
    const f1 = 261.625565; // C4
    const f2 = 523.25113;  // C5
    for (let i = 0; i < bufferSize; i++) {
      const t = i / sampleRate;
      // Hann-ish envelope to reduce spectral leakage.
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (bufferSize - 1));
      frame[i] = w * (0.6 * Math.sin(2 * Math.PI * f1 * t) + 0.4 * Math.sin(2 * Math.PI * f2 * t));
    }

    const chroma = Meyda.extract('chroma', frame, { bufferSize, sampleRate, windowingFunction: 'hann' });
    if (!Array.isArray(chroma) || chroma.length !== 12) return 0;

    let maxIdx = 0;
    let maxVal = -Infinity;
    for (let i = 0; i < 12; i++) {
      const v = Number.isFinite(chroma[i]) ? chroma[i] : -Infinity;
      if (v > maxVal) {
        maxVal = v;
        maxIdx = i;
      }
    }

    // Expected pitch class index for C is 0 (KEY_NAMES[0] = C).
    const shift = ((0 - maxIdx) % 12 + 12) % 12;
    return shift;
  } catch (err) {
    console.debug('Chroma calibration failed:', err);
    return 0;
  }
}

const REFERENCE_TOLERANCES = {
  loudness: 1.6,
  crestDb: 1.8,
  brightness: 550,
  rolloff: 1100,
  flatness: 0.10,
  bpm: 4.0
};

// Song score (genre targets + optional reference match)
const GENRE_PROFILES = {
  pop: {
    name: 'Pop',
    targets: { loudness: -14, crestDb: 8.0, brightness: 2600, rolloff: 9000, flatness: 0.26 },
    tolerances: { loudness: 3.5, crestDb: 3.0, brightness: 900, rolloff: 1800, flatness: 0.18 }
  },
  edm: {
    name: 'EDM',
    targets: { loudness: -8.5, crestDb: 6.0, brightness: 3200, rolloff: 10500, flatness: 0.32 },
    tolerances: { loudness: 3.0, crestDb: 2.5, brightness: 1000, rolloff: 2000, flatness: 0.20 }
  },
  hiphop: {
    name: 'Hip-Hop',
    targets: { loudness: -10.5, crestDb: 7.0, brightness: 2200, rolloff: 8500, flatness: 0.30 },
    tolerances: { loudness: 3.5, crestDb: 3.0, brightness: 900, rolloff: 1800, flatness: 0.20 }
  },
  rock: {
    name: 'Rock',
    targets: { loudness: -11.5, crestDb: 9.0, brightness: 2700, rolloff: 9500, flatness: 0.24 },
    tolerances: { loudness: 3.5, crestDb: 3.5, brightness: 900, rolloff: 2000, flatness: 0.18 }
  },
  jazz: {
    name: 'Jazz',
    targets: { loudness: -18.0, crestDb: 12.0, brightness: 2100, rolloff: 7800, flatness: 0.20 },
    tolerances: { loudness: 4.0, crestDb: 4.0, brightness: 900, rolloff: 1800, flatness: 0.16 }
  },
  classical: {
    name: 'Classical',
    targets: { loudness: -23.0, crestDb: 16.0, brightness: 1800, rolloff: 6500, flatness: 0.16 },
    tolerances: { loudness: 4.5, crestDb: 5.0, brightness: 900, rolloff: 1800, flatness: 0.14 }
  },
  voice: {
    name: 'Podcast / Voice',
    targets: { loudness: -16.0, crestDb: 10.0, brightness: 1800, rolloff: 6000, flatness: 0.18 },
    tolerances: { loudness: 3.0, crestDb: 4.0, brightness: 800, rolloff: 1500, flatness: 0.14 }
  }
};

const SCORE_WEIGHTS = {
  loudness: 0.32,
  crestDb: 0.26,
  brightness: 0.14,
  rolloff: 0.14,
  flatness: 0.14,
  bpm: 0.08
};

function safeGetLocalStorage(key) {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetLocalStorage(key, value) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

function metricScore(current, target, tolerance) {
  if (!Number.isFinite(current) || !Number.isFinite(target) || !Number.isFinite(tolerance) || tolerance <= 0) return null;
  const err = Math.abs(current - target) / tolerance;
  const normalized = clamp01(err);
  return 100 * (1 - normalized);
}

function formatMaybeSignedDelta(value, unit) {
  if (!Number.isFinite(value)) return '--';
  const sign = value > 0 ? '+' : (value < 0 ? '−' : '±');
  const abs = Math.abs(value);
  const formatted = Number.isFinite(abs) ? abs.toFixed(1) : '--';
  return `${sign}${formatted}${unit || ''}`;
}

function advisoryForMetric(metric, delta, scope) {
  const where = scope === 'ref' ? 'vs reference' : 'vs genre target';
  if (!Number.isFinite(delta)) return null;

  switch (metric) {
    case 'loudness': {
      if (delta > 1.2) return `Too loud ${where}. Lower limiter/clipper gain or back off bus compression.`;
      if (delta < -1.2) return `Too quiet ${where}. Increase master gain/limiting, or rebalance track levels.`;
      return `Loudness is close ${where}.`;
    }
    case 'crestDb': {
      if (delta < -1.2) return `Dynamics look tight ${where}. Ease compression/limiting; let transients through.`;
      if (delta > 1.2) return `Dynamics are very open ${where}. If it feels weak, add gentle bus compression.`;
      return `Dynamics are close ${where}.`;
    }
    case 'brightness': {
      if (delta > 350) return `Brighter ${where}. Tame 6–12 kHz, de-ess, or reduce harsh synth/cymbals.`;
      if (delta < -350) return `Darker ${where}. Add presence/air (EQ 3–10 kHz) or brighten key elements.`;
      return `Brightness is close ${where}.`;
    }
    case 'rolloff': {
      if (delta > 500) return `More high-end energy ${where}. Check hiss/harshness; smooth the top end.`;
      if (delta < -500) return `Less high-end energy ${where}. Add air, improve cymbal/vocal presence.`;
      return `Top-end roll-off is close ${where}.`;
    }
    case 'flatness': {
      if (delta > 0.06) return `More noise-like ${where}. Reduce wideband noise/hiss; tighten resonance or reverb.`;
      if (delta < -0.06) return `More tonal ${where}. If it’s boxy, add subtle texture or widen frequency spread.`;
      return `Tonal/noise balance is close ${where}.`;
    }
    case 'bpm': {
      if (Math.abs(delta) > 6) return `Tempo estimate differs ${where}. If wrong, ignore; BPM detection can miss.`;
      return `Tempo is close ${where}.`;
    }
    default:
      return null;
  }
}

function weightedAverageScore(parts) {
  let sum = 0;
  let wsum = 0;
  for (const p of parts) {
    if (!p || !Number.isFinite(p.score) || !Number.isFinite(p.weight) || p.weight <= 0) continue;
    sum += p.score * p.weight;
    wsum += p.weight;
  }
  if (wsum <= 0) return null;
  return sum / wsum;
}

function scoreLabel(score) {
  if (!Number.isFinite(score)) return '--';
  if (score >= 90) return 'Excellent';
  if (score >= 80) return 'Great';
  if (score >= 70) return 'Good';
  if (score >= 60) return 'Fair';
  return 'Needs work';
}

function computeScoreAgainstTargets(analysis, targets, tolerances, includeBpm = false) {
  if (!analysis || !targets || !tolerances) return { score: null, perMetric: {} };

  const perMetric = {
    loudness: metricScore(analysis.loudness, targets.loudness, tolerances.loudness),
    crestDb: metricScore(analysis.crestDb, targets.crestDb, tolerances.crestDb),
    brightness: metricScore(analysis.brightness, targets.brightness, tolerances.brightness),
    rolloff: metricScore(analysis.rolloff, targets.rolloff, tolerances.rolloff),
    flatness: metricScore(analysis.flatness, targets.flatness, tolerances.flatness)
  };

  if (includeBpm) {
    perMetric.bpm = metricScore(analysis.bpm, targets.bpm, tolerances.bpm);
  }

  const parts = Object.entries(perMetric).map(([k, v]) => ({ metric: k, score: v, weight: SCORE_WEIGHTS[k] || 0 }));
  const score = weightedAverageScore(parts);
  return { score, perMetric, parts };
}

function computeSongScore(current, reference, genreKey) {
  if (!current) {
    return {
      score: null,
      label: 'Load a track to score',
      breakdown: '--'
    };
  }

  const hasReference = !!reference;
  const wantsGenre = genreKey && genreKey !== 'none' && GENRE_PROFILES[genreKey];
  const genreProfile = wantsGenre ? GENRE_PROFILES[genreKey] : null;

  let referenceScore = null;
  let genreScore = null;
  let currentGenreScore = null;
  let referenceGenreScore = null;

  if (hasReference) {
    const refTargets = {
      loudness: reference.loudness,
      crestDb: reference.crestDb,
      brightness: reference.brightness,
      rolloff: reference.rolloff,
      flatness: reference.flatness,
      bpm: reference.bpm
    };
    referenceScore = computeScoreAgainstTargets(current, refTargets, REFERENCE_TOLERANCES, true);
  }

  if (genreProfile) {
    genreScore = computeScoreAgainstTargets(current, genreProfile.targets, genreProfile.tolerances, false);
    currentGenreScore = genreScore;
    if (hasReference) {
      referenceGenreScore = computeScoreAgainstTargets(reference, genreProfile.targets, genreProfile.tolerances, false);
    }
  }

  let finalScore = null;
  if (referenceScore?.score != null && genreScore?.score != null) {
    finalScore = 0.7 * referenceScore.score + 0.3 * genreScore.score;
  } else if (referenceScore?.score != null) {
    finalScore = referenceScore.score;
  } else if (genreScore?.score != null) {
    finalScore = genreScore.score;
  }

  if (finalScore == null) {
    return {
      score: null,
      label: hasReference ? 'Set a genre for extra context' : 'Set a reference or pick a genre',
      breakdown: hasReference ? 'Reference match available, but missing metrics.' : '--',
      details: null
    };
  }

  const label = scoreLabel(finalScore);

  const metricFriendly = {
    loudness: 'Loudness',
    crestDb: 'Dynamics',
    brightness: 'Brightness',
    rolloff: 'Roll-off',
    flatness: 'Tonal balance',
    bpm: 'Tempo'
  };

  const combinedPerMetric = {};
  if (referenceScore?.perMetric) {
    for (const [k, v] of Object.entries(referenceScore.perMetric)) {
      if (Number.isFinite(v)) combinedPerMetric[`ref_${k}`] = v;
    }
  }
  if (genreScore?.perMetric) {
    for (const [k, v] of Object.entries(genreScore.perMetric)) {
      if (Number.isFinite(v)) combinedPerMetric[`genre_${k}`] = v;
    }
  }

  let lowest = null;
  for (const [key, value] of Object.entries(combinedPerMetric)) {
    if (!Number.isFinite(value)) continue;
    if (!lowest || value < lowest.value) lowest = { key, value };
  }

  const basisParts = [];
  if (referenceScore?.score != null) basisParts.push(`Ref ${Math.round(referenceScore.score)}`);
  if (genreScore?.score != null) basisParts.push(`${genreProfile?.name || 'Genre'} ${Math.round(genreScore.score)}`);
  const basisText = basisParts.length ? basisParts.join(' · ') : '--';

  let lowestText = '';
  if (lowest) {
    const [scope, metric] = lowest.key.split('_');
    const prefix = scope === 'ref' ? 'Ref' : 'Genre';
    lowestText = ` | Lowest: ${prefix} ${metricFriendly[metric] || metric} ${Math.round(lowest.value)}`;
  }

  const details = {
    basis: {
      hasReference: referenceScore?.score != null,
      hasGenre: genreScore?.score != null,
      genreName: genreProfile?.name || null
    },
    current,
    reference: hasReference ? reference : null,
    genreProfile,
    referenceScore,
    genreScore,
    currentGenreScore,
    referenceGenreScore
  };

  return {
    score: finalScore,
    label,
    breakdown: `${basisText}${lowestText}`,
    details
  };
}

function weightedAverageFromKeys(perMetric, keys, weightMap) {
  if (!perMetric || !Array.isArray(keys) || keys.length === 0) return null;
  const parts = keys.map(k => ({ metric: k, score: perMetric[k], weight: weightMap?.[k] ?? 0 }));
  const score = weightedAverageScore(parts);
  return Number.isFinite(score) ? score : null;
}

function computeScoreSummary(details) {
  if (!details?.current) return null;

  const wantsGenre = !!details.genreProfile && !!details.currentGenreScore?.score;
  const wantsReference = !!details.reference && !!details.referenceScore?.score;

  const basis = wantsGenre
    ? {
        name: `${details.genreProfile?.name || 'Genre'} target`,
        targets: details.genreProfile.targets,
        tolerances: details.genreProfile.tolerances
      }
    : (wantsReference
        ? {
            name: 'Reference',
            targets: {
              loudness: details.reference.loudness,
              crestDb: details.reference.crestDb,
              brightness: details.reference.brightness,
              rolloff: details.reference.rolloff,
              flatness: details.reference.flatness
            },
            tolerances: REFERENCE_TOLERANCES
          }
        : null);

  if (!basis?.targets || !basis?.tolerances) return null;

  const a = details.current;
  const t = basis.targets;
  const tol = basis.tolerances;

  const deltas = {
    loudness: (Number.isFinite(a.loudness) && Number.isFinite(t.loudness)) ? (a.loudness - t.loudness) : null,
    crestDb: (Number.isFinite(a.crestDb) && Number.isFinite(t.crestDb)) ? (a.crestDb - t.crestDb) : null
  };

  const perMetric = {
    loudness: metricScore(a.loudness, t.loudness, tol.loudness),
    crestDb: metricScore(a.crestDb, t.crestDb, tol.crestDb),
    brightness: metricScore(a.brightness, t.brightness, tol.brightness),
    rolloff: metricScore(a.rolloff, t.rolloff, tol.rolloff),
    flatness: metricScore(a.flatness, t.flatness, tol.flatness)
  };

  const levelScore = perMetric.loudness;
  const dynamicsScore = perMetric.crestDb;
  const toneScore = weightedAverageFromKeys(perMetric, ['brightness', 'rolloff', 'flatness'], SCORE_WEIGHTS);

  const issues = [];
  const loudnessDelta = deltas.loudness;
  const crestDelta = deltas.crestDb;

  const loudTooHot = Number.isFinite(loudnessDelta) && loudnessDelta > 1.2;
  const loudTooQuiet = Number.isFinite(loudnessDelta) && loudnessDelta < -1.2;
  const crestTooTight = Number.isFinite(crestDelta) && crestDelta < -1.2;
  const crestTooOpen = Number.isFinite(crestDelta) && crestDelta > 1.2;

  if (loudTooHot) issues.push('Loudness is hot');
  if (loudTooQuiet) issues.push('Loudness is low');
  if (crestTooTight) issues.push('Dynamics are tight');
  if (crestTooOpen) issues.push('Dynamics are open');

  let primary = null;
  if (loudTooHot || loudTooQuiet) primary = 'loudness';
  else if (crestTooTight || crestTooOpen) primary = 'dynamics';

  const steps = [];
  if (loudTooHot && crestTooOpen) {
    steps.push('Fix loudness first: reduce limiter/clipper drive and/or trim master gain.');
    steps.push('If you still want “glue”, you can add gentle bus compression, but lower makeup/output so integrated loudness still comes down.');
  } else if (loudTooHot && crestTooTight) {
    steps.push('You’re loud and compressed: back off limiting/compression to recover crest, then re-hit loudness with level balance (not more compression).');
  } else if (loudTooQuiet && crestTooOpen) {
    steps.push('You’re quiet and open: gentle bus compression + limiting can raise density; keep transients alive with slow attack / modest ratio.');
  } else if (loudTooQuiet && crestTooTight) {
    steps.push('You’re quiet but already tight: avoid more compression; rebalance levels/EQ first, then add only minimal limiting at the end.');
  } else if (loudTooHot) {
    steps.push('Bring loudness down: reduce limiter/clipper drive or master gain; avoid chasing volume with more compression.');
  } else if (loudTooQuiet) {
    steps.push('Bring loudness up: increase master gain/limiting carefully, or rebalance mix levels into the limiter.');
  } else if (crestTooTight) {
    steps.push('Open dynamics: ease bus compression/limiting, or use parallel compression instead of more gain reduction.');
  } else if (crestTooOpen) {
    steps.push('Add control: if it feels weak, try gentle bus compression (1–2 dB GR) or transient shaping.');
  } else {
    steps.push('No major loudness/dynamics red flags; use the metric rows for fine-tuning.');
  }

  return {
    basisName: basis.name,
    deltas,
    perMetric,
    levelScore,
    dynamicsScore,
    toneScore,
    issues,
    primary,
    steps
  };
}

function updateSongScoreUi() {
  if (!songScoreValueEl || !songScoreLabelEl || !songScoreBreakdownEl) return;

  const current = (currentIndex >= 0 && tracks[currentIndex]) ? tracks[currentIndex].analysis : null;
  const reference = (referenceIndex >= 0 && tracks[referenceIndex]) ? tracks[referenceIndex].analysis : null;
  const genreKey = genreSelect ? genreSelect.value : 'pop';
  const result = computeSongScore(current, reference, genreKey);

  if (!Number.isFinite(result?.score)) {
    songScoreValueEl.textContent = '--';
    songScoreLabelEl.textContent = result?.label || '--';
    songScoreBreakdownEl.textContent = result?.breakdown || '--';
    if (songScoreDetailsEl) songScoreDetailsEl.textContent = '--';
    return;
  }

  const rounded = Math.round(clamp(result.score, 0, 100));
  songScoreValueEl.textContent = `${rounded}`;
  songScoreLabelEl.textContent = result.label;
  songScoreBreakdownEl.textContent = result.breakdown;

  if (songScoreDetailsEl) {
    const details = result.details;
    if (!details) {
      songScoreDetailsEl.textContent = '--';
    } else {
      const metricMeta = [
        {
          key: 'loudness',
          label: 'Loudness',
          fmt: (v) => Number.isFinite(v) ? `${v.toFixed(1)} LUFS` : '--',
          unitDelta: ' LUFS'
        },
        {
          key: 'crestDb',
          label: 'Dynamics (crest)',
          fmt: (v) => Number.isFinite(v) ? `${v.toFixed(1)} dB` : '--',
          unitDelta: ' dB'
        },
        {
          key: 'brightness',
          label: 'Brightness',
          fmt: (v) => formatHz(v),
          unitDelta: ' Hz'
        },
        {
          key: 'rolloff',
          label: 'Roll-off',
          fmt: (v) => formatHz(v),
          unitDelta: ' Hz'
        },
        {
          key: 'flatness',
          label: 'Tonal balance',
          fmt: (v) => Number.isFinite(v) ? formatPercent(v) : '--',
          unitDelta: ''
        }
      ];

      const wantsGenre = !!details.genreProfile && !!details.currentGenreScore?.score;
      const wantsReferenceMatch = !!details.reference && !!details.referenceScore?.score;
      const hasReferenceForGenre = wantsGenre && !!details.reference && !!details.referenceGenreScore?.score;

      const currentA = details.current || {};
      const refA = details.reference || {};

      const genreName = details.genreProfile?.name || 'Genre';
      const genreCurrent = wantsGenre ? details.currentGenreScore?.score : null;
      const genreReference = hasReferenceForGenre ? details.referenceGenreScore?.score : null;

      const summaryBits = [];
      summaryBits.push(`<div class="score-kpi"><strong>Overall</strong>: ${Math.round(rounded)} (${result.label})</div>`);

      const scoreSummary = computeScoreSummary(details);
      if (scoreSummary) {
        const level = Number.isFinite(scoreSummary.levelScore) ? Math.round(scoreSummary.levelScore) : '--';
        const dyn = Number.isFinite(scoreSummary.dynamicsScore) ? Math.round(scoreSummary.dynamicsScore) : '--';
        const tone = Number.isFinite(scoreSummary.toneScore) ? Math.round(scoreSummary.toneScore) : '--';
        summaryBits.push(`<div class="score-kpi"><strong>Level</strong>: ${level}</div>`);
        summaryBits.push(`<div class="score-kpi"><strong>Dynamics</strong>: ${dyn}</div>`);
        summaryBits.push(`<div class="score-kpi"><strong>Tone</strong>: ${tone}</div>`);
      }

      if (wantsReferenceMatch) {
        summaryBits.push(`<div class="score-kpi"><strong>Ref match</strong>: ${Math.round(details.referenceScore.score)} (how close you are to the reference)</div>`);
      }
      if (wantsGenre) {
        const gCur = Number.isFinite(genreCurrent) ? Math.round(genreCurrent) : null;
        const gRef = Number.isFinite(genreReference) ? Math.round(genreReference) : null;
        if (gCur != null && gRef != null) {
          const delta = gCur - gRef;
          const deltaText = `${delta > 0 ? '+' : (delta < 0 ? '−' : '±')}${Math.abs(delta)}`;
          summaryBits.push(`<div class="score-kpi"><strong>${genreName}</strong>: Current ${gCur} vs Ref ${gRef} (Δ ${deltaText})</div>`);
        } else if (gCur != null) {
          summaryBits.push(`<div class="score-kpi"><strong>${genreName}</strong>: Current ${gCur}</div>`);
        }
      }

      const rows = [];
      for (const m of metricMeta) {
        const weight = SCORE_WEIGHTS[m.key] || 0;
        const currentVal = currentA[m.key];
        const refVal = refA[m.key];

        const parts = [];
        parts.push(`<strong>Current</strong>: ${m.fmt(currentVal)}`);

        let tip = null;

        if (wantsReferenceMatch && Number.isFinite(refVal) && Number.isFinite(currentVal)) {
          const deltaRef = currentVal - refVal;
          const deltaTextRef = m.key === 'flatness'
            ? `${deltaRef > 0 ? '+' : (deltaRef < 0 ? '−' : '±')}${Math.abs(deltaRef).toFixed(2)}`
            : formatMaybeSignedDelta(deltaRef, m.unitDelta);
          parts.push(`<strong>Ref</strong>: ${m.fmt(refVal)} (Δ ${deltaTextRef})`);
          tip = advisoryForMetric(m.key, deltaRef, 'ref');
        }

        if (wantsGenre) {
          const target = details.genreProfile.targets[m.key];
          const tol = details.genreProfile.tolerances[m.key];
          if (Number.isFinite(target) && Number.isFinite(currentVal) && Number.isFinite(tol)) {
            const deltaTarget = currentVal - target;
            const currentMetricScore = metricScore(currentVal, target, tol);
            const refMetricScore = (hasReferenceForGenre && Number.isFinite(refVal)) ? metricScore(refVal, target, tol) : null;

            const deltaTextTarget = m.key === 'flatness'
              ? `${deltaTarget > 0 ? '+' : (deltaTarget < 0 ? '−' : '±')}${Math.abs(deltaTarget).toFixed(2)}`
              : formatMaybeSignedDelta(deltaTarget, m.unitDelta);

            parts.push(`<strong>Target</strong>: ${m.fmt(target)} (Δ ${deltaTextTarget})`);

            const scoreText = Number.isFinite(currentMetricScore)
              ? `${Math.round(currentMetricScore)}`
              : '--';
            const refScoreText = Number.isFinite(refMetricScore)
              ? `${Math.round(refMetricScore)}`
              : '--';

            const weightPct = Math.round(weight * 100);
            parts.push(`<strong>Metric score</strong>: ${scoreText}${hasReferenceForGenre ? ` (Ref ${refScoreText})` : ''} · <strong>Weight</strong>: ${weightPct}%`);

            const targetTip = advisoryForMetric(m.key, deltaTarget, 'genre');
            // Prefer the more actionable message (genre guidance), but keep the ref hint if no genre guidance.
            if (targetTip) tip = targetTip;
          }
        }

        if (tip) parts.push(`<span>${tip}</span>`);

        rows.push(`
          <div class="score-detail-row">
            <div class="score-detail-metric">${m.label}</div>
            <div class="score-detail-text">${parts.join(' · ')}</div>
          </div>
        `);
      }

      if (!rows.length && !summaryBits.length) {
        songScoreDetailsEl.textContent = '--';
      } else {
        const summaryHtml = summaryBits.length
          ? `<div class="score-kpi-row">${summaryBits.join('')}</div>`
          : '';

        const summaryCallout = scoreSummary
          ? (() => {
              const deltaL = scoreSummary.deltas?.loudness;
              const deltaC = scoreSummary.deltas?.crestDb;
              const loudnessDeltaText = Number.isFinite(deltaL) ? formatMaybeSignedDelta(deltaL, ' LUFS') : '--';
              const crestDeltaText = Number.isFinite(deltaC)
                ? `${deltaC > 0 ? '+' : (deltaC < 0 ? '−' : '±')}${Math.abs(deltaC).toFixed(1)} dB`
                : '--';
              const issuesText = Array.isArray(scoreSummary.issues) && scoreSummary.issues.length
                ? scoreSummary.issues.join(' · ')
                : 'No major issues detected';
              const stepHtml = (Array.isArray(scoreSummary.steps) ? scoreSummary.steps : []).map(s => `<li>${s}</li>`).join('');
              return `
                <div class="score-callout" role="note" aria-label="Score summary">
                  <div class="score-callout-title">Score summary (why rows can disagree)</div>
                  <div class="score-callout-sub">Basis: ${scoreSummary.basisName} · Loudness Δ ${loudnessDeltaText} · Dynamics Δ ${crestDeltaText}</div>
                  <div class="score-callout-issues">${issuesText}</div>
                  <ul class="score-callout-list">${stepHtml}</ul>
                </div>
              `;
            })()
          : '';

        songScoreDetailsEl.innerHTML = `${summaryHtml}${rows.join('')}`;
        if (summaryCallout) {
          songScoreDetailsEl.innerHTML = `${summaryHtml}${summaryCallout}${rows.join('')}`;
        }
      }
    }
  }
}

function resetSongScoreUi() {
  if (!songScoreValueEl || !songScoreLabelEl || !songScoreBreakdownEl) return;
  songScoreValueEl.textContent = '--';
  songScoreLabelEl.textContent = 'Load a track to score';
  songScoreBreakdownEl.textContent = '--';
  if (songScoreDetailsEl) songScoreDetailsEl.textContent = '--';
}

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

function isCurrentlyPlaying() {
  if (!audio) return false;
  return !audio.paused && !audio.ended;
}

function updateReanalyzeButtonState() {
  if (!reanalyzeBtn) return;
  reanalyzeBtn.disabled = !(currentIndex >= 0 && isCurrentlyPlaying());
}

if (reanalyzeBtn) {
  reanalyzeBtn.addEventListener('click', async () => {
    updateReanalyzeButtonState();
    if (reanalyzeBtn.disabled) return;

    const track = tracks[currentIndex];
    if (!track) return;

    initAudio();
    if (audioCtx && audioCtx.state === 'suspended') {
      try { await audioCtx.resume(); } catch (err) { /* ignore */ }
    }

    track.analysis = null;
    persistTrack(track);
    const runId = ++analysisRunId;
    analyzeTrack(track, runId);
  });
}

if (audio) {
  audio.addEventListener('play', updateReanalyzeButtonState);
  audio.addEventListener('pause', updateReanalyzeButtonState);
  audio.addEventListener('ended', updateReanalyzeButtonState);
}

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

// Restore last selected genre
if (genreSelect) {
  const saved = safeGetLocalStorage('meterlab.genre');
  if (saved && (saved === 'none' || GENRE_PROFILES[saved])) {
    genreSelect.value = saved;
  }
  genreSelect.addEventListener('change', () => {
    safeSetLocalStorage('meterlab.genre', genreSelect.value);
    updateSongScoreUi();
  });
}

if (refreshScoreBtn) {
  refreshScoreBtn.addEventListener('click', () => {
    updateSongScoreUi();
  });
}

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
  updateReanalyzeButtonState();
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
    updateSongScoreUi();
    return;
  }

  referenceIndex = index;
  updateReferenceUi();
  renderPlaylist();

  const track = tracks[index];
  if (!track) {
    updateDeltas();
    applyLoudnessMatchGain();
    return;
  }

  // Ensure analysis exists for the reference, without interrupting the current UI analysis.
  if (!track.analysis) {
    const bgRunId = ++backgroundAnalysisRunId;
    try {
      const analysis = await computeTrackAnalysis(track, bgRunId, () => bgRunId !== backgroundAnalysisRunId);
      if (bgRunId !== backgroundAnalysisRunId) return;
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
  updateSongScoreUi();
};

// Play track
window.playTrack = function(index) {
  initAudio();
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }

  currentIndex = index;
  const track = tracks[index];
  if (!track) return;

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
  updateReanalyzeButtonState();

  applyLoudnessMatchGain();
  updateDeltas();
  updateSongScoreUi();

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
    updateSongScoreUi();
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
  let chromaWeightSum = 0;

  const hpcpSum = new Array(12).fill(0);
  let hpcpWeightSum = 0;
  const bassChromaSum = new Array(12).fill(0);
  let bassWeightSum = 0;
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
    const chromaRaw = extractFeature('chroma', frame);
    const chroma = Array.isArray(chromaRaw) && chromaRaw.length === 12
      ? rotateLeft12(chromaRaw, CHROMA_CALIBRATION_SHIFT)
      : chromaRaw;
    const rms = extractFeature('rms', frame);
    const centroid = extractFeature('spectralCentroid', frame);
    const rolloff = extractFeature('spectralRolloff', frame);
    const flatness = extractFeature('spectralFlatness', frame);
    const zcr = extractFeature('zeroCrossingRate', frame);
    const loudness = extractFeature('loudness', frame);

    // Spectrum-based chroma (HPCP-ish). We compute this less frequently to reduce cost.
    let amplitudeSpectrum = null;
    if (frameCount % 4 === 0) {
      amplitudeSpectrum = extractFeature('amplitudeSpectrum', frame);
    }

    if (chroma && rms && rms > 0.003) {
      // Chroma from noisy / percussive frames can confuse tonic & mode.
      // Downweight frames with high spectral flatness (noise-like).
      const flat = (typeof flatness === 'number' && Number.isFinite(flatness)) ? clamp01(flatness) : 0.18;
      const harmonicWeight = 1 - flat;
      const weight = Math.max(0, rms) * Math.max(0, harmonicWeight);
      if (weight > 0.00005) {
        for (let c = 0; c < 12; c++) chromaSum[c] += chroma[c] * weight;
        chromaWeightSum += weight;
      }
    }

    if (amplitudeSpectrum && rms && rms > 0.003) {
      const flat = (typeof flatness === 'number' && Number.isFinite(flatness)) ? clamp01(flatness) : 0.18;
      const harmonicWeight = 1 - flat;
      const weight = Math.max(0, rms) * Math.max(0, harmonicWeight);

      if (weight > 0.00005) {
        const broad = hpcpFromAmplitudeSpectrum(amplitudeSpectrum, sampleRate, frameSize, 55, 5000);
        const bass = hpcpFromAmplitudeSpectrum(amplitudeSpectrum, sampleRate, frameSize, 40, 260);

        for (let c = 0; c < 12; c++) {
          hpcpSum[c] += broad[c] * weight;
          bassChromaSum[c] += bass[c] * weight;
        }
        hpcpWeightSum += weight;
        bassWeightSum += weight;
      }
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
  if (chromaWeightSum > 0 || hpcpWeightSum > 0) {
    const avgMeyda = chromaWeightSum > 0 ? chromaSum.map(v => v / chromaWeightSum) : new Array(12).fill(0);
    const avgHpcp = hpcpWeightSum > 0 ? hpcpSum.map(v => v / hpcpWeightSum) : new Array(12).fill(0);
    const avgBass = bassWeightSum > 0 ? bassChromaSum.map(v => v / bassWeightSum) : null;

    const meydaN = normalizeChromaSum(avgMeyda);
    const hpcpN = normalizeChromaSum(avgHpcp);

    // Only blend in HPCP if we actually computed it for enough frames.
    // Otherwise it can add noise and degrade results.
    const hasStrongHpcp = hpcpWeightSum > 0.15 * (chromaWeightSum || hpcpWeightSum);
    const blended = hasStrongHpcp ? blendChroma(meydaN, hpcpN, 0.25) : meydaN;

    key = detectKey(blended, avgBass ? normalizeChromaSum(avgBass) : null);
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
    keyCandidates: Array.isArray(key?.candidates) ? key.candidates : null,
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
function detectKey(chroma, bassChroma) {
  const standardize = (arr) => {
    const mean = arr.reduce((s, v) => s + v, 0) / Math.max(1, arr.length);
    const centered = arr.map(v => v - mean);
    const mag = Math.sqrt(centered.reduce((s, v) => s + v * v, 0));
    return mag > 0 ? centered.map(v => v / mag) : centered;
  };

  const normalizeSum = (arr) => {
    const safe = arr.map(v => (Number.isFinite(v) && v > 0 ? v : 0));
    const sum = safe.reduce((s, v) => s + v, 0);
    return sum > 0 ? safe.map(v => v / sum) : safe;
  };

  const rotate = (arr, n) => {
    const offset = ((n % 12) + 12) % 12;
    // Rotate so that template[0] (tonic) aligns with chroma[offset].
    // i.e., for key=E (offset=4), rotated[4] = template[0].
    const cut = (12 - offset) % 12;
    return arr.slice(cut).concat(arr.slice(0, cut));
  };

  const rotateLeft = (arr, n) => {
    const offset = ((n % 12) + 12) % 12;
    return arr.slice(offset).concat(arr.slice(0, offset));
  };

  const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);

  const MAJOR_SCALE_INTERVALS = [0, 2, 4, 5, 7, 9, 11];
  const MINOR_SCALE_INTERVALS = [0, 2, 3, 5, 7, 8, 10];
  const MAJOR_DEGREE_WEIGHTS = MAJOR_SCALE_INTERVALS.map(i => MAJOR[i]);
  const MINOR_DEGREE_WEIGHTS = MINOR_SCALE_INTERVALS.map(i => MINOR[i]);

  const buildModeProfile = (intervals, degreeWeights) => {
    // Weighted diatonic template: tonic/dominant are naturally emphasized by degreeWeights.
    // Keep non-scale tones low but non-zero to penalize chroma energy outside the mode.
    const safeWeights = Array.isArray(degreeWeights) && degreeWeights.length === intervals.length
      ? degreeWeights
      : new Array(intervals.length).fill(1);
    const minInScale = Math.min(...safeWeights);
    const outScale = Number.isFinite(minInScale) ? Math.max(0, minInScale * 0.18) : 0.18;
    const profile = new Array(12).fill(outScale);
    for (let idx = 0; idx < intervals.length; idx++) {
      const step = ((intervals[idx] % 12) + 12) % 12;
      profile[step] = safeWeights[idx];
    }
    return profile;
  };

  const SCALE_TEMPLATES = [
    // Existing Krumhansl-style profiles for major/minor.
    { name: 'major', profile: MAJOR, intervals: MAJOR_SCALE_INTERVALS },
    { name: 'minor', profile: MINOR, intervals: MINOR_SCALE_INTERVALS },
    // Common diatonic modes (intervals from tonic).
    { name: 'dorian', intervals: [0, 2, 3, 5, 7, 9, 10], profile: buildModeProfile([0, 2, 3, 5, 7, 9, 10], MINOR_DEGREE_WEIGHTS) },
    { name: 'phrygian', intervals: [0, 1, 3, 5, 7, 8, 10], profile: buildModeProfile([0, 1, 3, 5, 7, 8, 10], MINOR_DEGREE_WEIGHTS) },
    { name: 'lydian', intervals: [0, 2, 4, 6, 7, 9, 11], profile: buildModeProfile([0, 2, 4, 6, 7, 9, 11], MAJOR_DEGREE_WEIGHTS) },
    { name: 'mixolydian', intervals: [0, 2, 4, 5, 7, 9, 10], profile: buildModeProfile([0, 2, 4, 5, 7, 9, 10], MAJOR_DEGREE_WEIGHTS) },
    { name: 'locrian', intervals: [0, 1, 3, 5, 6, 8, 10], profile: buildModeProfile([0, 1, 3, 5, 6, 8, 10], MINOR_DEGREE_WEIGHTS) }
  ];

  const evaluate = (inputChroma, inputBassChroma) => {
    const normChroma = standardize(inputChroma);
    const sumChroma = normalizeSum(inputChroma);
    const sumBass = Array.isArray(inputBassChroma) && inputBassChroma.length === 12
      ? normalizeSum(inputBassChroma)
      : null;
    const candidates = [];

    const membershipScoreFor = (tonicIndex, intervals) => {
      if (!Array.isArray(intervals) || intervals.length === 0) return { membership: 0, inEnergy: 0, tonicEnergy: 0 };
      const tonicEnergy = sumChroma[tonicIndex] || 0;
      let inEnergy = 0;
      for (const step of intervals) {
        const idx = (tonicIndex + step + 1200) % 12;
        inEnergy += sumChroma[idx] || 0;
      }
      const outEnergy = 1 - inEnergy;
      // Bias toward a strong tonic to distinguish modes that share pitch sets
      // (e.g., E Phrygian vs C Major).
      const tonicBoost = 0.35;
      const outPenalty = 0.55;
      const membership = inEnergy - outPenalty * outEnergy + tonicBoost * tonicEnergy;
      return { membership, inEnergy, tonicEnergy };
    };

    for (let i = 0; i < 12; i++) {
      for (const template of SCALE_TEMPLATES) {
        const normTemplate = standardize(template.profile);
        const corrScore = dot(normChroma, rotate(normTemplate, i));
        const ms = membershipScoreFor(i, template.intervals);
        // Small tonic emphasis helps separate relative-mode ambiguities.
        const bassTonic = sumBass ? (sumBass[i] || 0) : 0;
        const tonicNudge = 0.10 * (ms.tonicEnergy || 0) + 0.18 * bassTonic;
        const score = corrScore + 0.75 * (ms.membership || 0) + tonicNudge;
        candidates.push({
          score,
          corrScore,
          membership: ms.membership,
          inEnergy: ms.inEnergy,
          tonicEnergy: ms.tonicEnergy,
          bassTonic,
          name: KEY_NAMES[i],
          scale: template.name,
          tonicIndex: i
        });
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    const bestByScore = candidates[0] || { score: -Infinity, name: null, scale: null };
    let best = bestByScore;

    // If ambiguous by score, prefer the candidate with a clearer tonic/bass among near-ties.
    if (Number.isFinite(bestByScore.score)) {
      const window = 0.06;
      const near = candidates.filter(c => Number.isFinite(c.score) && c.score >= bestByScore.score - window);
      if (near.length > 1) {
        near.sort((a, b) => ((b.bassTonic || 0) + (b.tonicEnergy || 0)) - ((a.bassTonic || 0) + (a.tonicEnergy || 0)));
        const tonicWinner = near[0];
        const tonicWinnerStrength = (tonicWinner?.bassTonic || 0) + (tonicWinner?.tonicEnergy || 0);
        const bestStrength = (bestByScore?.bassTonic || 0) + (bestByScore?.tonicEnergy || 0);
        if (tonicWinner && tonicWinnerStrength > bestStrength + 0.04) {
          best = tonicWinner;
        }
      }
    }

    // Ensure the returned candidates include the chosen best first.
    if (best && candidates.length) {
      const idx = candidates.findIndex(c => c === best || (c.name === best.name && c.scale === best.scale && c.tonicIndex === best.tonicIndex));
      if (idx > 0) {
        const picked = candidates.splice(idx, 1)[0];
        candidates.unshift(picked);
      }
    }

    // Confidence: compute probability of chosen best vs strongest alternative.
    const temp = 0.18;
    const maxScore = Number.isFinite(candidates[0]?.score) ? candidates[0].score : (Number.isFinite(best?.score) ? best.score : 0);
    const exps = candidates.slice(0, 10).map(c => {
      const s = Number.isFinite(c.score) ? c.score : -Infinity;
      const x = (s - maxScore) / temp;
      return Number.isFinite(x) ? Math.exp(Math.max(-60, x)) : 0;
    });
    const expSum = exps.reduce((s, v) => s + v, 0) || 1;
    const probs = exps.map(v => v / expSum);
    const pBest = probs[0] || 0;
    const pSecond = probs.slice(1).reduce((m, v) => Math.max(m, v), 0);
    const marginConf = clamp((pBest - pSecond) / 0.65, 0, 1);

    let bassConf = 0;
    if (sumBass) {
      const sortedBass = sumBass
        .map((v, idx) => ({ v: Number.isFinite(v) ? v : 0, idx }))
        .sort((a, b) => b.v - a.v);
      const b1 = sortedBass[0]?.v ?? 0;
      const b2 = sortedBass[1]?.v ?? 0;
      bassConf = clamp((b1 - b2) / 0.18, 0, 1);
    }

    const confidence = clamp(0.75 * marginConf + 0.25 * bassConf, 0, 1);
    return {
      best,
      confidence,
      candidates: candidates.slice(0, 5)
    };
  };

  const result = evaluate(chroma, bassChroma);
  return {
    name: result?.best?.name || null,
    scale: result?.best?.scale || null,
    confidence: result?.confidence ?? 0,
    candidates: Array.isArray(result?.candidates) ? result.candidates : null,
    chromaShift: CHROMA_CALIBRATION_SHIFT
  };
}

// Display analysis
function displayAnalysis(analysis) {
  keyEl.textContent = analysis.key;
  scaleEl.textContent = analysis.scale.charAt(0).toUpperCase() + analysis.scale.slice(1);
  const conf01 = Number.isFinite(analysis.confidence) ? analysis.confidence : 0;
  const confPct = Math.round(conf01 * 100);
  const confMeta = confidenceLabel(conf01);
  confidenceEl.textContent = confMeta.label;

  try {
    const certaintyTile = confidenceMetricTileEl || confidenceEl?.closest?.('.metric');
    if (certaintyTile) {
      const baseTip = CONFIDENCE_TOOLTIP_DEFAULT
        || certaintyTile.getAttribute('data-tooltip')
        || 'Key certainty: how separated the top guess is from the runner-up (low = ambiguous).';
      const extra = `Current: ${confPct}% (${confMeta.label}). Use this to decide whether to trust the label or check the top guesses.`;
      certaintyTile.setAttribute('data-tooltip', `${baseTip} ${extra}`);
    }
  } catch {
    /* ignore */
  }

  // Add extra context as a tooltip when the key/mode is ambiguous.
  try {
    const keyMetricEl = keyMetricTileEl || keyEl?.closest?.('.metric');
    if (keyMetricEl) {
      const baseTip = KEY_TOOLTIP_DEFAULT || keyMetricEl.getAttribute('data-tooltip') || 'Key estimate based on chroma correlation.';
      const shiftText = `chromaShift=${CHROMA_CALIBRATION_SHIFT}`;

      const top = (Array.isArray(analysis.keyCandidates) ? analysis.keyCandidates : [])
        .slice(0, 3)
        .map(c => {
          const scale = String(c.scale || '');
          const scaleCap = scale ? (scale.charAt(0).toUpperCase() + scale.slice(1)) : '';
          const scoreText = Number.isFinite(c.score) ? c.score.toFixed(2) : '--';
          const tonicText = Number.isFinite(c.tonicEnergy) ? c.tonicEnergy.toFixed(2) : '--';
          return `${c.name} ${scaleCap} (s=${scoreText}, tonic=${tonicText})`;
        });

      const extra = top.length ? `Top guesses (${shiftText}): ${top.join(' · ')}` : shiftText;
      if (top.length && confPct < 65) keyMetricEl.setAttribute('data-tooltip', `${baseTip} ${extra}`);
      else keyMetricEl.setAttribute('data-tooltip', baseTip);
    }
  } catch {
    /* ignore */
  }
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
  updateSongScoreUi();
}

// Reset analysis
function resetAnalysis() {
  keyEl.textContent = '--';
  scaleEl.textContent = '--';
  confidenceEl.textContent = '--';

  try {
    if (keyMetricTileEl && KEY_TOOLTIP_DEFAULT) keyMetricTileEl.setAttribute('data-tooltip', KEY_TOOLTIP_DEFAULT);
    if (scaleMetricTileEl && SCALE_TOOLTIP_DEFAULT) scaleMetricTileEl.setAttribute('data-tooltip', SCALE_TOOLTIP_DEFAULT);
    if (confidenceMetricTileEl && CONFIDENCE_TOOLTIP_DEFAULT) confidenceMetricTileEl.setAttribute('data-tooltip', CONFIDENCE_TOOLTIP_DEFAULT);
  } catch {
    /* ignore */
  }
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
  resetSongScoreUi();
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

  // Reset before measuring to avoid any chance of a feedback loop (e.g. refresh actions
  // that trigger displayAnalysis -> syncMeterHeight repeatedly).
  meterStack.style.height = 'auto';
  meterStack.style.maxHeight = 'none';

  // Important: only sync the meter stack to the canvas height.
  // Forcing the left column height can create a flexbox feedback loop where
  // the measured height increases slightly on each call (e.g., when analysis refresh
  // triggers reflows), making meters “grow” over time.
  if (leftColumn) {
    leftColumn.style.height = 'auto';
    leftColumn.style.maxHeight = 'none';
  }

  // Prefer content height to avoid flexbox stretch affecting the measurement.
  const contentHeight = Math.round(canvasStack.scrollHeight || 0);
  const rect = canvasStack.getBoundingClientRect();
  const targetHeight = contentHeight > 0 ? contentHeight : Math.round(rect.height || 0);

  if (targetHeight > 0) {
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

    setHeight(meterStack, targetHeight);
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
    CHROMA_CALIBRATION_SHIFT = calibrateChromaShift();
    if (CHROMA_CALIBRATION_SHIFT) {
      console.log('[MeterLab] Chroma calibrated shift:', CHROMA_CALIBRATION_SHIFT);
    }
    return;
  }

  const fallbackScript = document.createElement('script');
  fallbackScript.src = 'https://cdn.jsdelivr.net/npm/meyda@5.6.3/dist/web/meyda.min.js';
  fallbackScript.crossOrigin = 'anonymous';
  fallbackScript.onload = () => {
    if (typeof Meyda !== 'undefined') {
      console.log('Meyda loaded via fallback CDN');
      CHROMA_CALIBRATION_SHIFT = calibrateChromaShift();
      if (CHROMA_CALIBRATION_SHIFT) {
        console.log('[MeterLab] Chroma calibrated shift:', CHROMA_CALIBRATION_SHIFT);
      }
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
