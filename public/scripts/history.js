const DB_NAME = 'meterlab';
const DB_VERSION = 2;
const SCORE_STORE = 'scores';

const historyTableBody = document.getElementById('historyTableBody');
const historyEmpty = document.getElementById('historyEmpty');
const historySearch = document.getElementById('historySearch');
const clearHistoryBtn = document.getElementById('clearHistoryBtn');

let dbPromise = null;
let cachedScores = [];

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB not available in this browser.'));
      return;
    }

    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      // Nothing to do here: mixer page handles store creation.
      // But keep this in case the user hits History first.
      const db = req.result;
      if (!db.objectStoreNames.contains(SCORE_STORE)) {
        const store = db.createObjectStore(SCORE_STORE, { keyPath: 'id' });
        store.createIndex('savedAt', 'savedAt', { unique: false });
        store.createIndex('trackId', 'trackId', { unique: false });
        store.createIndex('comboKey', 'comboKey', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Failed to open IndexedDB'));
  });
  return dbPromise;
}

async function getAllScores() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SCORE_STORE, 'readonly');
    const req = tx.objectStore(SCORE_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error || new Error('Failed to read scores'));
  });
}

async function deleteScore(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SCORE_STORE, 'readwrite');
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error || new Error('Failed to delete score'));
    tx.objectStore(SCORE_STORE).delete(id);
  });
}

async function clearScores() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SCORE_STORE, 'readwrite');
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error || new Error('Failed to clear scores'));
    tx.objectStore(SCORE_STORE).clear();
  });
}

function fmtDate(ts) {
  if (!Number.isFinite(ts)) return '--';
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function escapeHtml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function scoreBadge(score, label) {
  const s = Number.isFinite(score) ? Math.round(score) : null;
  if (s == null) return '<span class="badge text-bg-secondary">--</span>';

  let cls = 'text-bg-danger';
  if (s >= 90) cls = 'text-bg-success';
  else if (s >= 80) cls = 'text-bg-primary';
  else if (s >= 70) cls = 'text-bg-info';
  else if (s >= 60) cls = 'text-bg-warning';

  return `<span class="badge ${cls}">${s}</span> <span style="color: rgba(255,255,255,0.75);">${escapeHtml(label || '')}</span>`;
}

function matchesQuery(row, q) {
  if (!q) return true;
  const hay = [
    row.trackName,
    row.referenceName,
    row.genreName,
    row.genreKey,
    row.trackKey,
    row.trackScale,
    row.breakdown
  ]
    .filter(Boolean)
    .join(' | ')
    .toLowerCase();
  return hay.includes(q.toLowerCase());
}

function render(scores) {
  if (!historyTableBody || !historyEmpty) return;

  const q = (historySearch?.value || '').trim();
  const filtered = (Array.isArray(scores) ? scores : []).filter(r => matchesQuery(r, q));

  historyEmpty.style.display = filtered.length ? 'none' : 'block';
  historyTableBody.innerHTML = '';

  for (const r of filtered) {
    const trackLine = `${escapeHtml(r.trackName || 'Unknown')}<div style="color: rgba(255,255,255,0.65); font-size: 0.85rem; margin-top: 4px;">${escapeHtml(r.trackKey || '--')} ${escapeHtml(r.trackScale || '')}</div>`;

    const contextBits = [];
    if (r.referenceName) contextBits.push(`<div><strong>Ref:</strong> ${escapeHtml(r.referenceName)}</div>`);
    if (r.genreName || (r.genreKey && r.genreKey !== 'none')) contextBits.push(`<div><strong>Genre:</strong> ${escapeHtml(r.genreName || r.genreKey)}</div>`);
    if (!contextBits.length) contextBits.push('<div style="color: rgba(255,255,255,0.65);">(No ref / no genre)</div>');

    const scoreLine = `${scoreBadge(r.score, r.label)}<div style="color: rgba(255,255,255,0.65); font-size: 0.85rem; margin-top: 4px;">${escapeHtml(r.breakdown || '')}</div>`;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${trackLine}</td>
      <td>${contextBits.join('')}</td>
      <td>${scoreLine}</td>
      <td>${escapeHtml(fmtDate(r.savedAt))}</td>
      <td class="text-end">
        <button class="btn btn-sm btn-outline-light" data-action="delete" data-id="${escapeHtml(r.id)}">Delete</button>
      </td>
    `;
    historyTableBody.appendChild(tr);
  }
}

async function refresh() {
  try {
    cachedScores = await getAllScores();
  } catch (err) {
    console.warn('Failed to load score history:', err);
    cachedScores = [];
  }

  cachedScores.sort((a, b) => (b?.savedAt || 0) - (a?.savedAt || 0));
  render(cachedScores);
}

if (historySearch) {
  historySearch.addEventListener('input', () => render(cachedScores));
}

if (clearHistoryBtn) {
  clearHistoryBtn.addEventListener('click', async () => {
    const ok = confirm('Clear all saved score snapshots?');
    if (!ok) return;
    try {
      await clearScores();
    } catch (err) {
      alert(`Failed to clear history: ${err.message || err}`);
    }
    refresh();
  });
}

if (historyTableBody) {
  historyTableBody.addEventListener('click', async (e) => {
    const btn = e.target?.closest?.('button[data-action="delete"]');
    if (!btn) return;
    const id = btn.getAttribute('data-id');
    if (!id) return;
    const ok = confirm('Delete this snapshot?');
    if (!ok) return;

    try {
      await deleteScore(id);
    } catch (err) {
      alert(`Failed to delete: ${err.message || err}`);
    }
    refresh();
  });
}

refresh();
