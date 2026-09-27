// Get all button elements
const newWindowBtn = document.getElementById("new-window");
const newTabBtn = document.getElementById("new-tab");
const enableTorBtn = document.getElementById("enable-tor");
const sharePageBtn = document.getElementById("share-page");
const printPageBtn = document.getElementById("print-page");
const passwordsBtn = document.getElementById("passwords");
const historyBtn = document.getElementById("history");
const bookmarksBtn = document.getElementById("bookmarks");
const extensionsBtn = document.getElementById("extensions");
const nukeDataBtn = document.getElementById("nuke-data");
const helpBtn = document.getElementById("help");
const settingsBtn = document.getElementById("settings");
const shareWaveBtn = document.getElementById("share-wave");
const enableKeyPassXCBtn = document.getElementById("enable-keypassxc");
const autofillKeyPassXCBtn = document.getElementById("autofill-keypassxc");

let menuContext = {};
let sourceWindowId = null;

// Listen for menu context from main process
if (window.electronAPI && window.electronAPI.onMenuContext) {
    window.electronAPI.onMenuContext((data) => {
        menuContext = data || {};
        sourceWindowId = data?.sourceId;

        if (enableTorBtn) {
            const enabled = !!menuContext.torEnabled;
            enableTorBtn.innerHTML = `<svg class="icon"><use href="#icon-${enabled ? "vpn_lock" : "vpn_key"}"></use></svg> ${enabled ? "Disable TOR" : "Enable TOR"}`;
        }
    });
}

// Helper: Close menu
function closeMenu() {
    window.close();
}

// Button handlers
newWindowBtn?.addEventListener("click", (e) => {
    if (e && e.preventDefault) e.preventDefault();
    try {
        if (!window.electronAPI || !window.electronAPI.openNewWindow) throw new Error('electronAPI.openNewWindow missing');
        window.electronAPI.openNewWindow();
    } catch (e) {
        console.error('newWindow error', e);
    }
    closeMenu();
});

newTabBtn?.addEventListener("click", (e) => {
    if (e && e.preventDefault) e.preventDefault();
    try {
        if (!window.electronAPI || !window.electronAPI.menuAction) throw new Error('electronAPI.menuAction missing');
        window.electronAPI.menuAction({ action: 'new-tab' });
    } catch (e) {
        console.error('newTab error', e);
    }
    closeMenu();
});

enableTorBtn?.addEventListener("click", (e) => {
    if (e && e.preventDefault) e.preventDefault();
    try {
        window.electronAPI.menuAction({ action: 'toggle-tor' });
    } catch (e) { console.error('toggle-tor error', e); }
    closeMenu();
});

enableKeyPassXCBtn?.addEventListener("click", (e) => {
    if (e && e.preventDefault) e.preventDefault();
    try {
        window.electronAPI.menuAction({ action: 'toggle-keypassxc' });
    } catch (e) { console.error('toggle-keypassxc error', e); }
    closeMenu();
});

autofillKeyPassXCBtn?.addEventListener("click", (e) => {
    if (e && e.preventDefault) e.preventDefault();
    try {
        window.electronAPI.menuAction({ action: 'keypassxc-autofill' });
    } catch (e) { console.error('keypassxc-autofill error', e); }
    closeMenu();
});

sharePageBtn?.addEventListener("click", (e) => {
    if (e && e.preventDefault) e.preventDefault();
    try {
        // prefer copying via clipboardAPI if available
        const urlToCopy = (menuContext && menuContext.currentUrl) || '';
        if (window.clipboardAPI && window.clipboardAPI.copyText) {
            window.clipboardAPI.copyText(urlToCopy);
        } else {
            window.electronAPI.menuAction({ action: 'share-page' });
        }
    } catch (e) { console.error('share-page error', e); }
    closeMenu();
});

printPageBtn?.addEventListener("click", (e) => {
    if (e && e.preventDefault) e.preventDefault();
    try { window.electronAPI.menuAction({ action: 'print-page' }); } catch (e) { console.error('print-page error', e); }
    closeMenu();
});

passwordsBtn?.addEventListener("click", (e) => {
    if (e && e.preventDefault) e.preventDefault();
    try { window.electronAPI.menuAction({ action: 'open-manager', manager: 'passwords' }); } catch (e) { console.error('passwords error', e); }
    closeMenu();
});

historyBtn?.addEventListener("click", (e) => {
    if (e && e.preventDefault) e.preventDefault();
    try { window.electronAPI.menuAction({ action: 'open-settings', section: 'history' }); } catch (e) { console.error('history error', e); }
    closeMenu();
});

bookmarksBtn?.addEventListener("click", (e) => {
    if (e && e.preventDefault) e.preventDefault();
    try { window.electronAPI.menuAction({ action: 'open-settings', section: 'bookmarks' }); } catch (e) { console.error('bookmarks error', e); }
    closeMenu();
});

extensionsBtn?.addEventListener("click", (e) => {
    if (e && e.preventDefault) e.preventDefault();
    try { window.electronAPI.menuAction({ action: 'open-settings', section: 'extensions' }); } catch (e) { console.error('extensions error', e); }
    closeMenu();
});

nukeDataBtn?.addEventListener("click", (e) => {
    if (e && e.preventDefault) e.preventDefault();
    if (confirm('This will delete ALL Navigator data and restart the app. Continue?')) {
        try { window.electronAPI.menuAction({ action: 'nuke-data' }); } catch (e) { console.error('nuke-data error', e); }
    }
    closeMenu();
});

helpBtn?.addEventListener("click", (e) => {
    if (e && e.preventDefault) e.preventDefault();
    try { window.electronAPI.menuAction({ action: 'open-url', url: 'https://docs.cheeter.de/navigator' }); } catch (e) { console.error('help error', e); }
    closeMenu();
});

settingsBtn?.addEventListener("click", (e) => {
    if (e && e.preventDefault) e.preventDefault();
    try { window.electronAPI.menuAction({ action: 'open-settings' }); } catch (e) { console.error('settings error', e); }
    closeMenu();
});

shareWaveBtn?.addEventListener("click", (e) => {
    if (e && e.preventDefault) e.preventDefault();
    try {
        if (window.clipboardAPI && window.clipboardAPI.copyText) {
            window.clipboardAPI.copyText('https://navigator.cheeter.de');
        } else {
            window.electronAPI.menuAction({ action: 'share-url', url: 'https://navigator.cheeter.de' });
        }
    } catch (e) { console.error('share-url error', e); }
    closeMenu();
});
