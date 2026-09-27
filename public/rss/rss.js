const DEFAULT_SOURCES = [];
const STORAGE_KEY = 'rssSources';

const sourceInput = document.getElementById('source-input');
const sourcesContainer = document.getElementById('sources');
const entriesContainer = document.getElementById('entries');
const status = document.getElementById('status');
const addSourceBtn = document.getElementById('add-source');
const refreshButton = document.getElementById('refresh-button');
const sourcePanel = document.getElementById('source-panel');
const mode = new URLSearchParams(window.location.search).get('mode');
const isSettingsMode = mode === 'settings';

let rssSources = [];
let lastUpdated = null;

function renderSources() {
  sourcesContainer.innerHTML = '';
  if (rssSources.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No RSS sources added.';
    sourcesContainer.appendChild(empty);
    return;
  }

  rssSources.forEach((url, index) => {
    const item = document.createElement('div');
    item.className = 'source-item';
    item.innerHTML = `
      <span>${url}</span>
      <button type="button" data-index="${index}">Remove</button>
    `;
    const removeBtn = item.querySelector('button');
    removeBtn.addEventListener('click', () => {
      rssSources.splice(index, 1);
      saveSources();
      renderSources();
      refreshFeeds();
    });
    sourcesContainer.appendChild(item);
  });
}

function renderEntries(entries) {
  entriesContainer.innerHTML = '';
  if (!entries || entries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No feed entries available. Add sources or refresh the feeds.';
    entriesContainer.appendChild(empty);
    return;
  }

  entries.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

  entries.forEach((entry) => {
    const card = document.createElement('article');
    card.className = 'entry-card';
    card.innerHTML = `
      <div style="display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap; align-items:flex-start;">
        <h2>${entry.title || '(kein Titel)'}</h2>
        <span class="entry-meta">${entry.source || ''}</span>
      </div>
      <p>${entry.description || ''}</p>
      <div class="entry-meta">
        <span>${entry.pubDate ? new Date(entry.pubDate).toLocaleString() : ''}</span>
        <a href="#" data-url="${entry.link || ''}">Open Article</a>
      </div>
    `;
    const link = card.querySelector('a');
    link.addEventListener('click', (event) => {
      event.preventDefault();
      const target = event.currentTarget.dataset.url;
      if (!target) return;
      if (window.electronAPI && window.electronAPI.navigateTo) {
        window.electronAPI.navigateTo({ url: target, isPersistent: false });
      }
    });
    entriesContainer.appendChild(card);
  });
}

function setStatus(text, isError = false) {
  status.textContent = text;
  status.style.color = isError ? '#fca5a5' : '#94a3b8';
}

function saveSources() {
  if (window.electronAPI && window.electronAPI.setSetting) {
    window.electronAPI.setSetting(STORAGE_KEY, rssSources);
  } else {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rssSources));
  }
}

function normalizeUrl(value) {
  try {
    const parsed = new URL(value.trim());
    return parsed.href;
  } catch (e) {
    return null;
  }
}

async function fetchFeedText(url) {
  if (window.electronAPI && window.electronAPI.fetchRssFeed) {
    const result = await window.electronAPI.fetchRssFeed(url);
    if (!result || !result.success) {
      throw new Error(result && result.error ? result.error : 'Feed konnte nicht geladen werden');
    }
    return result.text;
  }
  throw new Error('RSS feed fetching is not supported in this environment.');
}

function parseFeed(text, sourceUrl) {
  const parser = new DOMParser();
  const xml = parser.parseFromString(text, 'application/xml');
  const parserError = xml.querySelector('parsererror');
  if (parserError) {
    throw new Error('Ungültiges XML-Format');
  }

  const channel = xml.querySelector('channel');
  const sourceTitle = channel ? (channel.querySelector('title')?.textContent || sourceUrl) : sourceUrl;
  const items = Array.from(xml.querySelectorAll('item')).map((item) => {
    const title = item.querySelector('title')?.textContent || '';
    const link = item.querySelector('link')?.textContent || item.querySelector('guid')?.textContent || '';
    const pubDate = item.querySelector('pubDate')?.textContent || item.querySelector('updated')?.textContent || '';
    let description = item.querySelector('description')?.textContent || item.querySelector('summary')?.textContent || '';
    description = description.trim().replace(/\s+/g, ' ');
    if (description.length > 260) {
      description = `${description.slice(0, 260).trim()}…`;
    }
    return {
      title,
      link,
      pubDate,
      description,
      source: sourceTitle,
    };
  });

  return items;
}

async function refreshFeeds() {
  if (isSettingsMode) {
    if (entriesContainer) entriesContainer.innerHTML = '';
    setStatus('Manage your RSS sources here. Entries are shown on the Home screen.');
    return;
  }

  entriesContainer.innerHTML = '';
  setStatus('Loading RSS Feeds…');

  if (rssSources.length === 0) {
    renderEntries([]);
    setStatus('Add a source to load feeds.');
    return;
  }

  const allEntries = [];
  for (const source of rssSources) {
    try {
      const text = await fetchFeedText(source);
      const items = parseFeed(text, source);
      allEntries.push(...items);
    } catch (err) {
      const message = err && err.message ? err.message : 'Unknown error';
      const entry = document.createElement('div');
      entry.className = 'empty-state';
      entry.textContent = `Error loading ${source}: ${message}`;
      entriesContainer.appendChild(entry);
    }
  }

  renderEntries(allEntries);
  lastUpdated = new Date();
  setStatus(`Last updated: ${lastUpdated.toLocaleString()}`);
}

async function loadSources() {
  if (window.electronAPI && window.electronAPI.getSettings) {
    try {
      const settings = await window.electronAPI.getSettings();
      if (settings && Array.isArray(settings[STORAGE_KEY])) {
        rssSources = settings[STORAGE_KEY].slice();
      } else {
        rssSources = DEFAULT_SOURCES.slice();
      }
    } catch (e) {
      rssSources = DEFAULT_SOURCES.slice();
    }
  } else {
    try {
      rssSources = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    } catch (e) {
      rssSources = DEFAULT_SOURCES.slice();
    }
  }
  renderSources();
  if (isSettingsMode) {
    if (sourcePanel) sourcePanel.setAttribute('open', 'open');
    if (entriesContainer) entriesContainer.style.display = 'none';
    setStatus('Manage your RSS sources here. Entries are shown on the Home screen.');
    return;
  }
  refreshFeeds();
}

addSourceBtn.addEventListener('click', () => {
  const normalized = normalizeUrl(sourceInput.value || '');
  if (!normalized) {
    setStatus('Please enter a valid RSS URL.', true);
    return;
  }
  if (rssSources.includes(normalized)) {
    setStatus('The source is already added.', true);
    return;
  }
  rssSources.push(normalized);
  sourceInput.value = '';
  saveSources();
  renderSources();
  refreshFeeds();
});

refreshButton.addEventListener('click', () => {
  if (isSettingsMode) {
    setStatus('Sources are saved automatically. Entries are shown on the Home screen.');
    return;
  }
  refreshFeeds();
});

window.addEventListener('DOMContentLoaded', () => {
  loadSources();
});
