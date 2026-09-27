const urlInput = document.getElementById("url");
const menuButton = document.getElementById("menu");
const bookmarkButton = document.getElementById("bookmark");
const manipulationButton = document.getElementById("manipulation");
const menuDropdown = document.getElementById("dropdown-menu");
const bookmarkDropdown = document.getElementById("dropdown-bookmark");
const incognitoBtn = document.getElementById("incognito");
const adblockBtn = document.getElementById("adblock");
const newTabBtn = document.getElementById("new-tab");
const tabsContainer = document.getElementById("tabs-container");
const sidebarToggleBtn = document.getElementById("sidebar-toggle");
const sidebar = document.getElementById("sidebar");

// Add platform-specific class for macOS so we can apply spacing for traffic lights
try {
    const plat = (window.electronAPI && window.electronAPI.getPlatform) ? window.electronAPI.getPlatform() : null;
    if (plat === 'darwin') {
        document.body.classList.add('platform-darwin');
        // Ensure a visible and immediate spacing for the traffic lights using a CSS variable
        const trafficSpace = '74px';
        try { document.documentElement.style.setProperty('--traffic-space', trafficSpace); } catch (e) { }
        // Apply inline styles as a fallback so you see the change without needing a full reload
        const tb = document.getElementById('titlebar');
        if (tb) {
            tb.style.paddingLeft = trafficSpace;
            // mark applied for debugging if needed
            tb.setAttribute('data-traffic-applied', 'true');
        }
        const tc = document.getElementById('tabs-container');
        if (tc) tc.style.maxWidth = `calc(97% - var(--traffic-space, ${trafficSpace}))`;
        console.log('[layout] Applied macOS traffic-space:', trafficSpace);
    }
} catch (e) { }

// Menu specific ID fix for 'new-tab' inside menu to avoid conflict
const menuNewTabBtn = document.getElementById("menu-new-tab");

const addBtn = document.getElementById('add-bookmark-btn');
const cancelBtn = document.getElementById('cancel-bookmark-btn');
const bookmarkBar = document.getElementById('bookmarkbar');
const nameInput = document.getElementById('name-bookmark');

let persistentSites = JSON.parse(localStorage.getItem("persistentSites") || "[]");
let bookmarks = JSON.parse(localStorage.getItem("bookmarks") || "[]");
let tabs = [];
let activeTabId = null;
let nextTabId = 0;
let draggedTabId = null;
let splitState = { group: [] };
let tabGroups = [];
let editingGroupId = null;

function getNextGroupName() {
    const used = new Set();
    tabGroups.forEach((g) => {
        if (g && typeof g.name === 'string') {
            const m = g.name.match(/^Group\s*(\d+)$/i);
            if (m) {
                const n = Number(m[1]);
                if (n > 0) used.add(n);
            }
        }
    });

    let candidate = 1;
    while (used.has(candidate)) candidate += 1;
    return `Group ${candidate}`;
}

function createTabGroupNow(activeTabId, targetTabId) {
    const name = getNextGroupName();
    const color = randomColor();
    if (window.electronAPI && window.electronAPI.groupTabs) {
        window.electronAPI.groupTabs({ group: [activeTabId, targetTabId], name, color });
    }
}


if (window.electronAPI && window.electronAPI.onGroupUpdated) {
    window.electronAPI.onGroupUpdated((data) => {
        tabGroups = Array.isArray(data.groups) ? data.groups : [];
        renderTabs();
    });
}

if (window.electronAPI && window.electronAPI.onAskTabGroupName) {
    window.electronAPI.onAskTabGroupName((data) => {
        if (!data || typeof data.targetId !== 'number' || typeof data.activeTabId !== 'number') return;
        createTabGroupNow(data.activeTabId, data.targetId);
    });
}

function randomColor() {
    const hue = Math.floor(Math.random() * 360);
    const saturation = 50 + Math.floor(Math.random() * 30);
    const lightness = 45 + Math.floor(Math.random() * 10);
    return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}

function formatGroupTitle(groupIds) {
    const names = groupIds.map(id => {
        const t = tabs.find(x => x.id === id);
        return (t && t.title) ? t.title : 'New Tab';
    });
    if (names.length === 0) return '';
    if (names.length === 1) return names[0];
    if (names.length === 2) return `${names[0]} & ${names[1]}`;
    // 3+ -> "A, B & C"
    const last = names.pop();
    return `${names.join(', ')} & ${last}`;
}

function updateTabGroupName(groupIndex, newName) {
    if (typeof groupIndex !== 'number' || !newName || !newName.trim()) return;
    if (!Array.isArray(tabGroups) || !tabGroups[groupIndex]) return;
    tabGroups[groupIndex].name = newName.trim();
    if (window.electronAPI && window.electronAPI.groupTabs) {
        window.electronAPI.groupTabs({ group: tabGroups });
    }
}

function createGroupHeader(group, groupIndex) {
    const groupHeader = document.createElement('div');
    groupHeader.className = 'tab-group-header';
    groupHeader.style.borderLeft = `3px solid ${group.color || '#888'}`;
    groupHeader.dataset.groupIndex = groupIndex;

    const titleSpan = document.createElement('span');
    titleSpan.className = 'tab-group-header-title';
    titleSpan.textContent = group.name || `Group ${groupIndex + 1}`;
    groupHeader.appendChild(titleSpan);

    const editBtn = document.createElement('button');
    editBtn.className = 'tab-group-edit';
    editBtn.title = 'Rename group';
    editBtn.textContent = '✎';
    editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const input = document.createElement('input');
        input.className = 'tab-group-header-input';
        input.value = group.name || `Group ${groupIndex + 1}`;
        input.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') {
                ev.preventDefault();
                updateTabGroupName(groupIndex, input.value);
                groupHeader.replaceChild(titleSpan, input);
            } else if (ev.key === 'Escape') {
                ev.preventDefault();
                groupHeader.replaceChild(titleSpan, input);
            }
        });
        input.addEventListener('blur', () => {
            if (input.value.trim()) {
                updateTabGroupName(groupIndex, input.value);
            }
            groupHeader.replaceChild(titleSpan, input);
        });
        groupHeader.replaceChild(input, titleSpan);
        input.focus();
        input.select();
    });
    groupHeader.appendChild(editBtn);

    const ungroupBtn = document.createElement('button');
    ungroupBtn.className = 'tab-group-ungroup';
    ungroupBtn.title = 'Ungroup tabs';
    ungroupBtn.textContent = '×';
    ungroupBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const newGroups = tabGroups.filter((_, idx) => idx !== groupIndex);
        if (window.electronAPI && window.electronAPI.groupTabs) {
            window.electronAPI.groupTabs({ group: newGroups });
        }
    });
    groupHeader.appendChild(ungroupBtn);

    groupHeader.addEventListener('dragover', (e) => {
        e.preventDefault();
        groupHeader.classList.add('drag-over');
    });
    groupHeader.addEventListener('dragleave', () => {
        groupHeader.classList.remove('drag-over');
    });
    groupHeader.addEventListener('drop', (e) => {
        e.preventDefault();
        groupHeader.classList.remove('drag-over');
        const fromId = e.dataTransfer.getData('text/plain');
        if (!fromId) return;
        if (window.electronAPI && window.electronAPI.groupTabs) {
            window.electronAPI.groupTabs({ addId: Number(fromId), targetId: group.ids[0], name: group.name, color: group.color });
        }
    });

    return groupHeader;
}

function createTabElement(tab, tabGroup = null) {
    const isSplitGroupMember = Array.isArray(splitState.group) && splitState.group.includes(tab.id);
    if (isSplitGroupMember && splitState.group[0] !== tab.id) {
        return null;
    }

    const isInTabGroup = !!tabGroup;
    const tabElement = document.createElement('div');
    tabElement.className = `tab ${tab.id === activeTabId ? 'active' : ''} ${isSplitGroupMember ? 'split' : ''} ${isInTabGroup ? 'tab-group-member' : ''}`;
    if (isInTabGroup) {
        tabElement.style.borderBottom = `3px solid ${tabGroup.color || 'transparent'}`;
    }

    if (isSplitGroupMember && splitState.group[0] === tab.id) {
        tabElement.classList.add('tab-split-root');
    }

    tabElement.dataset.tabId = tab.id;
    tabElement.style.webkitAppRegion = 'no-drag';
    tabElement.setAttribute('draggable', 'true');

    if (tab.isManipulation) {
        tabElement.style.outline = '2px dashed #626262';
        tabElement.style.filter = 'brightness(0.5)';
        tabElement.style.outlineOffset = '-2px';
        tabElement.title = tab.title || 'Manipulation tab';
    }

    tabElement.addEventListener('dragstart', (e) => {
        try {
            e.dataTransfer.setData('text/plain', String(tab.id));
        } catch (err) { }
        e.dataTransfer.effectAllowed = 'move';
        draggedTabId = tab.id;
        tabElement.classList.add('dragging');
    });

    tabElement.addEventListener('dragend', () => {
        draggedTabId = null;
        tabElement.classList.remove('dragging');
        tabElement.classList.remove('insert-left', 'insert-right', 'split-target');
        const items = tabsContainer.querySelectorAll('.tab.insert-left, .tab.insert-right, .tab.split-target');
        items.forEach((it) => it.classList.remove('insert-left', 'insert-right', 'split-target'));
    });

    tabElement.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';

        const rect = tabElement.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const ratio = x / rect.width;

        tabElement.classList.remove('insert-left', 'insert-right', 'split-target');

        if (ratio < 0.28) {
            tabElement.classList.add('insert-left');
        } else if (ratio > 0.72) {
            tabElement.classList.add('insert-right');
        } else {
            tabElement.classList.add('split-target');
        }
    });

    tabElement.addEventListener('dragleave', () => {
        tabElement.classList.remove('insert-left', 'insert-right', 'split-target');
    });

    tabElement.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();

        const fromId = e.dataTransfer.getData('text/plain') || draggedTabId;
        const toId = tab.id;
        if (!fromId || String(fromId) === String(toId)) return;

        const rect = tabElement.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const ratio = x / rect.width;

        const fromIndex = tabs.findIndex((t) => String(t.id) === String(fromId));
        const toIndex = tabs.findIndex((t) => t.id === toId);
        if (fromIndex === -1 || toIndex === -1) return;

        const targetGroup = tabGroups.find((g) => Array.isArray(g.ids) && g.ids.includes(toId));

        if (targetGroup && ratio >= 0.28 && ratio <= 0.72) {
            // drop into group by using target group representative
            if (window.electronAPI && window.electronAPI.groupTabs) {
                window.electronAPI.groupTabs({ addId: Number(fromId), targetId: targetGroup.ids[0], name: targetGroup.name, color: targetGroup.color });
            }
        } else if (ratio < 0.28) {
            const [moved] = tabs.splice(fromIndex, 1);
            const insertIndex = fromIndex < toIndex ? toIndex - 1 : toIndex;
            tabs.splice(insertIndex, 0, moved);
            renderTabs();
            if (window.electronAPI && window.electronAPI.reorderTabs) {
                try { window.electronAPI.reorderTabs(tabs.map((t) => t.id)); } catch (err) { }
            }
        } else if (ratio > 0.72) {
            const [moved] = tabs.splice(fromIndex, 1);
            let insertIndex = toIndex + 1;
            if (fromIndex < toIndex) insertIndex = toIndex;
            tabs.splice(insertIndex, 0, moved);
            renderTabs();
            if (window.electronAPI && window.electronAPI.reorderTabs) {
                try { window.electronAPI.reorderTabs(tabs.map((t) => t.id)); } catch (err) { }
            }
        } else {
            // split/merge fallback
            if (window.electronAPI && window.electronAPI.splitTabs) {
                try { window.electronAPI.splitTabs({ addId: Number(fromId), targetId: Number(toId) }); } catch (err) { }
            }
        }

        tabElement.classList.remove('insert-left', 'insert-right', 'split-target');
    });

    // favicon + title
    if (tab.isManipulation) {
        const iconDiv = document.createElement('div');
        iconDiv.className = 'favicon';
        iconDiv.innerHTML = '<svg class="icon"><use href="#icon-syringe"></use></svg>';
        tabElement.appendChild(iconDiv);
    } else {
        const favicon = document.createElement('img');
        favicon.className = 'favicon';
        const domain = getDomain(tab.url);
        favicon.onerror = () => { favicon.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="white"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/></svg>'; };
        favicon.src = domain ? `https://www.google.com/s2/favicons?sz=16&domain=${domain}` : '';
        tabElement.appendChild(favicon);
    }

    const titleSpan = document.createElement('span');
    titleSpan.className = 'tab-title';
    titleSpan.textContent = tab.title || 'New Tab';
    titleSpan.title = tab.title || 'New Tab';
    tabElement.appendChild(titleSpan);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'close-btn';
    closeBtn.innerHTML = '<svg class="icon"><use href="#icon-close"></use></svg>';
    closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeTab(tab.id, e);
    });
    tabElement.appendChild(closeBtn);

    tabElement.addEventListener('click', (e) => {
        if (!e.target.closest('.close-btn')) {
            switchTab(tab.id);
        }
    });

    tabElement.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (window.electronAPI && window.electronAPI.showTabContextMenu) {
            window.electronAPI.showTabContextMenu({ tabId: tab.id });
        }
    });

    return tabElement;
}

// Startup/home page handling
let startupHome = null;
// when no homepage is configured we show an internal start page instead of the
// old default remote URL (space.cheeter.de).  the special URI is handled in
// main.js and also recognised locally so we can clear the address field.
const START_PAGE_URI = 'navigator://start'; // reminder: maps to /startpage/index.html
const DEFAULT_HOME = 'https://space.cheeter.de';
let searchEngine = 'Cheeter Space';
function normalizeHomeUrl(v) {
    if (!v) return null;
    v = v.trim();
    if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
    try { new URL(v); return v; } catch (e) { return null; }
}
function getStartupUrl() {
    // preference for a user‑configured homepage; fall back to our internal
    // start page if none is set.  this ensures new tabs and the home button
    // always open something local rather than going to space.cheeter.de.
    return normalizeHomeUrl(startupHome) || START_PAGE_URI;
}

// helper used throughout the UI to know when we're looking at the start page
function isStartPageUrl(url) {
    if (!url) return false;
    // check both the special URI and the eventual real path (dev/prod)
    return url === START_PAGE_URI || url.includes('/startpage/index.html');
}

function getSearchUrl(query) {
    const enc = encodeURIComponent(query);

    // If user chose 'Custom' engine and provided a template, use it
    if (searchEngine === 'Custom' && customSearchEngine) {
        if (customSearchEngine.includes('{search}')) return customSearchEngine.replace('{search}', enc);
        return customSearchEngine + (customSearchEngine.includes('?') ? '&q=' + enc : '?q=' + enc);
    }

    // prefer managed custom engines (legacy support)
    const custom = searchEngines.find(e => e.name === searchEngine);
    if (custom && custom.template) {
        if (custom.template.includes('{search}')) return custom.template.replace('{search}', enc);
        return custom.template + (custom.template.includes('?') ? '&q=' + enc : '?q=' + enc);
    }

    const templates = {
        'Cheeter Spaceᴰᴱ': `https://space.cheeter.de/s.php#gsc.tab=0&gsc.q=${enc}`,
        'CGWebᴾᴴ': `https://web.canaveral.group/search?q=${enc}`,
        'Startpageᴺᴸ': `https://www.startpage.com/sp/search?q=${enc}`,
        'DuckDuckGoᵘˢ': `https://duckduckgo.com/?q=${enc}`,
        'Ecosiaᴰᴱ': `https://www.ecosia.org/search?q=${enc}`,
        'OceanHeroᴰᴱ': `https://www.oceanhero.today/web?q=${enc}`,
        'Bingᵘˢ': `https://www.bing.com/search?q=${enc}`
    };
    // ensure we always return some URL; if the requested engine isn't known,
    // fall back to the DE Cheeter Space variant.
    return templates[searchEngine] || templates['Cheeter Spaceᴰᴱ'];
}

// Load persisted settings for startupHome, searchEngine and custom search engines
let searchEngines = [];
let customSearchEngine = '';
let saveHistory = false;

// adblocker state (kept in sync with main)
let adblockEnabled = false;

function updateAdblockUI() {
    if (!adblockBtn) return;
    if (adblockEnabled) {
        adblockBtn.style.color = "#28a745"; // green
    } else {
        adblockBtn.style.color = "#dc3545"; // red
    }
    if (adblockBadge) {
        adblockBadge.style.display = adblockEnabled ? 'block' : 'none';
    }
    // update count badge anytime UI changes
    updateAdblockBadge();
}
if (window.electronAPI && window.electronAPI.getSettings) {
    window.electronAPI.getSettings().then(s => {
        startupHome = s && s.homePage ? s.homePage : '';
        searchEngine = s && s.searchEngine ? s.searchEngine : searchEngine;
        searchEngines = Array.isArray(s && s.searchEngines) ? s.searchEngines.slice() : [];
        customSearchEngine = s && s.customSearchEngine ? s.customSearchEngine : '';
        saveHistory = !!(s && s.saveHistory);
        adblockEnabled = !!(s && s.adblockEnabled);
        updateAdblockUI();
    }).catch(() => { });
    if (window.electronAPI.onSettingsUpdated) window.electronAPI.onSettingsUpdated((s) => {
        startupHome = s && s.homePage ? s.homePage : '';
        searchEngine = s && s.searchEngine ? s.searchEngine : searchEngine;
        searchEngines = Array.isArray(s && s.searchEngines) ? s.searchEngines.slice() : searchEngines;
        customSearchEngine = s && s.customSearchEngine ? s.customSearchEngine : customSearchEngine;
        saveHistory = !!(s && s.saveHistory);
        adblockEnabled = !!(s && s.adblockEnabled);
        updateAdblockUI();
    });
    if (window.electronAPI.onAdblockStatus) {
        window.electronAPI.onAdblockStatus((val) => {
            adblockEnabled = !!val;
            updateAdblockUI();
        });
    }
    if (window.electronAPI.onAdblockStatsUpdated) {
        window.electronAPI.onAdblockStatsUpdated((stats) => {
            // directly put the blocked count into the badge
            if (adblockBadge) {
                adblockBadge.textContent = stats && stats.blocked ? stats.blocked : '0';
            }
        });
    }
    if (window.electronAPI.getKeyPassXCStatus) {
        window.electronAPI.getKeyPassXCStatus().then((data) => {
            console.log('KeyPassXC status:', data);
        }).catch(() => { });
    }
} else {
    startupHome = localStorage.getItem('homePage') || '';
    searchEngine = localStorage.getItem('searchEngine') || searchEngine;
    try { searchEngines = JSON.parse(localStorage.getItem('searchEngines') || '[]'); } catch (e) { searchEngines = []; }
    customSearchEngine = localStorage.getItem('customSearchEngine') || '';
    const v = localStorage.getItem('adblockEnabled');
    if (v !== null) adblockEnabled = v === 'true';
    updateAdblockUI();

}

// periodically refresh count badge in case blocking happened in background
setInterval(updateAdblockBadge, 5000);
// Apply saved theme globally for the main window and listen for updates
(function () {
    function applyThemeClass(t) { document.body.className = t || 'theme-default'; }

    // color utilities (same logic as settings)
    function hexToRgb(hex) { hex = hex.replace('#', ''); const bigint = parseInt(hex, 16); return { r: (bigint >> 16) & 255, g: (bigint >> 8) & 255, b: bigint & 255 }; }
    function rgbToHex(r, g, b) { return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join(''); }
    function rgbToHsl(r, g, b) { r /= 255; g /= 255; b /= 255; const max = Math.max(r, g, b), min = Math.min(r, g, b); let h, s, l = (max + min) / 2; if (max === min) { h = s = 0; } else { const d = max - min; s = l > 0.5 ? d / (2 - max - min) : d / (max + min); switch (max) { case r: h = (g - b) / d + (g < b ? 6 : 0); break; case g: h = (b - r) / d + 2; break; case b: h = (r - g) / d + 4; break; } h /= 6; } return { h: h, s: s, l: l }; }
    function hslToRgb(h, s, l) { let r, g, b; if (s === 0) { r = g = b = l; } else { const hue2rgb = (p, q, t) => { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; }; const q = l < 0.5 ? l * (1 + s) : l + s - l * s; const p = 2 * l - q; r = hue2rgb(p, q, h + 1 / 3); g = hue2rgb(p, q, h); b = hue2rgb(p, q, h - 1 / 3); } return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) }; }
    function adjustLightness(hex, deltaPercent) { const rgb = hexToRgb(hex); const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b); hsl.l = Math.max(0, Math.min(1, hsl.l + deltaPercent / 100)); const rgb2 = hslToRgb(hsl.h, hsl.s, hsl.l); return rgbToHex(rgb2.r, rgb2.g, rgb2.b); }
    function luminance(hex) { const { r, g, b } = hexToRgb(hex); const rs = r / 255, gs = g / 255, bs = b / 255; const srgb = (v) => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); const L = 0.2126 * srgb(rs) + 0.7152 * srgb(gs) + 0.0722 * srgb(bs); return L; }

    function applyCustomColors(hex) {
        if (!hex) return;
        const primary = hex;
        const bgToolbar = primary;
        const bgMain = adjustLightness(primary, -18);
        const bgElementHover = adjustLightness(primary, 10);
        const bgInput = adjustLightness(primary, -8);
        const borderColor = adjustLightness(primary, -28);
        const bgTitlebar = adjustLightness(primary, -6);
        const L = luminance(primary);
        const textColor = L < 0.45 ? '#eaf1ff' : (L > 0.75 ? '#111111' : '#434c57');

        const root = document.documentElement;
        root.style.setProperty('--bg-toolbar', bgToolbar);
        root.style.setProperty('--bg-main', bgMain);
        root.style.setProperty('--bg-element-hover', bgElementHover);
        root.style.setProperty('--bg-input', bgInput);
        root.style.setProperty('--border-color', borderColor);
        root.style.setProperty('--text-color', textColor);
        root.style.setProperty('--bg-titlebar', bgTitlebar);
    }

    if (window.electronAPI && window.electronAPI.getSettings) {
        window.electronAPI.getSettings().then(s => {
            const t = s && s.theme ? s.theme : 'theme-default';
            applyThemeClass(t);
            if (t === 'theme-custom' && s && s.themeColor) applyCustomColors(s.themeColor);
        }).catch(() => {
            const t = localStorage.getItem('theme') || 'theme-default';
            applyThemeClass(t);
            if (t === 'theme-custom') applyCustomColors(localStorage.getItem('themeColor') || '#1E88E5');
        });
        if (window.electronAPI.onSettingsUpdated) {
            window.electronAPI.onSettingsUpdated((s) => {
                const t = s && s.theme ? s.theme : 'theme-default';
                applyThemeClass(t);
                if (t === 'theme-custom') applyCustomColors(s && s.themeColor ? s.themeColor : (localStorage.getItem('themeColor') || '#1E88E5'));
            });
        }
    } else {
        const t = localStorage.getItem('theme') || 'theme-default';
        applyThemeClass(t);
        if (t === 'theme-custom') applyCustomColors(localStorage.getItem('themeColor') || '#1E88E5');
    }
})();

// Listen for local (non-electron) setting changes dispatched from settings page
window.addEventListener('settings-changed', (e) => {
    if (!e || !e.detail) return;
    if (e.detail.searchEngine) searchEngine = e.detail.searchEngine;
    if (e.detail.customSearchEngine) customSearchEngine = e.detail.customSearchEngine;
    if (e.detail.searchEngines) searchEngines = e.detail.searchEngines.slice();
    if (typeof e.detail.saveHistory !== 'undefined') saveHistory = !!e.detail.saveHistory;
    if (e.detail.searchHistory) {
        // nothing to do here, view will pick it up from storage
    }
    if (e.detail.theme) { document.body.className = e.detail.theme; }
    if (e.detail.themeColor && document.documentElement) {
        // apply same color logic
        (function () {
            const hex = e.detail.themeColor;
            if (!hex) return;
            function hexToRgb(hex) { hex = hex.replace('#', ''); const bigint = parseInt(hex, 16); return { r: (bigint >> 16) & 255, g: (bigint >> 8) & 255, b: bigint & 255 }; }
            function rgbToHex(r, g, b) { return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join(''); }
            function rgbToHsl(r, g, b) { r /= 255; g /= 255; b /= 255; const max = Math.max(r, g, b), min = Math.min(r, g, b); let h, s, l = (max + min) / 2; if (max === min) { h = s = 0; } else { const d = max - min; s = l > 0.5 ? d / (2 - max - min) : d / (max + min); switch (max) { case r: h = (g - b) / d + (g < b ? 6 : 0); break; case g: h = (b - r) / d + 2; break; case b: h = (r - g) / d + 4; break; } h /= 6; } return { h: h, s: s, l: l }; }
            function hslToRgb(h, s, l) { let r, g, b; if (s === 0) { r = g = b = l; } else { const hue2rgb = (p, q, t) => { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; }; const q = l < 0.5 ? l * (1 + s) : l + s - l * s; const p = 2 * l - q; r = hue2rgb(p, q, h + 1 / 3); g = hue2rgb(p, q, h); b = hue2rgb(p, q, h - 1 / 3); } return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) }; }
            function adjustLightness(hex, deltaPercent) { const rgb = hexToRgb(hex); const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b); hsl.l = Math.max(0, Math.min(1, hsl.l + deltaPercent / 100)); const rgb2 = hslToRgb(hsl.h, hsl.s, hsl.l); return rgbToHex(rgb2.r, rgb2.g, rgb2.b); }
            function luminance(hex) { const { r, g, b } = hexToRgb(hex); const rs = r / 255, gs = g / 255, bs = b / 255; const srgb = (v) => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); const L = 0.2126 * srgb(rs) + 0.7152 * srgb(gs) + 0.0722 * srgb(bs); return L; }

            const primary = hex;
            const bgToolbar = primary;
            const bgMain = adjustLightness(primary, -18);
            const bgElementHover = adjustLightness(primary, 10);
            const bgInput = adjustLightness(primary, -8);
            const borderColor = adjustLightness(primary, -28);
            const bgTitlebar = adjustLightness(primary, -6);
            const L = luminance(primary);
            const textColor = L < 0.45 ? '#eaf1ff' : (L > 0.75 ? '#111111' : '#434c57');

            const root = document.documentElement;
            root.style.setProperty('--bg-toolbar', bgToolbar);
            root.style.setProperty('--bg-main', bgMain);
            root.style.setProperty('--bg-element-hover', bgElementHover);
            root.style.setProperty('--bg-input', bgInput);
            root.style.setProperty('--border-color', borderColor);
            root.style.setProperty('--text-color', textColor);
            root.style.setProperty('--bg-titlebar', bgTitlebar);
        })();
    }
});

function syncViewWithUI() {
    const toolbar = document.getElementById('toolbar');
    const titlebar = document.getElementById('titlebar');

    if (!toolbar || !titlebar) return;

    // Berechnung: Titlebar (beinhaltet jetzt Tabs) + Toolbar
    let totalHeight = titlebar.offsetHeight + toolbar.offsetHeight;

    // Bookmarkbar Check
    if (bookmarkBar && bookmarkBar.style.display !== 'none') {
        totalHeight += bookmarkBar.offsetHeight;
    }

    if (sidebar) {
        sidebar.style.top = Math.ceil(totalHeight) + 'px';
    }

    // Defensive clamp before telling main: avoid uiHeight==0 or very small values
    const MIN_UI_HEIGHT = 64;
    const reported = Math.ceil(totalHeight);
    const uiHeightToSend = Math.max(MIN_UI_HEIGHT, reported);
    if (reported < MIN_UI_HEIGHT) console.warn(`[renderer] clamped uiHeight ${reported} -> ${uiHeightToSend}`);

    const uiWidthLeftToSend = (sidebar && sidebar.style.display !== 'none') ? sidebar.offsetWidth : 0;

    // Sende Pixel-Wert an Main
    if (window.electronAPI && window.electronAPI.syncViewBounds) {
        window.electronAPI.syncViewBounds({ uiHeight: uiHeightToSend, uiWidthLeft: uiWidthLeftToSend });
    }
    // Position TOR border overlay if present
    const torBorder = document.getElementById('tor-border');
    if (torBorder) {
        torBorder.style.top = uiHeightToSend + 'px';
        torBorder.style.height = `calc(100% - ${uiHeightToSend}px)`;
    }
}

let torEnabled = false;

function getDomain(url) {
    try {
        const parsed = new URL(url);
        return parsed.hostname;
    } catch (e) { return null; }
}

function updateButtonUI(url) {
    const domain = getDomain(url);
    // defensive: DOM refs may be null in edge-cases
    if (incognitoBtn) {
        if (domain && persistentSites.includes(domain)) {
            incognitoBtn.innerHTML = "<svg class=\"icon\"><use href=\"#icon-visibility\"></use></svg>";
            incognitoBtn.style.color = "#dc3545";
        } else {
            incognitoBtn.innerHTML = "<svg class=\"icon\"><use href=\"#icon-visibility_off\"></use></svg>";
            incognitoBtn.style.color = "#28a745";
        }
    }
    const isBookmarked = bookmarks.some(b => b.url === url);
    if (bookmarkButton) bookmarkButton.style.color = isBookmarked ? "gold" : "";
    // ensure adblock icon reflects current state
    updateAdblockUI();
}

function createNewTab() {
    const newTabId = nextTabId++;
    const url = getStartupUrl();
    const isPersistent = false;
    window.electronAPI.navigateTo({ url, isPersistent, tabId: newTabId });
}

function switchTab(tabId) {
    console.log('switchTab called with tabId:', tabId);

    // Update local state first
    activeTabId = tabId;
    const currentTab = tabs.find(t => t.id === tabId);

    if (currentTab) {
        urlInput.value = isStartPageUrl(currentTab.url) ? '' : currentTab.url;
        updateButtonUI(currentTab.url);
    }

    // Re-render tabs UI
    renderTabs();

    // Tell main process to switch the view
    window.electronAPI.switchTab({ tabId });
    // ensure main has correct UI height after switching (defensive)
    setTimeout(syncViewWithUI, 50);
}

function closeTab(tabId, event) {
    if (event) event.stopPropagation();
    window.electronAPI.closeTab({ tabId });
}

function renderTabs() {
    tabsContainer.innerHTML = '';

    const renderedGroups = new Set();

    tabs.forEach((tab) => {
        const isSplitGroupMember = Array.isArray(splitState.group) && splitState.group.includes(tab.id);
        if (isSplitGroupMember && splitState.group[0] !== tab.id) {
            return;
        }

        const tabGroup = tabGroups.find((g) => Array.isArray(g.ids) && g.ids.includes(tab.id));

        if (tabGroup) {
            const groupKey = tabGroup.ids.join(',');
            if (renderedGroups.has(groupKey)) {
                return;
            }

            const groupIndex = tabGroups.findIndex((g) => g === tabGroup);
            const groupHeader = createGroupHeader(tabGroup, groupIndex);
            tabsContainer.appendChild(groupHeader);

            tabGroup.ids.forEach((memberId) => {
                const memberTab = tabs.find((t) => t.id === memberId);
                if (!memberTab) return;

                const tabElement = createTabElement(memberTab, tabGroup);
                if (tabElement) tabsContainer.appendChild(tabElement);
            });

            renderedGroups.add(groupKey);
            return;
        }

        const tabElement = createTabElement(tab, null);
        if (tabElement) tabsContainer.appendChild(tabElement);
    });
}

// Container-level drag handling for between-tab insertion
let _insertionTarget = null; // { type: 'before'|'after', tabId }

tabsContainer.addEventListener('dragover', (e) => {
    e.preventDefault();

    const x = e.clientX;
    const children = Array.from(tabsContainer.querySelectorAll('.tab'));
    let found = false;

    // clear previous
    children.forEach(c => c.classList.remove('insert-left', 'insert-right'));

    for (const c of children) {
        const r = c.getBoundingClientRect();
        const mid = r.left + r.width / 2;
        if (x < mid) {
            c.classList.add('insert-left');
            _insertionTarget = { type: 'before', tabId: c.dataset.tabId };
            found = true;
            break;
        }
    }

    if (!found && children.length > 0) {
        const last = children[children.length - 1];
        last.classList.add('insert-right');
        _insertionTarget = { type: 'after', tabId: last.dataset.tabId };
    }
});

tabsContainer.addEventListener('dragleave', (e) => {
    const children = Array.from(tabsContainer.querySelectorAll('.tab'));
    children.forEach(c => c.classList.remove('insert-left', 'insert-right'));
    _insertionTarget = null;
});

tabsContainer.addEventListener('drop', (e) => {
    e.preventDefault();
    const fromId = e.dataTransfer.getData('text/plain') || draggedTabId;
    if (!fromId) return;
    const target = _insertionTarget;
    if (!target) return;

    // compute indices
    const fromIndex = tabs.findIndex(t => String(t.id) === String(fromId));
    const toIndex = tabs.findIndex(t => String(t.id) === String(target.tabId));
    if (fromIndex === -1 || toIndex === -1) return;

    let insertIndex = (target.type === 'before') ? toIndex : (toIndex + 1);
    if (fromIndex < insertIndex) insertIndex -= 1;

    const [moved] = tabs.splice(fromIndex, 1);
    tabs.splice(insertIndex, 0, moved);

    renderTabs();
    if (window.electronAPI && window.electronAPI.reorderTabs) {
        try { window.electronAPI.reorderTabs(tabs.map(t => t.id)); } catch (err) { }
    }

    const children = Array.from(tabsContainer.querySelectorAll('.tab'));
    children.forEach(c => c.classList.remove('insert-left', 'insert-right'));
    _insertionTarget = null;
});

// ensure cleanup on global dragend
window.addEventListener('dragend', () => {
    const children = Array.from(tabsContainer.querySelectorAll('.tab'));
    children.forEach(c => c.classList.remove('insert-left', 'insert-right', 'split-target', 'dragging'));
    _insertionTarget = null;
});

function requestNavigation(url, tabId = activeTabId) {
    const domain = getDomain(url);
    const isPersistent = domain && persistentSites.includes(domain);
    window.electronAPI.navigateTo({ url, isPersistent, tabId });
    setTimeout(syncViewWithUI, 50);
}



// Browsing history helper
function addHistoryEntry(url, title) {
    if (!url) return;
    url = (url || '').trim();
    if (!url) return;
    const entry = { url: url, title: title || '', ts: Date.now() };
    try {
        if (window.electronAPI && window.electronAPI.setSetting && window.electronAPI.getSettings) {
            window.electronAPI.getSettings().then(s => {
                let arr = Array.isArray(s && s.history) ? s.history.slice() : [];
                arr = arr.filter(it => (it.url || '').toLowerCase() !== url.toLowerCase());
                arr.unshift(entry);
                arr = arr.slice(0, 1000);
                window.electronAPI.setSetting('history', arr);
                try { window.dispatchEvent(new CustomEvent('settings-changed', { detail: { history: arr } })); } catch (e) { }
            }).catch(() => { });
        } else {
            let arr = [];
            try { arr = JSON.parse(localStorage.getItem('history') || '[]'); } catch (e) { arr = []; }
            arr = arr.filter(it => (it.url || '').toLowerCase() !== url.toLowerCase());
            arr.unshift(entry);
            arr = arr.slice(0, 1000);
            localStorage.setItem('history', JSON.stringify(arr));
            window.dispatchEvent(new CustomEvent('settings-changed', { detail: { history: arr } }));
        }
    } catch (e) { console.error(e); }
}

// Update the title for an existing history entry for a given URL (if present)
function updateHistoryEntryTitle(url, title) {
    if (!url) return;
    url = (url || '').trim();
    if (!url) return;
    try {
        if (window.electronAPI && window.electronAPI.setSetting && window.electronAPI.getSettings) {
            window.electronAPI.getSettings().then(s => {
                let arr = Array.isArray(s && s.history) ? s.history.slice() : [];
                let changed = false;
                arr = arr.map(it => {
                    if ((it.url || '').toLowerCase() === url.toLowerCase()) { changed = true; return Object.assign({}, it, { title: title || it.title }); }
                    return it;
                });
                if (changed) {
                    window.electronAPI.setSetting('history', arr);
                    try { window.dispatchEvent(new CustomEvent('settings-changed', { detail: { history: arr } })); } catch (e) { }
                }
            }).catch(() => { });
        } else {
            let arr = [];
            try { arr = JSON.parse(localStorage.getItem('history') || '[]'); } catch (e) { arr = []; }
            let changed = false;
            arr = arr.map(it => {
                if ((it.url || '').toLowerCase() === url.toLowerCase()) { changed = true; return Object.assign({}, it, { title: title || it.title }); }
                return it;
            });
            if (changed) {
                localStorage.setItem('history', JSON.stringify(arr));
                window.dispatchEvent(new CustomEvent('settings-changed', { detail: { history: arr } }));
            }
        }
    } catch (e) { console.error(e); }
}

function navigate() {
    let input = urlInput.value.trim();
    if (!input) {
        // blank address bar -> start page
        requestNavigation(START_PAGE_URI);
        return;
    }
    // Determine whether the input should be treated as a search or a URL.
    // Previous logic treated anything without a dot as a search (breaking hosts like "localhost").
    let isSearch;
    // If user provided any protocol (e.g., http(s) or custom like navigator://), it's definitely a URL
    if (/^[a-z]+:\/\//i.test(input)) {
        isSearch = false;
    } else if (input.includes(" ")) {
        // Spaces -> search
        isSearch = true;
    } else if (input.includes(".")) {
        // Contains a dot -> likely a domain
        isSearch = false;
    } else if (input.toLowerCase() === 'localhost' || /^\d+\.\d+\.\d+\.\d+(:\d+)?(\/.*)?$/.test(input) || /[:\/]/.test(input)) {
        // localhost, IPs, or host with port/path -> treat as URL
        isSearch = false;
    } else {
        // No dot and no space and no port/path -> treat as search (e.g., 'example' -> search)
        isSearch = true;
    }

    // Choose default scheme: prefer http for local hosts or IPs (dev servers), otherwise https
    let url;
    if (isSearch) {
        url = getSearchUrl(input);
    } else if (/^[a-z]+:\/\//i.test(input)) {
        // input already contains a scheme (including navigator://)
        url = input;
    } else if (input.startsWith("http")) {
        url = input;
    } else {
        // Determine if input looks like localhost, IP, or includes a port -> prefer http
        const hostOnlyMatch = input.match(/^([^\/\:]+)(:\d+)?(\/.*)?$/);
        const hostCandidate = hostOnlyMatch ? hostOnlyMatch[1] : '';
        const useHttp = /^(localhost|127\.0\.0\.1|\d+\.\d+\.\d+\.\d+)$/.test(hostCandidate) || input.includes(":");
        url = (useHttp ? "http://" : "https://") + input;
    }



    requestNavigation(url);
}

// Event listeners für Main-Prozess-Events
if (window.electronAPI.onNavigated) {
    window.electronAPI.onNavigated((url) => {
        // If we're looking at our internal start page we keep the address
        // bar empty; otherwise show the URL so it can be edited.
        urlInput.value = isStartPageUrl(url) ? '' : url;
        updateButtonUI(url);
        syncViewWithUI();
        window.electronAPI.setCurrentUrl(url, nameInput.value || 'Page');

        // Use the active tab's title if available to avoid picking up a stale title from another tab
        let historyTitle = nameInput.value || document.title || '';
        try {
            const currentTab = tabs.find(t => t.id === activeTabId);
            if (currentTab && currentTab.title) historyTitle = currentTab.title;
        } catch (e) { }

        if (saveHistory) {
            try { addHistoryEntry(url, historyTitle); } catch (e) { }
        }
    });
}

if (window.electronAPI.onTitleChanged) {
    window.electronAPI.onTitleChanged((title) => {
        nameInput.value = title;
        window.electronAPI.setCurrentUrl(urlInput.value, title);
        // If the title arrives later, update any existing history entry for the current URL
        try { if (saveHistory && urlInput && urlInput.value) updateHistoryEntryTitle(urlInput.value, title); } catch (e) { }
    });
}

if (window.electronAPI.onTabsUpdated) {
    window.electronAPI.onTabsUpdated((data) => {
        if (data && data.tabs) {
            tabs = data.tabs;
            activeTabId = data.activeTabId;
            // accept split/group array from main process
            splitState.group = Array.isArray(data.group) ? data.group.slice() : [];
            tabGroups = Array.isArray(data.tabGroups) ? data.tabGroups.slice() : [];

            const currentTab = tabs.find(t => t.id === activeTabId);
            if (currentTab) {
                urlInput.value = isStartPageUrl(currentTab.url) ? '' : currentTab.url;
                updateButtonUI(currentTab.url);
            }

            renderTabs();
            syncViewWithUI();
        }
    });
}

if (window.electronAPI.onUpdateTab) {
    window.electronAPI.onUpdateTab((data) => {
        const tab = tabs.find(t => t.id === data.tabId);
        if (tab) {
            if (data.url) tab.url = data.url;
            if (data.title) tab.title = data.title;
            renderTabs();
        }
    });
}

if (window.electronAPI.onSplitUpdated) {
    window.electronAPI.onSplitUpdated((data) => {
        if (data && typeof data === 'object' && Array.isArray(data.group)) {
            splitState.group = data.group.slice();
        } else {
            splitState.group = [];
        }
        renderTabs();
    });
}

if (window.electronAPI.onNewTabRequest) {
    window.electronAPI.onNewTabRequest(() => {
        createNewTab();
    });
}

if (window.electronAPI.onSwitchTabRequest) {
    window.electronAPI.onSwitchTabRequest((data) => {
        switchTab(data.tabId);
    });
}

// Handler für Bookmark-Updates
if (window.electronAPI.onBookmarkAdded) {
    window.electronAPI.onBookmarkAdded((data) => {
        bookmarks.push({ title: data.title, url: data.url });
        localStorage.setItem('bookmarks', JSON.stringify(bookmarks));
        renderBookmarks();
        updateButtonUI(urlInput.value);
    });
}

if (window.electronAPI.onBookmarkRemoved) {
    window.electronAPI.onBookmarkRemoved((data) => {
        bookmarks = bookmarks.filter(b => b.url !== data.url);
        localStorage.setItem('bookmarks', JSON.stringify(bookmarks));
        renderBookmarks();
        updateButtonUI(urlInput.value);
    });
}

if (window.electronAPI.onNavigateToUrl) {
    window.electronAPI.onNavigateToUrl((data) => {
        if (data && data.url) {
            requestNavigation(data.url);
        }
    });
}

// Restore session handler (main -> renderer)
if (window.electronAPI.onRestoreSession) {
    window.electronAPI.onRestoreSession((data) => {
        try {
            if (!data || !Array.isArray(data.tabs)) return;
            // Create tabs for each saved URL and navigate
            data.tabs.forEach((t, idx) => {
                const url = (t && t.url) ? t.url : getStartupUrl();
                const newTabId = nextTabId++;
                const domain = getDomain(url);
                const isPersistent = domain && persistentSites.includes(domain);
                window.electronAPI.navigateTo({ url, isPersistent, tabId: newTabId });
            });
            // Optionally switch to activeTab if provided (renderer receives tabs-updated from main)
        } catch (e) { console.error('[restore-session] failed', e); }
    });
}

if (window.electronAPI.onTorStatus) {
    window.electronAPI.onTorStatus((data) => {
        torEnabled = !!data.enabled;
        const torBorder = document.getElementById('tor-border');
        if (torBorder) torBorder.style.display = torEnabled ? 'block' : 'none';

        const enableTorMenuItem = document.getElementById('enable-tor');
        if (enableTorMenuItem) {
            enableTorMenuItem.innerHTML = `<svg class="icon"><use href="#icon-${torEnabled ? 'vpn_lock' : 'vpn_key'}"></use></svg> ${torEnabled ? 'Disable TOR' : 'Enable TOR'}`;
        }

        console.log('TOR Status:', torEnabled ? 'enabled' : 'disabled');
        syncViewWithUI();
    });
}

if (window.electronAPI.onKeyPassXCStatus) {
    window.electronAPI.onKeyPassXCStatus((data) => {
        console.log('KeyPassXC status updated:', data);
    });
}

const btnMin = document.getElementById("window-minimize");
if (btnMin) btnMin.addEventListener("click", () => window.electronAPI.windowControl('minimize'));
const btnMax = document.getElementById("window-maximize");
if (btnMax) btnMax.addEventListener("click", () => window.electronAPI.windowControl('maximize'));
const btnClose = document.getElementById("window-close");
if (btnClose) btnClose.addEventListener("click", () => window.electronAPI.windowControl('close'));
document.getElementById("reload").addEventListener("click", () => window.electronAPI.browserControl('reload'));
document.getElementById("back").addEventListener("click", () => window.electronAPI.browserControl('back'));
document.getElementById("forward").addEventListener("click", () => window.electronAPI.browserControl('forward'));
document.getElementById("home").addEventListener("click", () => {
    const su = getStartupUrl();
    if (su === START_PAGE_URI) {
        // go directly to the internal start page and keep the address bar empty
        requestNavigation(su);
        urlInput.value = '';
    } else {
        urlInput.value = su;
        navigate();
    }
});

// Add event listener to new tab button
if (newTabBtn) {
    newTabBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        createNewTab();
    });
}

// Add event listener for Menu New Tab button
if (menuNewTabBtn) {
    menuNewTabBtn.addEventListener('click', (e) => {
        createNewTab();
        menuDropdown.style.display = "none";
    });
}

// Manipulation control (start/stop background bots)
let manipulationRunning = false;
if (manipulationButton) {
    manipulationButton.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!manipulationRunning) {
            if (window.electronAPI && window.electronAPI.startManipulation) {
                window.electronAPI.startManipulation();
            }
        } else {
            if (window.electronAPI && window.electronAPI.stopManipulation) {
                window.electronAPI.stopManipulation();
            }
        }
    });
}

if (window.electronAPI && window.electronAPI.onManipulationStatus) {
    window.electronAPI.onManipulationStatus((data) => {
        manipulationRunning = !!(data && data.running);
        if (manipulationRunning) {
            manipulationButton.classList.add('active');
            manipulationButton.title = 'Stop manipulation';
        } else {
            manipulationButton.classList.remove('active');
            manipulationButton.title = 'Start manipulation';
        }
    });
}

incognitoBtn.addEventListener("click", () => {
    const currentUrl = urlInput.value;
    const domain = getDomain(currentUrl);
    if (!domain) return;
    if (persistentSites.includes(domain)) {
        persistentSites = persistentSites.filter(d => d !== domain);
    } else {
        persistentSites.push(domain);
    }
    localStorage.setItem("persistentSites", JSON.stringify(persistentSites));
    requestNavigation(currentUrl);
});

addBtn.addEventListener('click', () => {
    const currentUrl = urlInput.value;
    if (bookmarks.some(b => b.url === currentUrl)) return;
    const title = nameInput.value || "New Bookmark";
    bookmarks.push({ title, url: currentUrl });
    localStorage.setItem("bookmarks", JSON.stringify(bookmarks));
    renderBookmarks();
    updateButtonUI(currentUrl);
});

cancelBtn.addEventListener('click', () => {
    const currentUrl = urlInput.value;
    bookmarks = bookmarks.filter(b => b.url !== currentUrl);
    localStorage.setItem("bookmarks", JSON.stringify(bookmarks));
    renderBookmarks();
    updateButtonUI(currentUrl);
});

function renderBookmarks() {
    bookmarkBar.innerHTML = '';
    if (bookmarks.length > 0) {
        bookmarkBar.style.display = 'flex';
        bookmarks.forEach(bm => {
            const item = createBookmarkElement(bm.title, bm.url);
            bookmarkBar.appendChild(item);
        });
    } else {
        bookmarkBar.style.display = 'none';
    }
    syncViewWithUI();
}

// adblock icon behaviour: toggle blocking on/off and update badge
const adblockBadge = document.getElementById('adblock-badge');
function updateAdblockBadge() {
    if (!adblockBadge) return;
    if (!adblockEnabled) {
        adblockBadge.textContent = '0';
        return;
    }
    if (window.electronAPI && window.electronAPI.getAdblockStats) {
        window.electronAPI.getAdblockStats().then((stats) => {
            adblockBadge.textContent = stats && stats.blocked ? stats.blocked : '0';
        }).catch(() => {
            adblockBadge.textContent = '0';
        });
    } else {
        adblockBadge.textContent = '0';
    }
}

if (adblockBtn) {
    adblockBtn.addEventListener('click', () => {
        adblockEnabled = !adblockEnabled;
        if (window.electronAPI && window.electronAPI.setSetting) {
            window.electronAPI.setSetting('adblockEnabled', adblockEnabled);
        } else {
            localStorage.setItem('adblockEnabled', adblockEnabled);
        }
        updateAdblockUI();
        updateAdblockBadge();
    });
}

if (sidebarToggleBtn && sidebar) {
    sidebarToggleBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const isClosed = sidebar.style.display === "none";
        sidebar.style.display = isClosed ? "flex" : "none";
        syncViewWithUI();
    });
}

function createBookmarkElement(title, url) {
    const item = document.createElement('div');
    item.id = 'bookmark-item';
    const favicon = document.createElement('img');
    favicon.src = `https://www.google.com/s2/favicons?sz=64&domain=${getDomain(url)}`;
    const titleSpan = document.createElement('span');
    titleSpan.textContent = title;
    item.addEventListener('click', () => {
        urlInput.value = url;
        navigate();
    });
    item.appendChild(favicon);
    item.appendChild(titleSpan);
    return item;
}

urlInput.addEventListener("keydown", (e) => { if (e.key === "Enter") navigate(); });

const toggleDropdown = (dropdown) => {
    const isVisible = dropdown.style.display === "block";
    [menuDropdown, bookmarkDropdown].forEach(d => d.style.display = "none");
    dropdown.style.display = isVisible ? "none" : "block";
    syncViewWithUI();
};

menuButton.addEventListener("click", (e) => {
    e.stopPropagation();
    const rect = menuButton.getBoundingClientRect();
    const bounds = {
        left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height
    };
    window.electronAPI.openMenuDropdown(bounds);
});
bookmarkButton.addEventListener("click", (e) => {
    e.stopPropagation();
    const rect = bookmarkButton.getBoundingClientRect();
    const bounds = {
        left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height
    };
    window.electronAPI.openBookmarkDropdown(bounds);
});

// In-page menu item handlers (for dropdown inside main window)
const inNewWindow = document.getElementById('new-window');
const inEnableTor = document.getElementById('enable-tor');
const inSharePage = document.getElementById('share-page');
const inPrintPage = document.getElementById('print-page');
const inPasswords = document.getElementById('passwords');
const inHistory = document.getElementById('history');
const inBookmarks = document.getElementById('bookmarks');
const inExtensions = document.getElementById('extensions');
const inNuke = document.getElementById('nuke-data');
const inHelp = document.getElementById('help');
const inSettings = document.getElementById('settings');
const inShareWave = document.getElementById('share-wave');

inNewWindow?.addEventListener('click', (e) => { e.stopPropagation(); window.electronAPI.openNewWindow(); });
inEnableTor?.addEventListener('click', (e) => { e.stopPropagation(); try { window.electronAPI.menuAction({ action: 'toggle-tor' }); } catch (err) { console.error(err); } });
inSharePage?.addEventListener('click', (e) => { e.stopPropagation(); try { if (window.clipboardAPI && window.clipboardAPI.copyText) window.clipboardAPI.copyText(urlInput.value || ''); else window.electronAPI.menuAction({ action: 'share-page' }); } catch (err) { console.error(err); } });
inPrintPage?.addEventListener('click', (e) => { e.stopPropagation(); window.electronAPI.menuAction({ action: 'print-page' }); });
inPasswords?.addEventListener('click', (e) => { e.stopPropagation(); window.electronAPI.menuAction({ action: 'open-manager', manager: 'passwords' }); });
inHistory?.addEventListener('click', (e) => { e.stopPropagation(); window.electronAPI.menuAction({ action: 'open-manager', manager: 'history' }); });
inBookmarks?.addEventListener('click', (e) => { e.stopPropagation(); window.electronAPI.menuAction({ action: 'open-manager', manager: 'bookmarks' }); });
inExtensions?.addEventListener('click', (e) => { e.stopPropagation(); window.electronAPI.menuAction({ action: 'open-manager', manager: 'extensions' }); });
inNuke?.addEventListener('click', (e) => { e.stopPropagation(); if (confirm('Open First‑Run Setup?')) window.electronAPI.menuAction({ action: 'open-url', url: 'navigator://onboarding' }); });
inHelp?.addEventListener('click', (e) => { e.stopPropagation(); window.electronAPI.menuAction({ action: 'open-url', url: 'https://docs.cheeter.de/navigator' }); });
inSettings?.addEventListener('click', (e) => { e.stopPropagation(); window.electronAPI.menuAction({ action: 'open-settings' }); });
inShareWave?.addEventListener('click', (e) => { e.stopPropagation(); try { if (window.clipboardAPI && window.clipboardAPI.copyText) window.clipboardAPI.copyText('https://navigator.cheeter.de'); else window.electronAPI.menuAction({ action: 'share-url', url: 'https://navigator.cheeter.de' }); } catch (err) { console.error(err); } });

window.addEventListener("click", (e) => {
    if (!e.target.closest('.dropdown') && !e.target.closest('.headerbtn')) {
        [menuDropdown, bookmarkDropdown].forEach(d => d.style.display = "none");
        syncViewWithUI();
    }
});

window.addEventListener('resize', syncViewWithUI);

// Start
renderBookmarks();
createNewTab();

setTimeout(() => {
    window.electronAPI.getWindowTabs?.();
}, 100);

// --- Sidebar Apps Logic ---
const AVAILABLE_APPS = {
    "ab_ftp": { name: "Arquivo FTP", url: "https://arquivo.cheeter.de/ftp", icon: "icon-arquivo-ftp", cat: "arquivo" },
    "ab_photos": { name: "Arquivo Photos", url: "https://arquivo.cheeter.de/photos", icon: "icon-arquivo-photos", cat: "arquivo" },
    "ab_tv": { name: "Arquivo TV", url: "https://arquivo.cheeter.de/tv", icon: "icon-arquivo-tv", cat: "arquivo" },
    "ia_mail": { name: "Mail", url: "https://mail.cheeter.de", panelUrl: "mail/index.html", icon: "icon-mail", cat: "integrated" },
    "ia_contacts": { name: "Contacts", url: "https://contacts.cheeter.de", icon: "icon-contacts", cat: "integrated" },
    "ia_calendar": { name: "Calendar", url: "https://calendar.cheeter.de", icon: "icon-calendar", cat: "integrated" },
    "ia_notes": { name: "Notes", url: "https://notes.cheeter.de", icon: "icon-notes", cat: "integrated" },
    "ia_rss": { name: "RSS Settings", url: "https://rss.cheeter.de", panelUrl: "rss/index.html?mode=settings", icon: "icon-rss", cat: "integrated" },
    "tp_discord": { name: "Discord", url: "https://discord.com/app", icon: "favicon", domain: "discord.com", cat: "thirdparty" },
    "tp_mastodon": { name: "Mastodon", url: "https://mastodon.social", icon: "favicon", domain: "mastodon.social", cat: "thirdparty" }
};

function ensureRssSidebarApp(selectedAppIds) {
    const list = Array.isArray(selectedAppIds) ? [...selectedAppIds] : [];
    if (!list.includes("ia_rss")) list.push("ia_rss");
    return list;
}

function renderSidebarApps(selectedAppIds) {
    if (!sidebar) return;

    // Clear everything except #home
    const homeBtn = document.getElementById("home");
    sidebar.innerHTML = "";
    if (homeBtn) sidebar.appendChild(homeBtn);

    const normalizedAppIds = ensureRssSidebarApp(selectedAppIds);
    if (normalizedAppIds.length === 0) return;

    // Group selected apps by category to insert separators
    const grouped = { arquivo: [], integrated: [], thirdparty: [] };
    normalizedAppIds.forEach(id => {
        const app = AVAILABLE_APPS[id];
        if (app) {
            grouped[app.cat].push({ id, ...app });
        }
    });

    let isFirstGroup = true;
    const catKeys = ["arquivo", "integrated", "thirdparty"];

    const initialHr = document.createElement("hr");
    initialHr.style = "width: 80%; border-color: var(--border-color); margin: 8px 0; border-top: none; border-left: none; border-right: none;";
    sidebar.appendChild(initialHr);

    catKeys.forEach(cat => {
        const apps = grouped[cat];
        if (apps.length > 0) {
            // Add separator if it is not the very first group
            if (!isFirstGroup) {
                const hr = document.createElement("hr");
                hr.style = "width: 80%; border-color: var(--border-color); margin: 8px 0; border-top: none; border-left: none; border-right: none;";
                sidebar.appendChild(hr);
            }
            isFirstGroup = false;

            apps.forEach(app => {
                const btn = document.createElement("button");
                btn.className = "headerbtn";
                btn.title = app.name;
                btn.style = "justify-content: center; padding: 6px; border-radius: 8px; width: 100%; display: flex; align-items: center; margin-top: 4px;";

                let iconHtml = "";
                if (app.cat === "thirdparty" || app.icon === "favicon") {
                    const faviconUrl = `https://www.google.com/s2/favicons?domain=${app.domain}&sz=64`;
                    iconHtml = `<img src="${faviconUrl}" style="width: 20px; height: 20px; object-fit: contain; border-radius: 4px;">`;
                } else {
                    iconHtml = `<svg class="icon" style="width: 20px; height: 20px;"><use href="#${app.icon}"></use></svg>`;
                }

                btn.innerHTML = iconHtml;
                btn.addEventListener("click", () => {
                    if (app.panelUrl && window.electronAPI && window.electronAPI.toggleThirdPartyPanel) {
                        window.electronAPI.toggleThirdPartyPanel({ appId: app.id, panelUrl: app.panelUrl });
                    } else if (app.cat === "thirdparty" && window.electronAPI && window.electronAPI.toggleThirdPartyPanel) {
                        window.electronAPI.toggleThirdPartyPanel({ appId: app.id, url: app.url });
                    } else {
                        requestNavigation(app.url);
                    }
                });
                sidebar.appendChild(btn);
            });
        }
    });
}

// Load and apply sidebar apps on start
if (window.electronAPI && window.electronAPI.getSettings) {
    window.electronAPI.getSettings().then(s => {
        renderSidebarApps(s && s.sidebarApps ? s.sidebarApps : []);
    }).catch(() => { });

    if (window.electronAPI.onSettingsUpdated) {
        window.electronAPI.onSettingsUpdated(s => {
            renderSidebarApps(s && s.sidebarApps ? s.sidebarApps : []);
        });
    }
}
