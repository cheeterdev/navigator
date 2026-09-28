(function(){
  const THEMES = [
    { id: 'theme-default', title: 'Default Dark', desc: 'Default theme', color: '#1E88E5' },
    { id: 'theme-blue', title: 'Deep Ocean', desc: 'Cool blue palette', color: '#1976D2' },
    { id: 'theme-green', title: 'Emerald', desc: 'Vibrant green', color: '#059669' },
    { id: 'theme-red', title: 'Crimson', desc: 'Bold red', color: '#DC2626' },
    { id: 'theme-orange', title: 'Sunset', desc: 'Warm orange', color: '#D97706' },
    { id: 'theme-purple', title: 'Violet', desc: 'Deep purple', color: '#6D28D9' },
    { id: 'theme-pink', title: 'Rose', desc: 'Warm pink', color: '#DB2777' },
    { id: 'theme-yellow', title: 'Sunflower', desc: 'Bright yellow', color: '#F59E0B' },
    { id: 'theme-cyan', title: 'Cyan', desc: 'Refreshing cyan', color: '#0891B2' },
    { id: 'theme-light', title: 'Light', desc: 'Bright & clean', color: '#F5F5F5' },
    { id: 'theme-liquid-glass', title: 'Liquid Glass', desc: 'Translucent, Safari‑style glass', color: '#CDE7FF' },
    { id: 'theme-oled', title: 'OLED', desc: 'Pure black', color: '#000000' },
  ];

  const themeGrid = document.getElementById('theme-grid');
  const searchList = document.getElementById('search-list');
  const frMakeDefaultBtn = document.getElementById('fr-make-default-btn');
  const frMakeDefaultStatus = document.getElementById('fr-make-default-status');
  const frRestoreLastSession = document.getElementById('fr-restore-last-session');
  const frDisposableSwitch = document.getElementById('fr-disposable-switch');
  const frUsernameInput = document.getElementById('fr-username-input');
  const frCustomHomepageInput = document.getElementById('fr-custom-homepage-input');
  const frSidebarBookmarksCb = document.getElementById('fr-sidebar-bookmarks-checkbox');
  const onboardingArquivoGroup = document.getElementById('onboarding-arquivo-group');
  const onboardingIntegratedGroup = document.getElementById('onboarding-integrated-group');
  const onboardingCustomAppsContainer = document.getElementById('onboarding-custom-apps-container');
  const onboardingCustomAppUrl = document.getElementById('onboarding-custom-app-url');
  const onboardingAddCustomAppBtn = document.getElementById('onboarding-add-custom-app-btn');
  const onboardingCustomAppError = document.getElementById('onboarding-custom-app-error');

  let developerShowCheeterSpace = false;
  let developerShowArquivoAndIntegrated = false;
  let customApps = [];

  const skipBtn = document.getElementById('skip-setup'); // may be null if header button removed
  const prevBtn = document.getElementById('prev-btn');
  const nextBtn = document.getElementById('next-btn');
  const finishBtn = document.getElementById('finish-btn');
  const progress = document.getElementById('fr-progress');
  const sections = Array.from(document.querySelectorAll('.fr-section'));
  const headerTitleEl = document.querySelector('.fr-title');
  const headerSubEl = document.querySelector('.fr-sub');
  const logoImg = document.querySelector('.logo-img');
  const logoIcon = document.querySelector('.logo-icon');

  let current = 0;
  let selectedTheme = null;
  let selectedSearch = null;
  let availableSearchEngines = [];
  const hasWelcome = document.getElementById('welcome') !== null;
  // number of real steps after the welcome page
  const realSteps = sections.length - (hasWelcome ? 1 : 0);

  function updateHeaderForSection(idx) {
    if (!headerTitleEl || !headerSubEl) return;
    // logo handling
    // swap between image and material icon
    if (logoImg && logoIcon) {
      if (hasWelcome && idx === 0) {
        logoImg.style.display = 'inline';
        logoIcon.style.display = 'none';
      } else {
        logoImg.style.display = 'none';
        logoIcon.style.display = 'inline';
        const sec = sections[idx];
        if (sec && sec.dataset.headerIcon) {
          const iconName = sec.dataset.headerIcon;
          const useEl = logoIcon.querySelector('use');
          if (useEl) {
            // Ensure icon name has icon- prefix
            const iconId = iconName.startsWith('icon-') ? iconName : `icon-${iconName}`;
            useEl.setAttribute('href', `#${iconId}`);
          }
        }
      }
    }

    if (hasWelcome && idx === 0) {
      headerTitleEl.textContent = 'Welcome to Navigator';
      headerSubEl.textContent = "Let's get things configured — a few quick choices and you're ready.";
      return;
    }
    const sec = sections[idx];
    const title = sec && sec.dataset.headerTitle ? sec.dataset.headerTitle : '';
    const desc = sec && sec.dataset.headerDesc ? sec.dataset.headerDesc : '';
    headerTitleEl.textContent = title;
    headerSubEl.textContent = desc;
  }

  // small utility: darken hex color by percent (0-100)
  function shadeColor(hex, percent) {
    if (!hex) return hex;
    let c = hex.replace('#','');
    if (c.length === 3) c = c.split('').map(ch => ch+ch).join('');
    const num = parseInt(c,16);
    let r = (num >> 16) & 0xFF;
    let g = (num >> 8) & 0xFF;
    let b = num & 0xFF;
    r = Math.max(0, Math.min(255, Math.round(r*(1 - percent/100))));
    g = Math.max(0, Math.min(255, Math.round(g*(1 - percent/100))));
    b = Math.max(0, Math.min(255, Math.round(b*(1 - percent/100))));
    return `#${((1<<24) + (r<<16) + (g<<8) + b).toString(16).slice(1)}`;
  }

  // Return readable text color (#fff or #111) for a given hex background
  function getContrastColor(hex){
    if (!hex) return '#fff';
    let c = (''+hex).replace('#','').trim();
    if (c.length === 3) c = c.split('').map(ch=>ch+ch).join('');
    if (c.length !== 6) return '#fff';
    const r = parseInt(c.substring(0,2),16);
    const g = parseInt(c.substring(2,4),16);
    const b = parseInt(c.substring(4,6),16);
    // relative luminance (approx) — threshold tuned for legibility
    const L = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    return L > 0.6 ? '#111' : '#fff';
  }

  function renderThemeTiles(){
    themeGrid.innerHTML = '';
    THEMES.forEach(t => {
      const el = document.createElement('div');
      el.className = 'theme-tile';
      el.dataset.id = t.id;
      el.title = `${t.title} - ${t.desc}`;

      // For the standard theme, use the actual CSS variables so the preview matches the real theme colors
      let frontColor = t.color;
      if (t.id === 'theme-default') {
        try {
          const root = getComputedStyle(document.documentElement);
          const toolbar = (root.getPropertyValue('--bg-toolbar') || '').trim() || '#1d1d1d';
          frontColor = toolbar;
        } catch (e) {
          frontColor = t.color;
        }
      }

      let checkmarkColor = getContrastColor(frontColor);

      el.innerHTML = `
        <div class="theme-circle" style="background:${frontColor}">
          <svg class="checkmark" viewBox="0 0 24 24" fill="none" stroke="${checkmarkColor}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
        </div>
      `;
      el.addEventListener('click', () => selectTheme(t.id, el));
      themeGrid.appendChild(el);
    });
  }

  function selectTheme(id, el){
    selectedTheme = id;
    document.querySelectorAll('.theme-tile').forEach(x => x.classList.remove('selected'));
    el.classList.add('selected');
    // Preview instantly
    applyThemePreview(id);
    try { if (window.electronAPI && window.electronAPI.setSetting) window.electronAPI.setSetting('theme', id); else localStorage.setItem('theme', id); } catch(e){}
  }

  function applyThemePreview(id){
    document.body.className = '';
    if (id) document.body.classList.add(id);
  }

  async function loadSearchEngines(){
    try {
      const res = await fetch('./search-engines.json');
      availableSearchEngines = await res.json();
    } catch (e) {
      availableSearchEngines = [{name: 'Cheeter Space', category: 'Featured, Secure'}, {name:'CGWeb', category: 'Featured, Secure'}];
    }

    renderSearchTiles();
  }

  function renderSearchTiles(){
    searchList.className = 'search-grid';
    searchList.innerHTML = '';

    let enginesToRender = availableSearchEngines;
    if (!developerShowCheeterSpace) {
      enginesToRender = availableSearchEngines.filter(se => !((se.name || '').toLowerCase().includes('cheeter')));
    }

    enginesToRender.forEach((se) => {
      const el = document.createElement('div');
      el.className = 'search-tile';
      el.dataset.name = se.name;
      const icon = se.icon || 'search';
      const color = se.color || 'rgba(255,255,255,0.03)';
      const textColor = (typeof color === 'string' && color.startsWith('#')) ? getContrastColor(color) : '#fff';

      // --- security badge: prefer explicit `se.security`, otherwise infer from `category` ---
      let security = (se.security || '').toString().toLowerCase();
      if (!security) {
        const cat = (se.category || '').toLowerCase();
        if (/collects your data|collects|overwhelming|microsoft|msft/.test(cat)) security = 'low';
        else if (/never sell|won'?t ever track|promises to never sell|private|secure|promises to keep your data/.test(cat)) security = 'high';
        else security = 'medium';
      }
      const SECURITY_COLORS = { high: '#059669', highmid: '#51af12', medium: '#f5da0b', low: '#DC2626', unknown: 'rgba(255,255,255,0.06)' };
      const secColor = SECURITY_COLORS[security] || SECURITY_COLORS.unknown;
      const secTextColor = getContrastColor(secColor);

      // --- logo selection: prefer explicit `se.logo`, otherwise try a domain->favicon fallback ---
      const nameKey = (se.name || '').toLowerCase();
      const LOGO_DOMAINS = {
        'duckduckgo': 'duckduckgo.com',
        'startpage': 'startpage.com',
        'bing': 'bing.com',
        'ecosia': 'ecosia.org',
        'oceanhero': 'oceanhero.today',
        'cheeter': 'space.cheeter.de',
        'cgweb': 'web.canaveral.group'
      };
      let logoSrc = (se.logo || '').toString().trim() || null;
      if (!logoSrc) {
        for (const k in LOGO_DOMAINS) {
          if (nameKey.includes(k)) { logoSrc = `https://www.google.com/s2/favicons?domain=${LOGO_DOMAINS[k]}&sz=64`; break; }
        }
      }
      const logoHtml = logoSrc
        ? `<img class="search-logo" src="${logoSrc}" alt="${se.name} logo" onerror="this.style.display='none'">`
        : `<svg class="icon"><use href="#icon-${icon}"></use></svg>`;

      // small textual markers per-security-level: high=✓, highmid=plain, medium=!, low=×
      const MARKERS = { high: '✓', highmid: '', medium: '!', low: '×' };
      const marker = MARKERS[security] !== undefined ? MARKERS[security] : '';
      const showMarker = !!marker;

      el.innerHTML = `<div class="search-icon" style="color: ${color}; border-color: rgba(0,0,0,0.06);">${logoHtml}</div>
        <div style="flex:1">
          <div class="search-title">${se.name}</div>
          <div class="search-desc">${se.category}</div>
        </div>
        <div class="search-security" title="Sicherheit: ${security.charAt(0).toUpperCase() + security.slice(1)}" style="color: ${secColor};">
          <svg class="icon shield-icon"><use href="#icon-shield"></use></svg>
          ${showMarker ? `<span class="security-mark security-mark--${security}">${marker}</span>` : ''}
        </div>`;

      el.addEventListener('click', () => selectSearchEngine(se.name, el));
      searchList.appendChild(el);
    });

    // apply preselected from settings or default
    const defaultEng = (enginesToRender[0] && enginesToRender[0].name) || null;
    if (!selectedSearch || (!developerShowCheeterSpace && (selectedSearch || '').toLowerCase().includes('cheeter'))) {
      selectedSearch = defaultEng;
    }
    applySearchSelection();
  }



  function selectSearchEngine(name, el){
    selectedSearch = name;
    applySearchSelection();
    try { if (window.electronAPI && window.electronAPI.setSetting) window.electronAPI.setSetting('searchEngine', selectedSearch); else localStorage.setItem('searchEngine', selectedSearch); } catch(e){}
  }

  function applySearchSelection(){
    document.querySelectorAll('.search-tile').forEach(x => x.classList.remove('selected'));
    const chosen = document.querySelector(`.search-tile[data-name="${selectedSearch}"]`);
    if (chosen) chosen.classList.add('selected');
  }

  // legacy placeholder removed


  function applyArquivoIntegratedVisibility(show) {
    if (onboardingArquivoGroup) onboardingArquivoGroup.style.display = show ? '' : 'none';
    if (onboardingIntegratedGroup) onboardingIntegratedGroup.style.display = show ? '' : 'none';
  }

  function renderCustomApps() {
    if (!onboardingCustomAppsContainer) return;
    onboardingCustomAppsContainer.innerHTML = '';
    customApps.forEach(app => {
      const label = document.createElement('label');
      label.className = 'app-item';
      label.dataset.appId = app.id;

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'sidebar-app-cb checkbox-custom';
      cb.value = app.id;
      cb.checked = true;

      let domain = app.domain;
      if (!domain && app.url) {
        try { domain = new URL(app.url).hostname; } catch(e) { domain = app.url; }
      }
      const img = document.createElement('img');
      img.src = `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
      img.style.cssText = 'width: 18px; height: 18px; border-radius: 4px;';
      img.onerror = () => { img.style.display = 'none'; };

      const span = document.createElement('span');
      span.textContent = app.name || 'Custom App';

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'app-delete-btn';
      delBtn.title = 'Delete custom app';
      delBtn.innerHTML = '&times;';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        customApps = customApps.filter(a => a.id !== app.id);
        if (window.electronAPI && window.electronAPI.setSetting) {
          window.electronAPI.setSetting('customApps', customApps);
        } else {
          localStorage.setItem('customApps', JSON.stringify(customApps));
        }
        renderCustomApps();
      });

      label.appendChild(cb);
      label.appendChild(img);
      label.appendChild(span);
      label.appendChild(delBtn);
      onboardingCustomAppsContainer.appendChild(label);
    });
  }

  function deriveNameFromDomain(domain) {
    if (!domain) return 'Custom App';
    const clean = domain.replace(/^www\./i, '');
    const main = clean.split('.')[0] || clean;
    const brandMap = {
      'youtube': 'YouTube',
      'github': 'GitHub',
      'discord': 'Discord',
      'mastodon': 'Mastodon',
      'reddit': 'Reddit',
      'twitter': 'Twitter',
      'twitch': 'Twitch',
      'spotify': 'Spotify',
      'whatsapp': 'WhatsApp',
      'telegram': 'Telegram',
      'instagram': 'Instagram',
      'facebook': 'Facebook',
      'linkedin': 'LinkedIn',
      'netflix': 'Netflix',
      'wikipedia': 'Wikipedia',
      'amazon': 'Amazon',
      'google': 'Google'
    };
    if (brandMap[main.toLowerCase()]) return brandMap[main.toLowerCase()];
    return main.charAt(0).toUpperCase() + main.slice(1);
  }

  async function resolvePageTitle(url, domain) {
    if (window.electronAPI && window.electronAPI.getPageTitle) {
      try {
        const raw = await window.electronAPI.getPageTitle(url);
        if (raw && raw.trim()) {
          let t = raw.trim();
          const seps = [' | ', ' - ', ' — ', ' · ', ' • '];
          for (const sep of seps) {
            if (t.includes(sep)) {
              const parts = t.split(sep).map(p => p.trim()).filter(Boolean);
              if (parts[0] && parts[0].length >= 2 && parts[0].length <= 25) {
                t = parts[0];
                break;
              } else if (parts[parts.length - 1] && parts[parts.length - 1].length >= 2 && parts[parts.length - 1].length <= 25) {
                t = parts[parts.length - 1];
                break;
              }
            }
          }
          if (t.length > 25) t = t.slice(0, 25).trim();
          if (t) return t;
        }
      } catch(e) {}
    }
    return deriveNameFromDomain(domain);
  }

  const onboardingPreviewIcon = document.getElementById('onboarding-custom-app-icon');
  const onboardingAddRowEl = document.getElementById('onboarding-add-custom-row');

  if (onboardingAddRowEl && onboardingCustomAppUrl) {
    onboardingAddRowEl.addEventListener('click', (e) => {
      if (e.target !== onboardingAddCustomAppBtn && !e.target.closest('#onboarding-add-custom-app-btn')) {
        onboardingCustomAppUrl.focus();
      }
    });
  }

  if (onboardingCustomAppUrl) {
    onboardingCustomAppUrl.addEventListener('input', () => {
      let val = onboardingCustomAppUrl.value.trim();
      if (!onboardingPreviewIcon) return;
      if (!val) {
        onboardingPreviewIcon.src = 'https://www.google.com/s2/favicons?domain=example.com&sz=64';
        return;
      }
      if (!/^https?:\/\//i.test(val)) val = 'https://' + val;
      try {
        const d = new URL(val).hostname;
        if (d && d.includes('.')) {
          onboardingPreviewIcon.src = `https://www.google.com/s2/favicons?domain=${d}&sz=64`;
        }
      } catch(e) {}
    });
  }

  async function addCustomAppFromUrl() {
    let url = (onboardingCustomAppUrl ? onboardingCustomAppUrl.value : '').trim();

    if (!url) {
      if (onboardingCustomAppError) {
        onboardingCustomAppError.textContent = 'Please enter a URL.';
        onboardingCustomAppError.style.display = 'block';
      }
      return;
    }

    if (!/^https?:\/\//i.test(url)) {
      url = 'https://' + url;
    }

    let domain = '';
    try {
      domain = new URL(url).hostname;
    } catch(e) {
      if (onboardingCustomAppError) {
        onboardingCustomAppError.textContent = 'Please enter a valid URL.';
        onboardingCustomAppError.style.display = 'block';
      }
      return;
    }

    if (!domain || !domain.includes('.')) {
      if (onboardingCustomAppError) {
        onboardingCustomAppError.textContent = 'Please enter a valid URL (e.g. https://example.com).';
        onboardingCustomAppError.style.display = 'block';
      }
      return;
    }

    if (onboardingCustomAppError) onboardingCustomAppError.style.display = 'none';

    const name = await resolvePageTitle(url, domain);

    const newApp = {
      id: 'tp_custom_' + Date.now(),
      name: name,
      url: url,
      domain: domain,
      cat: 'thirdparty',
      icon: 'favicon'
    };

    customApps.push(newApp);
    if (window.electronAPI && window.electronAPI.setSetting) {
      window.electronAPI.setSetting('customApps', customApps);
    } else {
      localStorage.setItem('customApps', JSON.stringify(customApps));
    }

    if (onboardingCustomAppUrl) onboardingCustomAppUrl.value = '';
    if (onboardingPreviewIcon) onboardingPreviewIcon.src = 'https://www.google.com/s2/favicons?domain=example.com&sz=64';

    renderCustomApps();
  }

  if (onboardingAddCustomAppBtn) {
    onboardingAddCustomAppBtn.addEventListener('click', addCustomAppFromUrl);
  }
  if (onboardingCustomAppUrl) {
    onboardingCustomAppUrl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addCustomAppFromUrl(); }
    });
  }

  function loadSaved(){
    const loadFromSettings = window.electronAPI && window.electronAPI.getSettings;
    if (loadFromSettings){
      window.electronAPI.getSettings().then(s => {
        if (!s) return;
        developerShowCheeterSpace = !!s.developerShowCheeterSpace;
        developerShowArquivoAndIntegrated = !!s.developerShowArquivoAndIntegrated;
        applyArquivoIntegratedVisibility(developerShowArquivoAndIntegrated);

        if (s && typeof s.bookmarksInSidebar !== 'undefined' && frSidebarBookmarksCb) {
          frSidebarBookmarksCb.checked = !!s.bookmarksInSidebar;
        }
        if (s && Array.isArray(s.customApps)) {
          customApps = s.customApps;
        }
        renderCustomApps();

        // Theme mapping: if a saved theme was 'theme-custom' or missing, fall back to 'theme-default'
        const savedTheme = (s.theme === 'theme-custom' || !s.theme) ? 'theme-default' : s.theme;
        if (savedTheme) {
          const tile = document.querySelector(`.theme-tile[data-id="${savedTheme}"]`);
          if (tile) { selectTheme(savedTheme, tile); }
          else { applyThemePreview(savedTheme); }
        }

        if (s.searchEngine) {
          // ignore 'Custom' if present
          selectedSearch = (s.searchEngine === 'Custom') ? null : s.searchEngine;
        }
        // Quick settings prefill
        if (typeof frRestoreLastSession !== 'undefined' && s && typeof s.restoreLastSession !== 'undefined') frRestoreLastSession.checked = !!s.restoreLastSession;
        if (typeof frDisposableSwitch !== 'undefined' && s && typeof s.disposableMode !== 'undefined') frDisposableSwitch.checked = (s.disposableMode === 'disposable');
        if (typeof frUsernameInput !== 'undefined' && s && s.username) frUsernameInput.value = s.username;
        if (typeof frCustomHomepageInput !== 'undefined' && s && s.homepage) frCustomHomepageInput.value = s.homepage;
        if (s && s.sidebarApps) {
            document.querySelectorAll(".sidebar-app-cb").forEach(cb => {
                if (s.sidebarApps.includes(cb.value)) cb.checked = true;
            });
        }

        if (availableSearchEngines.length > 0) renderSearchTiles();
        else applySearchSelection();
      }).catch(()=>{});
    } else {
      developerShowCheeterSpace = (localStorage.getItem('developerShowCheeterSpace') === 'true');
      developerShowArquivoAndIntegrated = (localStorage.getItem('developerShowArquivoAndIntegrated') === 'true');
      applyArquivoIntegratedVisibility(developerShowArquivoAndIntegrated);

      if (frSidebarBookmarksCb) frSidebarBookmarksCb.checked = (localStorage.getItem('bookmarksInSidebar') === 'true');
      try {
        customApps = JSON.parse(localStorage.getItem('customApps') || '[]');
      } catch(e) {}
      renderCustomApps();

      const t = localStorage.getItem('theme'); if (t) applyThemePreview(t);
      const se = localStorage.getItem('searchEngine'); if (se){ selectedSearch = se; }
      // Quick settings fallback
      if (typeof frRestoreLastSession !== 'undefined') frRestoreLastSession.checked = (localStorage.getItem('restoreLastSession') === 'true');
      if (typeof frDisposableSwitch !== 'undefined') frDisposableSwitch.checked = (localStorage.getItem('disposableMode') === 'disposable');
      if (typeof frUsernameInput !== 'undefined') frUsernameInput.value = localStorage.getItem('username') || '';
      if (typeof frCustomHomepageInput !== 'undefined') frCustomHomepageInput.value = localStorage.getItem('homepage') || '';
      try {
        const sbarApps = JSON.parse(localStorage.getItem('sidebarApps') || '[]');
        document.querySelectorAll(".sidebar-app-cb").forEach(cb => {
            if (sbarApps.includes(cb.value)) cb.checked = true;
        });
      } catch(e) {}
      if (availableSearchEngines.length > 0) renderSearchTiles();
      else applySearchSelection();
    }
  }

  // Match AVAILABLE_APPS from renderer.js
  const AVAILABLE_APPS = {
    "ab_ftp": { name: "Arquivo FTP", icon: "icon-arquivo-ftp", cat: "arquivo" },
    "ab_photos": { name: "Arquivo Photos", icon: "icon-arquivo-photos", cat: "arquivo" },
    "ab_tv": { name: "Arquivo TV", icon: "icon-arquivo-tv", cat: "arquivo" },
    "ia_mail": { name: "Mail", icon: "icon-mail", cat: "integrated" },
    "ia_contacts": { name: "Contacts", icon: "icon-contacts", cat: "integrated" },
    "ia_calendar": { name: "Calendar", icon: "icon-calendar", cat: "integrated" },
    "ia_notes": { name: "Notes", icon: "icon-notes", cat: "integrated" },
    "tp_discord": { name: "Discord", icon: "favicon", domain: "discord.com", cat: "thirdparty" },
    "tp_mastodon": { name: "Mastodon", icon: "favicon", domain: "mastodon.social", cat: "thirdparty" },
    "tp_youtube": { name: "YouTube", icon: "favicon", domain: "youtube.com", cat: "thirdparty" },
    "tp_cheeter_hosting": { name: "Cheeter Hosting", icon: "favicon", domain: "hosting.cheeter.de", cat: "thirdparty" },
    "tp_cheeter": { name: "Cheeter", icon: "favicon", domain: "cheeter.de", cat: "thirdparty" }
  };

  function updateAppIcons() {
    document.querySelectorAll(".sidebar-app-cb").forEach(checkbox => {
      const appId = checkbox.value;
      const appInfo = AVAILABLE_APPS[appId] || customApps.find(a => a.id === appId);
      if (!appInfo) return;

      const label = checkbox.closest('.app-item');
      if (!label) return;

      // If an icon already exists, clean up any duplicates and keep only 1
      const existingIcons = label.querySelectorAll('svg, img:not(.custom-app-dummy-cb):not(.custom-app-preview-icon)');
      if (existingIcons.length > 0) {
        for (let i = 1; i < existingIcons.length; i++) {
          existingIcons[i].remove();
        }
        return;
      }

      // Create and insert correct icon
      let iconElement;
      if (appInfo.cat === "thirdparty" || appInfo.icon === "favicon") {
        const faviconUrl = `https://www.google.com/s2/favicons?domain=${appInfo.domain}&sz=64`;
        iconElement = document.createElement('img');
        iconElement.src = faviconUrl;
        iconElement.style.width = "18px";
        iconElement.style.height = "18px";
        iconElement.style.borderRadius = "4px";
        iconElement.setAttribute('data-app-favicon', 'true');
        iconElement.alt = appInfo.name;
      } else {
        iconElement = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        iconElement.setAttribute('class', 'icon');
        iconElement.setAttribute('style', 'width: 18px; height: 18px;');
        const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
        use.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', `#${appInfo.icon}`);
        iconElement.appendChild(use);
      }

      label.insertBefore(iconElement, label.querySelector('span'));
    });
  }

  function showSection(idx){
    // update header text before toggling sections
    updateHeaderForSection(idx);
    sections.forEach((s,i) => { s.style.display = i === idx ? 'block' : 'none'; });

    // customize for welcome page
    if (hasWelcome && idx === 0) {
      // splash: hide progress, use skip button for prev
      progress.style.visibility = 'hidden';
      prevBtn.disabled = false;
      prevBtn.textContent = 'Skip';
      nextBtn.textContent = 'Get started';
      nextBtn.style.display = 'inline-block';
      finishBtn.style.display = 'none';
      return;
    }

    // normal pages: show progress with adjusted counts
    progress.style.visibility = 'visible';
    // compute step number relative to welcome
    const stepNum = idx - (hasWelcome ? 1 : 0);
    progress.textContent = `${stepNum+1} / ${realSteps}`;
    prevBtn.disabled = false;
    prevBtn.textContent = 'Back';
    nextBtn.textContent = 'Next';
    nextBtn.style.display = idx < sections.length - 1 ? 'inline-block' : 'none';
    finishBtn.style.display = idx === sections.length -1 ? 'inline-block' : 'none';
  }

  // Flow controls
  prevBtn.addEventListener('click', () => {
    if (hasWelcome && current === 0) {
      // act as skip on welcome page
      skip();
      return;
    }
    if (current > 0) { current--; showSection(current); }
  });
  nextBtn.addEventListener('click', () => {
    // if on welcome page, treat as stepping to first real step
    if (hasWelcome && current === 0) {
      current = 1;
      showSection(current);
      return;
    }
    if (current < sections.length-1) { current++; showSection(current); }
  });
  finishBtn.addEventListener('click', finish);
  if (skipBtn) skipBtn.addEventListener('click', skip);

  function finish(){
    // ensure settings persisted
    try { if (window.electronAPI && window.electronAPI.setSetting){
      if (selectedTheme) window.electronAPI.setSetting('theme', selectedTheme);
      if (selectedSearch) window.electronAPI.setSetting('searchEngine', selectedSearch);
      const dm = (typeof frDisposableSwitch !== 'undefined' && frDisposableSwitch.checked) ? 'disposable' : 'none';
      window.electronAPI.setSetting('disposableMode', dm);
      // quick settings
      if (typeof frRestoreLastSession !== 'undefined') window.electronAPI.setSetting('restoreLastSession', !!frRestoreLastSession.checked);
      if (typeof frUsernameInput !== 'undefined' && frUsernameInput.value) window.electronAPI.setSetting('username', frUsernameInput.value.trim());
      if (typeof frCustomHomepageInput !== 'undefined' && frCustomHomepageInput.value) window.electronAPI.setSetting('homepage', frCustomHomepageInput.value.trim());
      if (typeof frSidebarBookmarksCb !== 'undefined' && frSidebarBookmarksCb) window.electronAPI.setSetting('bookmarksInSidebar', !!frSidebarBookmarksCb.checked);
      window.electronAPI.setSetting('customApps', customApps);
      const sidebarApps = Array.from(document.querySelectorAll(".sidebar-app-cb:checked")).map(cb => cb.value);
      if (!sidebarApps.includes('ia_rss')) sidebarApps.push('ia_rss');
      window.electronAPI.setSetting('sidebarApps', sidebarApps);
      window.electronAPI.setSetting('firstRunComplete', true);
      if (window.electronAPI && window.electronAPI.completeFirstRun) window.electronAPI.completeFirstRun();
    } else {
      if (selectedTheme) localStorage.setItem('theme', selectedTheme);
      if (selectedSearch) localStorage.setItem('searchEngine', selectedSearch);
      const dm = (typeof frDisposableSwitch !== 'undefined' && frDisposableSwitch.checked) ? 'disposable' : 'none';
      localStorage.setItem('disposableMode', dm);
      if (typeof frRestoreLastSession !== 'undefined') localStorage.setItem('restoreLastSession', frRestoreLastSession.checked);
      if (typeof frUsernameInput !== 'undefined' && frUsernameInput.value) localStorage.setItem('username', frUsernameInput.value.trim());
      if (typeof frCustomHomepageInput !== 'undefined' && frCustomHomepageInput.value) localStorage.setItem('homepage', frCustomHomepageInput.value.trim());
      if (typeof frSidebarBookmarksCb !== 'undefined' && frSidebarBookmarksCb) localStorage.setItem('bookmarksInSidebar', String(!!frSidebarBookmarksCb.checked));
      localStorage.setItem('customApps', JSON.stringify(customApps));
      const sidebarApps = Array.from(document.querySelectorAll(".sidebar-app-cb:checked")).map(cb => cb.value);
      if (!sidebarApps.includes('ia_rss')) sidebarApps.push('ia_rss');
      localStorage.setItem('sidebarApps', JSON.stringify(sidebarApps));
      localStorage.setItem('firstRunComplete', '1');
      // best-effort: reload or close
      window.close();
    } } catch(e){ console.error(e); }
  }

  function skip(){
    try { if (window.electronAPI && window.electronAPI.setSetting) { window.electronAPI.setSetting('firstRunComplete', true); if (window.electronAPI.completeFirstRun) window.electronAPI.completeFirstRun(); } else { localStorage.setItem('firstRunComplete','1'); window.close(); } } catch(e){ console.error(e); }
  }

  // Make-default button wiring (Quick Settings)
  if (typeof frMakeDefaultBtn !== 'undefined'){
    frMakeDefaultBtn.addEventListener('click', () => {
      try {
        if (window.electronAPI && window.electronAPI.menuAction) {
          window.electronAPI.menuAction({ action: 'make-default-browser' });
          if (frMakeDefaultStatus) frMakeDefaultStatus.textContent = 'Request sent — follow system prompt if shown';
          setTimeout(() => { if (frMakeDefaultStatus) frMakeDefaultStatus.textContent = 'macOS will show a system dialog if required'; }, 5000);
        }
      } catch (e) { console.error('[onboarding] make-default error', e); }
    });
  }

  // Disposable switch wiring (Quick Settings)
  if (typeof frDisposableSwitch !== 'undefined'){
    frDisposableSwitch.addEventListener('change', () => {
      const dm = frDisposableSwitch.checked ? 'disposable' : 'none';
      try { if (window.electronAPI && window.electronAPI.setSetting) window.electronAPI.setSetting('disposableMode', dm); else localStorage.setItem('disposableMode', dm); } catch(e){}
    });
  }

  // nothing special needed; welcome page uses img by default

  // init
  renderThemeTiles();
  loadSaved();
  updateAppIcons();
  loadSearchEngines();
  showSection(0);
})();
