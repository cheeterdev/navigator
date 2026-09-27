const STORAGE_KEY = 'mailAccounts';

const backBtn = document.getElementById('back-btn');
const protocolSelect = document.getElementById('protocol');
const hostInput = document.getElementById('host');
const portInput = document.getElementById('port');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const useTlsCheckbox = document.getElementById('use-tls');
const addAccountButton = document.getElementById('add-account');
const refreshButton = document.getElementById('refresh-mail');
const accountsContainer = document.getElementById('accounts');
const statusEl = document.getElementById('status');
const accountInfo = document.getElementById('account-info');
const messagesContainer = document.getElementById('messages');

let mailAccounts = [];
let activeAccountIndex = null;
let lastConnection = null;

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.style.color = isError ? '#fca5a5' : '';
}

backBtn.addEventListener('click', () => {
  window.location.href = '../index.html';
});

function saveAccounts() {
  if (window.electronAPI && window.electronAPI.setSetting) {
    window.electronAPI.setSetting(STORAGE_KEY, mailAccounts);
  } else {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(mailAccounts));
  }
}

function renderAccounts() {
  accountsContainer.innerHTML = '';
  if (mailAccounts.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'account-item';
    empty.textContent = 'Keine Mail-Konten konfiguriert. Füge ein Konto hinzu.';
    accountsContainer.appendChild(empty);
    return;
  }

  mailAccounts.forEach((account, index) => {
    const item = document.createElement('div');
    item.className = 'account-item';

    const header = document.createElement('div');
    const title = document.createElement('strong');
    title.innerHTML = `${account.protocol.toUpperCase()} • ${account.username}@${account.host}`;
    header.appendChild(title);

    const actions = document.createElement('div');
    
    const connect = document.createElement('button');
    connect.textContent = activeAccountIndex === index ? '↻' : '▶';
    connect.title = activeAccountIndex === index ? 'Erneut verbinden' : 'Verbinden';
    connect.addEventListener('click', (e) => {
      e.stopPropagation();
      activeAccountIndex = index;
      renderAccounts();
      connectMailAccount(index);
    });

    const remove = document.createElement('button');
    remove.textContent = '✕';
    remove.title = 'Löschen';
    remove.addEventListener('click', (e) => {
      e.stopPropagation();
      if (activeAccountIndex === index) {
        activeAccountIndex = null;
      }
      mailAccounts.splice(index, 1);
      saveAccounts();
      renderAccounts();
      renderMessages(null);
      setStatus('Konto entfernt.');
    });

    actions.appendChild(connect);
    actions.appendChild(remove);
    item.appendChild(header);
    item.appendChild(actions);
    accountsContainer.appendChild(item);
  });
}

function renderMessages(data) {
  messagesContainer.innerHTML = '';
  accountInfo.textContent = '';

  if (!data) {
    accountInfo.textContent = 'Verbinde mit einem Konto...';
    return;
  }

  const statusIcon = data.success ? '✓' : '✗';
  const statusText = data.success ? 'Verbunden' : 'Fehler';
  accountInfo.innerHTML = `<span style="font-size:1.2em;margin-right:8px">${statusIcon}</span> <strong>${statusText}</strong>`;

  if (!data.success) {
    const error = document.createElement('div');
    error.className = 'message-card';
    error.innerHTML = `<h2>Fehler</h2><p><strong>${sanitizeText(data.error || 'Verbindung fehlgeschlagen.')}</strong></p>`;
    messagesContainer.appendChild(error);
    return;
  }

  if (data.greeting) {
    const greeting = document.createElement('div');
    greeting.className = 'message-card';
    greeting.innerHTML = `<h2>Server</h2><p>${sanitizeText(data.greeting)}</p>`;
    messagesContainer.appendChild(greeting);
  }

  if (Array.isArray(data.mailboxes) && data.mailboxes.length > 0) {
    const mailbox = document.createElement('div');
    mailbox.className = 'message-card';
    mailbox.innerHTML = `<h2>Postfächer</h2><p>${data.mailboxes.map((m) => sanitizeText(m.name)).join(' • ')}</p>`;
    messagesContainer.appendChild(mailbox);
  }

  if (Array.isArray(data.messages) && data.messages.length > 0) {
    const msgContainer = document.createElement('div');
    msgContainer.className = 'message-card';
    msgContainer.innerHTML = `<h2>Übersicht</h2><p>${data.messages.map(sanitizeText).join('<br>')}</p>`;
    messagesContainer.appendChild(msgContainer);
  }

  if (Array.isArray(data.logs) && data.logs.length > 0) {
    const logs = document.createElement('div');
    logs.className = 'message-card';
    logs.innerHTML = `<h2>Details</h2><pre style="margin:0;font-size:0.85em;white-space:pre-wrap;word-break:break-word">${data.logs.slice(0, 8).map(sanitizeText).join('\n')}</pre>`;
    messagesContainer.appendChild(logs);
  }
}

function sanitizeText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function loadAccounts() {
  try {
    if (window.electronAPI && window.electronAPI.getSettings) {
      const settings = await window.electronAPI.getSettings();
      mailAccounts = Array.isArray(settings?.[STORAGE_KEY]) ? settings[STORAGE_KEY] : [];
    } else {
      mailAccounts = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    }
  } catch (err) {
    mailAccounts = [];
  }
  renderAccounts();
  renderMessages(lastConnection);
}

function validateAccount(account) {
  if (!account.host || !account.port || !account.username || !account.password) {
    return false;
  }
  return true;
}

function updateDefaultPort() {
  const protocol = protocolSelect.value;
  const useTls = useTlsCheckbox.checked;
  let defaultPort;
  if (protocol === 'imap') {
    defaultPort = useTls ? 993 : 143;
  } else if (protocol === 'pop3') {
    defaultPort = useTls ? 995 : 110;
  }
  portInput.value = defaultPort;
  portInput.placeholder = `Port (Standard: ${defaultPort})`;
}

async function connectMailAccount(index) {
  const account = mailAccounts[index];
  if (!account || !validateAccount(account)) {
    setStatus('Unvollständige Kontodaten.', true);
    return;
  }
  setStatus('Verbinde…');
  try {
    const result = await window.electronAPI.connectMailAccount(account);
    lastConnection = result;
    renderMessages(result);
    if (result.success) {
      setStatus('Verbindung erfolgreich.');
    } else {
      setStatus(`Fehler: ${result.error}`, true);
    }
  } catch (err) {
    setStatus(`Fehler: ${err?.message || err}`, true);
  }
}

addAccountButton.addEventListener('click', () => {
  const protocol = protocolSelect.value;
  const useTls = useTlsCheckbox.checked;
  let defaultPort;
  if (protocol === 'imap') defaultPort = useTls ? 993 : 143;
  else if (protocol === 'pop3') defaultPort = useTls ? 995 : 110;
  else if (protocol === 'smtp') defaultPort = useTls ? 587 : 25;
  const account = {
    protocol,
    host: hostInput.value.trim(),
    port: parseInt(portInput.value.trim(), 10) || defaultPort,
    username: usernameInput.value.trim(),
    password: passwordInput.value,
    useTls,
  };

  if (!validateAccount(account)) {
    setStatus('Bitte alle Kontodaten ausfüllen.', true);
    return;
  }

  mailAccounts.push(account);
  saveAccounts();
  renderAccounts();
  setStatus('Konto hinzugefügt. Wähle es aus und verbinde es.');
});

refreshButton.addEventListener('click', () => {
  if (activeAccountIndex === null || activeAccountIndex === undefined) {
    setStatus('Wähle zuerst ein Konto aus.', true);
    return;
  }
  connectMailAccount(activeAccountIndex);
});

window.addEventListener('DOMContentLoaded', () => {
  loadAccounts();
  updateDefaultPort();
  protocolSelect.addEventListener('change', updateDefaultPort);
  useTlsCheckbox.addEventListener('change', updateDefaultPort);
});
