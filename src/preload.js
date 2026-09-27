const { contextBridge, ipcRenderer } = require('electron');

// SECURITY: Helper to prevent listener accumulation (memory leak)
// Each call removes the previous listener for the channel before adding a new one.
function safeOn(channel, handler) {
    ipcRenderer.removeAllListeners(channel);
    ipcRenderer.on(channel, handler);
}

function isTrustedOrigin() {
    try {
        const { protocol, hostname } = window.location;
        // Trusted if it's a local file: protocol (used in production for local HTML files)
        if (protocol === 'file:') {
            return true;
        }
        // Trusted if it's running on localhost/127.0.0.1 (used in development)
        if (hostname === 'localhost' || hostname === '127.0.0.1') {
            return true;
        }
        // Trusted if it's cheeter.de or a subdomain of cheeter.de
        const lowerHost = hostname.toLowerCase();
        if (lowerHost === 'cheeter.de' || lowerHost.endsWith('.cheeter.de')) {
            return true;
        }
    } catch (e) {
        // Fallback to false on any exception
    }
    return false;
}

if (isTrustedOrigin()) {
    contextBridge.exposeInMainWorld('electronAPI', {
        navigateTo: (data) => ipcRenderer.send('navigate-to', data),
        browserControl: (action) => ipcRenderer.send('browser-control', action),
        syncViewBounds: (data) => ipcRenderer.send('sync-view-bounds', data),
        toggleThirdPartyPanel: (data) => ipcRenderer.send('toggle-third-party-panel', data),
        fetchRssFeed: (url) => ipcRenderer.invoke('fetch-rss-feed', url),
        connectMailAccount: (account) => ipcRenderer.invoke('connect-mail-account', account),
        onPanelStateChanged: (callback) => safeOn('panel-state-changed', (e, data) => callback(data)),
        onNavigated: (callback) => safeOn('on-navigated', (e, url) => callback(url)),
        onTitleChanged: (callback) => safeOn('on-title-changed', (e, title) => callback(title)),
        openNewWindow: () => ipcRenderer.send('new-window'),
        openBookmarkDropdown: (bounds) => ipcRenderer.send('bookmark', bounds),
        openMenuDropdown: (bounds) => ipcRenderer.send('menu', bounds),
        windowControl: (action) => ipcRenderer.send('window-control', action),
        setCurrentUrl: (url, title) => ipcRenderer.send('set-current-url', { url, title }),
        onCurrentUrlUpdated: (callback) => safeOn('current-url-updated', (e, data) => callback(data)),
        addBookmark: (url, title) => ipcRenderer.send('add-bookmark', { url, title }),
        removeBookmark: (url) => ipcRenderer.send('remove-bookmark', { url }),
        onBookmarkAdded: (callback) => safeOn('bookmark-added', (e, data) => callback(data)),
        onBookmarkRemoved: (callback) => safeOn('bookmark-removed', (e, data) => callback(data)),
        switchTab: (data) => ipcRenderer.send('switch-tab', data),
        closeTab: (data) => ipcRenderer.send('close-tab', data),
        getWindowTabs: () => ipcRenderer.send('get-window-tabs'),
        reorderTabs: (order) => ipcRenderer.send('reorder-tabs', order),
        splitTabs: (data) => ipcRenderer.send('split-tabs', data),
        groupTabs: (data) => ipcRenderer.send('group-tabs', data),
        showTabContextMenu: (data) => ipcRenderer.send('show-tab-context-menu', data),
        onGroupUpdated: (callback) => safeOn('group-updated', (e, data) => callback(data)),
        onAskTabGroupName: (callback) => safeOn('ask-tab-group-name', (e, data) => callback(data)),
        onSplitUpdated: (callback) => safeOn('split-updated', (e, data) => callback(data)),
        onTabsUpdated: (callback) => safeOn('tabs-updated', (e, data) => callback(data)),
        onUpdateTab: (callback) => safeOn('update-tab', (e, data) => callback(data)),
        onNewTabRequest: (callback) => safeOn('new-tab-request', () => callback()),
        onSwitchTabRequest: (callback) => safeOn('switch-tab-request', (e, data) => callback(data)),
        menuAction: (data) => ipcRenderer.send('menu-action', data),
        onMenuContext: (callback) => safeOn('menu-context', (e, data) => callback(data)),
        onTorStatus: (callback) => safeOn('tor-status', (e, data) => callback(data)),
        onNavigateToUrl: (callback) => safeOn('navigate-to-url', (e, data) => callback(data)),
        onOpenSettingsRequest: (callback) => safeOn('open-settings-request', () => callback()),
        // Settings + Session
        getSettings: () => ipcRenderer.invoke('get-settings'),
        setSetting: (key, value) => ipcRenderer.send('set-setting', { key, value }),
        onSettingsUpdated: (callback) => safeOn('settings-updated', (e, data) => callback(data)),
        onRestoreSession: (callback) => safeOn('restore-session', (e, data) => callback(data)),
        // Adblocker helpers
        // toggle handled by setSetting; badge data retrieved with getAdblockStats
        onAdblockStatus: (callback) => safeOn('adblock-status', (e, val) => callback(val)),
        onAdblockStatsUpdated: (callback) => safeOn('adblock-stats-updated', (e, stats) => callback(stats)),
        getAdblockStats: () => ipcRenderer.invoke('get-adblock-stats'),
        onKeyPassXCStatus: (callback) => safeOn('keypassxc-status', (e, status) => callback(status)),
        getKeyPassXCStatus: () => ipcRenderer.invoke('get-keypassxc-status'),
        getKeyPassXCEntries: () => ipcRenderer.invoke('get-keypassxc-entries'),
        // App info
        getAppVersion: () => ipcRenderer.invoke('get-app-version'),
        completeFirstRun: () => ipcRenderer.send('complete-onboarding'),
        // Manipulation (background bots)
        startManipulation: () => ipcRenderer.send('start-manipulation'),
        stopManipulation: () => ipcRenderer.send('stop-manipulation'),
        onManipulationStatus: (callback) => safeOn('manipulation-status', (e, d) => callback(d)),
        // Authentication for settings
        authenticate: (password) => ipcRenderer.invoke('authenticate', password),
        isAuthenticated: () => ipcRenderer.invoke('is-authenticated'),
        onAuthRequired: (callback) => safeOn('auth-required', () => callback()),
        closeOverlay: () => ipcRenderer.send('close-overlay'),
        // SECURITY: Platform info exposed via IPC invoke instead of directly
        // exposing process.platform (which leaks Node.js internals to renderer)
        getPlatform: () => (typeof process !== 'undefined' ? process.platform : '')
    });

    // backward-compatible clipboard helper
    contextBridge.exposeInMainWorld('clipboardAPI', {
        copyText: (text) => ipcRenderer.send('copy-text', text)
    });
} else {
    console.warn(`[Security] IPC APIs blocked for untrusted origin: ${window.location.href}`);
}