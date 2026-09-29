import { app, BrowserWindow, ipcMain, Menu, WebContentsView, dialog, shell, clipboard } from "electron";
import net from "node:net";
import tls from "node:tls";
import path from "node:path";
import { pathToFileURL } from "node:url";
import crypto from "node:crypto";
import fs from "node:fs";
import { spawn } from "node:child_process";

function getRendererAssetPath(assetPath) {
  const rendererDirectory = path.resolve(
    app.getAppPath(),
    ".vite",
    "renderer",
    MAIN_WINDOW_VITE_NAME,
  );
  const resolvedPath = path.resolve(rendererDirectory, assetPath);
  const relativePath = path.relative(rendererDirectory, resolvedPath);

  if (relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    throw new Error(`Renderer asset path is outside the renderer directory: ${assetPath}`);
  }
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Renderer asset not found: ${resolvedPath}`);
  }

  return resolvedPath;
}

function getRendererAssetUrl(assetPath, suffix = "") {
  return `${pathToFileURL(getRendererAssetPath(assetPath)).href}${suffix}`;
}

function isSettingsPageUrl(url) {
  try {
    const pathname = new URL(url).pathname.replace(/\\/g, "/");
    return pathname.endsWith("/settings/index.html") || pathname.includes("/public/settings/");
  } catch {
    return false;
  }
}

// SECURITY: Validate sender origin for all IPC handlers
const originalOn = ipcMain.on;
const originalHandle = ipcMain.handle;

function isSenderTrusted(event) {
  if (!event || !event.sender) return false;
  // Use senderFrame.url if available, falling back to sender.getURL()
  const url = event.senderFrame?.url || (event.sender.getURL ? event.sender.getURL() : "");
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "file:") return true;
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === "localhost" || hostname === "127.0.0.1") return true;
    if (hostname === "cheeter.de" || hostname.endsWith(".cheeter.de")) return true;
  } catch (e) {
    return false;
  }
  return false;
}

ipcMain.on = function (channel, listener) {
  return originalOn.call(ipcMain, channel, (event, ...args) => {
    const isAdblock = typeof channel === "string" && channel.startsWith("@ghostery/adblocker/");
    if (!isAdblock && !isSenderTrusted(event)) {
      console.warn(`[Security] IPC message on channel "${channel}" blocked from untrusted sender: ${event?.sender?.getURL()}`);
      return;
    }
    return listener(event, ...args);
  });
};

ipcMain.handle = function (channel, listener) {
  return originalHandle.call(ipcMain, channel, (event, ...args) => {
    const isAdblock = typeof channel === "string" && channel.startsWith("@ghostery/adblocker/");
    if (!isAdblock && !isSenderTrusted(event)) {
      console.warn(`[Security] IPC invoke on channel "${channel}" blocked from untrusted sender: ${event?.sender?.getURL()}`);
      throw new Error("Access denied");
    }
    return listener(event, ...args);
  });
};

function registerShortcutHandlers(win, webContents, isTab = false) {
  webContents.on("before-input-event", (event, input) => {
    if (webContents.isDestroyed() || win.isDestroyed()) return;
    const isMac = process.platform === "darwin";
    const cmdOrCtrl = isMac ? input.meta : input.control;

    if (!win._keysDown) win._keysDown = new Set();
    if (input.type === "keyDown") win._keysDown.add(input.key);
    else if (input.type === "keyUp") win._keysDown.delete(input.key);

    if (input.type !== "keyDown") return;

    const isKeyI = input.code === "KeyI" || input.key.toLowerCase() === "i";

    // Cmd+Alt+Shift+I -> Open DevTools of the Browser UI (Shell)
    if (cmdOrCtrl && input.shift && input.alt && isKeyI) {
      if (!win.isDestroyed()) {
        win.webContents.openDevTools({ mode: "detach" });
      }
      event.preventDefault();
      return;
    }

    // Cmd+Alt+I -> Open DevTools of the active tab (Web Page)
    if (cmdOrCtrl && !input.shift && input.alt && isKeyI) {
      if (isTab) {
        if (!webContents.isDestroyed()) {
          webContents.openDevTools({ mode: "detach" });
        }
      } else {
        const tabs = windowTabs.get(win);
        const activeTabIdForWin = activeTabId.get(win);
        const activeTab = tabs?.find((t) => t.id === activeTabIdForWin);
        if (activeTab?.view && !activeTab.view.webContents.isDestroyed()) {
          activeTab.view.webContents.openDevTools({ mode: "detach" });
        }
      }
      event.preventDefault();
      return;
    }

    // Cmd+H + Backspace/Delete -> Clear history
    try {
      const deleteHeld = win._keysDown.has("Delete") || win._keysDown.has("Backspace") || win._keysDown.has("Del");
      if (input.key.toLowerCase() === "h" && cmdOrCtrl && deleteHeld) {
        try {
          settings.history = [];
          saveSettings();
          BrowserWindow.getAllWindows().forEach((w) => {
            if (!w.isDestroyed()) w.webContents.send("settings-updated", settings);
          });
        } catch (e) {
          console.error("[shortcut] failed to clear history", e);
        }
        event.preventDefault();
      }
    } catch (e) { }
  });
}

import { AdblockerManager } from "./adblocker/index.js";

let mainWindow;
let bookmarkWindow;
let menuWindow;
let windowTabs = new Map();
let overlayViewMap = new Map();
let activeTabId = new Map();
let currentUrl = "";
let currentTitle = "";
let tabIdCounter = 0;

let adblockEnabled = false;

let adblockerManager = null;

let spoofingEnabled = false;
let spoofingBrowser = "Chrome";
let spoofingDevice = "Desktop-Windows";
let spoofingMode = "light";

const SPOOF_UA = {
  Chrome: {
    "Desktop-Windows": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36",
    "Desktop-MacOS": "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36",
    "Desktop-Linux": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36",
    "Mobile-Android": "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36",
    "Mobile-iOS": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/114.0.0.0 Mobile/15E148 Safari/604.1"
  },
  Firefox: {
    "Desktop-Windows": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:114.0) Gecko/20100101 Firefox/114.0",
    "Desktop-MacOS": "Mozilla/5.0 (Macintosh; Intel Mac OS X 13.5; rv:114.0) Gecko/20100101 Firefox/114.0",
    "Desktop-Linux": "Mozilla/5.0 (X11; Linux x86_64; rv:114.0) Gecko/20100101 Firefox/114.0",
    "Mobile-Android": "Mozilla/5.0 (Android 14; Mobile; rv:114.0) Gecko/114.0 Firefox/114.0",
    "Mobile-iOS": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/114.0 Mobile/15E148 Safari/605.1.15"
  },
  Safari: {
    "Desktop-Windows": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.4 Safari/605.1.15",
    "Desktop-MacOS": "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.4 Safari/605.1.15",
    "Desktop-Linux": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.4 Safari/605.1.15",
    "Mobile-Android": "Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.4 Safari/605.1.15",
    "Mobile-iOS": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
  },
  Edge: {
    "Desktop-Windows": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36 Edg/114.0.1823.67",
    "Desktop-MacOS": "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36 Edg/114.0.1823.67",
    "Desktop-Linux": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36 Edg/114.0.1823.67",
    "Mobile-Android": "Mozilla/5.0 (Linux; Android 14; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36 EdgA/114.0.1823.67",
    "Mobile-iOS": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) EdgiOS/114.0.1823.67 Mobile/15E148 Safari/605.1.15"
  }
};

function getSpoofedUserAgent() {
  if (!spoofingEnabled) return null;
  const b = spoofingBrowser || "Chrome";
  const d = spoofingDevice || "Desktop-Windows";
  let ua = (SPOOF_UA[b] && SPOOF_UA[b][d]) ? SPOOF_UA[b][d] : null;
  if (!ua) {
    try { ua = BrowserWindow.getAllWindows()[0]?.webContents.getUserAgent(); } catch (e) { }
  }
  if (!ua) ua = "";
  if (spoofingMode === 'dark') ua += " DarkMode";
  else if (spoofingMode === 'light') ua += " LightMode";
  return ua;
}

function applySpoofingToView(view) {
  if (!view || !view.webContents || view.webContents.isDestroyed()) return;

  try {
    if (!view._originalUA) {
      view._originalUA = view.webContents.getUserAgent();
    }
  } catch (e) { }

  const ua = getSpoofedUserAgent();
  if (ua && spoofingEnabled) {
    try { view.webContents.setUserAgent(ua); } catch (e) { }
  } else if (view._originalUA) {
    try { view.webContents.setUserAgent(view._originalUA); } catch (e) { }
  }

  if (!view._spoofListenerAdded) {
    view._spoofListenerAdded = true;
    view.webContents.on('dom-ready', () => {
      try {
        const dark = spoofingMode === 'dark';
        const script = `(function(){const orig=window.matchMedia.bind(window);window.matchMedia=function(q){if(q==='(prefers-color-scheme: dark)'){return {matches:${dark},media:q,addListener:()=>{},removeListener:()=>{}};}return orig(q);};})();`;
        view.webContents.executeJavaScript(script).catch(() => { });
      } catch (e) { }
    });
  }
}

function applySpoofingToAllViews() {
  windowTabs.forEach((tabs) => {
    tabs.forEach((t) => {
      if (t.view && t.view.webContents && !t.view.webContents.isDestroyed()) {
        applySpoofingToView(t.view);
        if (spoofingEnabled) {
          try { t.view.webContents.reload(); } catch (e) { }
        }
      }
    });
  });
}

function setSpoofingEnabled(val) {
  spoofingEnabled = !!val;
  applySpoofingToAllViews();

  windowTabs.forEach((tabs) => {
    tabs.forEach((t) => {
      if (t.view && t.view.webContents && !t.view.webContents.isDestroyed()) {
        try { t.view.webContents.reload(); } catch (e) { }
      }
    });
  });
}

function setSpoofingOption(key, value) {
  if (key === 'spoofingBrowser') spoofingBrowser = value;
  else if (key === 'spoofingDevice') spoofingDevice = value;
  else if (key === 'spoofingMode') spoofingMode = value;
  if (spoofingEnabled) applySpoofingToAllViews();
}

async function applyAdblockToSession(session) {
  try {
    if (!adblockerManager) return;
    if (adblockEnabled) {
      await adblockerManager.enableSession(session);
    } else {
      await adblockerManager.disableSession(session);
    }
  } catch (e) {
    console.error("[adblocker] failed to apply to session", e);
  }
}

function applyAdblockToAllViews() {
  windowTabs.forEach((tabs, win) => {
    tabs.forEach((t) => {
      if (t.view && t.view.webContents && !t.view.webContents.isDestroyed()) {
        applyAdblockToSession(t.view.webContents.session);
      }
    });
  });
}

async function isKeepassxcAvailable() {
  return new Promise((resolve) => {
    try {
      const child = spawn('keepassxc-cli', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let finished = false;
      child.on('error', () => {
        if (!finished) { finished = true; resolve(false); }
      });
      child.on('close', (code) => {
        if (!finished) { finished = true; resolve(code === 0); }
      });
      setTimeout(() => {
        if (!finished) {
          finished = true;
          try { child.kill(); } catch (e) { }
          resolve(false);
        }
      }, 2500);
    } catch (e) {
      resolve(false);
    }
  });
}

function broadcastKeyPassXCStatus() {
  BrowserWindow.getAllWindows().forEach((w) => {
    if (!w.isDestroyed()) {
      w.webContents.send('keypassxc-status', { enabled: keyPassXCEnabled });
    }
  });
}

async function setKeyPassXCEnabled(val) {
  keyPassXCEnabled = !!val;
  settings.keyPassXCEnabled = keyPassXCEnabled;
  saveSettings();
  broadcastKeyPassXCStatus();

  if (keyPassXCEnabled) {
    BrowserWindow.getAllWindows().forEach((w) => {
      if (!w.isDestroyed()) {
        attemptFillFromKeyPassXC(w, { interactive: false });
      }
    });
  }
}

async function attemptFillFromKeyPassXC(win, { interactive = false } = {}) {
  if (!keyPassXCEnabled || !win || win.isDestroyed()) return;
  const activeTabIdForWin = activeTabId.get(win);
  const tabs = windowTabs.get(win) || [];
  const tab = tabs.find((t) => t.id === activeTabIdForWin);
  if (!tab || !tab.view || tab.view.webContents.isDestroyed()) return;

  const pageUrl = tab.url || tab.displayUrl || '';
  let hostname;
  try {
    hostname = new URL(pageUrl).hostname;
  } catch (e) {
    return;
  }
  if (!hostname) return;

  const dbPath = settings.keyPassXCDBPath || DEFAULT_KEYPASSXC_DB_PATH;
  const masterPassword = process.env.KEYPASSXC_MASTER_PASSWORD;
  if (!masterPassword) {
    if (interactive) {
      dialog.showMessageBox(win, {
        type: 'warning', title: 'KeyPassXC',
        message: 'KeyPassXC Master Password missing',
        detail: 'Set the environment variable KEYPASSXC_MASTER_PASSWORD to enable autofill.',
      });
    }
    return;
  }

  try {
    const child = spawn('keepassxc-cli', ['show', dbPath, hostname, '--quiet'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let error = '';
    child.stdin.write(masterPassword + '\n');
    child.stdin.end();

    child.stdout.on('data', (c) => { output += String(c); });
    child.stderr.on('data', (c) => { error += String(c); });

    child.on('close', (code) => {
      if (code !== 0 || !output.trim()) {
        if (interactive) {
          dialog.showMessageBox(win, {
            type: 'error', title: 'KeyPassXC',
            message: 'AutoFill failed',
            detail: error || `No entry for ${hostname} found.`,
          });
        }
        return;
      }

      let username = '';
      let password = '';
      const userMatch = output.match(/^User:\s*(.*)$/im);
      const passMatch = output.match(/^Password:\s*(.*)$/im);
      if (userMatch) username = userMatch[1].trim();
      if (passMatch) password = passMatch[1].trim();

      if (!username && !password) {
        if (interactive) {
          dialog.showMessageBox(win, {
            type: 'warning', title: 'KeyPassXC',
            message: `Entry found but couldn't parse credentials for ${hostname}.`,
            detail: output,
          });
        }
        return;
      }

      const safeUser = JSON.stringify(username);
      const safePass = JSON.stringify(password);
      const script = `(function(){
        try {
          const uname = ${safeUser};
          const pwd = ${safePass};
          const userInput = document.querySelector('input[type="email"], input[type="text"], input[name*="user" i], input[name*="login" i]');
          const passInput = document.querySelector('input[type="password"]');
          if (userInput && uname) userInput.focus(), userInput.value = uname, userInput.dispatchEvent(new Event('input', { bubbles: true }));
          if (passInput && pwd) passInput.focus(), passInput.value = pwd, passInput.dispatchEvent(new Event('input', { bubbles: true }));
          if (passInput) passInput.blur();
          return true;
        } catch (e) { return false; }
      })();`;

      tab.view.webContents.executeJavaScript(script).then(() => {
        if (interactive) {
          dialog.showMessageBox(win, { type: 'info', title: 'KeyPassXC', message: 'AutoFill applied', detail: `Credentials have been injected for ${hostname}.` });
        }
      }).catch((execError) => {
        console.error('[keypassxc] run script failed', execError);
      });
    });
  } catch (e) {
    console.error('[keypassxc] autofill error', e);
  }
}

async function attemptSaveToKeyPassXC(win, { interactive = false } = {}) {
  if (!keyPassXCEnabled || !win || win.isDestroyed()) return;
  const activeTabKey = activeTabId.get(win);
  const tabs = windowTabs.get(win) || [];
  const tab = tabs.find((t) => t.id === activeTabKey);
  if (!tab || !tab.view || tab.view.webContents.isDestroyed()) return;

  let pageUrl = tab.url || tab.displayUrl || '';
  try {
    const parsed = new URL(pageUrl);
    pageUrl = parsed.href;
  } catch (e) {
    if (interactive) {
      dialog.showMessageBox(win, { type: 'warning', title: 'KeyPassXC', message: 'Current tab is not a valid URL.' });
    }
    return;
  }

  const script = `(function(){
    const usernameEl = document.querySelector('input[type="email"], input[type="text"], input[name*="user" i], input[name*="login" i]');
    const passwordEl = document.querySelector('input[type="password"]');
    return {
      username: usernameEl ? usernameEl.value : '',
      password: passwordEl ? passwordEl.value : ''
    };
  })();`;

  let credentials;
  try {
    credentials = await tab.view.webContents.executeJavaScript(script, true);
  } catch (err) {
    console.error('[keypassxc] failed to read credentials from page', err);
    if (interactive) {
      dialog.showMessageBox(win, { type: 'error', title: 'KeyPassXC', message: 'Could not read login form from the page.' });
    }
    return;
  }

  if (!credentials || !credentials.username || !credentials.password) {
    if (interactive) {
      dialog.showMessageBox(win, { type: 'warning', title: 'KeyPassXC', message: 'Could not find username/password fields with values on page.' });
    }
    return;
  }

  const host = (new URL(pageUrl)).hostname;
  const cacheKey = `${host}::${credentials.username}::${credentials.password}`;
  if (keyPassXCLastSaved.get(host) === cacheKey) {
    return; // avoid duplicating frequent autosaves
  }

  const dbPath = settings.keyPassXCDBPath || DEFAULT_KEYPASSXC_DB_PATH;
  const masterPassword = process.env.KEYPASSXC_MASTER_PASSWORD;
  if (!masterPassword) {
    if (interactive) {
      dialog.showMessageBox(win, {
        type: 'warning', title: 'KeyPassXC',
        message: 'KeePassXC master password is not set',
        detail: 'Set KEYPASSXC_MASTER_PASSWORD environment variable.',
      });
    }
    return;
  }

  const entryName = `${host}/${pageUrl}`;

  try {
    // SECURITY: Pass credentials via stdin, not as CLI arguments (visible in process list)
    const child = spawn('keepassxc-cli', ['add', dbPath, entryName, '--username', credentials.username, '-q'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stdin.write(masterPassword + '\n');
    child.stdin.write(credentials.password + '\n');
    child.stdin.end();
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      if (code === 0) {
        keyPassXCLastSaved.set(host, cacheKey);
        if (interactive) {
          dialog.showMessageBox(win, { type: 'info', title: 'KeyPassXC', message: `Saved credentials for ${host} to KeePassXC.` });
        }
      } else if (stderr.toLowerCase().includes('entry already exists')) {
        // try to update existing entry
        // SECURITY: Pass credentials via stdin, not as CLI arguments
        const editChild = spawn('keepassxc-cli', ['edit', dbPath, entryName, '--username', credentials.username, '-q'], { stdio: ['pipe', 'pipe', 'pipe'] });
        let editErr = '';
        editChild.stdin.write(masterPassword + '\n');
        editChild.stdin.write(credentials.password + '\n');
        editChild.stdin.end();
        editChild.stderr.on('data', (d) => { editErr += d.toString(); });
        editChild.on('close', (editCode) => {
          if (editCode === 0) {
            keyPassXCLastSaved.set(host, cacheKey);
            if (interactive) {
              dialog.showMessageBox(win, { type: 'info', title: 'KeyPassXC', message: `Updated credentials for ${host} in KeePassXC.` });
            }
          } else if (interactive) {
            dialog.showMessageBox(win, { type: 'error', title: 'KeyPassXC', message: 'Failed to update KeePassXC entry', detail: editErr || `exit code ${editCode}` });
          }
        });
      } else if (interactive) {
        dialog.showMessageBox(win, { type: 'error', title: 'KeyPassXC', message: 'Failed to save to KeePassXC', detail: stderr || `exit code ${code}` });
      }
    });
  } catch (e) {
    console.error('[keypassxc] save error', e);
    if (interactive) {
      dialog.showMessageBox(win, { type: 'error', title: 'KeyPassXC', message: 'Failed to save credentials.', detail: String(e) });
    }
  }
}

async function autoSaveFromKeyPassXC(win) {
  if (!keyPassXCEnabled || !win || win.isDestroyed()) return;
  try {
    const activeTabKey = activeTabId.get(win);
    const tabs = windowTabs.get(win) || [];
    const tab = tabs.find((t) => t.id === activeTabKey);
    if (!tab || !tab.view || tab.view.webContents.isDestroyed()) return;

    const pageUrl = tab.url || tab.displayUrl || '';
    let hostname;
    try {
      hostname = new URL(pageUrl).hostname;
    } catch (e) {
      return;
    }
    if (!hostname) return;

    const script = `(function(){
      const usernameEl = document.querySelector('input[type="email"], input[type="text"], input[name*="user" i], input[name*="login" i]');
      const passwordEl = document.querySelector('input[type="password"]');
      return {
        username: usernameEl ? usernameEl.value : '',
        password: passwordEl ? passwordEl.value : ''
      };
    })();`;

    const credentials = await tab.view.webContents.executeJavaScript(script, true);
    if (!credentials || !credentials.username || !credentials.password) return;

    // Only auto-save if form has actual filled values and this is a new set
    const cacheKey = `${hostname}::${credentials.username}::${credentials.password}`;
    if (keyPassXCLastSaved.get(hostname) === cacheKey) return;

    await attemptSaveToKeyPassXC(win, { interactive: false });
  } catch (e) {
    console.error('[keypassxc] autoSave error', e);
  }
}

function broadcastAdblockStatus() {
  BrowserWindow.getAllWindows().forEach((w) => {
    if (!w.isDestroyed()) w.webContents.send("adblock-status", adblockEnabled);
  });
}

function setAdblockEnabled(val) {
  adblockEnabled = !!val;
  applyAdblockToAllViews();
  windowTabs.forEach((tabs) => {
    tabs.forEach((t) => {
      if (t.view && t.view.webContents && !t.view.webContents.isDestroyed()) {
        try {
          t.view.webContents.reload();
        } catch (e) { }
      }
    });
  });
  broadcastAdblockStatus();
}

function serializeTabs(tabs) {
  return (tabs || []).map((t) => ({ id: t.id, title: t.title, url: t.displayUrl || t.url, isManipulation: !!t.__isManipulation }));
}
function setWindowTitle(win, pageTitle, fallbackUrl) {
  if (!win || win.isDestroyed()) return;
  let name = pageTitle;
  if (!name && fallbackUrl) {
    try {
      name = new URL(fallbackUrl).hostname;
    } catch (e) { }
  }
  if (!name) name = "New Tab";
  try {
    win.setTitle(`${name} | Cheeter Navigator`);
  } catch (e) { }
}
let menuSourceMap = new Map();
let torEnabled = new Map();
let torOverlayMap = new Map();
let uiHeightMap = new Map();
let splitGroupsMap = new Map();
let tabGroupsMap = new Map();
let panelViewMap = new Map();
let panelAppMap = new Map();
let panelWidthMap = new Map();
const PANEL_VIEW_WIDTH = 400;

let keyPassXCEnabled = false;
const keyPassXCLastSaved = new Map();
const DEFAULT_KEYPASSXC_DB_PATH = process.env.KEYPASSXC_DB_PATH || path.join(app.getPath('home'), 'navigator.kdbx');

const DEFAULT_TOR_PROXY = process.env.TOR_PROXY || "socks5://127.0.0.1:9150";

function isTorProxyReachable(proxyUrl = DEFAULT_TOR_PROXY, timeout = 2200) {
  return new Promise((resolve) => {
    const match = proxyUrl.match(/^(?:socks5:\/\/)?([\d.]+):(\d+)$/i);
    if (!match) return resolve(false);

    const host = match[1];
    const port = Number(match[2]);
    const socket = net.createConnection({ host, port }, () => {
      socket.destroy();
      resolve(true);
    });

    socket.on("error", () => {
      resolve(false);
    });

    socket.setTimeout(timeout, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function setTorProxyForSession(session, enabled) {
  if (!session || (!session.setProxy && !session.defaultSession)) return Promise.resolve(false);
  const proxyRules = enabled ? DEFAULT_TOR_PROXY : "";
  return session
    .setProxy({ proxyRules, proxyBypassRules: "<local>" })
    .then(() => true)
    .catch((err) => {
      console.error("[tor] setProxy failed", err);
      return false;
    });
}

async function setTorProxyForWindow(win, enabled) {
  if (!win || win.isDestroyed()) return false;
  let result = true;

  const tabs = windowTabs.get(win) || [];
  for (const tab of tabs) {
    if (tab && tab.view && tab.view.webContents && !tab.view.webContents.isDestroyed()) {
      const ok = await setTorProxyForSession(tab.view.webContents.session, enabled);
      result = result && ok;
    }
  }

  // also synchronize parent window's session if it exists
  if (win.webContents && !win.webContents.isDestroyed()) {
    const ok2 = await setTorProxyForSession(win.webContents.session, enabled);
    result = result && ok2;
  }

  return result;
}

function applyTorToNewView(win, view) {
  const enabled = !!torEnabled.get(win.id);
  if (enabled) {
    setTorProxyForSession(view.webContents.session, true).catch((err) => {
      console.error("[tor] failed to apply proxy on new view", err);
    });
  }
}

function getTorStatusText(enabled) {
  return enabled ? "Disable TOR" : "Enable TOR";
}

function getTorStatusIcon(enabled) {
  return enabled ? "vpn_lock" : "vpn_key";
}

function getDefaultTabGroupName(win) {
  const groups = tabGroupsMap.get(win.id) || [];
  const used = new Set();
  groups.forEach((g) => {
    if (g && typeof g.name === 'string') {
      const match = g.name.match(/^Group\s*(\d+)$/i);
      if (match) {
        const n = Number(match[1]);
        if (Number.isInteger(n) && n > 0) used.add(n);
      }
    }
  });
  let candidate = 1;
  while (used.has(candidate)) candidate++;
  return `Group ${candidate}`;
}

try {
  const gotLock = app.requestSingleInstanceLock && app.requestSingleInstanceLock();
  if (!gotLock) {
    console.log("[i] Another instance is running - exiting this one");
    app.quit();
  }
} catch (e) {
  console.warn("[i] requestSingleInstanceLock not available or failed", e);
}

function createTorOverlayForWindow(win, uiHeight = 110) {
  if (!win || win.isDestroyed()) return;
  const wid = win.id;
  if (torOverlayMap.get(wid)) return;

  const bounds = win.getBounds();
  const x = bounds.x;
  const y = bounds.y + (uiHeight || 110);
  const width = bounds.width;
  const height = Math.max(0, bounds.height - (uiHeight || 110));

  const overlay = new BrowserWindow({
    x,
    y,
    width,
    height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    parent: win,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{height:100%;background:transparent;margin:0}#b{position:absolute;inset:0;border:4px solid rgba(138,43,226,0.95);border-radius:6px;box-sizing:border-box;pointer-events:none;}</style></head><body><div id="b"></div></body></html>`;
  overlay.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  overlay.setIgnoreMouseEvents(true, { forward: true });
  overlay.showInactive();

  torOverlayMap.set(wid, overlay);

  const onMoveResize = () => {
    try {
      if (overlay && !overlay.isDestroyed()) {
        const b = win.getBounds();
        overlay.setBounds({ x: b.x, y: b.y + (uiHeight || 110), width: b.width, height: Math.max(0, b.height - (uiHeight || 110)) });
      }
    } catch (e) { }
  };

  win.on("move", onMoveResize);
  win.on("resize", onMoveResize);
  overlay._parentListeners = onMoveResize;
}

try {
  if (app.setAsDefaultProtocolClient) {
    const navOk = app.setAsDefaultProtocolClient("navigator");
    console.log("[protocol] attempted to set protocol handler: navigator ->", !!navOk, "(http/https deferred until user opt-in)");
  }
} catch (e) {
  console.warn("[protocol] setAsDefaultProtocolClient failed", e);
}

function routeOpenTarget(raw) {
  try {
    if (!raw || typeof raw !== "string") return;

    let navUrl = raw;
    const looksLikePath = /^[\/~]|^[a-zA-Z]:\\|\\.html$/.test(raw) || raw.endsWith(".html");
    if (looksLikePath || raw.startsWith("file://")) {
      try {
        if (!raw.startsWith("file://")) {
          navUrl = pathToFileURL(path.resolve(raw)).toString();
        }
      } catch (e) {
        console.error("[open-file] failed to convert path to file URL", e);
      }
    }

    const targetWindow = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    if (!targetWindow || targetWindow.isDestroyed()) return;

    targetWindow.webContents.send("new-tab-request");
    setTimeout(() => {
      try {
        targetWindow.webContents.send("navigate-to-url", { url: navUrl });
      } catch (e) {
        console.error("[routeOpenTarget] send navigate failed", e);
      }
    }, 180);
  } catch (e) {
    console.error("[routeOpenTarget] unexpected error", e);
  }
}

app.on("open-url", (event, url) => {
  try {
    event.preventDefault();
    routeOpenTarget(url);
  } catch (e) {
    console.error("[protocol] open-url handler error", e);
  }
});
app.on("open-file", (event, filePath) => {
  try {
    event.preventDefault();
    routeOpenTarget(filePath);
  } catch (e) {
    console.error("[open-file] handler error", e);
  }
});

app.on("second-instance", (event, argv) => {
  try {
    for (const a of argv || []) {
      if (typeof a !== "string") continue;
      if (a.startsWith("navigator://") || a.startsWith("http://") || a.startsWith("https://") || a.startsWith("file://") || a.endsWith(".html")) {
        routeOpenTarget(a);
        break;
      }
    }
  } catch (e) {
    console.error("[protocol] second-instance handler error", e);
  }
});
function destroyTorOverlayForWindow(win) {
  if (!win || win.isDestroyed()) return;
  const wid = win.id;
  const overlay = torOverlayMap.get(wid);
  if (overlay && !overlay.isDestroyed()) {
    try {
      const parent = BrowserWindow.fromId(wid);
      if (parent && overlay._parentListeners) {
        parent.removeListener("move", overlay._parentListeners);
        parent.removeListener("resize", overlay._parentListeners);
      }
      overlay.close();
    } catch (e) { }
  }
  torOverlayMap.delete(wid);
}

function updateTorOverlayForWindow(win, uiHeight = 110) {
  if (!win || win.isDestroyed()) return;
  const wid = win.id;
  const overlay = torOverlayMap.get(wid);
  if (!overlay || overlay.isDestroyed()) return;
  try {
    const b = win.getBounds();
    overlay.setBounds({ x: b.x, y: b.y + (uiHeight || 110), width: b.width, height: Math.max(0, b.height - (uiHeight || 110)) });
  } catch (e) { }
}

function getPanelWidthForWindow(mainWindow) {
  if (!mainWindow || mainWindow.isDestroyed()) return 0;
  return panelWidthMap.get(mainWindow.id) || 0;
}

function setPanelViewBounds(mainWindow, uiHeight = 110) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const panelView = panelViewMap.get(mainWindow.id);
  const panelWidth = getPanelWidthForWindow(mainWindow);
  if (!panelView || panelView.webContents.isDestroyed() || !panelWidth) return;

  const bounds = mainWindow.getContentBounds();
  const uiWidthLeft = global.uiWidthLeftMap ? (global.uiWidthLeftMap.get(mainWindow.id) || 0) : 0;
  panelView.setBounds({
    x: uiWidthLeft,
    y: uiHeight,
    width: panelWidth,
    height: Math.max(0, bounds.height - uiHeight),
  });
}

function updateAllViewBounds(mainWindow, uiHeight = 110, uiWidthLeft) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (uiWidthLeft === undefined) {
    uiWidthLeft = global.uiWidthLeftMap ? (global.uiWidthLeftMap.get(mainWindow.id) || 0) : 0;
  }

  const MIN_UI_HEIGHT = 64;
  if (typeof uiHeight !== 'number' || uiHeight < MIN_UI_HEIGHT) {
    console.warn(`[bounds] clamping uiHeight (${uiHeight}) -> ${MIN_UI_HEIGHT}`);
    uiHeight = MIN_UI_HEIGHT;
  }

  const tabs = windowTabs.get(mainWindow);
  if (!tabs) return;

  const currentActiveTabId = activeTabId.get(mainWindow);
  const bounds = mainWindow.getContentBounds();
  const panelWidth = getPanelWidthForWindow(mainWindow);

  const group = splitGroupsMap.get(mainWindow.id);
  if (Array.isArray(group) && group.length >= 2) {
    const leftId = group[0];
    const rightId = group[group.length - 1];
    const half = Math.floor((bounds.width - uiWidthLeft - panelWidth) / 2);
    tabs.forEach((t) => {
      if (!t.view || t.view.webContents.isDestroyed()) return;
      if (t.id === leftId) {
        t.view.setBounds({ x: uiWidthLeft + panelWidth, y: uiHeight, width: half, height: Math.max(0, bounds.height - uiHeight) });
      } else if (t.id === rightId) {
        t.view.setBounds({ x: uiWidthLeft + panelWidth + half, y: uiHeight, width: bounds.width - uiWidthLeft - panelWidth - half, height: Math.max(0, bounds.height - uiHeight) });
      } else {
        if (t.__isManipulation) {
          t.view.setBounds({ x: bounds.width + 20, y: uiHeight, width: half, height: Math.max(0, bounds.height - uiHeight) });
        } else {
          t.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
        }
      }
    });
    if (panelWidth) setPanelViewBounds(mainWindow, uiHeight);
    return;
  }
  tabs.forEach((t) => {
    if (!t.view || t.view.webContents.isDestroyed()) return;

    if (t.id === currentActiveTabId) {
      t.view.setBounds({
        x: uiWidthLeft + panelWidth,
        y: uiHeight,
        width: bounds.width - uiWidthLeft - panelWidth,
        height: Math.max(0, bounds.height - uiHeight),
      });
    } else {
      if (t.__isManipulation) {
        t.view.setBounds({ x: bounds.width + 20, y: uiHeight, width: bounds.width, height: Math.max(0, bounds.height - uiHeight) });
      } else {
        t.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
      }
    }
  });
  if (panelWidth) setPanelViewBounds(mainWindow, uiHeight);
}

const createWindow = () => {
  const win = new BrowserWindow({
    width: 1500,
    height: 950,
    autoHideMenuBar: true,
    vibrancy: 'hud',
    frame: true,
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" } : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (settings.adblockEnabled && adblockerManager) {
    try {
      adblockerManager.enableSession(win.webContents.session);
    } catch (e) {
      console.error('[adblock] failed to enable session for new window', e);
    }
  }

  windowTabs.set(win, []);
  try {
    win.setTitle("Cheeter Navigator");
  } catch (e) { }

  if (typeof MAIN_WINDOW_VITE_DEV_SERVER_URL !== "undefined") {
    win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    const indexPath = getRendererAssetPath("index.html");
    console.log("[main] loading index file:", indexPath);
    win.loadFile(indexPath);
  }

  const maybeAutoOpenDevTools = () => {
    if (settings.developerAutoOpenDevTools || settings.autoOpenDevTools) {
      try {
        if (!win.isDestroyed() && !win.webContents.isDevToolsOpened()) {
          win.webContents.openDevTools({ mode: "detach" });
        }
      } catch (e) {
        console.error("[main] failed to auto-open devtools", e);
      }
    }
  };
  win.once("ready-to-show", maybeAutoOpenDevTools);
  win.webContents.once("did-finish-load", maybeAutoOpenDevTools);

  registerShortcutHandlers(win, win.webContents, false);

  const updateViewBounds = (uiHeight) => {
    if (!win || win.isDestroyed()) return;

    const tabs = windowTabs.get(win);
    if (!tabs) return;

    try {
      const bounds = win.getContentBounds();
      const finalY = uiHeight || 110;

      tabs.forEach((tab) => {
        if (tab.view && !tab.view.webContents.isDestroyed()) {
          try {
            tab.view.setBounds({
              x: 0,
              y: finalY,
              z: -100,
              width: bounds.width,
              height: Math.max(0, bounds.height - finalY),
              depth: -100,
            });
          } catch (e) { }
        }
      });
    } catch (e) { }
  };

  const onResize = () => updateViewBounds();
  win.on("resize", onResize);

  win.on("closed", () => {
    win.removeListener("resize", onResize);

    const tabs = windowTabs.get(win);
    if (tabs) {
      tabs.forEach((tab) => {
        if (tab.view && !tab.view.webContents.isDestroyed()) {
          try {
            tab.view.webContents.close();
          } catch (e) { }
        }
      });
    }
    windowTabs.delete(win);
    activeTabId.delete(win);
  });

  return win;
};

const bookmarkDropdownWindow = (bounds, sourceWindow) => {
  const windowOptions = {
    width: 350,
    height: 200,
    vibrancy: 'hud',
    autoHideMenuBar: true,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  };

  bookmarkWindow = new BrowserWindow(windowOptions);

  if (bounds && sourceWindow && !sourceWindow.isDestroyed()) {
    const mainBounds = sourceWindow.getBounds();
    const x = Math.round(mainBounds.x + bounds.left);
    const y = Math.round(mainBounds.y + bounds.bottom + 20);
    bookmarkWindow.setPosition(x, y);
  }

  if (typeof MAIN_WINDOW_VITE_DEV_SERVER_URL !== "undefined") {
    bookmarkWindow.loadURL(`${MAIN_WINDOW_VITE_DEV_SERVER_URL}/dropdown/bookmark.html`);
  } else {
    const bookmarkPath = getRendererAssetPath("dropdown/bookmark.html");
    console.log("[main] loading bookmark dropdown:", bookmarkPath);
    bookmarkWindow.loadFile(bookmarkPath);
  }

  bookmarkWindow.webContents.on("did-finish-load", () => {
    if (!bookmarkWindow.isDestroyed()) {
      bookmarkWindow.webContents.send("current-url-updated", { url: currentUrl, title: currentTitle });
    }
  });

  bookmarkWindow.on("closed", () => {
    bookmarkWindow = null;
  });

  bookmarkWindow.show();
};

const menuDropdownWindow = (bounds, sourceWindow) => {
  const windowOptions = {
    width: 350,
    height: 700,
    vibrancy: 'hud',
    autoHideMenuBar: true,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  };

  menuWindow = new BrowserWindow(windowOptions);

  if (bounds && sourceWindow && !sourceWindow.isDestroyed()) {
    const mainBounds = sourceWindow.getBounds();
    const x = Math.round(mainBounds.x + bounds.left + bounds.left);
    const y = Math.round(mainBounds.y + bounds.bottom + 20);
    menuWindow.setPosition(x, y);
  }

  if (typeof MAIN_WINDOW_VITE_DEV_SERVER_URL !== "undefined") {
    menuWindow.loadURL(`${MAIN_WINDOW_VITE_DEV_SERVER_URL}/dropdown/menu.html`);
  } else {
    const menuPath = getRendererAssetPath("dropdown/menu.html");
    console.log("[main] loading menu dropdown:", menuPath);
    menuWindow.loadFile(menuPath);
  }

  menuWindow.on("closed", () => {
    menuWindow = null;
  });

  menuWindow.webContents.on("did-finish-load", () => {
    if (!menuWindow.isDestroyed() && sourceWindow && !sourceWindow.isDestroyed()) {
      const tabs = windowTabs.get(sourceWindow) || [];
      menuWindow.webContents.send("menu-context", {
        sourceId: sourceWindow.id,
        currentUrl,
        currentTitle,
        tabs: tabs.map((t) => ({ id: t.id, title: t.title, url: t.displayUrl || t.url })),
        activeTabId: activeTabId.get(sourceWindow),
        torEnabled: torEnabled.get(sourceWindow.id) || false,
        keyPassXCEnabled,
      });
      menuSourceMap.set(menuWindow.webContents.id, sourceWindow.id);
    }
  });
  menuWindow.show();
};
menuSourceMap.delete(menuWindow?.webContents?.id);

const settingsPath = path.join(app.getPath("userData"), "settings.json");
const lastSessionPath = path.join(app.getPath("userData"), "lastSession.json");
let settings = { restoreLastSession: false, disposableMode: "none" };

function loadSettings() {
  try {
    if (fs.existsSync(settingsPath)) {
      const raw = fs.readFileSync(settingsPath, "utf-8");
      settings = JSON.parse(raw || "{}");
    }
  } catch (e) {
    console.error("[settings] failed to load", e);
  }

  if (typeof settings.spoofingEnabled === 'undefined') settings.spoofingEnabled = false;
  if (typeof settings.spoofingBrowser !== 'string') settings.spoofingBrowser = spoofingBrowser;
  if (typeof settings.spoofingDevice !== 'string') settings.spoofingDevice = spoofingDevice;
  if (typeof settings.keyPassXCEnabled === 'undefined') settings.keyPassXCEnabled = false;
  if (typeof settings.keyPassXCDBPath !== 'string') settings.keyPassXCDBPath = DEFAULT_KEYPASSXC_DB_PATH;
  if (typeof settings.spoofingMode !== 'string') settings.spoofingMode = spoofingMode;
  spoofingEnabled = !!settings.spoofingEnabled;
  if (typeof settings.spoofingBrowser === 'string') spoofingBrowser = settings.spoofingBrowser;
  if (typeof settings.spoofingDevice === 'string') spoofingDevice = settings.spoofingDevice;
  if (typeof settings.spoofingMode === 'string') spoofingMode = settings.spoofingMode;
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
  } catch (e) {
    console.error("[settings] failed to save", e);
  }
}

function loadLastSession() {
  try {
    if (fs.existsSync(lastSessionPath)) {
      const raw = fs.readFileSync(lastSessionPath, "utf-8");
      return JSON.parse(raw || "{}");
    }
  } catch (e) {
    console.error("[session] failed to load", e);
  }
  return null;
}

function saveLastSession() {
  try {
    const data = { windows: [] };
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win || win.isDestroyed()) return;
      const tabs = windowTabs.get(win) || [];
      data.windows.push({
        bounds: win.getBounds(),
        activeTabId: activeTabId.get(win),
        tabs: tabs.map((t) => ({ url: t.url, isPersistent: !!t.isPersistent, title: t.title })),
      });
    });
    fs.mkdirSync(path.dirname(lastSessionPath), { recursive: true });
    fs.writeFileSync(lastSessionPath, JSON.stringify(data, null, 2), "utf-8");
    console.log("[session] saved last session to", lastSessionPath);
  } catch (e) {
    console.error("[session] failed to save", e);
  }
}

let disposableProcessing = false;

function performSoftDisposable() {
  try {

    let settingsBackup = null;
    try {
      if (fs.existsSync(settingsPath)) settingsBackup = fs.readFileSync(settingsPath, "utf-8");
    } catch (e) {
      console.error("[disposable][soft] failed to backup settings", e);
    }

    try {
      if (process.platform === "darwin") {
        const appName = app.getName();
        const dataPath = path.join(app.getPath("appData"), appName);
        if (fs.existsSync(dataPath)) fs.rmSync(dataPath, { recursive: true, force: true });
      } else {
        const dataPath = path.join(app.getPath("appData"), "Navigator");
        if (fs.existsSync(dataPath)) fs.rmSync(dataPath, { recursive: true, force: true });
      }
    } catch (e) {
      console.error("[disposable][soft] failed to remove appData", e);
    }

    try {
      if (fs.existsSync(lastSessionPath)) fs.rmSync(lastSessionPath, { force: true });
    } catch (e) {
      console.error("[disposable][soft] failed to remove lastSession", e);
    }

    try {
      if (settingsBackup) {
        fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
        fs.writeFileSync(settingsPath, settingsBackup, "utf-8");
      }
    } catch (e) {
      console.error("[disposable][soft] failed to restore settings backup", e);
    }
  } catch (e) {
    console.error("[disposable][soft] unexpected error", e);
  }
}

function performNoMercyDisposable() {
  try {
    const userDataPath = app.getPath("userData");
    if (fs.existsSync(userDataPath)) fs.rmSync(userDataPath, { recursive: true, force: true });
    try {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify({ disposableMode: "disposable" }, null, 2), "utf-8");
      console.log("[disposable] preserved disposableMode in settings");
    } catch (e) {
      console.error("[disposable] failed to write minimal settings", e);
    }
  } catch (e) {
    console.error("[disposable] failed to remove userData", e);
  }
}
ipcMain.handle("get-settings", async () => {
  return settings;
});

ipcMain.handle('fetch-rss-feed', async (event, url) => {
  if (!url || typeof url !== 'string') return { success: false, error: 'Invalid URL' };
  // SECURITY: Validate URL to prevent SSRF attacks against internal services
  try {
    const parsed = new URL(url);
    const protocol = parsed.protocol.toLowerCase();
    if (protocol !== 'http:' && protocol !== 'https:') {
      return { success: false, error: 'Only http and https URLs are allowed' };
    }
    const hostname = parsed.hostname.toLowerCase();
    // Block requests to localhost, private IPs, and link-local addresses
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '0.0.0.0' ||
      hostname.endsWith('.local') ||
      /^10\./.test(hostname) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
      /^192\.168\./.test(hostname) ||
      /^169\.254\./.test(hostname) ||
      /^fc00:/i.test(hostname) ||
      /^fe80:/i.test(hostname)
    ) {
      return { success: false, error: 'Requests to private/internal addresses are not allowed' };
    }
  } catch (e) {
    return { success: false, error: 'Invalid URL format' };
  }
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*;q=0.1',
      },
      redirect: 'follow',
      cache: 'no-store',
    });
    if (!response.ok) {
      return { success: false, error: `Fetch failed: ${response.status} ${response.statusText}` };
    }
    const text = await response.text();
    return { success: true, text };
  } catch (err) {
    return { success: false, error: err && err.message ? err.message : String(err) };
  }
});

ipcMain.handle('get-page-title', async (event, url) => {
  if (!url || typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const hostname = parsed.hostname.toLowerCase();
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '0.0.0.0' ||
      hostname.endsWith('.local') ||
      /^10\./.test(hostname) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
      /^192\.168\./.test(hostname) ||
      /^169\.254\./.test(hostname)
    ) {
      return null;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timeout);
    if (!response.ok) return null;
    const text = await response.text();
    const match = text.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (match && match[1]) {
      return match[1].trim();
    }
  } catch (e) {
    return null;
  }
  return null;
});

function readLinesFromBuffer(buffer) {
  const lines = buffer.split(/\r\n|\n/).filter(Boolean);
  return lines;
}

function createMailSocket(account) {
  const useTls = !!account.useTls;
  const port = Number(account.port) || (account.protocol === 'imap' ? (useTls ? 993 : 143) : account.protocol === 'pop3' ? (useTls ? 995 : 110) : (useTls ? 587 : 25));
  const options = { host: account.host, port, timeout: 30000 };
  return useTls ? tls.connect({ ...options, rejectUnauthorized: true }) : net.connect(options);
}

function readServerResponse(socket, expectedTag) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error('Mail server response timed out'));
    }, 30000);

    const cleanup = () => {
      clearTimeout(timeout);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('end', onEnd);
      socket.off('close', onClose);
    };

    const onClose = () => cleanup();
    const onEnd = () => cleanup();
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = readLinesFromBuffer(buffer);
      if (expectedTag) {
        const taggedLine = lines.find(line => line.startsWith(expectedTag + ' '));
        if (taggedLine) {
          cleanup();
          resolve(lines);
        }
      } else if (lines.length > 0) {
        const last = lines[lines.length - 1] || '';
        if (buffer.includes('\r\n.\r\n')) {
          cleanup();
          resolve(lines);
        } else if (/^(?:\+OK|-ERR)/i.test(last) && buffer.endsWith('\r\n') && !buffer.includes('\r\n.\r\n')) {
          cleanup();
          resolve(lines);
        }
      }
    };

    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('end', onEnd);
    socket.on('close', onClose);
  });
}

function sendCommand(socket, command) {
  return new Promise((resolve, reject) => {
    socket.write(`${command}\r\n`, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

ipcMain.handle('connect-mail-account', async (event, account) => {
  if (!account || !account.host || !account.username || !account.password || !account.protocol) {
    return { success: false, error: 'Ungültige Kontodaten' };
  }
  // SECURITY: Validate protocol to prevent unexpected behavior
  const allowedProtocols = ['imap', 'pop3'];
  if (!allowedProtocols.includes(account.protocol)) {
    return { success: false, error: 'Ungültiges Protokoll. Erlaubt: imap, pop3' };
  }
  // SECURITY: Validate host to prevent SSRF to internal services
  const mailHost = (account.host || '').toLowerCase();
  if (
    mailHost === 'localhost' ||
    mailHost === '127.0.0.1' ||
    mailHost === '::1' ||
    /^10\./.test(mailHost) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(mailHost) ||
    /^192\.168\./.test(mailHost)
  ) {
    return { success: false, error: 'Verbindung zu internen/lokalen Adressen nicht erlaubt' };
  }

  const mailbox = typeof account.mailbox === 'string' && account.mailbox.trim() ? account.mailbox.trim() : null;

  let socket;
  try {
    socket = createMailSocket(account);
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
      socket.once('timeout', () => reject(new Error('Connection timeout')));
    });

    const rawGreeting = await readServerResponse(socket, undefined);
    const result = { success: true, greeting: rawGreeting.join('\n'), logs: [] };

    if (account.protocol === 'imap') {
      // SECURITY: Quote IMAP credentials to prevent command injection
      const safeImapStr = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
      await sendCommand(socket, `A001 LOGIN ${safeImapStr(account.username)} ${safeImapStr(account.password)}`);
      const loginResponse = await readServerResponse(socket, 'A001');
      result.logs.push(...loginResponse);
      const loginOk = loginResponse.find(line => line.includes('A001') && line.includes('OK'));
      if (!loginOk) {
        throw new Error('IMAP Login fehlgeschlagen');
      }

      await sendCommand(socket, 'A002 LIST "" "*"');
      const listResponse = await readServerResponse(socket, 'A002');
      result.mailboxes = listResponse
        .filter((line) => /^\* LIST/i.test(line))
        .map((line) => {
          const cleanLine = line.replace(/^\* LIST\s*\([^)]*\)\s*/i, '').trim();
          const quotedMatch = cleanLine.match(/"([^"]+)"\s*$/);
          const mailboxName = quotedMatch
            ? quotedMatch[1]
            : cleanLine.split(/\s+/).pop().replace(/^"|"$/g, '');
          return { raw: line, name: mailboxName || 'INBOX' };
        })
        .filter((box, index, arr) => box.name && arr.findIndex((item) => item.name === box.name) === index);

      if (!result.mailboxes.length) {
        result.mailboxes = [{ raw: '* LIST () "INBOX"', name: 'INBOX' }];
      }

      const targetMailbox = mailbox || result.mailboxes[0].name || 'INBOX';
      result.selectedMailbox = targetMailbox;
      await sendCommand(socket, `A003 SELECT "${targetMailbox.replace(/"/g, '\\"')}"`);
      const selectResponse = await readServerResponse(socket, 'A003');
      result.logs.push(...selectResponse);
      const existsLine = selectResponse.find((line) => /EXISTS/i.test(line));
      const exists = existsLine ? parseInt((existsLine.match(/(\d+)/) || [0])[0], 10) : 0;
      result.exists = exists;
      if (exists > 0) {
        await sendCommand(socket, `A004 FETCH 1:${Math.min(exists, 5)} (BODY.PEEK[HEADER.FIELDS (SUBJECT FROM DATE)])`);
        const fetchResponse = await readServerResponse(socket, 'A004');
        result.messages = fetchResponse;
      }
    } else if (account.protocol === 'pop3') {
      await sendCommand(socket, `USER ${account.username}`);
      const userResp = await readServerResponse(socket, undefined);
      if (!userResp[userResp.length - 1]?.startsWith('+OK')) throw new Error('POP3 Nutzername abgelehnt');
      result.logs.push(...userResp);

      await sendCommand(socket, `PASS ${account.password}`);
      const passResp = await readServerResponse(socket, undefined);
      if (!passResp[passResp.length - 1]?.startsWith('+OK')) throw new Error('POP3 Passwort abgelehnt');
      result.logs.push(...passResp);

      await sendCommand(socket, 'STAT');
      const statResp = await readServerResponse(socket, undefined);
      result.logs.push(...statResp);
      const statMatch = statResp[statResp.length - 1]?.match(/(\d+) (\d+)/);
      if (statMatch) result.messages = [`${statMatch[1]} Nachrichten, ${statMatch[2]} bytes`];

      await sendCommand(socket, 'LIST');
      const listResp = await readServerResponse(socket, undefined);
      result.logs.push(...listResp);
    }

    try {
      socket.end();
    } catch (e) { }
    return result;
  } catch (err) {
    try { socket?.destroy(); } catch (e) { }
    return { success: false, error: err && err.message ? err.message : String(err) };
  }
});

ipcMain.handle("get-app-version", async () => {
  try {
    return app.getVersion();
  } catch (e) {
    console.error('get-app-version error', e);
    return '';
  }
});

const AUTH_TIMEOUT_MS = 5 * 60 * 1000;
let authenticatedUntil = 0;
function isAuthenticated() {
  return Date.now() < authenticatedUntil;
}

function verifyPassword(password) {
  return new Promise((resolve) => {
    try {
      if (process.platform === "darwin") {
        const args = ["-e", 'do shell script "echo AUTH_OK" with administrator privileges'];
        const p = spawn("osascript", args, { stdio: ["ignore", "pipe", "pipe"] });
        let out = "",
          err = "";
        p.stdout.on("data", (d) => {
          out += d.toString();
        });
        p.stderr.on("data", (d) => {
          err += d.toString();
        });
        p.on("error", () => resolve(false));
        p.on("close", (code) => {
          resolve(code === 0 && out.trim() === "AUTH_OK");
        });
        return;
      }

      if (process.platform === "linux") {
        const p = spawn("pkexec", ["sh", "-c", "echo AUTH_OK"], { stdio: ["ignore", "pipe", "pipe"] });
        let out = "",
          err = "";
        p.stdout.on("data", (d) => {
          out += d.toString();
        });
        p.stderr.on("data", (d) => {
          err += d.toString();
        });
        p.on("error", () => resolve(false));
        p.on("close", (code) => {
          resolve(code === 0 && out.trim() === "AUTH_OK");
        });
        return;
      }

      if (process.platform === "win32") {
        const ps = spawn("powershell.exe", ["-NoProfile", "-Command", "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"], { stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        ps.stdout.on("data", (d) => {
          out += d.toString();
        });
        ps.on("error", () => resolve(false));
        ps.on("close", () => {
          resolve(out.trim().toLowerCase() === "true");
        });
        return;
      }
      const p = spawn("sudo", ["-k", "-S", "-p", ""], { stdio: ["pipe", "pipe", "pipe"] });
      let stderr = "";
      p.stderr.on("data", (d) => {
        stderr += d.toString();
      });
      p.on("error", () => resolve(false));
      p.on("close", (code) => {
        resolve(code === 0 && !/incorrect password/i.test(stderr));
      });
      if (typeof password === "string") {
        p.stdin.write(password + "\n");
        p.stdin.end();
      } else {
        p.stdin.end();
      }
    } catch (e) {
      resolve(false);
    }
  });
}

ipcMain.handle("authenticate", async (event, password) => {
  try {
    console.log("[auth] authenticate request (password provided:", typeof password === "string", "platform:", process.platform, ")");
    const ok = await verifyPassword(password);
    if (ok) {
      authenticatedUntil = Date.now() + AUTH_TIMEOUT_MS;
      console.log("[auth] authentication success");
      return { success: true };
    }
    console.log("[auth] authentication failed");
    return { success: false, message: "authentication-failed" };
  } catch (e) {
    console.error("[auth] error during authentication", e);
    return { success: false, message: e.message };
  }
});

ipcMain.handle("is-authenticated", async () => {
  return isAuthenticated();
});

// SECURITY: Allowlist of permitted setting keys to prevent arbitrary data injection
const ALLOWED_SETTING_KEYS = new Set([
  'adblockEnabled', 'spoofingEnabled', 'spoofingBrowser', 'spoofingDevice', 'spoofingMode',
  'keyPassXCEnabled', 'keyPassXCDBPath', 'homePage', 'searchEngine', 'searchEngines',
  'customSearchEngine', 'theme', 'themeColor', 'saveHistory', 'history', 'bookmarks',
  'restoreLastSession', 'disposableMode', 'startupType', 'startupPages', 'sidebarApps',
  'suspiciousHosts', 'firstRunComplete', 'dataManipulationInterval', 'dataManipulationIntervalSeconds',
  'developerMode', 'developerAutoOpenDevTools', 'autoOpenDevTools', 'developerShowCheeterSpace',
  'developerShowArquivoAndIntegrated', 'customApps', 'bookmarksInSidebar'
]);

ipcMain.on("set-setting", (event, { key, value }) => {
  try {
    // SECURITY: Validate key against allowlist
    if (typeof key !== 'string' || !ALLOWED_SETTING_KEYS.has(key)) {
      console.warn(`[settings] rejected unknown setting key: ${key}`);
      return;
    }

    const url = event && event.sender && event.sender.getURL ? event.sender.getURL() : "";
    if (isSettingsPageUrl(url) && !isAuthenticated()) {
      if (event && event.sender) event.sender.send("auth-required");
      return;
    }

    settings[key] = value;
    saveSettings();

    if (key === 'adblockEnabled') {
      setAdblockEnabled(value);
    }
    if (key === 'spoofingEnabled') {
      setSpoofingEnabled(value);
    }
    if (key === 'keyPassXCEnabled') {
      setKeyPassXCEnabled(value);
    }
    if (key === 'keyPassXCDBPath') {
      settings.keyPassXCDBPath = value;
      saveSettings();
    }
    if (key === 'spoofingBrowser' || key === 'spoofingDevice' || key === 'spoofingMode') {
      setSpoofingOption(key, value);
    }

    BrowserWindow.getAllWindows().forEach((w) => {
      if (!w.isDestroyed()) w.webContents.send("settings-updated", settings);
    });
  } catch (e) {
    console.error("[settings] failed to set", e);
  }
});
ipcMain.handle('get-adblock-stats', () => {
  return {
    enabled: adblockEnabled,
    ...(adblockerManager ? adblockerManager.getStats() : { blocked: 0 }),
  };
});

ipcMain.handle('get-keypassxc-status', async () => {
  const available = await isKeepassxcAvailable();
  return {
    enabled: keyPassXCEnabled,
    available,
    dbPath: settings.keyPassXCDBPath || DEFAULT_KEYPASSXC_DB_PATH,
  };
});

ipcMain.handle('get-keypassxc-entries', async () => {
  if (!keyPassXCEnabled) return { enabled: false, entries: [], message: 'KeePassXC integration disabled' };
  const dbPath = settings.keyPassXCDBPath || DEFAULT_KEYPASSXC_DB_PATH;
  const masterPassword = process.env.KEYPASSXC_MASTER_PASSWORD;
  if (!masterPassword) return { enabled: true, entries: [], message: 'Master password not set' };

  const listEntries = [];

  const runKeePassCommand = (args) => {
    return new Promise((resolve, reject) => {
      try {
        const child = spawn('keepassxc-cli', args, { stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d.toString(); });
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.stdin.write(masterPassword + '\n');
        child.stdin.end();
        child.on('close', (code) => {
          if (code === 0) resolve(stdout.trim());
          else reject(new Error(stderr.trim() || `exit code ${code}`));
        });
      } catch (e) {
        reject(e);
      }
    });
  };

  try {
    const raw = await runKeePassCommand(['ls', dbPath]);
    const lines = raw.split('\n').map(line => line.trim()).filter(Boolean);
    for (const line of lines) {
      if (line.endsWith('/')) continue; // groups
      const entryName = line;
      try {
        const entryRaw = await runKeePassCommand(['show', dbPath, entryName, '--quiet']);
        const userMatch = entryRaw.match(/^User:\s*(.*)$/im);
        const passMatch = entryRaw.match(/^Password:\s*(.*)$/im);
        listEntries.push({
          name: entryName,
          username: userMatch ? userMatch[1].trim() : '',
          password: passMatch ? passMatch[1].trim() : '',
        });
      } catch (e) {
        listEntries.push({ name: entryName, username: '', password: '', error: e.message });
      }
    }
    return { enabled: true, entries: listEntries };
  } catch (e) {
    console.error('[keypassxc] get entries failed', e);
    return { enabled: true, entries: [], message: e.message || 'Failed to retrieve entries' };
  }
});

app.whenReady().then(async () => {
  // Set custom menu to change standard DevTools shortcut from Cmd+Alt+I to Cmd+Alt+Shift+I
  const template = [
    ...(process.platform === 'darwin' ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }] : []),
    {
      label: 'File',
      submenu: [
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(process.platform === 'darwin' ? [
          { role: 'pasteAndMatchStyle' },
          { role: 'delete' },
          { role: 'selectAll' },
          { type: 'separator' },
          {
            label: 'Speech',
            submenu: [
              { role: 'startSpeaking' },
              { role: 'stopSpeaking' }
            ]
          }
        ] : [
          { role: 'delete' },
          { type: 'separator' },
          { role: 'selectAll' }
        ])
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        {
          label: 'Toggle Developer Tools (Shell)',
          accelerator: 'CmdOrCtrl+Alt+Shift+I',
          click(item, focusedWindow) {
            if (focusedWindow) focusedWindow.webContents.toggleDevTools();
          }
        },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(process.platform === 'darwin' ? [
          { type: 'separator' },
          { role: 'front' },
          { type: 'separator' },
          { role: 'window' }
        ] : [
          { role: 'close' }
        ])
      ]
    }
  ];
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);

  loadSettings();
  if (typeof settings.adblockEnabled === 'undefined') settings.adblockEnabled = true;
  adblockerManager = new AdblockerManager();
  adblockerManager.onStatsChange = (stats) => {
    BrowserWindow.getAllWindows().forEach((w) => {
      if (!w.isDestroyed()) w.webContents.send('adblock-stats-updated', stats);
    });
  };
  try {
    await adblockerManager.init();
    console.log('[adblock] engine initialized');
  } catch (e) {
    console.error('[adblock] failed to initialize engine', e);
  }
  setAdblockEnabled(settings.adblockEnabled);
  setSpoofingEnabled(settings.spoofingEnabled);
  keyPassXCEnabled = !!settings.keyPassXCEnabled;
  settings.keyPassXCDBPath = settings.keyPassXCDBPath || DEFAULT_KEYPASSXC_DB_PATH;
  broadcastKeyPassXCStatus();
  if (keyPassXCEnabled) {
    BrowserWindow.getAllWindows().forEach((w) => {
      if (!w.isDestroyed()) {
        attemptFillFromKeyPassXC(w, { interactive: false });
        autoSaveFromKeyPassXC(w);
      }
    });
  }
  if (!Array.isArray(settings.suspiciousHosts)) settings.suspiciousHosts = [
    { host: 'codeon.codes', reason: 'scam / abuse' },
    { host: 'aurex.lk', reason: 'botnet / suspicious traffic' },
    { host: 'chaossmp.de', reason: 'suspicious activity' },
    { host: 'chaossmp.com', reason: 'impersonation' },
    { host: 'giws.us', reason: 'impersonation / abuse' },
    { host: 'getnexo.de', reason: 'credential harvesting' },
    { host: 'pentagon.cy', reason: 'Malware hosting' },
    { host: 'palentir.com', reason: 'privacy violation' },
    { host: 'path.net', reason: 'suspicious activity' },
    // Pornography Blocking
    { host: 'pornhub.org', reason: 'pornography' },
    { host: 'pornhub.de', reason: 'pornography' },
    { host: 'pornhub.com', reason: 'pornography' },
    { host: 'xhamster.desi', reason: 'pornography' },
    { host: 'onlyfans.com', reason: 'pornography' },
  ];
  const lastSession = loadLastSession();

  if (!settings.firstRunComplete) {
    const w = createWindow();
    w.once("ready-to-show", () => {
      try {
        showOverlayView(w, "navigator://onboarding");
      } catch (e) {
        console.error("[onboarding] failed to open as overlay", e);
      }
    });
  } else {
    if (settings.startupType === "specific" && Array.isArray(settings.startupPages) && settings.startupPages.length > 0) {
      const w = createWindow();
      w.once("ready-to-show", () => {
        try {
          const tabs = settings.startupPages.map((u) => ({ url: u, isPersistent: false, title: "" }));
          w.webContents.send("restore-session", { tabs, activeTabId: null });
        } catch (e) { }
      });
    } else if (settings.restoreLastSession && lastSession && Array.isArray(lastSession.windows) && lastSession.windows.length > 0) {
      lastSession.windows.forEach((winData) => {
        const w = createWindow();
        w.once("ready-to-show", () => {
          try {
            if (winData.bounds) w.setBounds(winData.bounds);
            w.webContents.send("restore-session", { tabs: winData.tabs || [], activeTabId: winData.activeTabId });
          } catch (e) { }
        });
      });
    } else {
      createWindow();
    }
  }

  console.log("[i] Cheeter Navigator started!");
  console.log(`[i] Running Navigator Version: ${app.getVersion()}`);
  console.log("");
  console.log(`[i] Running Electron version: ${process.versions.electron}`);
  console.log(`[i] Running Node.js version: ${process.versions.node}`);
  console.log(`[i] Running Chromium version: ${process.versions.chrome}`);
  console.log(`[i] Running V8 version: ${process.versions.v8}`);
  console.log("");
  console.log(`[i] Running Platform: ${process.platform} ${process.arch}`);
  console.log("");
  console.log(`[i] When using the Browser you might see a warning about "...EGL Driver message (Error) eglQueryDeviceAttribEXT: Bad attribute.". This is normal and can be safely ignored.`);
  console.log("");
  try {
    for (const a of process.argv || []) {
      if (typeof a !== "string") continue;
      if (a.startsWith("navigator://") || a.startsWith("http://") || a.startsWith("https://") || a.startsWith("file://") || a.endsWith(".html")) {
        routeOpenTarget(a);
        break;
      }
    }
  } catch (e) {
    console.error("[protocol] startup argv handling failed", e);
  }
});

function createFirstRunWindow() {
  const w = createWindow();
  w.once("ready-to-show", () => {
    try {
      showOverlayView(w, "navigator://onboarding");
    } catch (e) { }
  });
  return w;
}
ipcMain.on("complete-onboarding", (event) => {
  try {
    settings.firstRunComplete = true;
    saveSettings();
  } catch (e) {
    console.error("[onboarding] error setting flag", e);
  }

  try {
    const possibleWin = BrowserWindow.fromWebContents(event.sender);
    if (possibleWin) {
      hideOverlayView(possibleWin);
      // If it's a dedicated window (not main window with browser UI), close it.
      // But onboarding is now an overlay on the main window, so we just hide it.
    }

    BrowserWindow.getAllWindows().forEach((win) => {
      try {
        const tabs = windowTabs.get(win) || [];
        const idx = tabs.findIndex((t) => {
          if (!t || !t.view || t.view.webContents.isDestroyed()) return false;
          if (t.requestedUrl && typeof t.requestedUrl === "string" && t.requestedUrl.startsWith("navigator://onboarding")) return true;
          const u = t.view.webContents.getURL ? t.view.webContents.getURL() || "" : "";
          return u.includes("/onboarding/index.html");
        });
        if (idx !== -1) {
          const tab = tabs[idx];
          if (tab.view && !tab.view.webContents.isDestroyed()) {
            win.contentView.removeChildView(tab.view);
          }
          tabs.splice(idx, 1);
          windowTabs.set(win, tabs);
          if (tabs.length === 0) win.webContents.send("new-tab-request");
          else {
            const newActiveTabId = tabs[Math.min(idx, tabs.length - 1)].id;
            win.webContents.send("switch-tab-request", { tabId: newActiveTabId });
          }
        }
      } catch (e) { }
    });
    if (BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length === 0) createWindow();
  } catch (e) { }
});
app.on("before-quit", () => {
  try {
    if (settings.restoreLastSession) saveLastSession();
  } catch (e) { }

  try {
    if (!disposableProcessing && settings && settings.disposableMode) {
      disposableProcessing = true;
      if (settings.disposableMode === "disposable") {
        performNoMercyDisposable();
      }
    }
  } catch (e) {
    console.error("[disposable] error during cleanup", e);
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

ipcMain.on("new-window", () => createWindow());

ipcMain.on("bookmark", (event, bounds) => {
  const sourceWindow = BrowserWindow.fromWebContents(event.sender);
  bookmarkDropdownWindow(bounds, sourceWindow);
});

ipcMain.on("menu", (event, bounds) => {
  const sourceWindow = BrowserWindow.fromWebContents(event.sender);
  menuDropdownWindow(bounds, sourceWindow);
});

ipcMain.on("window-control", (event, action) => {
  const focusedWindow = BrowserWindow.getFocusedWindow();
  if (!focusedWindow) return;

  if (action === "close") focusedWindow.close();
  if (action === "minimize") focusedWindow.minimize();
  if (action === "maximize") {
    if (focusedWindow.isMaximized()) {
      focusedWindow.unmaximize();
    } else {
      focusedWindow.maximize();
    }
  }
});

ipcMain.on("set-current-url", (event, data) => {
  currentUrl = data.url;
  currentTitle = data.title;

  if (bookmarkWindow && !bookmarkWindow.isDestroyed()) {
    bookmarkWindow.webContents.send("current-url-updated", { url: currentUrl, title: currentTitle });
  }
});

ipcMain.on("add-bookmark", (event, data) => {
  BrowserWindow.getAllWindows().forEach((w) => {
    if (!w.isDestroyed()) w.webContents.send("bookmark-added", data);
  });
});

ipcMain.on("remove-bookmark", (event, data) => {
  BrowserWindow.getAllWindows().forEach((w) => {
    if (!w.isDestroyed()) w.webContents.send("bookmark-removed", data);
  });
});

ipcMain.on("sync-view-bounds", (event, { uiHeight, uiWidthLeft = 0 }) => {
  const sourceWindow = BrowserWindow.fromWebContents(event.sender);
  if (!sourceWindow || sourceWindow.isDestroyed()) return;
  uiHeightMap.set(sourceWindow.id, uiHeight);
  if (!global.uiWidthLeftMap) global.uiWidthLeftMap = new Map();
  global.uiWidthLeftMap.set(sourceWindow.id, uiWidthLeft);

  updateAllViewBounds(sourceWindow, uiHeight, uiWidthLeft);
  try {
    updateTorOverlayForWindow(sourceWindow, uiHeight);
  } catch (e) { }
});

function destroyPanelViewForWindow(sourceWindow) {
  if (!sourceWindow || sourceWindow.isDestroyed()) return;
  const panelView = panelViewMap.get(sourceWindow.id);
  if (!panelView) return;

  try {
    sourceWindow.contentView.removeChildView(panelView);
  } catch (e) { }

  try {
    if (!panelView.webContents.isDestroyed()) panelView.webContents.destroy();
  } catch (e) { }

  try {
    panelView.destroy?.();
  } catch (e) { }

  panelViewMap.delete(sourceWindow.id);
  panelAppMap.delete(sourceWindow.id);
  panelWidthMap.delete(sourceWindow.id);
  if (!sourceWindow.isDestroyed()) {
    sourceWindow.webContents.send("panel-state-changed", { open: false, appId: null });
  }
}

function createThirdPartyPanelView(sourceWindow, appId, resourceUrl) {
  if (!sourceWindow || sourceWindow.isDestroyed()) return;
  destroyPanelViewForWindow(sourceWindow);

  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      partition: `persist:thirdparty_panel`,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  try {
    applySpoofingToView(view);
    setupContextMenu(view);
  } catch (e) { }

  applyTorToNewView(sourceWindow, view);

  view.webContents.setWindowOpenHandler(({ url: openUrl }) => {
    try {
      sourceWindow.webContents.send("new-tab-request");
      setTimeout(() => sourceWindow.webContents.send("navigate-to-url", { url: openUrl }), 100);
    } catch (e) { }
    return { action: "deny" };
  });

  sourceWindow.contentView.addChildView(view);
  panelViewMap.set(sourceWindow.id, view);
  panelAppMap.set(sourceWindow.id, appId);
  panelWidthMap.set(sourceWindow.id, PANEL_VIEW_WIDTH);

  applyAdblockToSession(view.webContents.session);

  let loadUrl = resourceUrl;
  if (typeof loadUrl === 'string' && !/^https?:\/\//i.test(loadUrl) && !/^file:\/\//i.test(loadUrl)) {
    if (typeof MAIN_WINDOW_VITE_DEV_SERVER_URL !== 'undefined') {
      loadUrl = `${MAIN_WINDOW_VITE_DEV_SERVER_URL}/${loadUrl}`;
    } else {
      const assetUrl = new URL(loadUrl, "file:///");
      loadUrl = getRendererAssetUrl(
        decodeURIComponent(assetUrl.pathname.slice(1)),
        `${assetUrl.search}${assetUrl.hash}`,
      );
    }
  }

  view.webContents.loadURL(loadUrl);

  updateAllViewBounds(sourceWindow, uiHeightMap.get(sourceWindow.id) || 110);
  if (!sourceWindow.isDestroyed()) {
    sourceWindow.webContents.send("panel-state-changed", { open: true, appId });
  }
}

ipcMain.on("toggle-third-party-panel", (event, { appId, url, panelUrl }) => {
  const sourceWindow = BrowserWindow.fromWebContents(event.sender);
  if (!sourceWindow || sourceWindow.isDestroyed()) return;

  const currentAppId = panelAppMap.get(sourceWindow.id);
  if (currentAppId === appId) {
    destroyPanelViewForWindow(sourceWindow);
    updateAllViewBounds(sourceWindow, uiHeightMap.get(sourceWindow.id) || 110);
    return;
  }

  createThirdPartyPanelView(sourceWindow, appId, panelUrl || url);
});

function setupContextMenu(view) {
  view.webContents.on("context-menu", (event, params) => {
    if (params.mediaType === 'video') {
      const menu = Menu.buildFromTemplate([
        {
          label: 'Picture in Picture',
          click: () => {
            view.webContents.executeJavaScript(`
              try {
                if (document.pictureInPictureElement) {
                  document.exitPictureInPicture();
                } else {
                  document.elementFromPoint(${params.x}, ${params.y}).requestPictureInPicture();
                }
              } catch (e) { console.error('PiP failed', e); }
            `);
          }
        }
      ]);
      menu.popup();
    }
  });
}

ipcMain.on("navigate-to", (event, { url, isPersistent, tabId }) => {
  const sourceWindow = BrowserWindow.fromWebContents(event.sender);
  if (!sourceWindow || sourceWindow.isDestroyed()) return;

  if (tabId == null) {
    const active = activeTabId.get(sourceWindow);
    if (typeof active !== 'undefined') tabId = active;
  }

  let isStartUri = false;
  if (url === 'navigator://start') {
    isStartUri = true;
    url = typeof MAIN_WINDOW_VITE_DEV_SERVER_URL !== 'undefined'
      ? `${MAIN_WINDOW_VITE_DEV_SERVER_URL}/startpage/index.html`
      : getRendererAssetUrl("startpage/index.html");
  }

  const tabs = windowTabs.get(sourceWindow) || [];
  let tab = tabs.find((t) => t.id === tabId);
  if (tab && isStartUri) {
    tab.displayUrl = 'navigator://start';
  }

  if (!tab) {
    const view = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        partition: isPersistent ? "persist:main_storage" : `incognito_${Date.now()}`,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    try {
      applySpoofingToView(view);
      setupContextMenu(view);
    } catch (e) { }

    applyTorToNewView(sourceWindow, view);

    registerShortcutHandlers(sourceWindow, view.webContents, true);

    view.webContents.setWindowOpenHandler(({ url, disposition }) => {
      try {
        const newTabId = tabIdCounter++;
        sourceWindow.webContents.send("new-tab-request");
        setTimeout(() => {
          sourceWindow.webContents.send("navigate-to-url", { url });
        }, 100);
      } catch (e) { }
      return { action: "deny" };
    });

    tab = { id: tabId, view, url, title: "New Tab", isPersistent };
    tabs.push(tab);
    windowTabs.set(sourceWindow, tabs);
    sourceWindow.contentView.addChildView(view);

    applyAdblockToSession(view.webContents.session);

    view.webContents.on("did-navigate", (e, newUrl) => {
      tab.url = newUrl;

      try {
        const parsed = new URL(newUrl);
        const host = parsed.hostname;
        const bypass = parsed.searchParams.get('__cheeter_bypass_suspicious') === '1';
        const suspicious = Array.isArray(settings.suspiciousHosts) ? settings.suspiciousHosts : [];
        if (!bypass && host) {
          const match = suspicious.find(s => (typeof s === 'string' && s.toLowerCase() === host.toLowerCase()) || (s && s.host && s.host.toLowerCase() === host.toLowerCase()));
          if (match) {
            const reason = (typeof match === 'object' && match.reason) ? match.reason : undefined;
            let warningPath = typeof MAIN_WINDOW_VITE_DEV_SERVER_URL !== 'undefined'
              ? `${MAIN_WINDOW_VITE_DEV_SERVER_URL}/errors/suspicious-warning.html?host=${encodeURIComponent(host)}&url=${encodeURIComponent(newUrl)}`
              : `${getRendererAssetUrl("errors/suspicious-warning.html")}?host=${encodeURIComponent(host)}&url=${encodeURIComponent(newUrl)}`;
            if (reason) warningPath += `&reason=${encodeURIComponent(reason)}`;
            view.webContents.loadURL(warningPath);
            tab.requestedUrl = newUrl;
            tab.displayUrl = `warning:${host}`;
            sourceWindow.webContents.send("on-navigated", tab.displayUrl);
            sourceWindow.webContents.send("update-tab", { tabId: tabId, url: tab.displayUrl });
            return;
          }
        }
      } catch (e) { }

      tab.url = newUrl;
      if (tab.displayUrl === 'navigator://start' && !newUrl.includes('/startpage/index.html')) {
        tab.displayUrl = null;
      }
      const displayed = tab.displayUrl || newUrl;
      sourceWindow.webContents.send("on-navigated", displayed);
      sourceWindow.webContents.send("update-tab", { tabId: tabId, url: displayed });
    });
    view.webContents.on("did-navigate-in-page", (e, newUrl) => {
      tab.url = newUrl;
      if (tab.displayUrl === 'navigator://start' && !newUrl.includes('/startpage/index.html')) {
        tab.displayUrl = null;
      }
      const displayed = tab.displayUrl || newUrl;
      sourceWindow.webContents.send("on-navigated", displayed);
      sourceWindow.webContents.send("update-tab", { tabId: tabId, url: displayed });
    });
    view.webContents.on("did-fail-load", (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || !validatedURL) return;
      try {
        const parsed = new URL(validatedURL);
        const host = parsed.hostname;
        const isLocalHost = host === "localhost" || host === "127.0.0.1" || /^\d+\.\d+\.\d+\.\d+$/.test(host);
        if (parsed.protocol === "https:" && isLocalHost) {
          const httpUrl = validatedURL.replace(/^https:/, "http:");
          console.warn("[did-fail-load] retrying with http for", validatedURL);
          view.webContents.loadURL(httpUrl);
          return;
        }
      } catch (e) { }

      const desc = (errorDescription || '').toString();
      const isNetworkErr = /ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_NETWORK_CHANGED|ERR_CONNECTION_TIMED_OUT|ERR_CONNECTION_ABORTED/i.test(desc) || (typeof errorCode === 'number' && errorCode <= -100);
      if (isNetworkErr) {
        const offlinePath = typeof MAIN_WINDOW_VITE_DEV_SERVER_URL !== 'undefined'
          ? `${MAIN_WINDOW_VITE_DEV_SERVER_URL}/errors/offline.html`
          : getRendererAssetUrl("errors/offline.html");
        try { view.webContents.loadURL(offlinePath); } catch (e) { }
      }
    });

    try {
      const ses = view.webContents.session;
      if (!view._errorPagesRegistered) {
        const onCompleted = (details) => {
          try {
            if (details.webContentsId !== view.webContents.id) return;
            if (details.resourceType === 'mainFrame' && details.statusCode === 404) {
              const offlinePath = typeof MAIN_WINDOW_VITE_DEV_SERVER_URL !== 'undefined'
                ? `${MAIN_WINDOW_VITE_DEV_SERVER_URL}/errors/offline.html?url=${encodeURIComponent(details.url)}`
                : `${getRendererAssetUrl("errors/offline.html")}?url=${encodeURIComponent(details.url)}`;
              view.webContents.loadURL(offlinePath);
            }
          } catch (e) { }
        };
        ses.webRequest.onCompleted(onCompleted);
        view._errorPagesRegistered = true;
      }
    } catch (e) { }

    view.webContents.on("did-stop-loading", () => {
      const title = view.webContents.getTitle();
      tab.title = title;
      sourceWindow.webContents.send("on-title-changed", title);
      sourceWindow.webContents.send("update-tab", { tabId: tabId, title });
      if (activeTabId.get(sourceWindow) === tabId) {
        setWindowTitle(sourceWindow, title, tab.url);
      }

      if (keyPassXCEnabled) {
        attemptFillFromKeyPassXC(sourceWindow, { interactive: false });
        autoSaveFromKeyPassXC(sourceWindow);
      }
    });
    view.webContents.on("page-title-updated", (event, title) => {
      tab.title = title;
      sourceWindow.webContents.send("on-title-changed", title);
      sourceWindow.webContents.send("update-tab", { tabId: tabId, title });
      if (activeTabId.get(sourceWindow) === tabId) {
        setWindowTitle(sourceWindow, title, tab.url);
      }
    });

    activeTabId.set(sourceWindow, tabId);
    sourceWindow.webContents.send("tabs-updated", { tabs: serializeTabs(tabs), activeTabId: tabId, group: splitGroupsMap.get(sourceWindow.id) || [], tabGroups: tabGroupsMap.get(sourceWindow.id) || [] });
    updateAllViewBounds(sourceWindow, 110);

    tabs.forEach((t) => {
      if (t.id !== tabId && t.view && !t.view.webContents.isDestroyed()) {
        t.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
      }
    });
  } else {
    tab.url = url;
    tab.isPersistent = isPersistent;
    activeTabId.set(sourceWindow, tabId);

    try {
      const currentStorage = tab.view.webContents.session.storagePath;
      const desired = isPersistent ? "persist:main_storage" : null;
      if (currentStorage !== desired) {
        sourceWindow.contentView.removeChildView(tab.view);
        const view = new WebContentsView({
          webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            partition: isPersistent ? "persist:main_storage" : `incognito_${Date.now()}`,
            contextIsolation: true,
            nodeIntegration: false,
          },
        });
        try {
          applySpoofingToView(view);
          setupContextMenu(view);
        } catch (e) { }

        view.webContents.setWindowOpenHandler(({ url, disposition }) => {
          try {
            const newTabId = tabIdCounter++;
            sourceWindow.webContents.send("new-tab-request");
            setTimeout(() => {
              sourceWindow.webContents.send("navigate-to-url", { url });
            }, 100);
          } catch (e) { }
          return { action: "deny" };
        });

        tab.view = view;
        sourceWindow.contentView.addChildView(view);

        applyTorToNewView(sourceWindow, view);

        registerShortcutHandlers(sourceWindow, view.webContents, true);

        view.webContents.on("did-navigate", (e, newUrl) => {
          tab.url = newUrl;

          try {
            const parsed = new URL(newUrl);
            const host = parsed.hostname;
            const bypass = parsed.searchParams.get('__cheeter_bypass_suspicious') === '1';
            const suspicious = Array.isArray(settings.suspiciousHosts) ? settings.suspiciousHosts : [];
            if (!bypass && host) {
              const match = suspicious.find(s => (typeof s === 'string' && s.toLowerCase() === host.toLowerCase()) || (s && s.host && s.host.toLowerCase() === host.toLowerCase()));
              if (match) {
                const reason = (typeof match === 'object' && match.reason) ? match.reason : undefined;
                let warningPath = typeof MAIN_WINDOW_VITE_DEV_SERVER_URL !== 'undefined'
                  ? `${MAIN_WINDOW_VITE_DEV_SERVER_URL}/errors/suspicious-warning.html?host=${encodeURIComponent(host)}&url=${encodeURIComponent(newUrl)}`
                  : `${getRendererAssetUrl("errors/suspicious-warning.html")}?host=${encodeURIComponent(host)}&url=${encodeURIComponent(newUrl)}`;
                if (reason) warningPath += `&reason=${encodeURIComponent(reason)}`;
                view.webContents.loadURL(warningPath);
                tab.requestedUrl = newUrl;
                tab.displayUrl = `warning:${host}`;
                sourceWindow.webContents.send("on-navigated", tab.displayUrl);
                sourceWindow.webContents.send("update-tab", { tabId, url: tab.displayUrl });
                return;
              }
            }
          } catch (e) { }

          const displayed = tab.displayUrl || newUrl;
          sourceWindow.webContents.send("on-navigated", displayed);
          sourceWindow.webContents.send("update-tab", { tabId, url: displayed });
        });
        view.webContents.on("did-navigate-in-page", (e, newUrl) => {
          tab.url = newUrl;
          const displayed = tab.displayUrl || newUrl;
          sourceWindow.webContents.send("on-navigated", displayed);
          sourceWindow.webContents.send("update-tab", { tabId, url: displayed });
        });

        view.webContents.on("did-fail-load", (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
          if (!isMainFrame || !validatedURL) return;
          try {
            const parsed = new URL(validatedURL);
            const host = parsed.hostname;
            const isLocalHost = host === "localhost" || host === "127.0.0.1" || /^\d+\.\d+\.\d+\.\d+$/.test(host);
            if (parsed.protocol === "https:" && isLocalHost) {
              const httpUrl = validatedURL.replace(/^https:/, "http:");
              console.warn("[did-fail-load] retrying with http for", validatedURL);
              view.webContents.loadURL(httpUrl);
              return;
            }
          } catch (e) { }

          const desc = (errorDescription || '').toString();
          const isNetworkErr = /ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_NETWORK_CHANGED|ERR_CONNECTION_TIMED_OUT|ERR_CONNECTION_ABORTED/i.test(desc) || (typeof errorCode === 'number' && errorCode <= -100);
          if (isNetworkErr) {
            const offlinePath = typeof MAIN_WINDOW_VITE_DEV_SERVER_URL !== 'undefined'
              ? `${MAIN_WINDOW_VITE_DEV_SERVER_URL}/errors/offline.html`
              : getRendererAssetUrl("errors/offline.html");
            try { view.webContents.loadURL(offlinePath); } catch (e) { }
          }
        });

        try {
          const ses = view.webContents.session;
          if (!view._errorPagesRegistered) {
            const onCompleted = (details) => {
              try {
                if (details.webContentsId !== view.webContents.id) return;
                if (details.resourceType === 'mainFrame' && details.statusCode === 404) {
                  const offlinePath = typeof MAIN_WINDOW_VITE_DEV_SERVER_URL !== 'undefined'
                    ? `${MAIN_WINDOW_VITE_DEV_SERVER_URL}/errors/offline.html?url=${encodeURIComponent(details.url)}`
                    : `${getRendererAssetUrl("errors/offline.html")}?url=${encodeURIComponent(details.url)}`;
                  view.webContents.loadURL(offlinePath);
                }
              } catch (e) { }
            };
            ses.webRequest.onCompleted(onCompleted);
            view._errorPagesRegistered = true;
          }
        } catch (e) { }

        view.webContents.on("did-stop-loading", () => {
          const title = view.webContents.getTitle();
          tab.title = title;
          sourceWindow.webContents.send("on-title-changed", title);
          sourceWindow.webContents.send("update-tab", { tabId, title });
          if (activeTabId.get(sourceWindow) === tabId) {
            setWindowTitle(sourceWindow, title, tab.url);
          }
        });
        view.webContents.on("page-title-updated", (event, title) => {
          tab.title = title;
          sourceWindow.webContents.send("on-title-changed", title);
          sourceWindow.webContents.send("update-tab", { tabId, title });
          if (activeTabId.get(sourceWindow) === tabId) {
            setWindowTitle(sourceWindow, title, tab.url);
          }
        });
      }
    } catch (e) { }
  }

  if (tab && tab.view && !tab.view.webContents.isDestroyed()) {
    let finalUrl = url;
    try {
      if (typeof url === "string" && url.startsWith("navigator://")) {
        tab.requestedUrl = url;
        tab.displayUrl = url;
        const parsed = new URL(url);
        let pathPart = "";
        if (parsed.hostname) pathPart += parsed.hostname;
        if (parsed.pathname && parsed.pathname !== "/") pathPart = path.join(pathPart, parsed.pathname.replace(/^\/+/, ""));
        pathPart = pathPart.replace(/^\/+/, "");
        const suffix = `${parsed.search || ""}${parsed.hash || ""}`;
        if (!pathPart) pathPart = "index.html";
        if (!pathPart.includes(".") && !pathPart.endsWith("/")) pathPart = path.join(pathPart, "index.html");
        if (pathPart.endsWith("/")) pathPart = pathPart + "index.html";

        if (typeof MAIN_WINDOW_VITE_DEV_SERVER_URL !== "undefined") {
          finalUrl = `${MAIN_WINDOW_VITE_DEV_SERVER_URL}/${pathPart}${suffix}`;
        } else {
          finalUrl = getRendererAssetUrl(pathPart, suffix);
        }
      } else {
        if (tab) {
          delete tab.requestedUrl;
          delete tab.displayUrl;
        }
      }
    } catch (e) {
      console.error("[navigate-to] failed to resolve navigator:// URL", e);
    }

    tab.view.webContents.loadURL(finalUrl);
  }

  activeTabId.set(sourceWindow, tabId);
  updateAllViewBounds(sourceWindow, 110);
  sourceWindow.webContents.send("tabs-updated", { tabs: serializeTabs(windowTabs.get(sourceWindow) || []), activeTabId: tabId, group: splitGroupsMap.get(sourceWindow.id) || [], tabGroups: tabGroupsMap.get(sourceWindow.id) || [] });
});

ipcMain.on("switch-tab", (event, { tabId }) => {
  const sourceWindow = BrowserWindow.fromWebContents(event.sender);
  if (!sourceWindow || sourceWindow.isDestroyed()) return;

  const tabs = windowTabs.get(sourceWindow);
  if (!tabs) return;

  const tab = tabs.find((t) => t.id === tabId);
  if (!tab || !tab.view || tab.view.webContents.isDestroyed()) return;

  activeTabId.set(sourceWindow, tabId);
  updateAllViewBounds(sourceWindow, 110);

  sourceWindow.webContents.send("on-navigated", tab.url);
  sourceWindow.webContents.send("on-title-changed", tab.title);
  sourceWindow.webContents.send("tabs-updated", { tabs: serializeTabs(tabs), activeTabId: tabId, group: splitGroupsMap.get(sourceWindow.id) || [], tabGroups: tabGroupsMap.get(sourceWindow.id) || [] });
  setWindowTitle(sourceWindow, tab.title, tab.url);
});

function closeTabById(sourceWindow, tabId) {
  if (!sourceWindow || sourceWindow.isDestroyed()) return;

  const tabs = windowTabs.get(sourceWindow);
  if (!tabs) return;

  const tabIndex = tabs.findIndex((t) => t.id === tabId);
  if (tabIndex === -1) return;

  const tab = tabs[tabIndex];
  if (tab.view && !tab.view.webContents.isDestroyed()) {
    sourceWindow.contentView.removeChildView(tab.view);
  }

  tabs.splice(tabIndex, 1);
  windowTabs.set(sourceWindow, tabs);

  const grp = splitGroupsMap.get(sourceWindow.id);
  if (Array.isArray(grp) && grp.includes(tabId)) {
    const newGrp = grp.filter((id) => id !== tabId);
    if (newGrp.length < 2) {
      splitGroupsMap.delete(sourceWindow.id);
      sourceWindow.webContents.send("split-updated", { group: [] });
    } else {
      splitGroupsMap.set(sourceWindow.id, newGrp);
      sourceWindow.webContents.send("split-updated", { group: newGrp });
    }
  }

  removeTabFromGroups(sourceWindow, tabId);

  if (tabs.length === 0) {
    sourceWindow.webContents.send("new-tab-request");
  } else {
    const newActiveTabId = tabs[Math.min(tabIndex, tabs.length - 1)].id;
    sourceWindow.webContents.send("switch-tab-request", { tabId: newActiveTabId });
  }
}

ipcMain.on("close-tab", (event, { tabId }) => {
  const sourceWindow = BrowserWindow.fromWebContents(event.sender);
  closeTabById(sourceWindow, tabId);
});

ipcMain.on("reorder-tabs", (event, newOrder) => {
  const sourceWindow = BrowserWindow.fromWebContents(event.sender);
  if (!sourceWindow || sourceWindow.isDestroyed()) return;

  const tabs = windowTabs.get(sourceWindow);
  if (!tabs || !Array.isArray(newOrder)) return;

  const reordered = [];
  newOrder.forEach((id) => {
    const t = tabs.find((x) => x.id === id);
    if (t) reordered.push(t);
  });

  tabs.forEach((t) => {
    if (!reordered.find((x) => x.id === t.id)) reordered.push(t);
  });

  windowTabs.set(sourceWindow, reordered);

  const currentActiveTabId = activeTabId.get(sourceWindow);
  sourceWindow.webContents.send("tabs-updated", { tabs: serializeTabs(reordered), activeTabId: currentActiveTabId, group: splitGroupsMap.get(sourceWindow.id) || [], tabGroups: tabGroupsMap.get(sourceWindow.id) || [] });
});

function randomColor() {
  const hue = Math.floor(Math.random() * 360);
  const saturation = 60 + Math.floor(Math.random() * 20);
  const lightness = 45 + Math.floor(Math.random() * 10);
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}

function setSplitGroup(win, group) {
  if (!win || win.isDestroyed()) return;
  if (!Array.isArray(group) || group.length < 2) {
    splitGroupsMap.delete(win.id);
    win.webContents.send("split-updated", { group: [] });
  } else {
    const tabs = windowTabs.get(win) || [];
    const valid = group.filter((id) => tabs.find((t) => t.id === id));
    if (valid.length >= 2) {
      splitGroupsMap.set(win.id, valid);
      win.webContents.send("split-updated", { group: valid });
    }
  }

  const uiHeight = uiHeightMap.get(win.id) || 110;
  updateAllViewBounds(win, uiHeight);
}

function setTabGroups(win, groups) {
  if (!win || win.isDestroyed()) return;

  if (!Array.isArray(groups) || groups.length === 0) {
    tabGroupsMap.delete(win.id);
    win.webContents.send("group-updated", { groups: [] });
    return;
  }

  const tabs = windowTabs.get(win) || [];
  const normalized = [];

  groups.forEach((group) => {
    let ids = [];
    let name = getDefaultTabGroupName(win);
    let color = randomColor();

    if (!group) return;
    if (Array.isArray(group.ids)) {
      ids = group.ids;
      if (typeof group.name === "string" && group.name.trim()) name = group.name.trim();
      if (typeof group.color === "string" && group.color.trim()) color = group.color.trim();
    } else if (Array.isArray(group)) {
      ids = group;
    } else {
      return;
    }

    const validIds = Array.from(new Set(ids.filter((id) => tabs.find((t) => t.id === id))));
    if (validIds.length >= 2) {
      normalized.push({ ids: validIds, name, color });
    }
  });

  if (normalized.length) {
    tabGroupsMap.set(win.id, normalized);
    win.webContents.send("group-updated", { groups: normalized });
  } else {
    tabGroupsMap.delete(win.id);
    win.webContents.send("group-updated", { groups: [] });
  }
}

function removeTabFromGroups(win, tabId) {
  if (!win || win.isDestroyed()) return;
  const groups = tabGroupsMap.get(win.id);
  if (!Array.isArray(groups)) return;

  const remaining = groups
    .map((group) => ({
      ids: Array.isArray(group.ids) ? group.ids.filter((id) => id !== tabId) : [],
      name: group.name,
      color: group.color,
    }))
    .filter((group) => Array.isArray(group.ids) && group.ids.length >= 2);

  if (remaining.length) {
    tabGroupsMap.set(win.id, remaining);
    win.webContents.send("group-updated", { groups: remaining });
  } else {
    tabGroupsMap.delete(win.id);
    win.webContents.send("group-updated", { groups: [] });
  }
}

ipcMain.on("split-tabs", (event, { addId, targetId, group }) => {
  const sourceWindow = BrowserWindow.fromWebContents(event.sender);
  if (!sourceWindow || sourceWindow.isDestroyed()) return;

  if (Array.isArray(group)) {
    setSplitGroup(sourceWindow, group);
    return;
  }

  const tabs = windowTabs.get(sourceWindow) || [];
  if (typeof addId === "number" && typeof targetId === "number") {
    let grp = splitGroupsMap.get(sourceWindow.id) || [];
    if (grp.includes(targetId)) {
      if (!grp.includes(addId)) grp.push(addId);
    } else {
      grp = [targetId, addId];
    }
    grp = grp.filter((id, i, arr) => arr.indexOf(id) === i && tabs.find((t) => t.id === id));
    if (grp.length >= 2) {
      setSplitGroup(sourceWindow, grp);
    }
  }
});

ipcMain.on("group-tabs", (event, { group, addId, targetId, removeId, name, color }) => {
  const sourceWindow = BrowserWindow.fromWebContents(event.sender);
  if (!sourceWindow || sourceWindow.isDestroyed()) return;
  const tabs = windowTabs.get(sourceWindow) || [];

  if (Array.isArray(group)) {
    if (group.length === 0) {
      setTabGroups(sourceWindow, []);
      return;
    }

    // If array of IDs, create one group; if array of objects, pass through
    if (group.every((item) => typeof item === "number")) {
      const valid = group.filter((id) => tabs.find((t) => t.id === id));
      if (valid.length >= 2) {
        const existingGroups = tabGroupsMap.get(sourceWindow.id) || [];
        const compacted = existingGroups.filter((g) => !g.ids.some((id) => valid.includes(id)));
        compacted.push({ ids: valid, name: name || "Gruppe", color: color || randomColor() });
        setTabGroups(sourceWindow, compacted);
      }
      return;
    }

    // array of group objects
    const normalized = group.map((g) => {
      if (!g) return null;
      const ids = Array.isArray(g.ids) ? g.ids : Array.isArray(g) ? g : [];
      const groupName = typeof g.name === "string" && g.name.trim() ? g.name.trim() : "Gruppe";
      const groupColor = typeof g.color === "string" && g.color.trim() ? g.color.trim() : randomColor();
      return { ids, name: groupName, color: groupColor };
    }).filter((g) => g && g.ids.length >= 2);

    setTabGroups(sourceWindow, normalized);
    return;
  }

  if (typeof addId === "number" && typeof targetId === "number") {
    let groups = tabGroupsMap.get(sourceWindow.id) || [];
    const groupTarget = groups.find((g) => Array.isArray(g.ids) ? g.ids.includes(targetId) : false);
    if (groupTarget) {
      if (!groupTarget.ids.includes(addId)) {
        groupTarget.ids.push(addId);
      }
    } else {
      groups.push({ ids: [targetId, addId], name: name && name.trim() ? name.trim() : getDefaultTabGroupName(sourceWindow), color: color || randomColor() });
    }
    setTabGroups(sourceWindow, groups);
    return;
  }

  if (typeof removeId === "number") {
    const groups = tabGroupsMap.get(sourceWindow.id) || [];
    const remaining = groups
      .map((g) => {
        const filtered = Array.isArray(g.ids) ? g.ids.filter((id) => id !== removeId) : [];
        return { ids: filtered, name: g.name, color: g.color };
      })
      .filter((g) => g.ids.length >= 2);
    setTabGroups(sourceWindow, remaining);
    return;
  }
});

ipcMain.on("show-tab-context-menu", (event, { tabId }) => {
  const sourceWindow = BrowserWindow.fromWebContents(event.sender);
  if (!sourceWindow || sourceWindow.isDestroyed()) return;

  const currentTabId = activeTabId.get(sourceWindow);
  const splitGroup = splitGroupsMap.get(sourceWindow.id) || [];
  const tabGroups = tabGroupsMap.get(sourceWindow.id) || [];
  const isActive = currentTabId === tabId;
  const isSplit = splitGroup.includes(tabId);
  const groupItem = tabGroups.find((g) => Array.isArray(g.ids) && g.ids.includes(tabId));
  const isGrouped = !!groupItem;

  const template = [
    {
      label: 'Split screen with active tab',
      enabled: !isActive && currentTabId != null,
      click: () => {
        if (currentTabId != null) {
          setSplitGroup(sourceWindow, [currentTabId, tabId]);
        }
      }
    },
    {
      label: 'Create tab group with active tab',
      enabled: !isActive && currentTabId != null,
      click: () => {
        if (currentTabId != null) {
          const groups = tabGroupsMap.get(sourceWindow.id) || [];
          const name = getDefaultTabGroupName(sourceWindow);
          const color = randomColor();
          const newGroup = { ids: [currentTabId, tabId], name, color };
          setTabGroups(sourceWindow, [...groups, newGroup]);
        }
      }
    },
    {
      label: 'Ungroup tab',
      enabled: isGrouped,
      click: () => {
        const groups = (tabGroupsMap.get(sourceWindow.id) || []).map((g) => {
          const leftIds = Array.isArray(g.ids) ? g.ids.filter((id) => id !== tabId) : [];
          return { ids: leftIds, name: g.name, color: g.color };
        }).filter((g) => Array.isArray(g.ids) && g.ids.length >= 2);
        setTabGroups(sourceWindow, groups);
      }
    },
    {
      label: 'Clear split screen',
      enabled: splitGroup.length >= 2,
      click: () => {
        setSplitGroup(sourceWindow, []);
      }
    },
    { type: 'separator' },
    {
      label: 'Close tab',
      click: () => {
        closeTabById(sourceWindow, tabId);
      }
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  menu.popup({ window: sourceWindow });
});

ipcMain.on("get-window-tabs", (event) => {
  const sourceWindow = BrowserWindow.fromWebContents(event.sender);
  if (!sourceWindow || sourceWindow.isDestroyed()) return;

  const tabs = windowTabs.get(sourceWindow) || [];
  const currentActiveTabId = activeTabId.get(sourceWindow);

  sourceWindow.webContents.send("tabs-updated", { tabs: serializeTabs(tabs), activeTabId: currentActiveTabId, group: splitGroupsMap.get(sourceWindow.id) || [], tabGroups: tabGroupsMap.get(sourceWindow.id) || [] });
});

ipcMain.on("browser-control", (e, action) => {
  const sourceWindow = BrowserWindow.fromWebContents(e.sender) || BrowserWindow.getFocusedWindow();
  if (!sourceWindow || sourceWindow.isDestroyed()) return;
  const tabs = windowTabs.get(sourceWindow);
  const currentActiveTabId = activeTabId.get(sourceWindow);
  const tab = tabs?.find((t) => t.id === currentActiveTabId);
  if (!tab || !tab.view || tab.view.webContents.isDestroyed()) return;
  if (action === "back" && tab.view.webContents.navigationHistory.canGoBack()) tab.view.webContents.navigationHistory.goBack();
  if (action === "forward" && tab.view.webContents.navigationHistory.canGoForward()) tab.view.webContents.navigationHistory.goForward();
  if (action === "reload") tab.view.webContents.reload();
});

ipcMain.on("new-tab-request", (event) => {
  const sourceWindow = BrowserWindow.fromWebContents(event.sender);
  if (!sourceWindow || sourceWindow.isDestroyed()) return;
  sourceWindow.webContents.send("new-tab-request");
});

ipcMain.on("menu-action", async (event, data) => {
  try {
    const menuWindowContentId = event.sender.id;
    const sourceWindowId = menuSourceMap.get(menuWindowContentId);
    console.log("[menu-action] received", { fromMenuWebContentsId: menuWindowContentId, sourceWindowId, data });
    let targetWindow = null;
    if (sourceWindowId) {
      targetWindow = BrowserWindow.getAllWindows().find((w) => w.id === sourceWindowId);
    }
    if (!targetWindow || targetWindow.isDestroyed()) {
      try {
        targetWindow = BrowserWindow.fromWebContents(event.sender);
      } catch (e) {
        targetWindow = null;
      }
    }
    if (!targetWindow || targetWindow.isDestroyed()) {
      targetWindow = BrowserWindow.getFocusedWindow();
    }

    if (!targetWindow || targetWindow.isDestroyed()) return;

    const action = data?.action;

    if (action === "new-tab") {
      const newTabId = tabIdCounter++;
      const url = "https://space.cheeter.de";
      const isPersistent = false;
      targetWindow.webContents.send("new-tab-request");
    } else if (action === "toggle-tor") {
      const wid = targetWindow?.id;
      const enabled = !(torEnabled.get(wid) || false);
      if (enabled) {
        // try to reach the local Tor SOCKS proxy first
        const success = await isTorProxyReachable();
        if (!success) {
          dialog.showMessageBox(targetWindow, {
            type: "warning",
            title: "TOR proxy is not reachable",
            message: "It was not able for Cheeter Navigator to reach the local TOR proxy.",
            detail: `Expected proxy: ${DEFAULT_TOR_PROXY}`,
          });
          targetWindow.webContents.send("tor-status", { enabled: false });
          return;
        }
      }

      torEnabled.set(wid, enabled);
      console.log("[tor] toggle requested for window", wid, "->", enabled ? "enable" : "disable");

      try {
        const uiH = uiHeightMap.get(wid) || 110;
        if (enabled) {
          createTorOverlayForWindow(targetWindow, uiH);
        } else {
          destroyTorOverlayForWindow(targetWindow);
        }

        const proxyOk = await setTorProxyForWindow(targetWindow, enabled);
        if (!proxyOk && enabled) {
          console.warn("[tor] proxy configuration for window failed.");
          dialog.showMessageBox(targetWindow, {
            type: "warning",
            title: "TOR proxy error",
            message: "TOR could not be applied to all sessions.",
            detail: "Please check if the TOR service is running and restart the application.",
          });
          // Fallback: disable in UI if unbrauchbar
          torEnabled.set(wid, false);
          destroyTorOverlayForWindow(targetWindow);
          targetWindow.webContents.send("tor-status", { enabled: false });
          return;
        }

        targetWindow.webContents.send("tor-status", { enabled });
      } catch (e) {
        console.error("[tor] error toggling", e);
      }
    } else if (action === "toggle-keypassxc") {
      const enabled = !keyPassXCEnabled;
      await setKeyPassXCEnabled(enabled);
      if (!enabled) {
        targetWindow.webContents.send('keypassxc-status', { enabled: false });
      } else {
        const available = await isKeepassxcAvailable();
        if (!available) {
          dialog.showMessageBox(targetWindow, {
            type: 'warning', title: 'KeyPassXC',
            message: 'KeyPassXC CLI not found',
            detail: 'Please install KeyPassXC and ensure keepassxc-cli is available in PATH.',
          });
          await setKeyPassXCEnabled(false);
        }
      }
    } else if (action === "keypassxc-autofill") {
      await attemptFillFromKeyPassXC(targetWindow);
    } else if (action === "keypassxc-save") {
      await attemptSaveToKeyPassXC(targetWindow);
    } else if (action === "share-page") {
      const url = currentUrl || "https://navigator.cheeter.de";
      const shareUrl = `https://navigator.cheeter.de?share=${encodeURIComponent(url)}`;
      // SECURITY: Validate that the constructed URL is safe before opening externally
      try {
        const parsedShareUrl = new URL(shareUrl);
        if (parsedShareUrl.protocol === 'https:' || parsedShareUrl.protocol === 'http:') {
          shell.openExternal(shareUrl, { activate: true });
        }
      } catch (e) {
        console.error('[share] invalid share URL', e);
      }
    } else if (action === "print-page") {
      const tabs = windowTabs.get(targetWindow);
      const activeTabIdForWin = activeTabId.get(targetWindow);
      const tab = tabs?.find((t) => t.id === activeTabIdForWin);
      if (tab?.view && !tab.view.webContents.isDestroyed()) {
        tab.view.webContents.print({}, (success) => {
          if (!success) console.error("Failed to print");
        });
      }
    } else if (action === "open-manager") {
      const manager = data?.manager;
      const newTabId = tabIdCounter++;
      targetWindow.webContents.send("new-tab-request");
      setTimeout(() => {
        const managerUrls = {
          passwords: "navigator://settings#passwords",
          history: "navigator://settings#history",
          bookmarks: "navigator://settings#bookmarks",
          extensions: "navigator://settings#extensions",
        };
        const url = managerUrls[manager] || "navigator://settings";
        targetWindow.webContents.send("navigate-to-url", { url });
      }, 200);
    } else if (action === "reset") {
      try {
        const userDataPath = app.getPath("userData");
        if (fs.existsSync(userDataPath)) fs.rmSync(userDataPath, { recursive: true, force: true });
      } catch (e) {
        console.error("[reset] failed to remove userData", e);
      }
      app.relaunch();
      app.exit(0);
    } else if (action === "nuke-data") {
      try {
        let settingsBackup = null;
        try {
          if (fs.existsSync(settingsPath)) settingsBackup = fs.readFileSync(settingsPath, "utf-8");
        } catch (e) {
          console.error("[nuke-data] failed to read settings backup", e);
        }

        try {
          const appName = app.getName();
          const appDataRoot = app.getPath("appData");
          const candidates = [
            path.join(appDataRoot, appName),
            path.join(appDataRoot, "Cheeter Navigator"),
            path.join(appDataRoot, "cheeternavigator"),
            path.join(appDataRoot, "Navigator"),
          ];
          if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, "Cheeter Navigator"));
          if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, "Cheeter Navigator"));

          for (const p of candidates) {
            try {
              if (fs.existsSync(p)) {
                fs.rmSync(p, { recursive: true, force: true });
                console.log("[nuke-data] removed appData path:", p);
              }
            } catch (err) {
              console.error("[nuke-data] failed to remove appData path", p, err);
            }
          }
        } catch (e) {
          console.error("[nuke-data] failed to remove appData", e);
        }

        try {
          if (fs.existsSync(lastSessionPath)) fs.rmSync(lastSessionPath, { force: true });
        } catch (e) {
          console.error("[nuke-data] failed to remove lastSession", e);
        }

        try {
          const reportExists = (p) => {
            try { return fs.existsSync(p); } catch { return false; }
          };

          const userDataPath = app.getPath("userData");
          const cachePath = app.getPath("cache");
          const appDataRoot = app.getPath("appData");
          const platformAppDataCandidates = [
            path.join(appDataRoot, app.getName()),
            path.join(appDataRoot, "Cheeter Navigator"),
            path.join(appDataRoot, "cheeternavigator"),
            path.join(appDataRoot, "Navigator"),
            path.join(process.env.HOME || "", "Library", "Application Support", app.getName()),
            path.join(process.env.HOME || "", "Library", "Application Support", "Cheeter Navigator"),
          ];
          if (process.env.APPDATA) {
            platformAppDataCandidates.push(path.join(process.env.APPDATA, "Cheeter Navigator"));
          }
          if (process.env.LOCALAPPDATA) {
            platformAppDataCandidates.push(path.join(process.env.LOCALAPPDATA, "Cheeter Navigator"));
          }

          console.log("[nuke-data] pre-wipe check:", {
            userDataExists: reportExists(userDataPath),
            cacheExists: reportExists(cachePath),
            settingsExists: reportExists(settingsPath),
            lastSessionExists: reportExists(lastSessionPath),
            appDataCandidates: platformAppDataCandidates.map(p => ({ path: p, exists: reportExists(p) })),
          });

          try {
            if (reportExists(userDataPath)) {
              fs.rmSync(userDataPath, { recursive: true, force: true });
              console.log("[nuke-data] removed userData:", userDataPath);
            }
          } catch (err) {
            console.error("[nuke-data] failed to remove userData", err);
          }

          try {
            if (reportExists(cachePath)) {
              fs.rmSync(cachePath, { recursive: true, force: true });
              console.log("[nuke-data] removed cache:", cachePath);
            }
          } catch (err) {
            console.error("[nuke-data] failed to remove cache", err);
          }

          for (const candidate of platformAppDataCandidates) {
            try {
              if (reportExists(candidate)) {
                fs.rmSync(candidate, { recursive: true, force: true });
                console.log("[nuke-data] removed appData candidate:", candidate);
              }
            } catch (err) {
              console.error("[nuke-data] failed to remove appData candidate", candidate, err);
            }
          }

          try {
            if (reportExists(settingsPath)) fs.rmSync(settingsPath, { force: true });
            fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
            fs.writeFileSync(settingsPath, JSON.stringify({ firstRunComplete: false }, null, 2), "utf-8");
            console.log("[nuke-data] cleared settings and forced firstRunComplete=false");
          } catch (err) {
            console.error("[nuke-data] failed to clear/write settings", err);
          }
          try {
            if (reportExists(lastSessionPath)) fs.rmSync(lastSessionPath, { force: true });
          } catch (err) {
            console.error("[nuke-data] failed to remove lastSession (final check)", err);
          }

          console.log("[nuke-data] post-wipe check:", {
            userDataExists: reportExists(userDataPath),
            cacheExists: reportExists(cachePath),
            settingsExists: reportExists(settingsPath),
            lastSessionExists: reportExists(lastSessionPath),
            appDataCandidates: platformAppDataCandidates.map(p => ({ path: p, exists: reportExists(p) })),
          });
        } catch (e) {
          console.error("[nuke-data] unexpected error during full wipe", e);
        }
      } catch (e) {
        console.error("[nuke-data] unexpected error", e);
      }

      app.relaunch();
      app.exit(0);
    } else if (action === "open-url") {
      const url = data?.url;
      if (url) {
        const newTabId = tabIdCounter++;
        targetWindow.webContents.send("new-tab-request");
        setTimeout(() => {
          targetWindow.webContents.send("navigate-to-url", { url });
        }, 100);
      }
    } else if (action === "open-settings") {
      const section = data?.section;
      let navUrl = "navigator://settings";
      if (section) navUrl += `#${section}`;
      showOverlayView(targetWindow, navUrl);
    } else if (action === "make-default-browser") {
      try {
        const httpOk = app.setAsDefaultProtocolClient && app.setAsDefaultProtocolClient("http");
        const httpsOk = app.setAsDefaultProtocolClient && app.setAsDefaultProtocolClient("https");
        console.log("[default] make-default-browser result ->", { http: !!httpOk, https: !!httpsOk });
      } catch (e) {
        console.error("[default] failed to set default browser", e);
        dialog.showMessageBox(targetWindow, { type: "error", message: "Failed to set as default browser. Please set it manually in System Settings." });
      }
    } else if (action === "share-url") {
      const url = data?.url || "https://navigator.cheeter.de";
      const shareUrl = `https://navigator.cheeter.de?share=${encodeURIComponent(url)}`;
      // SECURITY: Validate URL before opening externally
      try {
        const parsedShareUrl = new URL(shareUrl);
        if (parsedShareUrl.protocol === 'https:' || parsedShareUrl.protocol === 'http:') {
          shell.openExternal(shareUrl, { activate: true });
        }
      } catch (e) {
        console.error('[share] invalid share URL', e);
      }
    }
  } catch (err) {
    console.error("[menu-action] error processing action", err);
  }
});

function showOverlayView(win, url) {
  if (!win || win.isDestroyed()) return;
  hideOverlayView(win);

  let loadUrl = url;
  if (url.startsWith("navigator://settings")) {
    const hash = url.includes("#") ? url.substring(url.indexOf("#")) : "";
    loadUrl = typeof MAIN_WINDOW_VITE_DEV_SERVER_URL !== "undefined"
      ? `${MAIN_WINDOW_VITE_DEV_SERVER_URL}/settings/index.html${hash}`
      : getRendererAssetUrl("settings/index.html", hash);
  } else if (url.startsWith("navigator://onboarding")) {
    loadUrl = typeof MAIN_WINDOW_VITE_DEV_SERVER_URL !== "undefined"
      ? `${MAIN_WINDOW_VITE_DEV_SERVER_URL}/onboarding/index.html`
      : getRendererAssetUrl("onboarding/index.html");
  }

  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const bounds = win.getContentBounds();
  view.setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height });
  view.setBackgroundColor("#00000000");

  win.contentView.addChildView(view);
  overlayViewMap.set(win.id, view);
  view.webContents.loadURL(loadUrl).catch((error) => {
    console.error(`[overlay] failed to load ${loadUrl}:`, error);
    if (overlayViewMap.get(win.id) === view) hideOverlayView(win);
  });

  const onResize = () => {
    if (!win.isDestroyed() && !view.webContents.isDestroyed()) {
      const b = win.getContentBounds();
      view.setBounds({ x: 0, y: 0, width: b.width, height: b.height });
    }
  };

  win.on("resize", onResize);
  view.webContents.once("destroyed", () => {
    win.removeListener("resize", onResize);
  });
}

function hideOverlayView(win) {
  if (!win || win.isDestroyed()) return;
  const view = overlayViewMap.get(win.id);
  if (view) {
    win.contentView.removeChildView(view);
    view.webContents.destroy();
    overlayViewMap.delete(win.id);
  }
}

ipcMain.on("close-overlay", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) hideOverlayView(win);
});

let manipulationManager = null;
class ManipulationManager {
  constructor() {
    this.running = false;
    this.records = new Map();
    this.queriesPath = path.join(__dirname, "data", "manipulation-queries.json");
  }

  _readQueries() {
    try {
      if (fs.existsSync(this.queriesPath)) {
        const raw = fs.readFileSync(this.queriesPath, "utf-8");
        return JSON.parse(raw || "{}");
      }
    } catch (e) {
      console.error("[manipulation] failed to read queries", e);
    }
    return { sites: [], queries: [] };
  }

  async _createManipulationTab(win) {
    try {
      const tabs = windowTabs.get(win) || [];
      const newTabId = tabIdCounter++;
      const isPersistent = false;
      const prevIds = (windowTabs.get(win) || []).map((t) => t.id);
      const previousActive = activeTabId.get(win);

      win.webContents.send("new-tab-request");

      const start = Date.now();
      let found = null;
      while (Date.now() - start < 3000) {
        const tabsArr = windowTabs.get(win) || [];
        const candidate = tabsArr.find((t) => !prevIds.includes(t.id));
        if (candidate) {
          found = candidate;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }

      if (!found) return null;
      found.__isManipulation = true;
      try {
        win.webContents.send("tabs-updated", { tabs: serializeTabs(windowTabs.get(win) || []), activeTabId: activeTabId.get(win), group: splitGroupsMap.get(win.id) || [], tabGroups: tabGroupsMap.get(win.id) || [] });
      } catch (e) { }
      try {
        updateAllViewBounds(win, uiHeightMap.get(win.id) || 110);
      } catch (e) { }

      if (typeof previousActive !== "undefined" && previousActive !== null) {
        activeTabId.set(win, previousActive);
        try {
          win.webContents.send("switch-tab-request", { tabId: previousActive });
        } catch (e) { }
      }

      const tab = found;
      try {
        win.webContents.send("tabs-updated", { tabs: serializeTabs(windowTabs.get(win) || []), activeTabId: activeTabId.get(win), group: splitGroupsMap.get(win.id) || [], tabGroups: tabGroupsMap.get(win.id) || [] });
      } catch (e) { }

      return tab;
    } catch (e) {
      console.error("[manipulation] _createManipulationTab error", e);
      return null;
    }
  }

  _pick(arr) {
    try {
      if (!Array.isArray(arr) || arr.length === 0) return null;
      return arr[crypto.randomInt(arr.length)];
    } catch (e) {
      return arr[Math.floor(Math.random() * arr.length)];
    }
  }

  _getSearchUrl(qStr) {
    const enc = encodeURIComponent(qStr);
    const choices = [`https://space.cheeter.de/s.php#gsc.tab=0&gsc.q=${enc}`, `https://duckduckgo.com/?q=${enc}`, `https://www.bing.com/search?q=${enc}`];
    return this._pick(choices);
  }

  async _runLoopForTab(win, tabId, type) {
    try {
      const q = this._readQueries();
      const sites = (Array.isArray(q.sites) && q.sites.length ? q.sites.slice() : ["walmart-content.com", "https://walmart.cn", "https://walmart.com", "https://walmart.pharmacy", "https://walmartimages.com", "https://wmt.co", "https://wanfangdata.com.cn", "https://wf.pub", "https://cdn.com", "https://8686c.com", "https://cdn0.com", "cdn0.org", "cdnmg.com", "chinanetcenter.com", "lxdns.cn", "lxdns.com", "lxdns.info", "lxdns.net",
        "lxdns.org",
        "mwcdns.com",
        "mwcloudcdn.com",
        "ourdvsss.com",
        "qtlcdn.cn",
        "qtlcdn.com",
        "qtlcdn.net",
        "speedws.info",
        "speedws.org",
        "wangsu.com",
        "wscdns.com",
        "wscdns.info",
        "wscdns.org",
        "wsdvs.com",
        "wsglb.com",
        "wsglb.net",
        "wswebcdn.com",
        "wswebpic.com",
        "benliton.com",
        "chinatimes.com",
        "chinatimes.com.tw",
        "ctee.com.tw",
        "ctitv.com.tw",
        "ctv.com.tw",
        "ctwant.com",
        "infotimes.com.tw",
        "lecoin.cc",
        "loveparents.org",
        "superstation.com.tw",
        "want-media.com",
        "wantblogger.com",
        "zwtvusa.com",
        "aichongzoo.cn",
        "hzdtv.tv",
        "hzman.net",
        "wasu.cn",
        "wasu.tv",
        "wasumedia.cn",
        "watchout",
        "waa.tw",
        "watchout.tw",
        "warnerbrosgames.com",
        "wbagora.com",
        "wbgames.com",
        "wbinsights.com",
        "datarouter.apps.netherrealm.com",
        "wb-agora-hydra-file-storage-.s.amazonaws.com",
        "hf-aw.cn",
        "hf-aw.com",
        "huafeng-accuweather.cn",
        "huafengaw.com",
        "weathercn.com",
        "webex.ca",
        "webex.co.in",
        "webex.co.it",
        "webex.co.jp",
        "webex.co.kr",
        "webex.co.nz",
        "webex.co.uk",
        "webex.com",
        "webex.com.au",
        "webex.com.br",
        "webex.com.cncn",
        "webex.com.hk",
        "webex.com.mx",
        "webex.de",
        "webex.es",
        "webtype",
        "webtype.com",
        "weiphone",
        "feng.com",
        "fengimg.com",
        "wfdata.club",
        "wenshushu",
        "wenshushu.cn",
        "wenshushu.com",
        "wenxiaozhan.cn",
        "wenxiaozhan.com",
        "wenxiaozhan.net",
        "wss.cc",
        "wss.email",
        "wss.ink",
        "wss.pet",
        "wss.show",
        "wss.zone",
        "ws.cn",
        "g-technology.com",
        "sandisk.ae",
        "sandisk.cncn",
        "sandisk.co.jp",
        "sandisk.co.kr",
        "sandisk.co.uk",
        "sandisk.com",
        "sandisk.com.au",
        "sandisk.com.br",
        "sandisk.com.tr",
        "sandisk.com.tw",
        "sandisk.de",
        "sandisk.es",
        "sandisk.fr",
        "sandisk.hk",
        "sandisk.id",
        "sandisk.in",
        "sandisk.it",
        "sandisk.nl",
        "sandisk.sg",
        "wd.com",
        "wdc.com",
        "westerndigital.com",
        "whatsapp",
        "graph.whatsapp.comads",
        "graph.whatsapp.netads",
        "wa.me",
        "whatsapp-plus.info",
        "whatsapp-plus.me",
        "whatsapp-plus.net",
        "whatsapp.cc",
        "whatsapp.com",
        "whatsapp.info",
        "whatsapp.net",
        "whatsapp.org",
        "whatsapp.tv",
        "whatsappbrand.com",
        "whatsapp-ads",
        "graph.whatsapp.comads",
        "graph.whatsapp.netads",
        "wholefoodsmarket",
        "wfm.com",
        "wholecitiesfoundation.org",
        "wholefoods.com",
        "wholefoodsmarket.co.uk",
        "wholefoodsmarket.com",
        "wholekidsfoundation.org",
        "wholeplanetfoundation.org",
        "wikidot",
        "wdfiles.com",
        "wikidot.com",
        "wikihow",
        "wikihow.com",
        "wikimedia",
        "mediawiki.org",
        "toolforge.org",
        "wikibooks.org",
        "wikidata.org",
        "wikimedia.org",
        "wikimediacloud.org",
        "wikimediafoundation.org",
        "wikinews.org",
        "wikipedia.org",
        "wikiquote.org",
        "wikisource.org",
        "wikiversity.org",
        "wikivoyage.org",
        "wiktionary.org",
        "wmcloud.org",
        "wmflabs.org",
        "wmfusercontent.org",
        "wildberries",
        "geobasket.ru",
        "paywb.com",
        "rwb.ru",
        "wb-basket.ru",
        "wb.ru",
        "wbbasket.ru",
        "wbpay.ru",
        "wibes.ru",
        "wildberries.ru",
        "wildberries.ru",
        "codeium.com",
        "codeiumdata.com",
        "windsurf.build",
        "windsurf.com",
        "windy",
        "windy.com",
        "wink",
        "ngenix.net",
        "restream-media.net",
        "wink.ru",
        "wise",
        "transferwise.com",
        "wise.com",
        "wisecoin.com",
        "wiseid.com",
        "wisekey.com",
        "wisekey.com.hk",
        "wish.com",
        "wistia",
        "embedwistia-a.akamaihd.net",
        "wistia.com",
        "wistia.net",
        "wamawama.com",
        "wiwide.com",
        "editorx.com",
        "parastorage.com",
        "wix-code.com",
        "wix.com",
        "wixanswers.com",
        "wixapps.net",
        "wixmp.com",
        "wixsite.com",
        "wixstatic.com",
        "wjx.cn",
        "wjx.com",
        "wjx.top",
        "wol.tv",
        "wolai.com",
        "wostatic.cn",
        "woolite",
        "woolite.ca",
        "woolite.cncn",
        "woolite.com",
        "woolite.com.cncn",
        "woolite.pl",
        "woolite.us",
        "woolitecarpet.com",
        "wordpress",
        "videopress.com",
        "w.org",
        "wordpress.com",
        "wordpress.org",
        "wordpress.tv",
        "wp-themes.com",
        "wp.com",
        "wpvip.com",
        "wps",
        "dzt.com",
        "docer.com",
        "iciba.com",
        "kdocs.cn",
        "kscord.com",
        "papocket.com",
        "qwps.cn",
        "wps.cn",
        "wps.com",
        "wpscdn.cn",
        "wpscdn.com",
        "wpsmail.net",
        "wpspdf.cn",
        "careerjournal.com",
        "collegejournal.com",
        "opinionjournal.com",
        "realestatejournal.com",
        "startupjournal.com",
        "wsj.com",
        "wsj.jobs",
        "wsj.net",
        "wsjmediakit.com",
        "wsjplus.com",
        "wsjshop.com",
        "wsjwine.com",
        "wwe",
        "wwe.com",
        "wwe.com",
        "wynd",
        "wynd.network",
        "wyndlabs.ai",
        "ads-twitter.comads",
        "cms-twdigitalassets.com",
        "grok.com",
        "periscope.tv",
        "pscp.tv",
        "t.co",
        "tellapart.com",
        "tweetdeck.com",
        "twimg.com",
        "twitpic.com",
        "twitter.biz",
        "twitter.com",
        "twitter.jp",
        "twitter.map.fastly.net",
        "twittercommunity.com",
        "twitterflightschool.com",
        "twitterinc.com",
        "twitteroauth.com",
        "twitterstat.us",
        "twtrdns.net",
        "twttr.com",
        "twttr.net",
        "twvid.com",
        "vine.co",
        "x.ai",
        "x.com",
        "5ka.ru",
        "5post.market",
        "chizhik.club",
        "clubx5.ru",
        "dialogx5.ru",
        "e5.ru",
        "fivepost.ru",
        "idx5.ru",
        "jx5.ru",
        "keyx5.ru",
        "mnogolososya.ru",
        "myapelsin.ru",
        "okolo.app",
        "perekrestok.com",
        "perekrestok.ru",
        "x5.ai",
        "x5.com",
        "x5.digital",
        "x5.group",
        "x5.media",
        "x5.ru",
        "x5.team",
        "x5.tech",
        "x5club.ru",
        "x5id.ru",
        "x5l.ru",
        "x5paket.ru",
        "x5q.ru",
        "x5static.net",
        "x5w.ru",
        "grok.com",
        "grok.x.com",
        "x.ai",
        "xbox",
        "asobostudio.com",
        "beth.games",
        "bethesda.net",
        "bethesdagamestudios.com",
        "bethsoft.com",
        "callersbane.com",
        "doom.com",
        "elderscrolls.com",
        "flightsimulator.com",
        "forza.net",
        "forzamotorsport.net",
        "forzaracingchampionship.com",
        "forzarc.com",
        "gamepass.com",
        "minecraft-services.net",
        "minecraft.net",
        "minecraftservices.com",
        "minecraftshop.com",
        "mojang.com",
        "orithegame.com",
        "renovacionxboxlive.com",
        "tellmewhygame.com",
        "xbox",
        "xbox.co",
        "xbox.com",
        "xbox.eu",
        "xbox.org",
        "xbox60.co",
        "xbox60.com",
        "xbox60.eu",
        "xbox60.org",
        "xboxab.com",
        "xboxgamepass.com",
        "xboxgamestudios.com",
        "xboxlive.cncn",
        "xboxlive.com",
        "xboxone.co",
        "xboxone.com",
        "xboxone.eu",
        "xboxplayanywhere.com",
        "xboxservices.com",
        "xboxstudios.com",
        "xbx.lv",
        "flightsimulator.azureedge.net",
        "prodforza.blob.core.windows.net",
        "xd",
        "ro.com",
        "tapapks.com",
        "tapimg.com",
        "tapimg.net",
        "taptap.cn",
        "taptap.com",
        "taptap.io!cn",
        "taptapdada.com",
        "xd.cn",
        "xd.com",
        "xdcdn.net",
        "xindong.com",
        "xda",
        "xda-cdn.com",
        "xda-developers.com",
        "xdaforums.com",
        "xdaimages.com",
        "xdty",
        "xdty.org",
        "xedge",
        "ganjiangvpn.com",
        "glxcc.net",
        "xedge.cc",
        "xn0.cc",
        "xhamster",
        "collector.xhamster.comads",
        "xhamster.com",
        "xhamster.desi",
        "xhamster.xxx",
        "xhamste8.com",
        "xhamste8.desi",
        "xhamsterlive.com",
        "xhcdn.com",
        "widgets.stripst.com",
        "xhamster-ads",
        "collector.xhamster.comads",
        "xiaoheihe",
        "xhh.cn",
        "accxiaoheihe.com",
        "chat.top",
        "debugmode.cn",
        "max-c.com",
        "maxadmin.cn",
        "maxjia.com",
        "xiaoheihe.cn",
        "askdiandian.com",
        "diandianlife.top",
        "rednotecdn.com",
        "xhscdn.com",
        "xhscdn.net",
        "xhslink.com",
        "xiaohongshu.com",
        "a.market.xiaomi.comads",
        "ad.intl.xiaomi.comads",
        "ad.mi.comads",
        "ad.xiaomi.comads",
        "a.xiaomi.comads",
        "admob.xiaomi.comads",
        "adv.sec.intl.miui.comads",
        "adv.sec.miui.comads",
        "airstarfinance.net",
        "c.mi.com!cn",
        "data.mistat.india.xiaomi.comads",
        "data.mistat.intl.xiaomi.comads",
        "data.mistat.rus.xiaomi.comads",
        "data.mistat.xiaomi.comads",
        "duokan.com",
        "duokanbox.com",
        "global.market.xiaomi.com!cn",
        "logupdate.avlyun.sec.miui.comads",
        "mgslb.com",
        "mi-idc.com",
        "mi-img.com",
        "mi.com",
        "miaibox.com",
        "mifile.cn",
        "migames.com",
        "mijia.tech",
        "miot-spec.org",
        "mipay.com",
        "misc.in.duokanbox.comads",
        "mitvos.com",
        "miui.com",
        "miwifi.com",
        "saxyit.com",
        "sentry.d.mi.comads",
        "sentry.d.xiaomi.netads",
        "stats.music.xiaomi.comads",
        "tjqonline.cnads",
        "tracker.ai.xiaomi.comads",
        "tracker.xiaomixiaoai.comads",
        "tracking.miui.comads",
        "wali.com",
        "xiaoaiassist.com",
        "xiaomi.cn",
        "xiaomi.com",
        "xiaomi.net",
        "xiaomicp.com",
        "xiaomidns.cn",
        "xiaomidns.com",
        "xiaomidns.com.cn",
        "xiaomidns.net",
        "xiaomiev.com",
        "xiaomiinc.cn",
        "xiaomiinc.com",
        "xiaomiinc.com.cn",
        "xiaomiinc.net",
        "xiaomimimo.com",
        "xiaomimobile.com",
        "xiaominr.com",
        "xiaomiprint.com",
        "xiaomisa.cn",
        "xiaomisa.com",
        "xiaomisa.net",
        "xiaomisa.org",
        "xiaomiwear.com",
        "xiaomixiaoai.com",
        "xiaomiyoupin.com",
        "youpin.cn",
        "youpin.com.cn",
        "zmifi.com",
        "xiaomi-ads",
        "a.market.xiaomi.comads",
        "ad.intl.xiaomi.comads",
        "ad.mi.comads",
        "ad.xiaomi.comads",
        "a.xiaomi.comads",
        "admob.xiaomi.comads",
        "adv.sec.intl.miui.comads",
        "adv.sec.miui.comads",
        "data.mistat.india.xiaomi.comads",
        "data.mistat.intl.xiaomi.comads",
        "data.mistat.rus.xiaomi.comads",
        "data.mistat.xiaomi.comads",
        "logupdate.avlyun.sec.miui.comads",
        "misc.in.duokanbox.comads",
        "sentry.d.mi.comads",
        "sentry.d.xiaomi.netads",
        "stats.music.xiaomi.comads",
        "tjqonline.cnads",
        "tracker.ai.xiaomi.comads",
        "tracker.xiaomixiaoai.comads",
        "tracking.miui.comads",
        "miaibox.com",
        "xiaoaiassist.com",
        "xiaomimimo.com",
        "xiaomi-iot",
        "account.xiaomi.com",
        "cn-ha.mqtt.io.mi.com",
        "ha.api.io.mi.com",
        "miot-spec.org",
        "xiaoyuzhou",
        "podcast.xyz",
        "xiaoyuzhoufm.com",
        "xyzcdn.net",
        "xyzfm.link",
        "xyzfm.space",
        "ximalaya",
        "ximalaya.com",
        "xmcdn.com",
        "ximalaya-ads",
        "adbehavior.ximalaya.comads",
        "adse.wsa.ximalaya.comads",
        "adse.ximalaya.comads",
        "xingkongwuxianmedia",
        "avstar.me",
        "avstar0.me",
        "avstar0.me",
        "avstar04.com",
        "avstar04.me",
        "avstar05.me",
        "avstar06.me",
        "avstar07.com",
        "avstar07.me",
        "avstar0.com",
        "avstar0.me",
        "avsta.com",
        "avstar.com",
        "avstar.com",
        "avstar4.com",
        "avstar5.com",
        "avstar6.com",
        "avstar8.com",
        "avstar.com",
        "xingrz",
        "xingrz.me",
        "xnxx-cdn.com",
        "xnxx.com",
        "xnxx.net",
        "xnxx.tv",
        "xnxx.com",
        "speiyou.com",
        "xesimg.com",
        "xueersi.com",
        "aiganggu.com",
        "danjuanfunds.com",
        "imedao.com",
        "snowballsecurities.com",
        "xueqiu.com",
        "00cdn.com",
        "88cdn.com",
        "pcdn.com",
        "sandai.net",
        "thundercdn.com",
        "thunderurl.com",
        "xunlei.com",
        "xycdn.com",
        "xycloud.com",
        "xv-ru.com",
        "xvideos-ar.com",
        "xvideos-cdn.com",
        "xvideos-india.com",
        "xvideos.com",
        "ads.yahoo.comads",
        "flic.kr",
        "flickr",
        "flickr.com",
        "flickr.net",
        "gemini.yahoo.comads",
        "maktoob.com",
        "myguide.hk",
        "staticflickr.com",
        "techcrunch.com",
        "yahoo",
        "yahoo-news.com.hk",
        "yahoo.ae",
        "yahoo.am",
        "yahoo.as",
        "yahoo.at",
        "yahoo.az",
        "yahoo.ba",
        "yahoo.be",
        "yahoo.bg",
        "yahoo.bi",
        "yahoo.bs",
        "yahoo.bt",
        "yahoo.by",
        "yahoo.ca",
        "yahoo.cat",
        "yahoo.cd",
        "yahoo.cg",
        "yahoo.ch",
        "yahoo.cl",
        "yahoo.cm",
        "yahoo.cncn",
        "yahoo.co.ao",
        "yahoo.co.bw",
        "yahoo.co.ck",
        "yahoo.co.cr",
        "yahoo.co.id",
        "yahoo.co.il",
        "yahoo.co.in",
        "yahoo.co.jp",
        "yahoo.co.kr",
        "yahoo.co.mz",
        "yahoo.co.nz",
        "yahoo.co.th",
        "yahoo.co.tz",
        "yahoo.co.uk",
        "yahoo.co.uz",
        "yahoo.co.ve",
        "yahoo.co.vi",
        "yahoo.co.za",
        "yahoo.com",
        "yahoo.com.af",
        "yahoo.com.ag",
        "yahoo.com.ai",
        "yahoo.com.ar",
        "yahoo.com.au",
        "yahoo.com.bd",
        "yahoo.com.bo",
        "yahoo.com.br",
        "yahoo.com.bz",
        "yahoo.com.cncn",
        "yahoo.com.co",
        "yahoo.com.do",
        "yahoo.com.ec",
        "yahoo.com.eg",
        "yahoo.com.es",
        "yahoo.com.fj",
        "yahoo.com.gi",
        "yahoo.com.gt",
        "yahoo.com.hk",
        "yahoo.com.kw",
        "yahoo.com.lb",
        "yahoo.com.ly",
        "yahoo.com.mt",
        "yahoo.com.mx",
        "yahoo.com.my",
        "yahoo.com.na",
        "yahoo.com.nf",
        "yahoo.com.om",
        "yahoo.com.pa",
        "yahoo.com.pe",
        "yahoo.com.ph",
        "yahoo.com.pk",
        "yahoo.com.pr",
        "yahoo.com.py",
        "yahoo.com.sa",
        "yahoo.com.sb",
        "yahoo.com.sg",
        "yahoo.com.sv",
        "yahoo.com.tj",
        "yahoo.com.tr",
        "yahoo.com.tw",
        "yahoo.com.ua",
        "yahoo.com.uy",
        "yahoo.com.vc",
        "yahoo.com.vn",
        "yahoo.cz",
        "yahoo.de",
        "yahoo.dj",
        "yahoo.dk",
        "yahoo.dm",
        "yahoo.ee",
        "yahoo.es",
        "yahoo.fi",
        "yahoo.fm",
        "yahoo.fr",
        "yahoo.ge",
        "yahoo.gg",
        "yahoo.gl",
        "yahoo.gm",
        "yahoo.gp",
        "yahoo.gr",
        "yahoo.gy",
        "yahoo.hk",
        "yahoo.hr",
        "yahoo.hu",
        "yahoo.ie",
        "yahoo.im",
        "yahoo.in",
        "yahoo.is",
        "yahoo.it",
        "yahoo.je",
        "yahoo.jo",
        "yahoo.la",
        "yahoo.lt",
        "yahoo.lu",
        "yahoo.lv",
        "yahoo.md",
        "yahoo.me",
        "yahoo.mk",
        "yahoo.mw",
        "yahoo.mx",
        "yahoo.net",
        "yahoo.nl",
        "yahoo.no",
        "yahoo.nu",
        "yahoo.ph",
        "yahoo.pl",
        "yahoo.pn",
        "yahoo.ps",
        "yahoo.pt",
        "yahoo.ro",
        "yahoo.ru",
        "yahoo.rw",
        "yahoo.se",
        "yahoo.sg",
        "yahoo.sh",
        "yahoo.si",
        "yahoo.sk",
        "yahoo.sm",
        "yahoo.sn",
        "yahoo.so",
        "yahoo.sr",
        "yahoo.st",
        "yahoo.tg",
        "yahoo.tk",
        "yahoo.tl",
        "yahoo.tm",
        "yahoo.tn",
        "yahoo.vg",
        "yahoo.ws",
        "yahooapis.com",
        "yahoodns.net",
        "yahoofinance.com",
        "yahoohealth.com",
        "yahoomusic.com",
        "yahoosandbox.com",
        "yahoosportsbook.com",
        "yho.com",
        "yimg.com",
        "yimg.jp",
        "ymail.com",
        "ysm.yahoo.comads",
        "yusercontent.com",
        "cdn.js7k.com",
        "yahoo-ads",
        "ads.yahoo.comads",
        "gemini.yahoo.comads",
        "ysm.yahoo.comads",
        "adfox.ru",
        "admetrica.ru",
        "kinopoisk-ru.clstorage.net",
        "kinopoisk.ru",
        "naydex.net",
        "rostaxi.org",
        "turbopages.org",
        "webvisor.com",
        "webvisor.org",
        "ya.ru",
        "yads.tech",
        "yandex",
        "yandex-bank.net",
        "yandex-images.clstorage.net",
        "yandex-team.ru",
        "yandex.aero",
        "yandex.az",
        "yandex.by",
        "yandex.cloud",
        "yandex.co.il",
        "yandex.com",
        "yandex.com.am",
        "yandex.com.ge",
        "yandex.com.ru",
        "yandex.com.tr",
        "yandex.com.ua",
        "yandex.de",
        "yandex.ee",
        "yandex.eu",
        "yandex.fi",
        "yandex.fr",
        "yandex.jobs",
        "yandex.kg",
        "yandex.kz",
        "yandex.lt",
        "yandex.lv",
        "yandex.md",
        "yandex.net",
        "yandex.org",
        "yandex.pl",
        "yandex.ru",
        "yandex.st",
        "yandex.sx",
        "yandex.tj",
        "yandex.tm",
        "yandex.tr",
        "yandex.ua",
        "yandex.uz",
        "yandexadexchange.net",
        "yandexcloud.net",
        "yandexcom.net",
        "yandexmetrica.com",
        "yandexwebcache.org",
        "yastat.net",
        "yastatic.net",
        "yandex-pogoda.static-storage.net",
        "ycombinator",
        "startupschool.org",
        "ycombinator.com",
        "ymtc.cn",
        "ymtc.com",
        "ymtc.com.cn",
        "ynet.cn",
        "ynet.com",
        "ynet.com.cn",
        "ynoproject",
        "ynoproject.net",
        "dobest.com",
        "langrenclub.com",
        "sanguosha.com",
        "xhlsgs.com",
        "xinwuji.com",
        "yokaverse.com",
        "zhuoyou.com",
        "chuokoron.jp",
        "fujinkoron.jp",
        "hochi.news",
        "ryokoyomiuri.co.jp",
        "the-japan-news.com",
        "ync.ne.jp",
        "yomikyo.or.jp",
        "yomilogi.com",
        "yomiuri-johkai.co.jp",
        "yomiuri-ryokou.co.jp",
        "yomiuri-shimbun.pressreader.com",
        "yomiuri-systec.co.jp",
        "yomiuri.co.jp",
        "youjizz",
        "yjcontentdelivery.com",
        "youjizz.com",
        "cibntv.net",
        "kumiao.com",
        "mmstat.com",
        "soku.com",
        "ykimg.com",
        "youku.com",
        "youku-ads",
        "ad.api.g.youku.comads",
        "ad.api.mobile.youku.comads",
        "ad.mobile.youku.comads",
        "adashx.ut.youku.comads",
        "atm.youku.comads",
        "e.stat.ykimg.comads",
        "ems.youku.comads",
        "guanggaoad.youku.comads",
        "h-adashx.ut.youku.comads",
        "lstat.youku.comads",
        "mobilemsg.youku.comads",
        "msg.youku.comads",
        "p-log.ykimg.comads",
        "passport-log.youku.comads",
        "pl.youku.comads",
        "s-adashx.ut.youku.comads",
        "stat.youku.comads",
        "statis.api.g.youku.comads",
        "v6-adashx.ut.youku.comads",
        "yk-ssp.ad.youku.comads",
        "ykad-data.youku.comads",
        "youmind",
        "youmind.ai",
        "youmind.com",
        "youmind.site",
        "extremetube.com",
        "keezmovies.com",
        "yopornshop.com",
        "youporn.com",
        "youporngay.com",
        "youpornpremium.com",
        "youpornru.com",
        "ypncdn.com",
        "aitcfw.com",
        "aizgtc.com",
        "hangzhouyq.cn",
        "hangzhouyq.com",
        "zgxytc.com",
        "zgzsa.com",
        "zhonshian.cn",
        "zhonshian.com",
        "zhonshian.com.cn",
        "zjzsa.com",
        "ggpht.cncn",
        "ggpht.com",
        "googlevideo.com",
        "wide-youtube.l.google.com",
        "withyoutube.com",
        "youtu.be",
        "youtube",
        "youtube-nocookie.com",
        "youtube-ui.l.google.com",
        "youtube.ae",
        "youtube.al",
        "youtube.am",
        "youtube.at",
        "youtube.az",
        "youtube.ba",
        "youtube.be",
        "youtube.bg",
        "youtube.bh",
        "youtube.bo",
        "youtube.by",
        "youtube.ca",
        "youtube.cat",
        "youtube.ch",
        "youtube.cl",
        "youtube.co",
        "youtube.co.ae",
        "youtube.co.at",
        "youtube.co.cr",
        "youtube.co.hu",
        "youtube.co.id",
        "youtube.co.il",
        "youtube.co.in",
        "youtube.co.jp",
        "youtube.co.ke",
        "youtube.co.kr",
        "youtube.co.ma",
        "youtube.co.nz",
        "youtube.co.th",
        "youtube.co.tz",
        "youtube.co.ug",
        "youtube.co.uk",
        "youtube.co.ve",
        "youtube.co.za",
        "youtube.co.zw",
        "youtube.com",
        "youtube.com.ar",
        "youtube.com.au",
        "youtube.com.az",
        "youtube.com.bd",
        "youtube.com.bh",
        "youtube.com.bo",
        "youtube.com.br",
        "youtube.com.by",
        "youtube.com.co",
        "youtube.com.do",
        "youtube.com.ec",
        "youtube.com.ee",
        "youtube.com.eg",
        "youtube.com.es",
        "youtube.com.gh",
        "youtube.com.gr",
        "youtube.com.gt",
        "youtube.com.hk",
        "youtube.com.hn",
        "youtube.com.hr",
        "youtube.com.jm",
        "youtube.com.jo",
        "youtube.com.kw",
        "youtube.com.lb",
        "youtube.com.lv",
        "youtube.com.ly",
        "youtube.com.mk",
        "youtube.com.mt",
        "youtube.com.mx",
        "youtube.com.my",
        "youtube.com.ng",
        "youtube.com.ni",
        "youtube.com.om",
        "youtube.com.pa",
        "youtube.com.pe",
        "youtube.com.ph",
        "youtube.com.pk",
        "youtube.com.pt",
        "youtube.com.py",
        "youtube.com.qa",
        "youtube.com.ro",
        "youtube.com.sa",
        "youtube.com.sg",
        "youtube.com.sv",
        "youtube.com.tn",
        "youtube.com.tr",
        "youtube.com.tw",
        "youtube.com.ua",
        "youtube.com.uy",
        "youtube.com.ve",
        "youtube.cr",
        "youtube.cz",
        "youtube.de",
        "youtube.dk",
        "youtube.ee",
        "youtube.es",
        "youtube.fi",
        "youtube.fr",
        "youtube.ge",
        "youtube.googleapis.com",
        "youtube.gr",
        "youtube.gt",
        "youtube.hk",
        "youtube.hr",
        "youtube.hu",
        "youtube.ie",
        "youtube.in",
        "youtube.iq",
        "youtube.is",
        "youtube.it",
        "youtube.jo",
        "youtube.jp",
        "youtube.kr",
        "youtube.kz",
        "youtube.la",
        "youtube.lk",
        "youtube.lt",
        "youtube.lu",
        "youtube.lv",
        "youtube.ly",
        "youtube.ma",
        "youtube.md",
        "youtube.me",
        "youtube.mk",
        "youtube.mn",
        "youtube.mx",
        "youtube.my",
        "youtube.ng",
        "youtube.ni",
        "youtube.nl",
        "youtube.no",
        "youtube.pa",
        "youtube.pe",
        "youtube.ph",
        "youtube.pk",
        "youtube.pl",
        "youtube.pr",
        "youtube.pt",
        "youtube.qa",
        "youtube.ro",
        "youtube.rs",
        "youtube.ru",
        "youtube.sa",
        "youtube.se",
        "youtube.sg",
        "youtube.si",
        "youtube.sk",
        "youtube.sn",
        "youtube.soy",
        "youtube.sv",
        "youtube.tn",
        "youtube.tv",
        "youtube.ua",
        "youtube.ug",
        "youtube.uy",
        "youtube.vn",
        "youtubeeducation.com",
        "youtubeembeddedplayer.googleapis.com",
        "youtubefanfest.com",
        "youtubegaming.com",
        "youtubego.co.id",
        "youtubego.co.in",
        "youtubego.com",
        "youtubego.com.br",
        "youtubego.id",
        "youtubego.in",
        "youtubei.googleapis.com",
        "youtubekids.com",
        "youtubemobilesupport.com",
        "yt.be",
        "ytimg.com",
        "yt.googleusercontent.com",
        "youzan",
        "youzan.com",
        "youzanyun.com",
        "yzcdn.cn",
        "yto-express",
        "gpall.cn",
        "gpall.net",
        "kjwugx.com",
        "mamayz.cn",
        "mamayz.com",
        "mumbuy65.com",
        "nellit.cn",
        "nellit.com.cn",
        "nellit.info",
        "nellit.net",
        "nellit.net.cn",
        "nellit.org.cn",
        "nellit.xyz",
        "sxgou.cn",
        "tianxiajiameng.cn",
        "tianxiajiameng.com",
        "yt0.cc",
        "yto-jsd.com",
        "yto-lgs.com",
        "yto-lgs.net",
        "yto.net.cn",
        "yto.top",
        "yto.vip",
        "yto.xin",
        "yto56.com.cn",
        "yto56.net.cn",
        "yto56test.com",
        "ytocargo.com",
        "ytocargo.com.cn",
        "ytoexpress.com",
        "ytoholding.com",
        "ytojg.com.cn",
        "ytokj.cn",
        "ytokj.com",
        "ytokj.com.cn",
        "ytokj.net",
        "ytokj.net.cn",
        "ytoluohan.cn",
        "ytoluohan.com",
        "ytoluohan.net",
        "ytoluohan.xin",
        "yuantongyizhan.cn",
        "yuantongyizhan.com",
        "ioo.cn",
        "laoba00.com",
        "shengyi.ai",
        "shengyizhuanjia.com",
        "yuanbei.biz",
        "yuanfudao",
        "banmaaike.com",
        "fbstatic.cn",
        "fenbi.com",
        "fenbike.cn",
        "fenbike.com",
        "fenbilantian.cn",
        "fenbilantian.com",
        "xiaoyuankousuan.com",
        "ybccode.com",
        "yuanfudao.com",
        "yuansouti.com",
        "yuantiku.com",
        "yuewen",
        "hongxiu.com",
        "lrts.me",
        "qdmm.com",
        "qidian.com",
        "readnovel.com",
        "rongshuxia.com",
        "tingbook.com",
        "xs.cn",
        "xs8.cn",
        "xxsy.net",
        "yuewen.com",
        "yuketang",
        "rainclassroom.com",
        "yuketang.cn",
        "yundaex",
        "udalogistic.cn",
        "udalogistic.com",
        "ydsys.cn",
        "yunda56.com",
        "yundaex.cn",
        "yundaex.com",
        "yundalog.com",
        "yundaltl.com",
        "yundasys.com",
        "yfcache.com",
        "yfcalc.com",
        "yfcdn.net",
        "yfcloud.com",
        "yfdts.net",
        "yfpp.net",
        "yfscdn.net",
        "yunfancdn.com",
        "doure.net",
        "kuaipa.net",
        "miaopa.net",
        "yunlaopo.cc",
        "yunlaopo.com",
        "yunlaopo.net",
        "yy",
        "duowan.com",
        "dwstatic.com",
        "yy.com",
        "yystatic.com",
        "lib.cloud",
        "lib.cz",
        "lib.domains",
        "lib.education",
        "lib.eu",
        "lib.limited",
        "lib.pl",
        "lib.sk",
        "lib.to",
        "lib.tw",
        "lib.org",
        "lib.net",
        "arlib.com",
        "b-ok.africa",
        "b-ok.asia",
        "b-ok.cc",
        "b-ok.global",
        "b-ok.org",
        "book4you.org",
        "bookfi.net",
        "booksc.eu",
        "booksc.me",
        "booksc.org",
        "booksc.xyz",
        "bookshome.info",
        "bookshome.net",
        "bookshome.world",
        "dlib.org",
        "dl.ncdn.ec",
        "hlib.org",
        "libsolutions.app",
        "libsolutions.domains",
        "libsolutions.net",
        "mlib.org",
        "slib.org",
        "singlelogin.app",
        "singlelogin.me",
        "singlelogin.re",
        "singlelogin.site",
        "z-lib.fm",
        "z-lib.gd",
        "z-lib.gl",
        "z-lib.org",
        "z-library.se",
        "z-library.sk",
        "zlib.life",
        "zlibcdn.com",
        "zlibcdn.com",
        "zx-team",
        "easy-jtag.com",
        "zx-team.com",
        "zaobao",
        "zaobao.com",
        "zaobao.com.sg",
        "zaobao.sg",
        "zb.app",
        "zb.com",
        "zb.io",
        "zb.live",
        "zdns",
        "zcmbc.com.cn",
        "zdns.cn",
        "zdns.net.cn",
        "zdns.org.cn",
        "zdnscloud.biz",
        "zdnscloud.cn",
        "zdnscloud.com",
        "zdnscloud.com.cn",
        "zdnscloud.info",
        "zdnscloud.net",
        "zdnscloud.net.cn",
        "zdnscloud.org.cn",
        "zee",
        "bgr.in",
        "bollywoodlife.com",
        "careerfundas.com",
        "cricketcountry.com",
        "dnai.in",
        "dnaindia.com",
        "earngeek.com",
        "ekhindi.com",
        "ind.sh",
        "india.com",
        "indiancolleges.com",
        "itripto.com",
        "oncars.in",
        "prepsure.com",
        "thehealthsite.com",
        "wionews.com",
        "yhealth.com",
        "zee.com",
        "zeebiz.com",
        "zeeentertainment.com",
        "zeenews.com",
        "zeenews-fonts.s.amazonaws.com",
        "zeetv",
        "z5.app",
        "z5.com",
        "zee5.com",
        "zee5.in",
        "zee5.tv",
        "zeebioskop.com",
        "zeetv.co.uk",
        "zeetv.com",
        "zeeuk.com",
        "outbound.io",
        "zdassets.com",
        "zdusercontent.com",
        "zendesk.com",
        "zndsk.com",
        "zopim.com",
        "zeplin",
        "zeplin.dev",
        "zeplin.io",
        "accuratead.cn",
        "dutils.com",
        "hiaiabc.com",
        "mob.com",
        "mobsdks.com",
        "sharesdk.cn",
        "yksdks.com",
        "zhihu",
        "crash.zhihu.comads",
        "zhihu-web-analytics.zhihu.comads",
        "zhihu.com",
        "zhimg.com",
        "zhimeishe",
        "68sex.top",
        "a7sex.com",
        "ctotires.com",
        "ferryclean.com",
        "zhimeishe888.com",
        "tianpeng.com",
        "zbj.com",
        "zbjdev.com",
        "zbjimg.com",
        "zhubajie.com",
        "ziroom",
        "ziroom.com",
        "ziroomapartment.com",
        "zoho",
        "zoho.com",
        "zoho.com.au",
        "zoho.eu",
        "zoho.in",
        "zohocdn.com",
        "zohomeetups.com",
        "zohomerchandise.com",
        "zohopublic.com",
        "zohoschools.com",
        "zohostatic.com",
        "zohostatic.in",
        "zohouniversity.com",
        "zohowebstatic.com",
        "zoom",
        "zoom.com",
        "zoom.com.cn",
        "zoom.us",
        "zotero",
        "zotero.org",
        "nubia.cn",
        "nubia.com",
        "redmagic.com",
        "zte.com.cn",
        "ztedevices.com",
        "ztemall.com",
        "ztems.com",
        "zto-express",
        "5.com",
        "izto.com",
        "izto.com.cn",
        "mlzt.com.cn",
        "tuxi.com",
        "zt-express.com",
        "zto.cn",
        "zto.com",
        "zto.net",
        "ztoapp.com",
        "ztoglobal.com",
        "ztogroup.com",
        "ztoyh.com",
        "zuoyebang",
        "syh.zybang.comads",
        "zuoyebang.cc",
        "zuoyebang.com",
        "zybang.com",
        "zynga.com",
        "zyngaplayersupport.com",
        "zyngapoker.com",
        "kr.afhz.org",
        "alchosting.net",
        "tmail.alchosting.net",
        "vpanel.alchosting.net",
        "cheeter.de",
        "hosting.cheeter.de",
        "dashboard.cheeeter.de",
        "app.alchosting.net",
        "my.alchosting.net",
        "app.alwaysfreehost.com",
        "alwaysfreehost.com",
      ]
      ).map((s) => (/^https?:\/\//i.test(s) ? s : `https://${s}`));
      const queries = Array.isArray(q.queries) && q.queries.length ? q.queries.slice() : ["Best coffee shops near me", "How to learn coding online", "Healthy dinner recipes quick", "Top travel destinations 2026", "Funny cat videos compilation", "Learn to play guitar tutorial", "Mindfulness meditation techniques", "DIY home decor ideas", "New sci-fi books 2026",
        "Beginner workout routine at home",
        "Photography tips for beginners",
        "Interesting facts about space",
        "Quick and easy dessert recipes",
        "Upcoming movie releases",
        "Popular podcast series 2026",
        "Natural remedies for headaches",
        "Online language learning platforms",
        "Best budget-friendly gadgets",
        "Funny jokes for a good laugh",
        "Artificial intelligence basics",
        "Vegan lunch ideas for work",
        "Healthy habits for a happy life",
        "DIY garden landscaping ideas",
        "Learn to draw step by step",
        "Effective time management tips",
        "Motivational quotes for success",
        "Popular mobile games 2026",
        "How to start a blog",
        "Mind-bending optical illusions",
        "Home workout equipment reviews",
        "Exciting weekend getaways",
        "Delicious smoothie recipes",
        "Introduction to astrophysics",
        "Best educational YouTube channels",
        "Cute puppy training tips",
        "Interesting historical events",
        "Top 10 TED talks of all time",
        "DIY skincare routine at home",
        "Unique and easy craft ideas",
        "Mediterranean diet meal plan",
        "Must-read classic novels",
        "How to grow your own herbs",
        "Virtual reality gaming experiences",
        "Famous motivational speeches",
        "Tips for better sleep quality",
        "Healthy habits for busy professionals",
        "Learn to play piano online",
        "Delicious vegetarian dinner ideas",
        "Exciting science experiments at home",
        "Popular workout playlists 2026",
        "DIY home organization hacks",
        "Outdoor photography tips",
        "Mindfulness apps for stress relief",
        "Creative writing prompts",
        "Best budget travel destinations",
        "Quick and easy breakfast recipes",
        "Popular self-help books 2026",
        "Introduction to philosophy",
        "Funny dog memes compilation",
        "Simple and tasty lunch ideas",
        "How to start a small business",
        "Positive affirmations for daily life",
        "Home office setup ideas",
        "Learn to dance online tutorials",
        "Fascinating space exploration facts",
        "DIY natural cleaning products",
        "Healthy snack ideas for weight loss",
        "Top 10 indie games 2026",
        "Motivational fitness quotes",
        "Quick and easy dinner recipes",
        "Best online courses for personal development",
        "Beginner yoga poses for flexibility",
        "Interesting science documentaries",
        "Delicious plant-based recipes",
        "Book recommendations for summer reading",
        "Mindfulness exercises for beginners",
        "DIY home renovation ideas",
        "Popular travel vlogs 2026",
        "How to make homemade ice cream",
        "Creative photography projects",
        "Best productivity apps for work",
        "Learn to code for beginners",
        "Healthy smoothie bowl recipes",
        "Top 10 action movies 2026",
        "Motivational TED talks for success",
        "Fun indoor activities for kids",
        "DIY natural beauty products",
        "Must-visit art galleries",
        "Travel photography tips and tricks",
        "Effective communication skills training",
        "Best budget-friendly recipes",
        "Interesting psychology experiments",
        "Virtual museum tours online",
        "Quick and easy dessert ideas",
        "Top 10 adventure novels",
        "Healthy habits for a strong immune system",
        "Learn to play ukulele tutorial",
        "Famous motivational quotes",
        "Mindfulness meditation for beginners",
        "DIY home decor on a budget",
        "Popular podcast episodes 2026",
        "Nature photography inspiration",
        "Healthy snack ideas for work",
        "Best online coding bootcamps",
        "Beginner painting tutorials",
        "Funny cat gifs compilation",
        "Learn a new language tips",
        "Creative writing exercises",
        "Quick and healthy dinner ideas",
        "Top 10 mystery novels 2026",
        "Motivational workout music playlist",
        "Indoor gardening tips for beginners",
        "DIY natural hair care recipes",
        "Best budget travel tips",
        "Interesting science facts",
        "Virtual reality travel experiences",
        "Delicious vegetarian lunch ideas",
        "Popular self-improvement books 2026",
        "Introduction to quantum physics",
        "Funny dog videos compilation",
        "Simple and tasty dinner recipes",
        "How to start an online business",
        "Positive mindset affirmations",
        "Home workout routines for beginners",
        "Learn to play guitar chords",
        "Fascinating astronomy facts",
        "DIY natural skincare routine",
        "Healthy dessert recipes without sugar",
        "Top 10 indie films 2026",
        "Motivational fitness speeches",
        "Quick and easy lunch recipes",
        "Best online courses for professional development",
        "Beginner yoga poses for stress relief",
        "Interesting historical documentaries",
        "Delicious plant-based desserts",
        "Book recommendations for fall reading",
        "Mindfulness meditation exercises",
        "DIY home improvement projects",
        "Popular travel blogs 2026",
        "How to make homemade pizza",
        "Creative writing prompts for kids",
        "Best productivity tools for work",
        "Learn to code for free",
        "Healthy smoothie recipes for weight loss",
        "Top 10 animated movies 2026",
        "Motivational TED talks for happiness",
        "Fun outdoor activities for families",
        "DIY natural cleaning recipes",
        "Must-visit historical landmarks",
        "Travel photography editing tips",
        "Effective public speaking techniques",
        "Best budget-friendly meals",
        "Interesting psychology books",
        "Virtual museum exhibits online",
        "Quick and easy dessert recipes with few ingredients",
        "Top 10 fantasy novels 2026",
        "Healthy habits for mental well-being",
        "Learn to play piano chords",
        "Famous motivational speeches for success",
        "Mindfulness meditation for stress relief",
        "DIY home organization ideas",
        "Popular podcast series episodes 2026",
        "Nature photography composition tips",
        "Healthy snack ideas for school",
        "Best online coding courses",
        "Beginner drawing tutorials",
        "Funny cat videos for a good laugh",
        "Learn a new language quickly",
        "Creative writing prompts for adults",
        "Quick and healthy lunch ideas",
        "Top 10 crime novels 2026",
        "Motivational workout quotes",
        "Indoor gardening ideas for small spaces",
        "DIY natural beauty products recipes",
        "Best budget travel destinations 2026",
        "Interesting science articles",
        "Virtual reality gaming tips",
        "Delicious vegetarian dinner recipes",
        "Popular self-help podcasts 2026",
        "Introduction to psychology",
        "Funny dog memes for a good laugh",
        "Simple and tasty lunch recipes",
        "How to start a small business online",
        "Positive affirmations for success",
        "Home workout routines for weight loss",
        "Learn to play ukulele chords",
        "Fascinating space facts",
        "DIY natural hair care routine",
        "Healthy dessert recipes for kids",
        "Top 10 indie games of all time",
        "Motivational fitness videos",
        "Quick and easy dinner ideas",
        "Best online courses for personal growth",
        "Beginner yoga poses for beginners",
        "Interesting science podcasts",
        "Delicious plant-based dinner ideas",
        "Book recommendations for winter reading",
        "Mindfulness meditation techniques for anxiety",
        "DIY home decor projects",
        "Popular travel destinations 2026",
        "How to make homemade cookies",
        "Creative photography tips",
        "Best productivity apps for productivity",
        "Learn to code for beginners free",
        "Healthy smoothie bowl recipes for weight loss",
        "Top 10 action movies of all time",
        "Motivational TED talks for motivation",
        "Fun indoor activities for adults",
        "DIY natural hair care recipes for growth",
        "Must-visit art museums",
        "Travel photography tips for beginners",
        "Effective communication skills in the workplace",
        "Best budget-friendly recipes for dinner",
        "Interesting psychology experiments to try",
        "Virtual museum tours for students",
        "Quick and easy dessert ideas for parties",
        "Top 10 adventure novels of all time",
        "Healthy habits for a strong immune system",
        "Learn to play guitar chords for beginners",
        "Famous motivational quotes about life",
        "Mindfulness meditation for beginners youtube",
        "DIY home decor on a budget bedroom",
        "Popular podcast episodes of all time",
        "Nature photography inspiration ideas",
        "Healthy snack ideas for work meetings",
        "Best online coding bootcamps 2026",
        "Beginner painting tutorials acrylic",
        "Funny cat gifs for a good laugh",
        "Learn a new language in 30 days",
        "Creative writing exercises for high school students",
        "Quick and healthy dinner ideas for two",
        "Top 10 mystery novels of all time",
        "Motivational workout music playlist 2026",
        "Indoor gardening ideas for beginners",
        "DIY natural hair care recipes for black hair",
        "Best budget travel tips and tricks",
        "Interesting science facts about animals",
        "Virtual reality travel experiences 2026",
        "Delicious vegetarian lunch ideas for work",
        "Popular self-improvement books of all time",
        "Introduction to quantum physics for beginners",
        "Funny dog videos for a good laugh 2026",
        "Simple and tasty dinner recipes for two",
        "How to start an online business for dummies",
        "Positive mindset affirmations for success",
        "Home workout routines for beginners without equipment",
        "Learn to play guitar chords for beginners acoustic",
        "Fascinating astronomy facts about the universe",
        "DIY natural skincare routine for oily skin",
        "Healthy dessert recipes without sugar and flour",
        "Top 10 indie films of all time",
        "Motivational fitness speeches for success",
        "Quick and easy lunch recipes for work",
        "Best online courses for professional development 2026",
        "Beginner yoga poses for stress relief at home",
        "Interesting historical documentaries on netflix",
        "Delicious plant-based desserts for a crowd",
        "Book recommendations for fall reading 2026",
        "Mindfulness meditation exercises for anxiety",
        "DIY home improvement projects on a budget",
        "Popular travel blogs of all time",
        "How to make homemade pizza from scratch",
        "Creative writing prompts for kids with pictures",
        "Best productivity tools for work 2026",
        "Learn to code for free online",
        "Healthy smoothie recipes for weight loss and energy",
        "Top 10 animated movies of all time",
        "Motivational TED talks for happiness and success",
        "Fun outdoor activities for families on a budget",
        "DIY natural cleaning recipes with essential oils",
        "Must-visit historical landmarks in the world",
        "Travel photography editing tips and tricks",
        "Effective public speaking techniques for students",
        "Best budget-friendly meals for college students",
        "Interesting psychology books to read",
        "Virtual museum exhibits online for students",
        "Quick and easy dessert recipes with few ingredients and no baking",
        "Top 10 fantasy novels of all time",
        "Healthy habits for mental well-being and happiness",
        "Learn to play piano chords for beginners",
        "Famous motivational speeches for success in life",
        "Mindfulness meditation for stress relief and anxiety",
        "DIY home organization ideas on a budget",
        "Popular podcast series episodes of all time 2026",
        "Nature photography composition tips and tricks",
        "Healthy snack ideas for school and work",
        "Best online coding courses for beginners",
        "Beginner drawing tutorials step by step",
        "Funny cat videos for a good laugh 2026",
        "Learn a new language quickly and easily",
        "Creative writing prompts for adults fiction",
        "Quick and healthy lunch ideas for weight loss",
        "Top 10 crime novels of all time",
        "Motivational workout quotes for women",
        "Indoor gardening ideas for small spaces on a budget",
        "DIY natural beauty products recipes for skin",
        "Best budget travel destinations 2026 summer",
        "Interesting science articles for high school students",
        "Virtual reality gaming tips and tricks",
        "Delicious vegetarian dinner recipes for two",
        "Popular self-help podcasts of all time 2026",
        "Introduction to psychology online course",
        "Funny dog memes for a good laugh 2026",
        "Simple and tasty lunch recipes for two",
        "How to start a small business online for free",
        "Positive affirmations for success and happiness",
        "Home workout routines for weight loss and toning",
        "Learn to play ukulele chords for beginners",
        "Fascinating space facts for kids",
        "DIY natural hair care routine for curly hair",
        "Healthy dessert recipes for kids birthday party",
        "Top 10 indie games of all time pc",
        "Motivational fitness videos for beginners",
        "Quick and easy dinner ideas for family",
        "Best online courses for personal growth and development",
        "Beginner yoga poses for beginners at home",
        "Interesting science podcasts for kids",
        "Delicious plant-based dinner ideas for two",
        "Book recommendations for winter reading 2026",
        "Mindfulness meditation techniques for anxiety and stress",
        "DIY home decor projects for small spaces",
        "Popular travel destinations 2026 usa",
        "How to make homemade cookies from scratch",
        "Creative photography tips and tricks",
        "Best productivity apps for productivity and time management",
        "Learn to code for beginners free online",
        "Healthy smoothie bowl recipes for weight loss and detox",
        "Top 10 action movies of all time imdb",
        "Motivational TED talks for motivation and success",
        "Fun indoor activities for adults at home",
        "DIY natural hair care recipes for growth and thickness",
        "Must-visit art museums in the world",
        "Travel photography tips for beginners dslr",
        "Effective communication skills in the workplace training",
        "Best budget-friendly recipes for dinner parties",
        "Funny dog videos",
        "How to train a cat",
        "Popular dog breeds 2026",
        "Cute kittens for adoption",
        "Best dog parks near me",
        "Cat behavior problems solutions",
        "Dog-friendly beaches in the Us",
        "Funny cat memes",
        "Top 10 guard dog breeds",
        "Adopt a senior cat",
        "Puppy training tips",
        "Famous cats on Instagram",
        "Dog health care essentials",
        "DIY cat toys ideas",
        "Guide to choosing a cat food brand",
        "Cool dog names for males",
        "Cat grooming basics",
        "Dog photography tips",
        "Catnip benefits for cats",
        "Puppy socialization classes near me",
        "Cat behavior decoded",
        "Dog-friendly hiking trails",
        "Indoor activities for cats",
        "Cute dog costumes for Halloween",
        "How to introduce a new dog to your cat",
        "Best cat litter brands",
        "Fun tricks to teach your dog",
        "Interactive toys for indoor cats",
        "Famous dog quotes",
        "Cats vs. Dogs: Which is the better pet?",
        "Low-maintenance dog breeds",
        "Homemade cat food recipes",
        "Dog-friendly hotels",
        "Cute kitten names",
        "Essential vaccinations for puppies",
        "Cat health checkup checklist",
        "Dog agility training at home",
        "Funny cat videos compilation",
        "Unique dog breeds you've never heard of",
        "Cat furniture DIY ideas",
        "Must-have items for new cat owners",
        "Puppy teething remedies",
        "Celebrities and their pets",
        "Best cat cafes in the world",
        "Dogs in Halloween costumes",
        "Cat yoga poses",
        "Training a dog to fetch",
        "Common cat illnesses and symptoms",
        "Dog-friendly restaurants with outdoor seating",
        "How to choose the right dog bed",
        "Cat dental care tips",
        "Famous dogs in movies",
        "Understanding cat body language",
        "Dog-friendly vacation spots",
        "Cute cat wallpaper for your phone",
        "Dog park etiquette",
        "DIY dog treats recipes",
        "Cats with unique markings",
        "Guide to choosing a cat litter box",
        "Puppy playdate ideas",
        "Cat behavior problems and solutions",
        "Dog obedience training basics",
        "Catnip toys for indoor cats",
        "Dog breeds good with children",
        "Best cat trees for large cats",
        "Training a cat to walk on a leash",
        "Top 10 most popular dog names",
        "Natural remedies for cat allergies",
        "Puppy potty training hacks",
        "Dog-friendly hiking trails near me",
        "Cute cat GIFs",
        "Guardian breeds for livestock",
        "Cat body language explained",
        "Funny dog memes",
        "Interactive dog toys for smart dogs",
        "How to choose the right cat food",
        "Dog-friendly beaches in Europe",
        "DIY dog grooming tips",
        "Cute cat costumes for Halloween",
        "Puppy socialization games",
        "Dog park safety tips",
        "Cat agility training at home",
        "Dog travel essentials checklist",
        "Famous cats on YouTube",
        "Choosing the right dog collar",
        "Cat enrichment ideas",
        "Famous dogs on social media",
        "Fun facts about cat breeds",
        "Puppy-proofing your home",
        "Cat behavior problems scratching",
        "Best dog-friendly cities",
        "Cool cat names for females",
        "Training a dog to stay",
        "DIY cat bed ideas",
        "Dog-friendly hiking trails in the Uk",
        "Cute puppy pictures",
        "Cat grooming at home",
        "Dog breeds for first-time owners",
        "Indoor activities for dogs",
        "Cute cat videos on TikTok",
        "Puppy teething toys",
        "Dog-friendly hotels with pet amenities",
        "Cat health care basics",
        "Funny dog fails",
        "How to introduce a new cat to your dog",
        "Best cat litter for odor control",
        "Top 10 dog-friendly vacation spots",
        "Training a cat to use a scratching post",
        "Dog dental care tips",
        "Cat behavior problems biting",
        "Puppy training schedule",
        "Cute dog quotes",
        "DIY cat scratching post",
        "Dog-friendly parks with agility courses",
        "Cats with unique personalities",
        "Guide to choosing a dog food brand",
        "Famous cats in history",
        "Dog-friendly beaches in Australia",
        "Catnip benefits for dogs",
        "Puppy socialization tips",
        "Dog behavior problems and solutions",
        "Cat-proofing your home",
        "Homemade dog food recipes",
        "Fun tricks to teach your cat",
        "Interactive toys for dogs",
        "Famous dogs in literature",
        "Cute cat names for males",
        "Dog-friendly restaurants with patios",
        "How to groom a cat at home",
        "Cat health checkup schedule",
        "Dog agility training equipment",
        "Funny cat jokes",
        "Puppy socialization classes online",
        "Cats vs. Dogs: Pros and Cons",
        "Low-shedding dog breeds",
        "Homemade cat treats recipes",
        "Dog-friendly hotels in the Us",
        "Cute kitten videos on YouTube",
        "Essential vaccinations for kittens",
        "Cat behavior problems peeing",
        "Dog-friendly hiking trails in Canada",
        "Indoor activities for puppies",
        "Cute dog videos on Instagram",
        "Understanding cat nutrition",
        "Dog-friendly vacation rentals",
        "Best cat toys for indoor cats",
        "Puppy teething remedies natural",
        "Celebrity cats on social media",
        "Dog park etiquette for beginners",
        "DIY dog toys from household items",
        "Cats with unique coat patterns",
        "Must-have items for new dog owners",
        "Puppy potty training schedule",
        "Cat behavior problems meowing",
        "Dog obedience training at home",
        "Catnip toys for outdoor cats",
        "Dog breeds good for apartments",
        "Training a cat to come when called",
        "Top 10 most popular cat names",
        "Natural remedies for dog allergies",
        "Puppy potty training hacks apartment",
        "Dog-friendly hiking trails in the Us",
        "Cute cat GIFs on Reddit",
        "Guardian breeds for small farms",
        "Cat body language tail",
        "Funny dog memes on Twitter",
        "Interactive dog toys for large dogs",
        "How to choose the right cat litter",
        "Dog-friendly beaches in Asia",
        "DIY dog grooming at home",
        "Cute cat costumes for Christmas",
        "Puppy socialization games at home",
        "Dog park safety tips for puppies",
        "Cat agility training equipment",
        "Dog travel essentials checklist for owners",
        "Famous cats on Facebook",
        "Choosing the right dog crate",
        "Cat enrichment ideas for indoor cats",
        "Famous dogs on TikTok",
        "Fun facts about cat breeds for kids",
        "Puppy-proofing your home checklist",
        "Cat behavior problems scratching furniture",
        "Best dog-friendly cities in Europe",
        "Cool cat names for males",
        "Training a dog to stay on command",
        "DIY cat bed ideas from cardboard",
        "Dog-friendly hiking trails in the Uk",
        "Cute puppy pictures to draw",
        "Cat grooming at home tips",
        "Dog breeds for first-time owners and families",
        "Indoor activities for dogs during winter",
        "Cute cat videos on TikTok compilation",
        "Puppy teething toys homemade",
        "Dog-friendly hotels with pet amenities in the Us",
        "Cat health care basics for beginners",
        "Funny dog fails compilation",
        "How to introduce a new cat to your dog smoothly",
        "Best cat litter for odor control and clumping",
        "Top 10 dog-friendly vacation spots in the Us",
        "Training a cat to use a scratching post properly",
        "Dog dental care tips at home",
        "Cat behavior problems biting and aggression",
        "Puppy training schedule for beginners",
        "Cute dog quotes for Instagram captions",
        "DIY cat scratching post with cardboard",
        "Dog-friendly parks with agility courses near me",
        "Cats with unique personalities and habits",
        "Guide to choosing a dog food brand for your pet's health",
        "Famous cats in history and their impact on culture",
        "Dog-friendly beaches in Australia with beautiful views",
        "Catnip benefits for dogs and how to use it",
        "Puppy socialization tips for a well-behaved dog",
        "Dog behavior problems and solutions for common issues",
        "Cat-proofing your home: Essential tips for a safe environment",
        "Homemade dog food recipes for a healthy and happy pup",
        "Fun tricks to teach your cat for interactive playtime",
        "Interactive toys for dogs to keep them mentally stimulated",
        "Famous dogs in literature and their fictional adventures",
        "Cute cat names for males that suit their personalities",
        "Dog-friendly restaurants with patios for a delightful dining experience",
        "How to groom a cat at home without stress for your feline friend",
        "Cat health checkup schedule for a proactive approach to their well-being",
        "Dog agility training equipment for a fun and challenging exercise routine",
        "Funny cat jokes to brighten your day with laughter and joy",
        "Puppy socialization classes online for convenient and effective training",
        "Cats vs. Dogs: Pros and Cons to help you make an informed pet choice",
        "Low-shedding dog breeds for a cleaner home and less maintenance",
        "Homemade cat treats recipes that are both delicious and nutritious",
        "Dog-friendly hotels in the US with comfortable accommodations for you and your furry companion",
        "Cute kitten videos on YouTube for a heartwarming and adorable experience",
        "Essential vaccinations for kittens to ensure a healthy start in life",
        "Cat behavior problems meowing excessively and how to address it",
        "Dog-friendly hiking trails in Canada for outdoor adventures with your pup",
        "Indoor activities for puppies to keep them entertained and engaged",
        "Cute dog videos on Instagram for a daily dose of happiness",
        "Understanding cat nutrition for a balanced and wholesome diet",
        "Dog-friendly vacation rentals for a memorable and pet-friendly getaway",
        "Best cat toys for indoor cats to promote physical and mental stimulation",
        "Puppy teething remedies natural for a comfortable teething process",
        "Celebrity cats on social media and their adorable antics",
        "Dog park etiquette for beginners to ensure a positive experience",
        "DIY dog toys from household items for budget-friendly and creative play",
        "Cats with unique coat patterns and their striking and beautiful appearances",
        "Must-have items for new dog owners to make the transition smoother",
        "Puppy potty training schedule for a successful and stress-free training",
        "Cat behavior problems meowing excessively and how to address it effectively",
        "Dog obedience training at home: Tips and tricks for a well-behaved dog",
        "Catnip toys for outdoor cats to enhance their playtime experience",
        "Dog breeds good for apartments: Compact and adaptable companions",
        "Training a cat to come when called for a more interactive relationship",
        "Top 10 most popular cat names for inspiration and naming your feline friend",
        "Natural remedies for dog allergies for a holistic approach to pet health",
        "Puppy potty training hacks apartment living for practical and effective solutions",
        "Dog-friendly hiking trails in the US with scenic views and nature exploration",
        "Cute cat GIFs on Reddit for a collection of amusing and endearing moments",
        "Guardian breeds for small farms: Reliable and protective farm companions",
        "Cat body language tail signals and what they indicate",
        "Funny dog memes on Twitter for a lighthearted and entertaining break",
        "Interactive dog toys for large dogs for physical and mental exercise",
        "How to choose the right cat litter for a clean and odor-free environment",
        "Dog-friendly beaches in Asia for a tropical and pet-friendly vacation",
        "DIY dog grooming at home for a well-maintained and happy pooch",
        "Cute cat costumes for Christmas for festive and adorable holiday celebrations",
        "Puppy socialization games at home for a well-socialized and confident dog",
        "Dog park safety tips for puppies to ensure a secure and enjoyable visit",
        "Cat agility training equipment for an engaging and stimulating activity",
        "Dog travel essentials checklist for owners planning a trip with their pets",
        "Famous cats on Facebook and their online popularity",
        "Choosing the right dog crate for comfort and security",
        "Cat enrichment ideas for indoor cats to enhance their living space",
        "Famous dogs on TikTok and their viral videos",
        "Fun facts about cat breeds for kids to learn and enjoy",
        "Puppy-proofing your home checklist for a safe environment for your new pup",
        "Cat behavior problems scratching furniture and effective solutions",
        "Best dog-friendly cities in Europe for pet-friendly travel",
        "Cool cat names for males that reflect their unique personalities",
        "Training a dog to stay on command for obedience and safety",
        "DIY cat bed ideas from cardboard for a cozy and budget-friendly option",
        "Dog-friendly hiking trails in the UK with picturesque landscapes",
        "Cute puppy pictures to draw for artistic inspiration",
        "Cat grooming at home tips for a stress-free grooming experience",
        "Dog breeds for first-time owners and families for a compatible and loving companion",
        "Indoor activities for dogs during winter to beat the cold weather blues",
        "Cute cat videos on TikTok compilation for a delightful and amusing watch",
        "Puppy teething toys homemade for a chewy and enjoyable teething process",
        "Dog-friendly hotels with pet amenities in the US for a comfortable stay",
        "Cat health care basics for beginners for a proactive approach to their well-being",
        "Funny dog fails compilation for a dose of laughter and entertainment",
        "How to introduce a new cat to your dog smoothly for a harmonious relationship",
        "Best cat litter for odor control and clumping for a clean and fresh environment",
        "Top 10 dog-friendly vacation spots in the US for a memorable getaway",
        "fastest electric cars 2026",
        "best fuel-efficient SUVs",
        "custom motorcycle paint jobs",
        "upcoming hybrid car models",
        "motorcycle safety gear reviews",
        "classic car restoration services",
        "off-road adventure motorcycles",
        "luxury electric vehicles comparison",
        "motorcycle riding tips for beginners",
        "future of self-driving cars",
        "vintage motorcycle collectors",
        "top-rated family SUVs",
        "sports cars under $50,000",
        "motorcycle engine performance upgrades",
        "latest electric bike technologies",
        "safest car models 2026",
        "popular motorcycle road trips",
        "compact hybrid cars comparison",
        "motorcycle gear for all seasons",
        "self-driving car technology advancements",
        "affordable classic cars for sale",
        "best adventure touring motorcycles",
        "electric vs hybrid cars pros and cons",
        "custom chopper builders near me",
        "upcoming sports car releases",
        "motorcycle maintenance checklist",
        "luxury SUVs with third-row seating",
        "car customization shops in New York",
        "must-have motorcycle accessories",
        "hybrid car battery life expectancy",
        "vintage car auctions near me",
        "motorcycle exhaust systems reviews",
        "top electric car charging stations",
        "motorcycle camping gear essentials",
        "suv safety ratings 2026",
        "classic car shows in America",
        "fastest production motorcycles 2026",
        "autonomous vehicle regulations update",
        "custom car interior upholstery",
        "motorcycle suspension tuning guide",
        "fuel-efficient sedans under $20,000",
        "best electric bikes for commuting",
        "car detailing services New York",
        "motorcycle road racing events 2026",
        "luxury SUVs with panoramic sunroof",
        "affordable hybrid SUVs 2026",
        "custom motorcycle helmet designs",
        "self-driving car legal considerations",
        "classic car restoration workshops",
        "motorcycle engine oil guide",
        "latest electric car technology news",
        "suv comparison chart 2026",
        "motorcycle riding groups in Italy",
        "future of autonomous motorcycles",
        "custom car audio system installations",
        "motorcycle safety courses near me",
        "fuel-efficient pickup trucks comparison",
        "best electric scooters for adults",
        "car modification laws in Europe",
        "motorcycle road trip destinations",
        "luxury hybrid cars 2026",
        "classic car museums in America",
        "sports motorcycles for beginners",
        "electric car charging infrastructure growth",
        "motorcycle tire reviews 2026",
        "safest SUVs for families",
        "top-rated electric car models",
        "adventure motorcycle gear checklist",
        "upcoming hybrid SUV releases",
        "custom car paint jobs cost",
        "motorcycle touring routes America",
        "self-driving car technology challenges",
        "vintage motorcycle restoration tips",
        "car customization trends 2026",
        "motorcycle helmet safety standards",
        "hybrid car tax incentives Europe",
        "luxury SUVs with massage seats",
        "best sports car under $30,000",
        "electric bike maintenance tips",
        "motorcycle gear for hot weather",
        "autonomous vehicle testing locations",
        "classic car insurance providers",
        "suv towing capacity comparison",
        "motorcycle track day tips",
        "future of hydrogen fuel cell cars",
        "custom car rims and tires",
        "motorcycle safety gear for women",
        "off-road SUVs comparison 2026",
        "electric car range anxiety solutions",
        "motorcycle road trip packing list",
        "top hybrid cars for city driving",
        "custom motorcycle exhaust systems",
        "self-driving car technology risks",
        "vintage car restoration projects",
        "sports motorcycles under $10,000",
        "suv cargo space comparison",
        "motorcycle riding in America",
        "luxury hybrid SUVs comparison",
        "classic car rally events 2026",
        "fastest electric motorcycles 2026",
        "autonomous vehicle ethical considerations",
        "custom car lighting options",
        "motorcycle helmet communication systems",
        "best electric cars for road trips",
        "safest SUVs with lane departure warning",
        "motorcycle gear for cold weather",
        "fuel-efficient hybrid cars 2026",
        "upcoming electric car releases",
        "custom motorcycle seat upholstery",
        "self-driving car technology benefits",
        "vintage car restoration schools",
        "sports car insurance rates comparison",
        "electric bike commuting tips",
        "motorcycle safety gear for summer",
        "affordable hybrid cars 2026",
        "luxury SUVs with hybrid technology",
        "classic car road trip essentials",
        "top electric car charging solutions",
        "motorcycle riding in America",
        "custom car decals and graphics",
        "suv off-road capabilities comparison",
        "motorcycle camping gear reviews",
        "autonomous vehicle cybersecurity",
        "custom car spoilers for sale",
        "motorcycle helmet buying guide",
        "best electric cars for city driving",
        "safest SUVs with automatic emergency braking",
        "motorcycle gear for rain",
        "fuel-efficient sedans under $15,000",
        "upcoming hybrid car technologies",
        "custom motorcycle handlebars for sale",
        "self-driving car technology impact on jobs",
        "vintage car restoration costs",
        "sports car aerodynamics upgrades",
        "electric bike battery lifespan",
        "motorcycle safety gear for cold weather",
        "hybrid SUV tax credits Europe",
        "luxury SUVs with off-road capabilities",
        "classic car restoration TV shows",
        "fastest electric cars 0-60",
        "autonomous vehicle data privacy",
        "custom car interior lighting",
        "motorcycle helmet care and maintenance",
        "best electric cars for winter driving",
        "safest SUVs with rearview cameras",
        "motorcycle gear for long rides",
        "fuel-efficient SUVs with third-row seating",
        "upcoming electric SUV models",
        "custom motorcycle exhaust pipes",
        "self-driving car technology and ethics",
        "vintage motorcycle maintenance tips",
        "custom car wraps near me",
        "suv fuel economy comparison 2026",
        "motorcycle riding in Los Angeles",
        "luxury hybrid SUVs with towing capacity",
        "classic car restoration reality shows",
        "sports car driving techniques",
        "electric bike charging station locations",
        "motorcycle safety gear for hot weather",
        "affordable hybrid SUVs 2026",
        "motorcycle gear for women riders",
        "custom car audio installation cost",
        "self-driving car technology and insurance",
        "vintage car restoration shops",
        "suv safety ratings comparison 2026",
        "motorcycle riding in Los Angeles",
        "luxury SUVs with autonomous driving",
        "classic car restoration before and after",
        "fastest electric motorcycles 0-60",
        "autonomous vehicle public perception",
        "custom car upholstery cost",
        "motorcycle helmet design trends",
        "best electric cars for long trips",
        "safest SUVs with blind spot detection",
        "motorcycle gear for short riders",
        "fuel-efficient hybrid SUVs 2026",
        "upcoming electric motorcycle models",
        "custom motorcycle paint colors",
        "self-driving car technology challenges",
        "vintage motorcycle restoration projects",
        "sports car maintenance tips",
        "electric bike winter riding tips",
        "motorcycle safety gear for beginners",
        "hybrid car battery recycling",
        "luxury SUVs with captain's chairs",
        "classic car restoration success stories",
        "suv towing capacity chart",
        "motorcycle riding in Los Angeles",
        "custom car interior design ideas",
        "autonomous vehicle impact on environment",
        "motorcycle camping gear checklist",
        "custom car body kits for sale",
        "safest SUVs with collision avoidance",
        "motorcycle gear for tall riders",
        "fuel-efficient sedans under $25,000",
        "best electric cars for commuting",
        "electric bike maintenance checklist",
        "motorcycle safety gear for rain",
        "affordable hybrid cars with good mileage",
        "luxury hybrid SUVs with panoramic sunroof",
        "classic car restoration on a budget",
        "sports car engine tuning",
        "upcoming hybrid SUV models",
        "custom motorcycle fairings for sale",
        "self-driving car technology and job creation",
        "vintage car restoration process",
        "suv comparison chart 2026",
        "motorcycle riding in Paris",
        "custom car wheels and rims",
        "autonomous vehicle impact on traffic",
        "motorcycle helmet safety standards",
        "best electric cars for families",
        "safest SUVs for teenage drivers",
        "motorcycle gear for hot weather",
        "fuel-efficient SUVs with all-wheel drive",
        "hybrid car tax credits Europe",
        "luxury SUVs with massage seats",
        "classic car restoration mistakes to avoid",
        "fastest electric cars on the market",
        "autonomous vehicle technology timeline",
        "custom car interior upholstery",
        "motorcycle riding in Madrid",
        "electric bike charging infrastructure growth",
        "custom motorcycle exhaust systems",
        "self-driving car technology and privacy",
        "vintage car restoration tips and tricks",
        "sports car insurance rates comparison",
        "motorcycle safety gear for summer",
        "affordable hybrid cars with good gas mileage",
        "luxury hybrid SUVs 2026",
        "classic car restoration workshops",
        "suv cargo space comparison 2026",
        "motorcycle touring routes America",
        "custom car decals and stickers",
        "autonomous vehicle technology challenges",
        "motorcycle helmet communication systems",
        "best electric cars for road trips",
        "safest SUVs with lane departure warning",
        "motorcycle gear for cold weather",
        "fuel-efficient hybrid cars 2026",
        "upcoming electric car releases",
        "custom motorcycle seat upholstery",
        "self-driving car technology benefits",
        "vintage car restoration schools",
        "sports car insurance rates comparison",
        "electric bike commuting tips",
        "motorcycle safety gear for rain",
        "affordable hybrid cars 2026",
        "luxury SUVs with hybrid technology",
        "classic car road trip essentials",
        "top electric car charging solutions",
        "motorcycle riding in America",
        "custom car decals and graphics",
        "suv off-road capabilities comparison",
        "motorcycle camping gear reviews",
        "autonomous vehicle cybersecurity",
        "custom car spoilers for sale",
        "motorcycle helmet buying guide",
        "best electric cars for winter driving",
        "safest SUVs with rearview cameras",
        "motorcycle gear for long rides",
        "fuel-efficient SUVs with third-row seating",
        "upcoming electric SUV models",
        "custom motorcycle exhaust pipes",
        "self-driving car technology and ethics",
        "vintage motorcycle maintenance tips",
        "custom car wraps near me",
        "suv fuel economy comparison 2026",
        "motorcycle riding in Los Angeles",
        "luxury hybrid SUVs with towing capacity",
        "classic car restoration reality shows",
        "sports car driving techniques",
        "electric bike charging station locations",
        "motorcycle safety gear for hot weather",
        "affordable hybrid SUVs 2026",
        "motorcycle gear for women riders",
        "custom car audio installation cost",
        "self-driving car technology and insurance",
        "vintage car restoration shops",
        "suv safety ratings comparison 2026",
        "motorcycle riding in Los Angeles",
        "luxury SUVs with autonomous driving",
        "classic car restoration before and after",
        "fastest electric motorcycles 0-60",
        "autonomous vehicle public perception",
        "custom car upholstery cost",
        "motorcycle helmet design trends",
        "best electric cars for long trips",
        "safest SUVs with blind spot detection",
        "motorcycle gear for short riders",
        "fuel-efficient hybrid SUVs 2026",
        "upcoming electric motorcycle models",
        "custom motorcycle paint colors",
        "self-driving car technology challenges",
        "vintage motorcycle restoration projects",
        "sports car maintenance tips",
        "electric bike winter riding tips",
        "motorcycle safety gear for beginners",
        "hybrid car battery recycling",
        "luxury SUVs with captain's chairs",
        "classic car restoration success stories",
        "suv towing capacity chart",
        "motorcycle riding in Los Angeles",
        "custom car interior design ideas",
        "autonomous vehicle impact on environment",
        "motorcycle camping gear checklist",
        "custom car body kits for sale",
        "safest SUVs with collision avoidance",
        "motorcycle gear for tall riders",
        "fuel-efficient sedans under $25,000",
        "best electric cars for commuting",
        "electric bike maintenance checklist",
        "motorcycle safety gear for rain",
        "affordable hybrid cars with good mileage",
        "luxury hybrid SUVs with panoramic sunroof",
        "classic car restoration on a budget",
        "sports car engine tuning",
        "upcoming hybrid SUV models",
        "custom motorcycle fairings for sale",
        "self-driving car technology and job creation",
        "vintage car restoration process",
        "suv comparison chart 2026",
        "motorcycle riding in Rome",
        "custom car wheels and rims",
        "autonomous vehicle impact on traffic",
        "motorcycle helmet safety standards",
        "best electric cars for families",
        "safest SUVs for teenage drivers",
        "motorcycle gear for hot weather",
        "fuel-efficient SUVs with all-wheel drive",
        "hybrid car tax credits Europe",
        "luxury SUVs with massage seats",
        "classic car restoration mistakes to avoid",
        "fastest electric cars on the market",
        "autonomous vehicle technology timeline",
        "custom car interior lighting",
        "motorcycle riding in Milan",
        "electric bike charging infrastructure growth",
        "custom motorcycle exhaust systems",
        "DIY home decor ideas",
        "easy woodworking projects",
        "painting techniques for beginners",
        "crafting with recycled materials",
        "simple home repair tips",
        "upcycling furniture projects",
        "basic plumbing repairs at home",
        "creative DIY storage solutions",
        "how to make a homemade toolbox",
        "beginner-friendly sewing projects",
        "essential power tools for DIYers",
        "quick and easy home improvement",
        "DIY garden landscaping ideas",
        "basic electrical wiring for beginners",
        "fun DIY projects for kids",
        "creative ways to repurpose old furniture",
        "painting hacks for a professional finish",
        "DIY outdoor furniture plans",
        "easy plumbing fixes anyone can do",
        "homemade cleaning solutions",
        "upcycled craft ideas for the home",
        "simple car maintenance for beginners",
        "budget-friendly DIY home upgrades",
        "basic woodworking skills for newbies",
        "creative DIY wall art projects",
        "how to build a simple birdhouse",
        "quick and easy sewing crafts",
        "essential plumbing tools for DIYers",
        "repurposing household items for decor",
        "DIY home organization ideas",
        "beginner-friendly electrical repairs",
        "crafting with Mason jars",
        "easy home painting tips",
        "creative DIY garden projects",
        "basic car repair skills everyone should know",
        "DIY room decor on a budget",
        "simple woodworking projects for the garage",
        "upcycled garden planters",
        "painting techniques for furniture",
        "DIY home improvement on a dime",
        "quick and easy sewing projects for beginners",
        "essential plumbing skills for homeowners",
        "repurposed pallet furniture ideas",
        "creative DIY storage solutions for small spaces",
        "easy car maintenance for non-mechanics",
        "budget-friendly home decorating ideas",
        "basic woodworking projects for beginners",
        "upcycled home decor projects",
        "how to fix a leaky faucet",
        "DIY garden landscaping on a budget",
        "simple sewing projects for the home",
        "essential tools for home repairs",
        "creative ways to use old wood",
        "painting tips for beginners",
        "DIY outdoor projects for summer",
        "quick and easy home repairs",
        "beginner-friendly woodworking projects",
        "upcycled furniture painting ideas",
        "basic plumbing skills for DIYers",
        "homemade cleaning products recipes",
        "crafting with recycled wood",
        "simple car maintenance tips",
        "creative DIY home decor ideas",
        "how to build a simple bookshelf",
        "budget-friendly home improvement projects",
        "basic electrical repairs for homeowners",
        "repurposed household items for gardening",
        "DIY organizing ideas for the home",
        "easy woodworking projects for gifts",
        "painting techniques for walls",
        "crafting with mason jars and twine",
        "DIY outdoor furniture from pallets",
        "basic plumbing repairs every homeowner should know",
        "quick and easy sewing projects for the kitchen",
        "upcycled craft projects for kids",
        "creative DIY storage ideas for bedrooms",
        "how to fix common car problems",
        "beginner-friendly home improvement tips",
        "essential woodworking tools for beginners",
        "repurposing furniture for outdoor use",
        "DIY home organization on a budget",
        "simple electrical repairs at home",
        "crafting with recycled materials for kids",
        "easy car maintenance for beginners",
        "creative DIY garden decor ideas",
        "how to build a simple planter box",
        "budget-friendly painting projects",
        "basic plumbing tips for homeowners",
        "upcycled furniture projects for beginners",
        "DIY home decor with reclaimed wood",
        "quick and easy sewing projects for the living room",
        "essential plumbing tools for home use",
        "repurposed garden containers",
        "painting techniques for furniture restoration",
        "crafting with recycled glass bottles",
        "DIY outdoor projects on a budget",
        "simple car maintenance for busy people",
        "creative ways to repurpose old books",
        "how to fix a clogged sink",
        "beginner-friendly home repair projects",
        "upcycled craft ideas for adults",
        "basic woodworking skills for homeowners",
        "DIY home organization hacks",
        "quick and easy electrical repairs",
        "essential tools for DIY home projects",
        "repurposed pallet garden projects",
        "painting hacks for beginners",
        "crafting with recycled cardboard",
        "DIY outdoor furniture with pallets",
        "simple plumbing repairs for beginners",
        "creative DIY storage solutions for the kitchen",
        "homemade cleaning products for a sparkling home",
        "upcycled furniture painting techniques",
        "basic car maintenance for everyday drivers",
        "how to build a simple bird feeder",
        "beginner-friendly sewing projects for the home",
        "budget-friendly woodworking projects",
        "repurposed household items for storage",
        "DIY home decor with natural materials",
        "quick and easy plumbing repairs",
        "essential plumbing skills for DIYers",
        "crafting with recycled plastic bottles",
        "simple car maintenance for non-mechanical minds",
        "creative DIY garden projects on a dime",
        "homemade cleaning solutions for a spotless home",
        "upcycled craft projects for beginners",
        "painting techniques for outdoor furniture",
        "DIY outdoor projects for the backyard",
        "basic woodworking projects for the home",
        "repurposed furniture ideas for small spaces",
        "how to fix a running toilet",
        "beginner-friendly home improvement ideas",
        "essential tools for basic home repairs",
        "creative ways to reuse old furniture",
        "budget-friendly DIY home upgrades",
        "upcycled garden decor ideas",
        "painting tips for DIYers",
        "crafting with recycled materials for adults",
        "DIY home organization on a tight budget",
        "quick and easy electrical repairs at home",
        "homemade cleaning products with essential oils",
        "simple car maintenance tips for busy schedules",
        "creative DIY garden projects for beginners",
        "how to build a simple workbench",
        "beginner-friendly sewing projects for the kitchen",
        "repurposed household items for gardening",
        "DIY outdoor furniture from reclaimed wood",
        "basic plumbing repairs for homeowners",
        "upcycled craft projects for kids",
        "painting techniques for wall art",
        "crafting with mason jars and fabric",
        "DIY outdoor projects for small spaces",
        "simple car maintenance for beginners",
        "creative DIY home decor ideas on a budget",
        "how to fix a leaky faucet in the kitchen",
        "essential plumbing tools for DIY plumbing",
        "homemade cleaning products for a green home",
        "upcycled furniture painting ideas for beginners",
        "basic woodworking projects for the garage",
        "repurposed garden containers for plants",
        "DIY home organization ideas on a dime",
        "quick and easy plumbing fixes for beginners",
        "beginner-friendly sewing projects for the living room",
        "budget-friendly home improvement tips",
        "essential woodworking tools for DIYers",
        "crafting with recycled glass jars",
        "DIY outdoor projects for a small backyard",
        "simple car maintenance for busy moms",
        "creative ways to repurpose old furniture for storage",
        "how to build a simple raised garden bed",
        "upcycled craft ideas for adults",
        "painting techniques for furniture refinishing",
        "crafting with recycled cardboard boxes",
        "DIY outdoor furniture with pallets for beginners",
        "simple plumbing repairs for DIYers",
        "creative DIY storage solutions for small kitchens",
        "homemade cleaning products for a healthy home",
        "upcycled furniture painting techniques for beginners",
        "basic car maintenance for everyday drivers",
        "how to build a simple bird feeder for your garden",
        "beginner-friendly sewing projects for the home",
        "budget-friendly woodworking projects for beginners",
        "repurposed household items for creative storage",
        "DIY home decor with natural and sustainable materials",
        "quick and easy plumbing repairs for homeowners",
        "essential plumbing skills for DIY plumbing projects",
        "crafting with recycled plastic bottles for kids",
        "simple car maintenance tips for non-mechanical minds",
        "creative DIY garden projects on a budget for beginners",
        "homemade cleaning solutions for a spotless and eco-friendly home",
        "upcycled craft projects for beginners",
        "painting techniques for outdoor furniture restoration",
        "DIY outdoor projects for a beautiful and functional backyard",
        "basic woodworking projects for the home and garden",
        "repurposed furniture ideas for small spaces",
        "how to fix a running toilet without calling a plumber",
        "beginner-friendly home improvement ideas for DIYers",
        "essential tools for basic home repairs and projects",
        "creative ways to reuse old furniture for a sustainable home",
        "budget-friendly DIY home upgrades and renovations",
        "upcycled garden decor ideas for a unique outdoor space",
        "painting tips for DIYers to achieve professional results",
        "crafting with recycled materials for adults and kids",
        "DIY home organization ideas on a tight budget",
        "quick and easy electrical repairs at home for beginners",
        "homemade cleaning products with essential oils for a natural clean",
        "simple car maintenance tips for busy schedules",
        "creative DIY garden projects for beginners",
        "how to build a simple workbench for your garage",
        "beginner-friendly sewing projects for the kitchen and living room",
        "repurposed household items for gardening and storage",
        "DIY outdoor furniture from reclaimed wood for a rustic look",
        "basic plumbing repairs for homeowners with step-by-step guides",
        "upcycled craft projects for kids to spark creativity",
        "painting techniques for wall art to personalize your space",
        "crafting with mason jars and fabric for unique decor",
        "DIY outdoor projects for small spaces to maximize functionality",
        "simple car maintenance for beginners to keep your vehicle running smoothly",
        "creative DIY home decor ideas on a budget for a personalized touch",
        "how to fix a leaky faucet in the kitchen with easy DIY solutions",
        "essential plumbing tools for DIY plumbing projects at home",
        "homemade cleaning products for a green and eco-friendly home",
        "upcycled furniture painting ideas for beginners to revamp your space",
        "basic woodworking projects for the garage to enhance your skills",
        "repurposed garden containers for plants to add greenery to your garden",
        "DIY home organization ideas on a dime for an orderly and tidy home",
        "quick and easy plumbing fixes for beginners with helpful tips",
        "beginner-friendly sewing projects for the living room and bedroom",
        "budget-friendly home improvement tips for cost-effective changes",
        "essential woodworking tools for DIYers to tackle various projects",
        "crafting with recycled glass jars for creative and eco-friendly decor",
        "DIY outdoor projects for a small backyard to create a relaxing space",
        "simple car maintenance for busy moms with practical tips",
        "creative ways to repurpose old furniture for storage solutions",
        "how to build a simple raised garden bed for a thriving garden",
        "upcycled craft ideas for adults to unleash your creativity",
        "painting techniques for furniture refinishing to transform old pieces",
        "crafting with recycled cardboard boxes for sustainable and fun projects",
        "DIY outdoor furniture with pallets for beginners to furnish your patio",
        "simple plumbing repairs for DIYers with step-by-step instructions",
        "creative DIY storage solutions for small kitchens to maximize space",
        "homemade cleaning solutions for a spotless and eco-friendly home",
        "upcycled furniture painting techniques for beginners to experiment with",
        "basic car maintenance for everyday drivers to keep your vehicle reliable",
        "how to build a simple bird feeder for your garden to attract birds",
        "beginner-friendly sewing projects for the home and personal accessories",
        "budget-friendly woodworking projects for beginners to hone your skills",
        "repurposed household items for creative storage ideas in every room",
        "DIY home decor with natural and sustainable materials for an eco-friendly touch",
        "quick and easy plumbing repairs for homeowners with handy tips",
        "essential plumbing skills for DIY plumbing projects around the house",
        "crafting with recycled plastic bottles for kids for a fun and green activity",
        "simple car maintenance tips for non-mechanical minds to keep your car running",
        "creative DIY garden projects on a budget for beginners to enhance your outdoor space",
        "homemade cleaning solutions for a spotless and chemical-free home",
        "upcycled craft projects for beginners to spark creativity and imagination",
        "painting techniques for outdoor furniture restoration to revive worn pieces",
        "DIY outdoor projects for a beautiful and functional backyard to enjoy",
        "basic woodworking projects for the home and garden to add a personal touch",
        "repurposed furniture ideas for small spaces to optimize your living area",
        "how to fix a running toilet without calling a plumber with easy solutions",
        "beginner-friendly home improvement ideas for DIYers to upgrade your space",
        "essential tools for basic home repairs and projects to have in your toolkit",
        "creative ways to reuse old furniture for a sustainable and stylish home",
        "budget-friendly DIY home upgrades and renovations for a fresh look",
        "upcycled garden decor ideas for a unique and charming outdoor atmosphere",
        "painting tips for DIYers to achieve professional results on various surfaces",
        "crafting with recycled materials for adults and kids for enjoyable projects",
        "DIY home organization ideas on a tight budget to declutter and organize",
        "quick and easy electrical repairs at home for beginners with clear instructions",
        "homemade cleaning products with essential oils for a natural and fragrant clean",
        "simple car maintenance tips for busy schedules to keep your car in top shape",
        "creative DIY garden projects for beginners to cultivate a green and vibrant space",
        "how to build a simple workbench for your garage for efficient and organized work",
        "beginner-friendly sewing projects for the kitchen and living room for a personalized touch",
        "repurposed household items for gardening and storage to repurpose everyday items",
        "DIY outdoor furniture from reclaimed wood for a rustic and charming outdoor setting",
        "best open-world games 2025",
        "top gaming laptops under $1000",
        "upcoming RPG games release dates",
        "how to level up fast in MMORPGs",
        "game development tutorial series",
        "most anticipated game sequels",
        "esports tournaments schedule",
        "gaming setup ideas for small spaces",
        "strategy games for beginners",
        "virtual reality gaming experiences",
        "popular game streaming platforms",
        "online multiplayer games with friends",
        "retro gaming console reviews",
        "game design principles for beginners",
        "gaming communities on social media",
        "free-to-play PC games 2025",
        "best gaming peripherals 2025",
        "how to fix lag in online games",
        "video game soundtracks playlist",
        "gaming industry news updates",
        "top game engines for indie developers",
        "guide to building a gaming Pc",
        "game art and animation tutorials",
        "most iconic video game characters",
        "speedrunning tips and tricks",
        "how to start a gaming YouTube channel",
        "gamer nutrition and fitness tips",
        "streaming equipment for beginners",
        "game theory in game design",
        "must-play indie games 2025",
        "gaming events and conventions 2025",
        "history of video game consoles",
        "best co-op games for couples",
        "AR and VR in the future of gaming",
        "classic games remastered list",
        "game development job opportunities",
        "gaming laptops vs desktops pros and cons",
        "video game addiction prevention",
        "best gaming chairs for long hours",
        "gaming peripherals for console players",
        "how to build a successful game studio",
        "mobile gaming trends 2025",
        "game localization tips for developers",
        "couch co-op games for family night",
        "game programming languages comparison",
        "gaming laptops under $500 reviews",
        "VR horror games immersive experiences",
        "game streaming etiquette and rules",
        "evolution of video game graphics",
        "top gaming influencers to follow",
        "free game development tools 2025",
        "gaming monitor buying guide",
        "video game marketing strategies",
        "best gaming headsets for FPs",
        "retro game collecting tips",
        "how to become a game tester",
        "game design document essentials",
        "gaming laptops with RTX 3080",
        "cybersecurity in online gaming",
        "history of esports tournaments",
        "game art styles inspiration",
        "game streaming platforms comparison",
        "virtual reality in education gaming",
        "how to create a successful game Kickstarter",
        "best gaming mouse for competitive play",
        "game development podcasts to listen to",
        "gaming consoles vs cloud gaming",
        "achievements and trophies guide",
        "game design schools and courses",
        "future of mobile gaming technology",
        "best indie game soundtracks",
        "gaming influencers' favorite games",
        "game development mistakes to avoid",
        "PC vs console gaming debate",
        "video game storytelling techniques",
        "how to get into game journalism",
        "game development internships guide",
        "game streaming on a budget",
        "top gaming documentaries to watch",
        "gaming laptops with Ryzen processors",
        "best gaming routers for low latency",
        "game design software for beginners",
        "gaming communities on Discord",
        "game streaming tips for beginners",
        "esports teams to watch in 2025",
        "game development conferences 2025",
        "gaming laptops with 240Hz refresh rate",
        "most iconic video game quotes",
        "virtual reality vs augmented reality gaming",
        "best gaming keyboards for typing",
        "how to design a memorable game logo",
        "game development mentorship programs",
        "gaming laptops with OLED displays",
        "retro gaming emulation guide",
        "VR fitness games for a workout",
        "game streaming on Twitch vs YouTube",
        "best gaming desks for small spaces",
        "game design books for beginners",
        "gaming laptops with high refresh rate",
        "online gaming safety tips for kids",
        "indie game development success stories",
        "gaming influencers' favorite peripherals",
        "game development competitions 2025",
        "top gaming chairs with massage features",
        "video game sound design tutorials",
        "how to create a successful gaming blog",
        "game development scholarships guide",
        "best gaming monitors for console gaming",
        "gaming laptops with mechanical keyboards",
        "virtual reality in healthcare gaming",
        "game streaming on a Mac",
        "best gaming glasses for eye protection",
        "game development courses on Udemy",
        "gaming laptops with long battery life",
        "indie game marketing strategies",
        "how to start a career in esports",
        "game development software for beginners",
        "gaming laptops with 4K displays",
        "future trends in mobile gaming",
        "best gaming mice for small hands",
        "game streaming on PlayStation vs Xbox",
        "top gaming podcasts to listen to",
        "game development bootcamps guide",
        "gaming laptops with dual screens",
        "virtual reality gaming and mental health",
        "how to create a game design portfolio",
        "game development internships for students",
        "best gaming headsets for streaming",
        "gaming laptops with liquid cooling",
        "indie game developers to follow",
        "game streaming on a Chromebook",
        "best gaming routers for multiple devices",
        "VR horror games jump scare compilation",
        "game development master's programs",
        "gaming laptops with AMD Ryzen processors",
        "how to build a gaming community",
        "game streaming on a budget setup",
        "gaming laptops with NVIDIA RTX 3080",
        "best gaming chairs for posture",
        "indie game soundtracks for relaxation",
        "how to create a game design document",
        "game development online courses",
        "gaming laptops with 1440p displays",
        "future of cloud gaming technology",
        "best gaming monitors for dual setup",
        "game streaming on a gaming console",
        "VR gaming experiences for beginners",
        "top gaming laptops under $800",
        "game development workshops guide",
        "gaming laptops with Ryzen 9 processors",
        "how to market a game on social media",
        "game streaming on a low-spec Pc",
        "best gaming desks for multiple monitors",
        "indie game development tools",
        "game development mentorship opportunities",
        "gaming laptops with 17-inch screens",
        "virtual reality in military training gaming",
        "best gaming glasses for blue light",
        "how to start a game development studio",
        "game streaming on a laptop",
        "gaming laptops with NVIDIA GTX 1660 Ti",
        "indie game development resources",
        "how to become a professional gamer",
        "game development events and meetups",
        "best gaming chairs for big and tall",
        "gaming laptops with AMD Radeon graphics",
        "how to create a game art portfolio",
        "game streaming on a Raspberry Pi",
        "best gaming routers for low ping",
        "indie game development courses",
        "game development conferences for beginners",
        "gaming laptops with 32GB RAm",
        "virtual reality gaming and education",
        "best gaming mice for precision",
        "how to monetize a game development blog",
        "game streaming on a Macbook",
        "gaming laptops with high-end graphics",
        "indie game development communities",
        "how to pitch a game development idea",
        "game development scholarships for minorities",
        "gaming laptops with customizable RGB lighting",
        "best gaming desks with cable management",
        "VR horror games for a spooky experience",
        "game streaming on a budget Pc",
        "indie game development courses online",
        "game development internships for high school students",
        "gaming laptops with AMD Ryzen 7 processors",
        "how to balance gaming and work",
        "game streaming on a budget microphone",
        "best gaming chairs for console gaming",
        "gaming laptops with Thunderbolt 4 support",
        "indie game development software",
        "game development bootcamps for beginners",
        "how to create a game design document template",
        "virtual reality gaming and social interaction",
        "best gaming glasses for night gaming",
        "game streaming on a smart Tv",
        "gaming laptops with high refresh rate displays",
        "indie game development podcasts",
        "game development mentorship programs for minorities",
        "how to start a game development company",
        "gaming laptops with NVIDIA RTX 3070",
        "best gaming desks with storage",
        "VR gaming experiences for adrenaline junkies",
        "game streaming on a budget webcam",
        "indie game development forums",
        "game development online courses for beginners",
        "gaming laptops with AMD Ryzen 5 processors",
        "how to market a game development studio",
        "game streaming on a budget graphics card",
        "best gaming routers for streaming",
        "indie game development conferences",
        "game development workshops for beginners",
        "how to become a game development consultant",
        "gaming laptops with 15-inch screens",
        "virtual reality gaming and therapy",
        "best gaming glasses for long gaming sessions",
        "game streaming on a budget keyboard",
        "indie game development books",
        "game development mentorship opportunities for minorities",
        "gaming laptops with NVIDIA GTX 1650",
        "how to start a game development career",
        "game development events and conferences",
        "best gaming chairs for PC gaming",
        "gaming laptops with AMD Radeon RX 6800m",
        "VR horror games for a heart-pounding experience",
        "game streaming on a budget microphone setup",
        "indie game development tools and software",
        "game development scholarships for women",
        "how to balance gaming and relationships",
        "gaming laptops with high-end processors",
        "best gaming desks for small rooms",
        "virtual reality gaming and cognitive benefits",
        "game streaming on a budget streaming setup",
        "indie game development communities online",
        "game development podcasts for beginners",
        "gaming laptops with NVIDIA RTX 3060",
        "how to create a game design document for beginners",
        "best gaming glasses for eye strain",
        "game streaming on a budget capture card",
        "indie game development resources online",
        "game development internships for college students",
        "gaming laptops with AMD Ryzen 3 processors",
        "how to market a game development company",
        "game streaming on a budget lighting setup",
        "best gaming routers for gaming consoles",
        "indie game development courses for beginners",
        "game development bootcamps for minorities",
        "how to start a game development studio as a student",
        "gaming laptops with 14-inch screens",
        "virtual reality gaming and learning",
        "best gaming glasses for migraines",
        "game streaming on a budget green screen",
        "indie game development podcasts for beginners",
        "game development mentorship programs for women",
        "gaming laptops with NVIDIA GTX 1660",
        "how to become a game development consultant",
        "game development events and expos",
        "best gaming chairs for console gaming under $100",
        "gaming laptops with AMD Radeon RX 6700m",
        "VR horror games for a spine-chilling experience",
        "game streaming on a budget webcam setup",
        "indie game development tools for beginners",
        "game development scholarships for minorities 2025",
        "how to balance gaming and academics",
        "gaming laptops with high refresh rate and low response time",
        "best gaming desks with cable management 2025",
        "virtual reality gaming and mental health benefits",
        "game streaming on a budget microphone and camera",
        "indie game development communities for beginners",
        "game development podcasts for beginners 2025",
        "gaming laptops with NVIDIA RTX 3080 Ti",
        "how to create a game design document template for beginners",
        "best gaming glasses for blue light and glare",
        "game streaming on a budget microphone and lighting setup",
        "indie game development books for beginners",
        "game development mentorship opportunities for minorities 2025",
        "gaming laptops with 17-inch screens 2025",
        "how to market a game development studio 2025",
        "game streaming on a budget microphone and green screen setup",
        "best gaming routers for low ping and high speed",
        "indie game development communities online 2025",
        "game development podcasts for beginners online",
        "gaming laptops with AMD Ryzen 9 processors 2025",
        "how to balance gaming and relationships 2025",
        "VR horror games for a heart-pounding experience 2025",
        "game streaming on a budget microphone and webcam setup",
        "indie game development tools and software 2025",
        "game development scholarships for women 2025",
        "how to create a game design document for beginners 2025",
        "best gaming glasses for eye strain 2025",
        "game streaming on a budget capture card setup",
        "indie game development resources online 2025",
        "game development internships for college students 2025",
        "gaming laptops with AMD Ryzen 3 processors 2025",
        "how to market a game development company 2025",
        "game streaming on a budget lighting setup 2025",
        "best gaming routers for gaming consoles 2025",
        "indie game development courses for beginners online 2025",
        "game development bootcamps for minorities 2025",
        "how to start a game development studio as a student 2025",
        "gaming laptops with 14-inch screens 2025",
        "virtual reality gaming and learning 2025",
        "best gaming glasses for migraines 2025",
        "game streaming on a budget green screen setup 2025",
        "indie game development podcasts for beginners 2025",
        "game development mentorship programs for women 2025",
        "gaming laptops with NVIDIA GTX 1660 2025",
        "how to become a game development consultant 2025",
        "game development events and expos 2025",
        "best gaming chairs for console gaming under $100 2025",
        "gaming laptops with AMD Radeon RX 6700M 2025",
        "VR horror games for a spine-chilling experience 2025",
        "game streaming on a budget webcam setup 2025",
        "indie game development tools for beginners 2025",
        "game development scholarships for minorities 2025",
        "how to balance gaming and academics 2025",
        "gaming laptops with high refresh rate and low response time 2025",
        "best gaming desks with cable management 2025",
        "virtual reality gaming and mental health benefits 2025",
        "game streaming on a budget microphone and camera setup 2025",
        "indie game development communities for beginners 2025",
        "game development podcasts for beginners 2025",
        "gaming laptops with NVIDIA RTX 3080 Ti 2025",
        "how to create a game design document template for beginners 2025",
        "best gaming glasses for blue light and glare 2025",
        "game streaming on a budget microphone and lighting setup 2025",
        "indie game development books for beginners 2025",
        "game development mentorship opportunities for minorities 2025",
        "gaming laptops with 17-inch screens 2025",
        "how to market a game development studio 2025",
        "game streaming on a budget microphone and green screen setup 2025",
        "best gaming routers for low ping and high speed 2025",
        "indie game development communities online 2025",
        "game development podcasts for beginners online 2025",
        "gaming laptops with AMD Ryzen 9 processors 2025",
        "how to balance gaming and relationships 2025",
        "VR horror games for a heart-pounding experience 2025",
        "game streaming on a budget microphone and webcam setup 2025",
        "indie game development tools and software 2025",
        "game development scholarships for women 2025",
        "how to create a game design document for beginners 2025",
        "best gaming glasses for eye strain 2025",
        "game streaming on a budget capture card setup 2025",
        "indie game development resources online 2025",
        "game development internships for college students 2025",
        "gaming laptops with AMD Ryzen 3 processors 2025",
        "how to market a game development company 2025",
        "game streaming on a budget lighting setup 2025",
        "best gaming routers for gaming consoles 2025",
        "indie game development courses for beginners online 2025",
        "game development bootcamps for minorities 2026",
        "how to start a game development studio as a student 2026",
        "gaming laptops with 14-inch screens 2026",
        "virtual reality gaming and learning 2026",
        "best gaming glasses for migraines 2026",
        "game streaming on a budget green screen setup 2026",
        "indie game development podcasts for beginners 2026",
        "game development mentorship programs for women 2026",
        "gaming laptops with NVIDIA GTX 1660 2026",
        "how to become a game development consultant 2026",
        "game development events and expos 2026",
        "best gaming chairs for console gaming under $100 2026",
        "gaming laptops with AMD Radeon RX 6700M 2026",
        "VR horror games for a spine-chilling experience 2026",
        "game streaming on a budget webcam setup 2026",
        "indie game development tools for beginners 2026",
        "game development scholarships for minorities 2026",
        "how to balance gaming and academics 2026",
        "gaming laptops with high refresh rate and low response time 2026",
        "best gaming desks with cable management 2026",
        "virtual reality gaming and mental health benefits 2026",
        "game streaming on a budget microphone and camera setup 2026",
        "indie game development communities for beginners 2026",
        "game development podcasts for beginners 2026",
        "gaming laptops with NVIDIA RTX 3080 Ti 2026",
        "how to create a game design document template for beginners 2026",
        "best gaming glasses for blue light and glare 2026",
        "game streaming on a budget microphone and lighting setup 2026",
        "indie game development books for beginners 2026",
        "game development mentorship opportunities for minorities 2026",
        "gaming laptops with 17-inch screens 2026",
        "how to market a game development studio 2026",
        "game streaming on a budget microphone and green screen setup 2026",
        "best gaming routers for low ping and high speed 2026",
        "indie game development communities online 2026",
        "game development podcasts for beginners online 2026",
        "gaming laptops with AMD Ryzen 9 processors 2026",
        "how to balance gaming and relationships 2026",
        "VR horror games for a heart-pounding experience 2026",
        "game streaming on a budget microphone and webcam setup 2026",
        "indie game development tools and software 2026",
        "game development scholarships for women 2026",
        "how to create a game design document for beginners 2026",
        "best gaming glasses for eye strain 2026",
        "game streaming on a budget capture card setup 2026",
        "indie game development resources online 2026",
        "game development internships for college students 2026",
        "gaming laptops with AMD Ryzen 3 processors 2026",
        "how to market a game development company 2026",
        "game streaming on a budget lighting setup 2026",
        "best gaming routers for gaming consoles 2026",
        "indie game development courses for beginners online 2026",
        "game development bootcamps for minorities 2026",
        "how to start a game development studio as a student 2026",
        "gaming laptops with 14-inch screens 2026",
        "virtual reality gaming and learning 2026",
        "best gaming glasses for migraines 2026",
        "game streaming on a budget green screen setup 2026",
        "indie game development podcasts for beginners 2026",
        "game development mentorship programs for women 2026",
        "gaming laptops with NVIDIA GTX 1660 2026",
        "how to become a game development consultant 2026",
        "game development events and expos 2026",
        "best gaming chairs for console gaming under $100 2026",
        "gaming laptops with AMD Radeon RX 6700M 2026",
        "VR horror games for a spine-chilling experience 2026",
        "game streaming on a budget webcam setup 2026",
        "indie game development tools for beginners 2026",
        "game development scholarships for minorities 2026",
        "how to balance gaming and academics 2026",
        "gaming laptops with high refresh rate and low response time 2026",
        "best gaming desks with cable management 2026",
        "virtual reality gaming and mental health benefits 2026",
        "game streaming on a budget microphone and camera setup 2026",
        "indie game development communities for beginners 2026",
        "game development podcasts for beginners 2026",
        "gaming laptops with NVIDIA RTX 3080 Ti 2026",
        "how to create a game design document template for beginners 2026",
        "best gaming glasses for blue light and glare 2026",
        "game streaming on a budget microphone and lighting setup 2026",
        "indie game development books for beginners 2026",
        "game development mentorship opportunities for minorities 2026",
        "gaming laptops with 17-inch screens 2026",
        "how to market a game development studio 2026",
        "game streaming on a budget microphone and green screen setup 2026",
        "best gaming routers for low ping and high speed 2026",
        "indie game development communities online 2026",
        "game development podcasts for beginners online 2026",
        "gaming laptops with AMD Ryzen 9 processors 2026",
        "how to balance gaming and relationships 2026",
        "VR horror games for a heart-pounding experience 2026",
        "game streaming on a budget microphone and webcam setup 2026",
        "indie game development tools and software 2026",
        "game development scholarships for women 2026",
        "how to create a game design document for beginners 2026",
        "best gaming glasses for eye strain 2026",
        "game streaming on a budget capture card setup 2026",
        "indie game development resources online 2026",
        "game development internships for college students 2026",
        "gaming laptops with AMD Ryzen 3 processors 2026",
        "how to market a game development company 2026",
        "game streaming on a budget lighting setup 2026",
        "best gaming routers for gaming consoles 2026",
        "indie game development courses for beginners online 2026",
        "game development bootcamps for minorities 2026",
        "how to start a game development studio as a student 2026",
        "gaming laptops with 14-inch screens 2026",
        "virtual reality gaming and learning 2026",
        "best gaming glasses for migraines 2026",
        "game streaming on a budget green screen setup 2026",
        "indie game development podcasts for beginners 2026",
        "game development mentorship programs for women 2026",
        "gaming laptops with NVIDIA GTX 1660 2026",
        "how to become a game development consultant 2026",
        "game development events and expos 2026",
        "best gaming chairs for console gaming under $100 2026",
        "gaming laptops with AMD Radeon RX 6700M 2026",
        "VR horror games for a spine-chilling experience 2026",
        "game streaming on a budget webcam setup 2026",
        "indie game development tools for beginners 2026",
        "game development scholarships for minorities 2026",
        "how to balance gaming and academics 2026",
        "gaming laptops with high refresh rate and low response time 2026",
        "best gaming desks with cable management 2026",
        "virtual reality gaming and mental health benefits 2026",
        "game streaming on a budget microphone and camera setup 2026",
        "indie game development communities for beginners 2026",
        "game development podcasts for beginners 2026",
        "gaming laptops with NVIDIA RTX 3080 Ti 2026",
        "how to create a game design document template for beginners 2026",
        "best gaming glasses for blue light and glare 2026",
        "game streaming on a budget microphone and lighting setup 2026",
        "indie game development books for beginners 2026",
        "game development mentorship opportunities for minorities 2026",
        "gaming laptops with 17-inch screens 2026",
        "how to market a game development studio 2026",
        "game streaming on a budget microphone and green screen setup 2026",
        "best gaming routers for low ping and high speed 2026",
        "indie game development communities online 2026",
        "game development podcasts for beginners online 2026",
        "gaming laptops with AMD Ryzen 9 processors 2026",
        "how to balance gaming and relationships 2026",
        "VR horror games for a heart-pounding experience 2026",
        "game streaming on a budget microphone and webcam setup 2026",
        "indie game development tools and software 2026",
        "game development scholarships for women 2026",
        "how to create a game design document for beginners 2026",
        "best gaming glasses for eye strain 2026",
        "game streaming on a budget capture card setup 2026",
        "indie game development resources online 2026",
        "game development internships for college students 2026",
        "gaming laptops with AMD Ryzen 3 processors 2026",
        "how to market a game development company 2026",
        "game streaming on a budget lighting setup 2026",
        "best gaming routers for gaming consoles 2026",
        "indie game development courses for beginners online 2026",
        "game development bootcamps for minorities 2026",
        "how to start a game development studio as a student 2026",
        "gaming laptops with 14-inch screens 2026",
        "virtual reality gaming and learning 2026",
        "best gaming glasses for migraines 2026",
        "game streaming on a budget green screen setup 2026",
        "indie game development podcasts for beginners 2026",
        "game development mentorship programs for women 2026",
        "gaming laptops with NVIDIA GTX 1660 2026",
        "how to become a game development consultant 2026",
        "game development events and expos 2026",
        "best gaming chairs for console gaming under $100 2026",
        "gaming laptops with AMD Radeon RX 6700M 2026",
        "VR horror games for a spine-chilling experience 2026",
        "game streaming on a budget webcam setup 2026",
        "indie game development tools for beginners 2026",
        "game development scholarships for minorities 2026",
        "how to balance gaming and academics 2026",
        "gaming laptops with high refresh rate and low response time 2026",
        "best gaming desks with cable management 2026",
        "virtual reality gaming and mental health benefits 2026",
        "game streaming on a budget microphone and camera setup 2026",
        "indie game development communities for beginners 2026",
        "game development podcasts for beginners 2026",
        "gaming laptops with NVIDIA RTX 3080 Ti 2026",
        "how to create a game design document template for beginners 2026",
        "best gaming glasses for blue light and glare 2026",
        "game streaming on a budget microphone and lighting setup 2026",
        "indie game development books for beginners 2026",
        "game development mentorship opportunities for minorities 2026",
        "gaming laptops with 17-inch screens 2026",
        "how to market a game development studio 2026",
        "game streaming on a budget microphone and green screen setup 2026",
        "best gaming routers for low ping and high speed 2026",
        "indie game development communities online 2026",
        "game development podcasts for beginners online 2026",
        "gaming laptops with AMD Ryzen 9 processors 2026",
        "how to balance gaming and relationships 2026",
        "VR horror games for a heart-pounding experience 2026",
        "game streaming on a budget microphone and webcam setup 2026",
        "indie game development tools and software 2026",
        "game development scholarships for women 2026",
        "how to create a game design document for beginners 2026",
        "best gaming glasses for eye strain 2026",
        "game streaming on a budget capture card setup 2026",
        "indie game development resources online 2026",
        "game development internships for college students 2026",
        "gaming laptops with AMD Ryzen 3 processors 2026",
        "how to market a game development company 2026",
        "game streaming on a budget lighting setup 2026",
        "best gaming routers for gaming consoles 2026",
        "indie game development courses for beginners online 2026",
        "game development bootcamps for minorities 2026",
        "how to start a game development studio as a student 2026",
        "gaming laptops with 14-inch screens 2026",
        "virtual reality gaming and learning 2026",
        "best gaming glasses for migraines 2026",
        "game streaming on a budget green screen setup 2026",
        "indie game development podcasts for beginners 2026",
        "game development mentorship programs for women 2026",
        "should you consider buying a electric scooter",
        "best electric scooters for driving in 2026",
      ];
      const intervalSeconds = (settings && (typeof settings.dataManipulationInterval === "number" ? settings.dataManipulationInterval : typeof settings.dataManipulationIntervalSeconds === "number" ? settings.dataManipulationIntervalSeconds : undefined)) || 60;

      while (this.running) {
        try {
          const tabsArr = windowTabs.get(win) || [];
          const tab = tabsArr.find((t) => t.id === tabId);
          if (!tab || !tab.view || tab.view.webContents.isDestroyed()) break;

          const url = type === "search" ? this._getSearchUrl(this._pick(queries)) : this._pick(sites);
          try {
            await tab.view.webContents.loadURL(url);
          } catch (e) {
            try {
              await tab.view.webContents.loadURL("about:blank");
            } catch (err) { }
          }
          await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 700) + 200));
          try {
            const totalMs = intervalSeconds * 1000;
            await tab.view.webContents.executeJavaScript(`(function(totalMs){
              return new Promise((resolve) => {
                const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
                let elapsed = 0;

                // start after a brief reading delay
                const initialDelay = rand(400, 1200);
                function step() {
                  if (elapsed >= totalMs) {
                    resolve(true);
                    return;
                  }

                  const distance = rand(2, 6);
                  try { window.scrollBy(0, distance); } catch (e) {}

                  if (Math.random() < 0.12) {
                    try { window.scrollBy(0, rand(-2, 2)); } catch (e) {}
                  }

                  let pause = rand(80, 180);
                  if (Math.random() < 0.08) pause += rand(800, 2500);
                  elapsed += pause;
                  setTimeout(step, pause);
                }
                setTimeout(step, initialDelay);
              });
            })(${totalMs});`, true);
          } catch (e) {
            console.error("[manipulation] scroll error", e);
          }
          try {
            if (!this.running) break;
            const tabsCur = windowTabs.get(win) || [];
            const idx = tabsCur.findIndex((t) => t.id === tabId);
            if (idx !== -1) {
              const t = tabsCur[idx];
              try {
                if (t.view && !t.view.webContents.isDestroyed()) t.view.destroy();
              } catch (e) { }
              tabsCur.splice(idx, 1);
              windowTabs.set(win, tabsCur);

              const newActive = tabsCur.length ? tabsCur[Math.max(0, idx - 1)].id : null;
              activeTabId.set(win, newActive);
              try {
                win.webContents.send("tabs-updated", { tabs: serializeTabs(tabsCur), activeTabId: newActive, group: splitGroupsMap.get(win.id) || [], tabGroups: tabGroupsMap.get(win.id) || [] });
              } catch (e) { }
              try {
                updateAllViewBounds(win, uiHeightMap.get(win.id) || 110);
              } catch (e) { }
            }

            if (this.running) {
              const createdReplacement = await this._createManipulationTab(win);
              if (createdReplacement && createdReplacement.id != null) {
                const rec = this.records.get(win.id) || {};
                if (type === "search") rec.searchTabId = createdReplacement.id;
                else rec.siteTabId = createdReplacement.id;
                this.records.set(win.id, rec);
                tabId = createdReplacement.id;
              } else {
                break;
              }
            }
          } catch (e) {
            console.error("[manipulation] replace tab error", e);
            break;
          }
        } catch (e) {
          console.error("[manipulation] loop error", e);
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    } catch (e) {
      console.error("[manipulation] _runLoopForTab uncaught", e);
    }
  }

  async _ensureWindow(win) {
    if (!win || win.isDestroyed()) return;
    try {
      const rec = this.records.get(win.id) || {};
      this.records.set(win.id, rec);

      const q = this._readQueries();
      const sites = Array.isArray(q.sites) && q.sites.length ? q.sites.slice() : ["https://cheeter.de"];
      if (!rec.searchTabId || !(windowTabs.get(win) || []).find((t) => t.id === rec.searchTabId)) {
        const created = await this._createManipulationTab(win);
        if (created && created.id != null) {
          rec.searchTabId = created.id;
          const tabObj = (windowTabs.get(win) || []).find((t) => t.id === rec.searchTabId);
          if (tabObj) tabObj.__isManipulation = true;
          try {
            win.webContents.send("tabs-updated", { tabs: serializeTabs(windowTabs.get(win) || []), activeTabId: activeTabId.get(win), group: splitGroupsMap.get(win.id) || [], tabGroups: tabGroupsMap.get(win.id) || [] });
          } catch (e) { }
          rec.loops = rec.loops || {};
          rec.loops.search = this._runLoopForTab(win, rec.searchTabId, "search");
        }
      }
      if (!rec.siteTabId || !(windowTabs.get(win) || []).find((t) => t.id === rec.siteTabId)) {
        const created2 = await this._createManipulationTab(win);
        if (created2 && created2.id != null) {
          rec.siteTabId = created2.id;
          const tabObj2 = (windowTabs.get(win) || []).find((t) => t.id === rec.siteTabId);
          if (tabObj2) tabObj2.__isManipulation = true;
          try {
            win.webContents.send("tabs-updated", { tabs: serializeTabs(windowTabs.get(win) || []), activeTabId: activeTabId.get(win), group: splitGroupsMap.get(win.id) || [], tabGroups: tabGroupsMap.get(win.id) || [] });
          } catch (e) { }
          rec.loops = rec.loops || {};
          rec.loops.site = this._runLoopForTab(win, rec.siteTabId, "site");
        }
      }
    } catch (e) {
      console.error("[manipulation] _ensureWindow error", e);
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    BrowserWindow.getAllWindows().forEach((w) => {
      try {
        this._ensureWindow(w);
      } catch (e) { }
    });

    this._onWindowCreated = (e, w) => {
      try {
        if (this.running) setTimeout(() => this._ensureWindow(w), 500);
      } catch (err) { }
    };
    app.on("browser-window-created", this._onWindowCreated);

    BrowserWindow.getAllWindows().forEach((w) => {
      try {
        w.webContents.send("manipulation-status", { running: true });
      } catch (e) { }
    });
    console.log("[manipulation] started");
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    BrowserWindow.getAllWindows().forEach((w) => {
      try {
        const tabsArr = windowTabs.get(w) || [];
        let changed = false;
        for (let i = tabsArr.length - 1; i >= 0; i--) {
          const t = tabsArr[i];
          if (t && t.__isManipulation) {
            try {
              if (t.view && !t.view.webContents.isDestroyed()) t.view.destroy();
            } catch (err) { }
            tabsArr.splice(i, 1);
            changed = true;
          }
        }
        if (changed) {
          windowTabs.set(w, tabsArr);
          const newActive = tabsArr.length ? tabsArr[Math.max(0, tabsArr.length - 1)].id : null;
          activeTabId.set(w, newActive);
          try {
            w.webContents.send("tabs-updated", { tabs: serializeTabs(tabsArr), activeTabId: newActive, group: splitGroupsMap.get(w.id) || [] });
          } catch (e) { }
          try {
            updateAllViewBounds(w, uiHeightMap.get(w.id) || 110);
          } catch (e) { }
        }
      } catch (e) { }
    });

    try {
      for (const [wid, rec] of this.records.entries()) {
        const win = BrowserWindow.getAllWindows().find((w) => w.id === wid);
        if (!win || win.isDestroyed()) continue;
        const tabsArr = windowTabs.get(win) || [];
        let changed = false;
        const toClose = [];
        if (rec.searchTabId) toClose.push(rec.searchTabId);
        if (rec.siteTabId) toClose.push(rec.siteTabId);
        for (let i = tabsArr.length - 1; i >= 0; i--) {
          const t = tabsArr[i];
          if (t && toClose.includes(t.id)) {
            try {
              if (t.view && !t.view.webContents.isDestroyed()) t.view.destroy();
            } catch (e) { }
            tabsArr.splice(i, 1);
            changed = true;
          }
        }
        if (changed) {
          windowTabs.set(win, tabsArr);
          const newActive = tabsArr.length ? tabsArr[Math.max(0, tabsArr.length - 1)].id : null;
          activeTabId.set(win, newActive);
          try {
            win.webContents.send("tabs-updated", { tabs: serializeTabs(tabsArr), activeTabId: newActive, group: splitGroupsMap.get(win.id) || [], tabGroups: tabGroupsMap.get(win.id) || [] });
          } catch (e) { }
          try {
            updateAllViewBounds(win, uiHeightMap.get(win.id) || 110);
          } catch (e) { }
          try {
            if (newActive) {
              win.webContents.send("switch-tab-request", { tabId: newActive });
            } else {
              win.webContents.send("new-tab-request");
            }
          } catch (e) { }
        }
      }
    } catch (e) {
      console.error("[manipulation] stop cleanup error", e);
    }

    this.records.clear();
    try {
      app.removeListener("browser-window-created", this._onWindowCreated);
    } catch (e) { }
    BrowserWindow.getAllWindows().forEach((w) => {
      try {
        w.webContents.send("manipulation-status", { running: false });
      } catch (e) { }
    });
    console.log("[manipulation] stopped");
  }
}
ipcMain.on("start-manipulation", () => {
  try {
    if (!manipulationManager) manipulationManager = new ManipulationManager();
    manipulationManager.start();
  } catch (e) {
    console.error("[start-manipulation] error", e);
  }
});

ipcMain.on("stop-manipulation", () => {
  try {
    if (manipulationManager) manipulationManager.stop();
  } catch (e) {
    console.error("[stop-manipulation] error", e);
  }
});

ipcMain.on("copy-text", (event, text) => {
  try {
    if (typeof text === "string") {
      // SECURITY: Limit clipboard content size to prevent memory exhaustion
      const maxLen = 1024 * 1024; // 1MB
      const safeText = text.length > maxLen ? text.substring(0, maxLen) : text;
      clipboard.writeText(safeText);
      // SECURITY: Do not log clipboard contents - may contain sensitive data (passwords, tokens)
      console.log("[copy-text] copied to clipboard (length:", safeText.length, ")");
    }
  } catch (e) {
    console.error("[copy-text] error", e);
  }
});
