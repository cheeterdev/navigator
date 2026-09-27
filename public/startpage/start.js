// load settings into localStorage so our helpers pick them up
function syncSettings() {
    if (window.electronAPI && window.electronAPI.getSettings) {
        window.electronAPI.getSettings().then(s => {
            if (s && s.searchEngine) localStorage.setItem('searchEngine', s.searchEngine);
            if (s && s.customSearchEngine) localStorage.setItem('customSearchEngine', s.customSearchEngine);
            if (s && Array.isArray(s.searchEngines)) {
                localStorage.setItem('searchEngines', JSON.stringify(s.searchEngines));
            }
            if (s && s.theme) {
                document.body.className = s.theme;
                localStorage.setItem('theme', s.theme);
            }
            if (s && s.themeColor) {
                localStorage.setItem('themeColor', s.themeColor);
                applyCustomTheme(s.themeColor);
            }
            if (s && s.username) {
                localStorage.setItem('username', s.username);
                updateWelcomeMessage();
            }
            if (s && Array.isArray(s.rssSources)) {
                localStorage.setItem('rssSources', JSON.stringify(s.rssSources));
            }
        }).catch(() => { });
    }
}

function applyCustomTheme(color) {
    if (!color) return;
    document.documentElement.style.setProperty('--theme-color', color);

    // Dynamic calculation for custom theme similar to renderer.js
    const hexToRgb = hex => {
        hex = hex.replace('#', '');
        const bigint = parseInt(hex, 16);
        return { r: (bigint >> 16) & 255, g: (bigint >> 8) & 255, b: bigint & 255 };
    };
    const rgbToHex = (r, g, b) => '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
    const rgbToHsl = (r, g, b) => {
        r /= 255; g /= 255; b /= 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        let h, s, l = (max + min) / 2;
        if (max === min) { h = s = 0; }
        else {
            const d = max - min;
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            switch (max) {
                case r: h = (g - b) / d + (g < b ? 6 : 0); break;
                case g: h = (b - r) / d + 2; break;
                case b: h = (r - g) / d + 4; break;
            }
            h /= 6;
        }
        return { h, s, l };
    };
    const hslToRgb = (h, s, l) => {
        let r, g, b;
        if (s === 0) { r = g = b = l; }
        else {
            const hue2rgb = (p, q, t) => {
                if (t < 0) t += 1; if (t > 1) t -= 1;
                if (t < 1 / 6) return p + (q - p) * 6 * t;
                if (t < 1 / 2) return q;
                if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
                return p;
            };
            const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
            const p = 2 * l - q;
            r = hue2rgb(p, q, h + 1 / 3); g = hue2rgb(p, q, h); b = hue2rgb(p, q, h - 1 / 3);
        }
        return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
    };
    const adjustLightness = (hex, delta) => {
        const rgb = hexToRgb(hex);
        const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
        hsl.l = Math.max(0, Math.min(1, hsl.l + delta / 100));
        const rgb2 = hslToRgb(hsl.h, hsl.s, hsl.l);
        return rgbToHex(rgb2.r, rgb2.g, rgb2.b);
    };
    const luminance = hex => {
        const { r, g, b } = hexToRgb(hex);
        const a = [r, g, b].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
        return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722;
    };

    const bgMain = color;
    const bgToolbar = adjustLightness(color, 8);
    const bgElementHover = adjustLightness(color, 15);
    const bgInput = adjustLightness(color, -5);
    const borderColor = adjustLightness(color, -15);
    const textColor = luminance(color) > 0.5 ? '#1a1a1a' : '#ffffff';

    document.documentElement.style.setProperty('--bg-main', bgMain);
    document.documentElement.style.setProperty('--bg-toolbar', bgToolbar);
    document.documentElement.style.setProperty('--bg-element-hover', bgElementHover);
    document.documentElement.style.setProperty('--bg-input', bgInput);
    document.documentElement.style.setProperty('--border-color', borderColor);
    document.documentElement.style.setProperty('--text-color', textColor);
}

// Function to update welcome message with username
function updateWelcomeMessage() {
    const h1 = document.getElementById('welcome-message');
    if (!h1) return;
    const username = localStorage.getItem('username') || 'User';
    h1.textContent = `Whats on your Mind, ${username}?`;
}

function getSearchUrl(query) {
    const enc = encodeURIComponent(query);
    const searchEngine = localStorage.getItem('searchEngine') || 'Cheeter Space';
    const searchEnginesRaw = localStorage.getItem('searchEngines') || '[]';
    let searchEngines;
    try { searchEngines = JSON.parse(searchEnginesRaw); } catch (e) { searchEngines = []; }
    const customSearchEngine = localStorage.getItem('customSearchEngine') || '';

    if (searchEngine === 'Custom' && customSearchEngine) {
        if (customSearchEngine.includes('{search}')) return customSearchEngine.replace('{search}', enc);
        return customSearchEngine + (customSearchEngine.includes('?') ? '&q=' + enc : '?q=' + enc);
    }
    const customEntry = searchEngines.find(e => e.name === searchEngine);
    if (customEntry && customEntry.template) {
        if (customEntry.template.includes('{search}')) return customEntry.template.replace('{search}', enc);
        return customEntry.template + (customEntry.template.includes('?') ? '&q=' + enc : '?q=' + enc);
    }

    const templates = {
        'Cheeter Spaceᴰᴱ': `https://space.cheeter.de/s.php#gsc.tab=0&gsc.q=${enc}`,
        'CGWebᴾ🇭': `https://web.canaveral.group/search?q=${enc}`,
        'Startpageᴺᴸ': `https://www.startpage.com/sp/search?q=${enc}`,
        'DuckDuckGoᵘˢ': `https://duckduckgo.com/?q=${enc}`,
        'Ecosiaᴰᴱ': `https://www.ecosia.org/search?q=${enc}`,
        'OceanHeroᴰᴱ': `https://www.oceanhero.today/web?q=${enc}`,
        'Bingᵘˢ': `https://www.bing.com/search?q=${enc}`,
        'Google': `https://www.google.com/search?q=${enc}`
    };
    return templates[searchEngine] || templates['Cheeter Spaceᴰᴱ'];
}

const RSS_STORAGE_KEY = 'rssSources';
const RSS_MAX_ENTRIES = 30;

function stripHtml(raw) {
    if (!raw) return '';
    const parser = new DOMParser();
    const doc = parser.parseFromString(raw, 'text/html');
    return (doc.body && doc.body.textContent ? doc.body.textContent : '').trim();
}

function truncateText(text, maxLength) {
    if (!text) return '';
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength).trim()}...`;
}

function setRssHomeStatus(text, isError = false) {
    const status = document.getElementById('rss-home-status');
    if (!status) return;
    status.textContent = text;
    if (text.includes('Loading')) {
        status.classList.remove('hidden');
        status.style.display = 'block';
    } else {
        status.classList.add('hidden');
        status.style.display = 'none';
    }
}

function renderRssHomeEntries(entries) {
    const container = document.getElementById('rss-home-entries');
    if (!container) return;
    container.innerHTML = '';

    if (!entries || entries.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'rss-home-empty';
        empty.style.gridColumn = '1 / -1';
        empty.style.textAlign = 'center';
        empty.style.padding = '3rem';
        empty.style.color = '#94a3b8';
        empty.innerHTML = `
            <p style="font-size: 1.25rem; font-weight: 500; margin-bottom: 0.5rem;">No news articles found</p>
            <p style="font-size: 0.875rem;">Check your connection or click Refresh to try again.</p>
        `;
        container.appendChild(empty);
        return;
    }

    const sorted = entries
        .slice()
        .sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0))
        .slice(0, RSS_MAX_ENTRIES);

    sorted.forEach(entry => {
        const date = entry.pubDate ? new Date(entry.pubDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
        const cardHTML = `
            <a href="${entry.link}" target="_blank" rel="noopener noreferrer" class="news-card">
                <div class="news-meta">
                    <span class="source">${entry.source || 'RSS'}</span>
                    <span class="date">${date}</span>
                </div>
                <h3 class="news-title">${entry.title || '(Untitled)'}</h3>
                <p class="news-desc">${truncateText(stripHtml(entry.description || ''), 200)}</p>
            </a>`;
        container.insertAdjacentHTML('beforeend', cardHTML);
    });
}

async function getRssSources() {
    if (window.electronAPI && window.electronAPI.getSettings) {
        try {
            const settings = await window.electronAPI.getSettings();
            if (settings && Array.isArray(settings[RSS_STORAGE_KEY])) {
                return settings[RSS_STORAGE_KEY].slice();
            }
        } catch (e) { }
    }

    try {
        const local = JSON.parse(localStorage.getItem(RSS_STORAGE_KEY) || '[]');
        return Array.isArray(local) ? local : [];
    } catch (e) {
        return [];
    }
}

async function fetchRssFeedText(url) {
    if (window.electronAPI && window.electronAPI.fetchRssFeed) {
        const result = await window.electronAPI.fetchRssFeed(url);
        if (!result || !result.success) {
            throw new Error(result && result.error ? result.error : 'Could not load feed');
        }
        return result.text;
    }
    throw new Error('RSS feed fetching is not supported in this environment.');
}

function parseRssFeed(text, sourceUrl) {
    const parser = new DOMParser();
    const xml = parser.parseFromString(text, 'application/xml');
    if (xml.querySelector('parsererror')) {
        throw new Error('Invalid XML feed');
    }

    const channel = xml.querySelector('channel');
    const feed = xml.querySelector('feed');
    const sourceTitle = (channel && channel.querySelector('title')?.textContent)
        || (feed && feed.querySelector('title')?.textContent)
        || sourceUrl;

    const items = Array.from(xml.querySelectorAll('item'));
    const entries = items.length ? items : Array.from(xml.querySelectorAll('entry'));

    return entries.map((item) => {
        const title = item.querySelector('title')?.textContent?.trim() || '';
        const linkNode = item.querySelector('link');
        const link = linkNode?.getAttribute?.('href') || linkNode?.textContent?.trim() || item.querySelector('guid')?.textContent?.trim() || '';
        const pubDate = item.querySelector('pubDate')?.textContent || item.querySelector('updated')?.textContent || item.querySelector('published')?.textContent || '';
        const description = item.querySelector('description')?.textContent || item.querySelector('summary')?.textContent || item.querySelector('content')?.textContent || '';

        return {
            title,
            link,
            pubDate,
            description,
            source: sourceTitle,
        };
    });
}

function loadHomeRssFeeds() {
    setRssHomeStatus('Loading RSS feeds...');

    getRssSources().then(async (sources) => {
        if (!sources.length) {
            renderRssHomeEntries([]);
            setRssHomeStatus('No feed sources configured yet.');
            return;
        }

        let failedSources = 0;
        const feedPromises = sources.map(async (source) => {
            try {
                const text = await fetchRssFeedText(source);
                return parseRssFeed(text, source);
            } catch (e) {
                console.error('Failed to fetch RSS source:', source, e);
                failedSources += 1;
                return [];
            }
        });

        const results = await Promise.all(feedPromises);
        const allEntries = results.flat();

        renderRssHomeEntries(allEntries);

        const parts = [`${allEntries.length} entries`];
        if (failedSources > 0) parts.push(`${failedSources} source(s) failed`);
        setRssHomeStatus(`Updated: ${new Date().toLocaleString()} • ${parts.join(' • ')}`, failedSources > 0 && allEntries.length === 0);
    }).catch(err => {
        console.error('Error loading RSS feeds:', err);
        setRssHomeStatus('Error loading RSS feeds.', true);
    });
}

// initial sync & listen for updates
syncSettings();
if (window.electronAPI && window.electronAPI.onSettingsUpdated) {
    window.electronAPI.onSettingsUpdated(() => {
        syncSettings();
        loadHomeRssFeeds();
    });
}

// Apply username to welcome message on page load
updateWelcomeMessage();

document.addEventListener('DOMContentLoaded', () => {
    // Random background logic
    const bgImages = [
        'Dark Atmosphere.jpg',
        'Dark Shadows.jpg',
        'Glowing Lights.jpg',
        'Grass.jpg',
        'Hills.jpg',
        'Sharper.jpg',
        'The Bridge.jpg',
        'The Skyline.jpg'
    ];

    const randomBg = bgImages[Math.floor(Math.random() * bgImages.length)];
    const imgUrl = `/assets/bg/${encodeURIComponent(randomBg)}`;

    // Preload image for smoother transition
    const img = new Image();
    img.src = imgUrl;
    img.onload = () => {
        document.body.style.backgroundImage = `url('${imgUrl}')`;
        document.body.style.opacity = '1';
    };
    img.onerror = () => {
        console.error('Failed to load background image:', imgUrl);
        document.body.style.opacity = '1';
    };
    // Fallback: show content anyway after 2s if image is slow
    setTimeout(() => {
        document.body.style.opacity = '1';
    }, 2000);

    const form = document.getElementById('search-form');
    form.addEventListener('submit', function (e) {
        e.preventDefault();
        const q = document.getElementById('search-input').value.trim();
        if (!q) return;
        let url = getSearchUrl(q);
        if (!url) {
            const enc = encodeURIComponent(q);
            url = `https://space.cheeter.de/s.php#gsc.tab=0&gsc.q=${enc}`;
        }
        if (window.electronAPI && window.electronAPI.navigateTo) {
            window.electronAPI.navigateTo({ url, isPersistent: false });
        } else {
            window.location.href = url;
        }
        document.getElementById('search-input').value = '';
    });

    const refreshBtn = document.getElementById('rss-home-refresh');
    if (refreshBtn) refreshBtn.addEventListener('click', loadHomeRssFeeds);

    loadHomeRssFeeds();
});
