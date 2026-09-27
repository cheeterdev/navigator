const STORAGE_KEY = 'mailAccounts';
const ACTIVE_ACCOUNT_KEY = 'activeMailAccount';

const settingsBtn = document.getElementById('settings-btn');
const composeBtn = document.getElementById('compose-btn');
const sidebarToggle = document.getElementById('sidebar-toggle');
const composeModal = document.getElementById('compose-modal');
const closeCompose = document.getElementById('close-compose');
const cancelCompose = document.getElementById('cancel-compose');
const composeForm = document.getElementById('compose-form');
const statusEl = document.getElementById('status');
const accountsList = document.getElementById('accounts-list');
const noAccountsMsg = document.getElementById('no-accounts');
const foldersSection = document.getElementById('folders-section');
const foldersList = document.getElementById('folders-list');
const messagesList = document.getElementById('messages-list');
const welcomeMsg = document.getElementById('welcome');
const loadingMsg = document.getElementById('loading');

let mailAccounts = [];
let activeAccountIndex = null;
let activeMailbox = null;

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.style.color = isError ? '#ff6b6b' : '';
}

function sanitizeText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderAccountsList() {
  accountsList.innerHTML = '';
  if (mailAccounts.length === 0) {
    noAccountsMsg.style.display = 'block';
    foldersSection.style.display = 'none';
    return;
  }
  noAccountsMsg.style.display = 'none';

  mailAccounts.forEach((account, index) => {
    const item = document.createElement('div');
    item.className = 'account-item';
    if (activeAccountIndex === index) {
      item.classList.add('active');
    }
    item.innerHTML = `<div class="account-email">${sanitizeText(account.username)}</div><div class="account-server">${account.protocol.toUpperCase()} • ${sanitizeText(account.host)}</div>`;
    item.addEventListener('click', () => {
      if (activeAccountIndex !== index) {
        activeMailbox = null;
      }
      activeAccountIndex = index;
      saveActiveAccount();
      renderAccountsList();
      loadMessages(index);
    });
    accountsList.appendChild(item);
  });
}

function renderFolderList(mailboxes) {
  foldersList.innerHTML = '';
  const mailboxItems = Array.isArray(mailboxes) && mailboxes.length > 0 ? mailboxes : [{ name: 'INBOX' }];
  foldersSection.style.display = 'block';

  mailboxItems.forEach((mailbox) => {
    const item = document.createElement('div');
    item.className = 'account-item folder-item';
    if (activeMailbox === mailbox.name) item.classList.add('active');
    item.innerHTML = `<div class="account-email">${sanitizeText(mailbox.name)}</div>`;
    item.addEventListener('click', () => {
      activeMailbox = mailbox.name;
      renderFolderList(mailboxItems);
      loadMessages(activeAccountIndex, mailbox.name);
    });
    foldersList.appendChild(item);
  });
}

function renderMessages(messages, mailbox) {
  messagesList.innerHTML = '';
  if (mailbox) {
    welcomeMsg.style.display = 'none';
  }
  if (!messages || messages.length === 0) {
    messagesList.innerHTML = '<div class="no-messages">Keine Nachrichten.</div>';
    return;
  }

  // Debug: Show raw messages
  messages.forEach((msg) => {
    const card = document.createElement('div');
    card.className = 'message-card';
    card.innerHTML = `<p>${sanitizeText(msg)}</p>`;
    messagesList.appendChild(card);
  });
}

async function loadMessages(index, mailbox = null) {
  const account = mailAccounts[index];
  if (!account) return;

  if (mailbox) {
    activeMailbox = mailbox;
  }

  welcomeMsg.style.display = 'none';
  loadingMsg.style.display = 'block';
  messagesList.innerHTML = '';

  try {
    const request = { ...account };
    if (activeMailbox) request.mailbox = activeMailbox;
    const result = await window.electronAPI.connectMailAccount(request);
    if (result.success) {
      const mailboxes = Array.isArray(result.mailboxes) && result.mailboxes.length > 0 ? result.mailboxes : [{ name: 'INBOX' }];
      account.mailboxes = mailboxes;
      renderFolderList(mailboxes);
      setStatus(`${account.username} • ${request.mailbox || mailboxes[0].name || 'INBOX'} geladen`);
      renderMessages(result.messages || [], result.selectedMailbox || request.mailbox || mailboxes[0].name || 'INBOX');
    } else {
      setStatus(`Fehler: ${result.error}`, true);
      renderMessages([result.error], null);
    }
  } catch (err) {
    setStatus(`Fehler: ${err?.message || err}`, true);
    renderMessages([err?.message || String(err)], null);
  } finally {
    loadingMsg.style.display = 'none';
  }
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
  
  const saved = localStorage.getItem(ACTIVE_ACCOUNT_KEY);
  if (saved !== null) {
    activeAccountIndex = parseInt(saved, 10);
  }
  
  renderAccountsList();
  if (activeAccountIndex !== null && mailAccounts[activeAccountIndex]) {
    loadMessages(activeAccountIndex);
  }
}

function saveActiveAccount() {
  if (activeAccountIndex !== null) {
    localStorage.setItem(ACTIVE_ACCOUNT_KEY, String(activeAccountIndex));
  }
}

settingsBtn.addEventListener('click', () => {
  const settingsUrl = 'pages/settings.html';
  window.location.href = settingsUrl;
});

composeBtn.addEventListener('click', () => {
  composeModal.style.display = 'flex';
});

closeCompose.addEventListener('click', () => {
  composeModal.style.display = 'none';
});

cancelCompose.addEventListener('click', () => {
  composeModal.style.display = 'none';
});

composeForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const to = document.getElementById('to-input').value;
  const subject = document.getElementById('subject-input').value;
  const body = document.getElementById('body-input').value;
  
  // Placeholder for sending email - implement SMTP sending later
  setStatus('E-Mail-Versand noch nicht implementiert', true);
  composeModal.style.display = 'none';
  composeForm.reset();
});

sidebarToggle.addEventListener('click', () => {
  const sidebar = document.getElementById('accounts-sidebar');
  sidebar.classList.toggle('open');
});

window.addEventListener('DOMContentLoaded', () => {
  loadAccounts();
});
