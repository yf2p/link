// Redirect to f2p section if not already on a hash route
const currentPath = window.location.pathname;
if (!window.location.hash) {
  window.location.replace(currentPath + '#f2p/');
}

(function() {
  const SUPPRESSED_CONSOLE_PATTERNS = [
    /Permissions policy violation/i,
    /The powerPreference option is currently ignored when calling requestAdapter\(\) on Windows/i,
    /compute-pressure is not allowed/i
  ];

  const nativeConsoleWarn = console.warn.bind(console);
  const nativeConsoleError = console.error.bind(console);

  console.warn = function(...args) {
    const text = args.map(value => String(value)).join(' ');
    if (SUPPRESSED_CONSOLE_PATTERNS.some(pattern => pattern.test(text))) {
      return;
    }
    nativeConsoleWarn(...args);
  };

  console.error = function(...args) {
    const text = args.map(value => String(value)).join(' ');
    if (SUPPRESSED_CONSOLE_PATTERNS.some(pattern => pattern.test(text))) {
      return;
    }
    nativeConsoleError(...args);
  };

  // Discord webhook URL is kept server-side in /api/webhook — NOT exposed here.
  // This prevents abuse/spam from users finding it in the client-side JS.
  const FAVOURITES_KEY = 'marketplace_favourites';
  const SHARE_CODE_BASE_DLC = 'https://dlc-1.vercel.app';
  const SHARE_CODE_BASE_NETLIFY = 'https://marketplacedlc.netlify.app';
  const SHARE_CODE_RE = /^[a-z0-9]{4}$/i;
  const REQUEST_RATE_LIMIT_KEY = 'marketplace_request_history_v1';
  const REQUEST_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
  const REQUEST_RATE_LIMIT_MAX = 3;

  // === MARKETPLACE API CONFIG (replaces the old database.json catalog) ===
  // The app now uses the Vercel bridge/proxy so the frontend does not hit the
  // upstream source or Discord directly. Do not hardcode the total page count;
  // the API should determine the real end of the catalog and stop naturally.
  const MARKETPLACE_API = 'https://mcsrc.vercel.app/api/items';
  const API_PATH_HEADERS = { 'X-Frontend-Path': window.location.pathname || '/' };
  let MARKETPLACE_TOTAL_PAGES = null;
  const MARKETPLACE_PARALLEL_PAGES = 20; // fetch 20 pages in parallel = 480 items per batch
  const MARKETPLACE_CACHE_KEY = 'marketplace_api_cache_v1';
  const MARKETPLACE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  const MARKETPLACE_IDB_NAME = 'marketplace_db';
  const MARKETPLACE_IDB_STORE = 'items_cache';
  const MARKETPLACE_IDB_KEY = 'all_items';
  const MARKETPLACE_SYNC_KEY = 'marketplace_upstream_fingerprint_v1';

  // Use the public keys.json database for item download links. This must always
  // refresh on page load so the app reflects the latest download availability.
  // Do not cache the database in localStorage.
  const DOWNLOAD_DB_URL = 'https://mcsrc.vercel.app/api/keys';
  const DOWNLOAD_DB_RETRY_ATTEMPTS = 3;
  const TOKEN_URL = 'https://mcsrc.vercel.app/api/token';
  const PROTECTED_ACTION_COOLDOWN_MS = 5000;
  let cachedRequestToken = null;
  let cachedRequestTokenExpiry = 0;
  let protectedActionCooldownUntil = 0;

  // Map marketplace item types to the categories the UI expects
  function normalizeMarketplaceType(value) {
    return String(value || '')
      .trim()
      .replace(/[_\-\s]+/g, '')
      .toLowerCase();
  }

  const TYPE_TO_CATEGORY = {
    skinpack: 'skins',
    skin: 'skins',
    world: 'worlds',
    addon: 'addons',
    addons: 'addons',
    texturepack: 'textures',
    texture: 'textures',
    mashup: 'mashups',
    mashups: 'mashups',
    pack: 'addons'
  };
  const TYPE_TO_SUBTITLE = {
    skinpack: 'Skin',
    skin: 'Skin',
    world: 'World',
    addon: 'Addon',
    addons: 'Addon',
    texturepack: 'Texture',
    texture: 'Texture',
    mashup: 'Mashup',
    mashups: 'Mashup'
  };

  // downloadDb is a Map<uuid, dbEntry> built from keys.json
  let downloadDb = new Map();
  let downloadDbLoaded = false;

  // Detail cache: stores {uuid: {rating, total_ratings, extra_images, panorama_url, yt_embed, description}}
  // in localStorage so sorting by rating/popularity works without refetching.
  const DETAIL_CACHE_KEY = 'marketplace_detail_cache_v1';
  let detailCache = {}; // loaded from localStorage at startup

  const APP_VERSION = '20260704';
  const CATALOG_CACHE_KEY = 'marketplace_catalog_cache_v2';
  const CATALOG_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  const CATALOG_VERSION_KEY = 'marketplace_catalog_version_v2';
  const CATALOG_LAST_REFRESH_KEY = 'marketplace_catalog_last_refresh_v2';
  const CATALOG_REFRESH_TTL_MS = 15 * 60 * 1000;
  const ITEMS_PER_PAGE = 30;
  const categoryNames = { worlds: 'World', addons: 'Addon', mashups: 'Mashup', textures: 'Texture', skins: 'Skin' };
  const categoryIcons = {
    worlds: 'fas fa-globe',
    addons: 'fas fa-puzzle-piece',
    mashups: 'fas fa-layer-group',
    textures: 'fas fa-image',
    skins: 'fas fa-tshirt'
  };
  const downloadLinkIcons = {
    worlds: 'fas fa-globe',
    world: 'fas fa-globe',
    addons: 'fas fa-puzzle-piece',
    addon: 'fas fa-puzzle-piece',
    'add-on': 'fas fa-puzzle-piece',
    mashups: 'fas fa-layer-group',
    mashup: 'fas fa-layer-group',
    textures: 'fas fa-image',
    texture: 'fas fa-image',
    skins: 'fas fa-tshirt',
    skin: 'fas fa-tshirt'
  };

  let itemsData = [];
  let shareCodeToUuid = new Map();
  let mediumCodeToUuid = new Map();
  let currentSort = 'default';
  let currentCreatorFilter = null;
  const externalLinkData = {
    minecraft: {
      href: 'https://www.youtube.com/@Vultir',
      icon: 'fas fa-cube',
      label: 'Minecraft',
      className: 'settings-menu-btn placeholder-btn'
    },
    social: [
      { href: 'https://discord.gg/yTXf8R7cGb', title: 'Discord', icon: 'fab fa-discord', className: 'social-icon discord' },
      { href: 'https://www.youtube.com/@MCF2P', title: 'YouTube', icon: 'fab fa-youtube', className: 'social-icon youtube' },
      { href: 'https://www.tiktok.com/@mcf2p', title: 'TikTok', icon: 'fab fa-tiktok', className: 'social-icon tiktok' }
    ],
    tutorials: [
      {
        title: 'How To Download - Mobile',
        src: 'https://youtu.be/vZF_xJFVSDg',
        label: 'How To Download - Mobile'
      },
      {
        title: 'How To Download - PC',
        src: 'https://youtu.be/FbXHMkHnBGA',
        label: 'How To Download - PC'
      }
    ]
  };
  let currentPage = 1;
  let allFilteredSortedItems = [];
  let isLoading = false;
  let isRendering = false;
  let hasMoreItems = true;
  let currentRenderToken = 0;
  let currentCategory = 'all';
  let currentCardStyle = 'style1';
  let currentContentPath = '/';
  let useHashRouting = true;
  let creatorExitBtn = null;
  const DEFAULT_THEME_PREFERENCES = {
    bgColor: '#0f0c29',
    titleColor: '#ffffff',
    iconsColor: '#ffffff',
    cardTitleColor: '#ffffff',
    cardTypeColor: '#cccccc',
    cardCreatorColor: '#cccccc',
    cardRatingsColor: '#ffffff',
    cardPopularityColor: '#ffffff',
    cardDescColor: '#dddddd',
    cardIconsColor: '#ffffff',
    modalTitleColor: '#ffffff',
    modalTypeColor: '#6495ed',
    modalDescColor: '#dddddd',
    modalIconsColor: '#ffffff',
    modalCreatorColor: '#6495ed',
    modalDownloadColor: '#ffffff',
    modalRatingsColor: '#f5d76e',
    modalPopularityColor: '#f5d76e',
    showCount: true,
    showType: true,
    showSortBadge: true,
    showModalTitle: true,
    showModalDescription: true,
    showModalType: true,
    showModalCreator: true,
    showModalRating: true,
    showModalPopularity: true,
    showModalImage: true,
    showModalFavourite: true,
    showModalShare: true,
    showDownloadPrefix: true,
    fontStyle: 'rubik'
  };
  let themePreferences = { ...DEFAULT_THEME_PREFERENCES };
  let cardStylePreferences = {
    style1: {
      showTitle: true,
      showType: true,
      showCreator: true,
      showRating: true,
      showTotalRatings: true,
      showImage: true
    },
    style2: {
      showTitle: true,
      showType: true,
      showCreator: true,
      showRating: true,
      showTotalRatings: true,
      showImage: true
    },
    style3: {
      showTitle: true,
      showType: true,
      showCreator: true,
      showRating: true,
      showTotalRatings: true,
      showImage: true
    },
    style4: {
      showTitle: true,
      showType: true,
      showCreator: true,
      showRating: true,
      showTotalRatings: true,
      showImage: true
    }
  };
  let overlayItemUuid = null;
  let logoCycleInterval = null;
  let shareOverlayEl = null;
  let searchTimeout;

  let slideTrack;
  let sliderPrev;
  let sliderNext;
  let sliderUp;
  let sliderDots;
  let sliderThumbs;
  let thumbTrackWrapper;
  let thumbTrack;
  let thumbPrev;
  let thumbNext;
  let panoramaSlider;

  let overlay;

  function setupLazyFadeImage(img) {
    img.classList.add('lazy-fade-image');
    const hideOverlay = () => {
      const overlay = img.parentElement?.querySelector('.img-loading-overlay');
      overlay?.classList.add('hidden');
    };
    img.addEventListener('load', () => {
      img.classList.add('loaded');
      hideOverlay();
    });
    img.addEventListener('error', () => {
      img.classList.remove('loaded');
      hideOverlay();
    });
  }
  let modalTitle;
  let modalType;
  let modalRating;
  let modalRatingValue;
  let modalTotalRatings;
  let modalDescription;
  let downloadLinks;
  let closeModal;
  let favouriteBtn;
  let shareBtn;
  let bottomNav;
  let downloadPickerOverlayEl = null;

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function getWeightedLength(str) {
    const words = String(str || '').split(/(\s+)/);
    return words.reduce((sum, word) => {
      if (/^[A-Z]{2,}$/.test(word)) {
        return sum + word.length * 1.25;
      }
      return sum + word.length;
    }, 0);
  }

  function shouldTruncateText(text, limit) {
    return getWeightedLength(text) > limit;
  }

  function shouldShowFullText(text, limit) {
    return getWeightedLength(text) - limit <= 2;
  }

  function getCardTextLimits() {
    const isDesktop = window.matchMedia('(min-width: 769px)').matches;
    return {
      title: isDesktop ? 35 : 25,
      subtitle: isDesktop ? 40 : 25
    };
  }

  function getActiveCardStylePreferences() {
    return cardStylePreferences[currentCardStyle] || cardStylePreferences.style1;
  }

  function updateCardStylePanelInputs() {
    const prefs = getActiveCardStylePreferences();
    document.getElementById('themeShowCardTitle').checked = prefs.showTitle;
    document.getElementById('themeShowCardType').checked = prefs.showType;
    document.getElementById('themeShowCardCreator').checked = prefs.showCreator;
    document.getElementById('themeShowCardRating').checked = prefs.showRating;
    document.getElementById('themeShowCardTotalRatings').checked = prefs.showTotalRatings;
    document.getElementById('themeShowCardImage').checked = prefs.showImage;
    document.querySelectorAll('.style-select-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.cardStyle === currentCardStyle);
    });
    updateToggleLabelStates();
  }

  function setActiveCardStyle(style) {
    if (!style || !cardStylePreferences[style]) return;
    currentCardStyle = style;
    updateCardStylePanelInputs();
    renderItems();
  }

  function setCardPreference(key, value) {
    if (!cardStylePreferences[currentCardStyle]) return;
    cardStylePreferences[currentCardStyle][key] = value;
  }

  function getEllipsisTruncatedText(text, limit) {
    const ellipsisReserve = 3;
    const effectiveLimit = Math.max(0, limit - ellipsisReserve);
    return `${escapeHtml(sliceByWeightedLimit(text, effectiveLimit).trimEnd())}...`;
  }

  function sliceByWeightedLimit(text, limit) {
    let length = 0;
    let index = 0;
    while (index < text.length) {
      const char = text[index];
      const wordMatch = text.slice(index).match(/^\S+/);
      if (wordMatch) {
        const word = wordMatch[0];
        if (/^[A-Z]{2,}$/.test(word)) {
          for (let i = 0; i < word.length; i += 1) {
            length += 1.25;
            if (length > limit) {
              return text.slice(0, index + i);
            }
          }
          index += word.length;
          continue;
        }
      }
      length += 1;
      if (length > limit) {
        return text.slice(0, index);
      }
      index += 1;
    }
    return text;
  }

  function normalizeShareNamePart(title) {
    const normalized = String(title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const part = normalized.slice(0, 1);
    return part.padEnd(1, 'x');
  }

  function generateShareCode(title, uuid) {
    const namePart = normalizeShareNamePart(title);
    const idPart = String(uuid || '').toLowerCase().slice(0, 3);
    return `${namePart}${idPart}`;
  }

  function generateTitleSlug(title) {
    return String(title || '').replace(/\s+/g, '').replace(/[^a-zA-Z0-9]/g, '');
  }

  function generateMediumCode(item) {
    const uuidPrefix = String(item.uuid || '').toLowerCase().slice(0, 2);
    const titleSlug = generateTitleSlug(item.title || '');
    return `${uuidPrefix}-${titleSlug}`;
  }

  function buildShareCodeIndex() {
    shareCodeToUuid.clear();
    mediumCodeToUuid.clear();

    itemsData.forEach(item => {
      if (!item || !item.uuid) return;
      const shortCode = generateShareCode(item.title, item.uuid).toLowerCase();
      const mediumCode = generateMediumCode(item).toLowerCase();
      shareCodeToUuid.set(shortCode, String(item.uuid).toLowerCase());
      mediumCodeToUuid.set(mediumCode, String(item.uuid).toLowerCase());
    });
  }

  function getHashFromUrl() {
    const hash = window.location.hash || '';
    if (hash.startsWith('#f2p/') || hash === '#f2p' || hash.startsWith('#/')) return null;
    return hash ? hash.slice(1) : null;
  }

  function getEffectiveRoutePath() {
    const hash = window.location.hash || '';
    if (hash.startsWith('#f2p/')) {
      return hash.slice(4) || '/';
    }
    if (hash === '#f2p') {
      return '/';
    }
    if (hash.startsWith('#/')) {
      return hash.slice(1) || '/';
    }
    return window.location.pathname || '/';
  }

  const VALID_ROUTE_CATEGORIES = ['all', 'worlds', 'addons', 'mashups', 'textures', 'skins'];

  function normalizeRouteSegment(value) {
    return String(value || '').toLowerCase().trim()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  function getCategoryFromPathSegment(segment) {
    const normalized = String(segment || '').toLowerCase().trim();
    return VALID_ROUTE_CATEGORIES.includes(normalized) ? normalized : 'all';
  }

  function getItemRoutePath(item) {
    const category = getCategoryFromPathSegment(item.category);
    const creatorSlug = normalizeRouteSegment(item.creator || 'creator');
    const itemSlug = normalizeRouteSegment(item.title || String(item.uuid));
    return `/${category}/${creatorSlug}/${itemSlug}`;
  }

  function buildContentRoute() {
    const creatorSlug = currentCreatorFilter ? `/${normalizeRouteSegment(currentCreatorFilter)}` : '';
    if (currentCategory === 'all') {
      return creatorSlug || '/';
    }
    return `/${currentCategory}${creatorSlug}`;
  }

  function setContentRoute(category, creatorFilter) {
    currentCategory = category || 'all';
    currentCreatorFilter = creatorFilter || null;
  }

  function updateBrowserPath(path, replace = false) {
    const normalized = String(path || '').replace(/\/+$|^\s+|\s+$/g, '') || '/';
    const url = useHashRouting ? (normalized === '/' ? '#f2p/' : `#f2p${normalized}`) : normalized;
    if (replace) {
      window.history.replaceState({ path: normalized }, '', url);
    } else {
      window.history.pushState({ path: normalized }, '', url);
    }
  }

  function findCreatorNameBySlug(creatorSlug, category) {
    const normalizedCreator = normalizeRouteSegment(creatorSlug);
    const candidates = itemsData.filter(item => normalizeRouteSegment(item.creator) === normalizedCreator && (category === 'all' || item.category === category));
    return candidates.length ? candidates[0].creator : null;
  }

  function updateCreatorExitButton() {
    if (!creatorExitBtn) return;
    if (currentCreatorFilter) {
      creatorExitBtn.style.display = 'inline-flex';
      creatorExitBtn.innerHTML = '<i class="fas fa-arrow-left"></i>';
    } else {
      creatorExitBtn.style.display = 'none';
    }
  }

  function processRoutePath(path, replaceHistory = false) {
    const raw = String(path || window.location.pathname || '/').trim();
    let normalized = raw.replace(/\/+$/g, '');
    if (normalized === '') normalized = '/';
    const segments = normalized.split('/').filter(Boolean);

    if (segments[0] === 'settings') {
      const panel = segments[1] || '';
      closeAllSidePanels();
      if (panel === 'cardstyle') {
        document.getElementById('cardStylePanel')?.classList.add('active');
      } else if (panel === 'themes') {
        document.getElementById('themesPanel')?.classList.add('active');
      } else if (panel === 'tutorial') {
        document.getElementById('tutorialSidePanel')?.classList.add('active');
      } else if (panel === 'statistics') {
        document.getElementById('statisticsSidePanel')?.classList.add('active');
      }
      document.getElementById('themesOverlay')?.classList.add('active');
      document.getElementById('navSettingsOverlay')?.classList.add('active');
      document.body.style.overflow = 'hidden';
      if (panel === 'statistics') updateStatistics?.();
      return;
    }

    const category = getCategoryFromPathSegment(segments[0]);
    currentCategory = category;
    currentCreatorFilter = null;
    document.querySelectorAll('.category-buttons button').forEach(btn => btn.classList.toggle('active', btn.dataset.filter === currentCategory));

    if (segments.length === 1 && normalized !== '/') {
      const isCategoryRoute = VALID_ROUTE_CATEGORIES.includes(segments[0].toLowerCase());
      const creatorName = findCreatorNameBySlug(segments[0], 'all');
      if (!isCategoryRoute && creatorName) {
        applyCreatorFilter(creatorName, 'all', replaceHistory);
        return;
      }

      if (isCategoryRoute) {
        setContentRoute(currentCategory, null);
        allFilteredSortedItems = getBaseItems();
        renderItems();
        updateCategoryCount();
        if (replaceHistory) updateBrowserPath(normalized, true);
        return;
      }
    }

    if (segments.length === 2) {
      const creatorName = findCreatorNameBySlug(segments[1], currentCategory);
      if (creatorName) {
        applyCreatorFilter(creatorName, currentCategory, replaceHistory);
        updateCreatorExitButton();
        return;
      }
    }

    if (segments.length >= 3) {
      const creatorSlug = segments[1];
      const creatorName = findCreatorNameBySlug(creatorSlug, currentCategory);
      const item = findItemByRouteParts(currentCategory, creatorSlug, segments[2]);
      setContentRoute(currentCategory, creatorName);
      updateCreatorExitButton();
      allFilteredSortedItems = getBaseItems();
      renderItems();
      updateCategoryCount();
      if (item) {
        openItemModal(item.uuid, replaceHistory);
      }
      if (replaceHistory) updateBrowserPath(normalized, true);
      return;
    }

    setContentRoute(currentCategory, null);
    allFilteredSortedItems = getBaseItems();
    renderItems();
    updateCategoryCount();
    updateCreatorExitButton();
    if (replaceHistory) updateBrowserPath(normalized, true);
  }

  function closeAllSidePanels() {
    document.querySelectorAll('.themes-panel.active, .overlay#navSettingsOverlay.active').forEach(el => el.classList.remove('active'));
    document.getElementById('themesOverlay')?.classList.remove('active');
    document.body.style.overflow = '';
    document.querySelectorAll('.bottom-nav-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById('bottomHomeBtn')?.classList.add('active');
    updateBottomNavVisibility();
    updateBrowserPath(buildContentRoute(), true);
  }

  function findItemByRouteParts(category, creatorSlug, itemSlug) {
    const normalizedCreator = normalizeRouteSegment(creatorSlug);
    const normalizedTitle = normalizeRouteSegment(itemSlug);
    return itemsData.find(item => {
      const candidateCreator = item.creator ? normalizeRouteSegment(item.creator) : 'creator';
      return candidateCreator === normalizedCreator && normalizeRouteSegment(item.title) === normalizedTitle && (category === 'all' || item.category === category);
    });
  }

  function createStars() {
    const container = document.getElementById('stars');
    if (!container) return;
    const frag = document.createDocumentFragment();
    for (let i = 0; i < 50; i += 1) {
      const star = document.createElement('div');
      star.className = 'star';
      const size = Math.random() * 2 + 1;
      star.style.width = star.style.height = `${size}px`;
      star.style.left = `${Math.random() * 100}%`;
      star.style.top = `${Math.random() * 100}%`;
      star.style.setProperty('--anim-dur', `${Math.random() * 3 + 2}s`);
      frag.appendChild(star);
    }
    container.appendChild(frag);
  }

  function getHiddenLinkElement(uuid, index) {
    const el = document.getElementById(`hiddenLink-${uuid}-${index}`);
    return el instanceof HTMLAnchorElement ? el : null;
  }

  function getHiddenLinkUrl(uuid, index) {
    const el = getHiddenLinkElement(uuid, index);
    return el ? el.href : null;
  }

  function loadFavourites() {
    try {
      const raw = localStorage.getItem(FAVOURITES_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(parsed) ? parsed : []);
    } catch (err) {
      return new Set();
    }
  }

  function saveFavourites(favsSet) {
    try {
      localStorage.setItem(FAVOURITES_KEY, JSON.stringify(Array.from(favsSet)));
    } catch (err) {
      // ignore storage failure
    }
  }

  function updateNameSortLabel() {
    const icon = document.getElementById('nameSortIcon');
    const label = document.getElementById('nameSortLabel');
    if (!icon || !label) return;
    if (currentSort === 'nameDesc') {
      icon.className = 'fas fa-sort-alpha-up';
      label.textContent = 'Name (Z-A)';
    } else {
      icon.className = 'fas fa-sort-alpha-down';
      label.textContent = 'Name (A-Z)';
    }
  }

  function saveDownloadCount(uuid, count) {
    try {
      localStorage.setItem(`item_${uuid}`, JSON.stringify({ downloadCount: count, lastUpdated: new Date().toISOString().split('T')[0] }));
    } catch (err) {
      // ignore storage failures
    }
  }

  function saveCurrentSort() {
    try {
      localStorage.setItem('marketplace_sort', currentSort);
    } catch (err) {
      // ignore storage failures
    }
  }

  function loadDownloadCounts() {
    itemsData.forEach(item => {
      const storage = localStorage.getItem(`item_${item.uuid}`);
      let downloadCount = 0;
      let lastUpdated = new Date().toISOString().split('T')[0];
      if (storage) {
        try {
          const parsed = JSON.parse(storage);
          downloadCount = parsed.downloadCount || 0;
          lastUpdated = parsed.lastUpdated || lastUpdated;
        } catch {
          downloadCount = 0;
        }
      }
      item.downloadCount = downloadCount;
      item.lastUpdated = lastUpdated;
    });

    const savedSort = localStorage.getItem('marketplace_sort');
    if (savedSort) {
      if (savedSort === 'recent') currentSort = 'newest';
      else if (savedSort === 'name') currentSort = 'nameAsc';
      else currentSort = savedSort;
      updateNameSortLabel();
      updateSortUI();
    }
  }

  function incrementDownloadCount(uuid) {
    const item = itemsData.find(i => String(i.uuid).toLowerCase() === String(uuid).toLowerCase());
    if (!item) return;
    item.downloadCount = (item.downloadCount || 0) + 1;
    item.lastUpdated = new Date().toISOString().split('T')[0];
    saveDownloadCount(uuid, item.downloadCount);
    updateItemDisplay();
  }

  function updateItemDisplay() {
    document.querySelectorAll('.item').forEach(itemEl => {
      const uuid = itemEl.dataset.uuid;
      const item = itemsData.find(i => String(i.uuid).toLowerCase() === String(uuid).toLowerCase());
      if (!item) return;
      const downloadCountEl = itemEl.querySelector('.download-count');
      if (downloadCountEl) {
        downloadCountEl.innerHTML = `<i class="fas fa-download"></i> ${item.downloadCount || 0}`;
        downloadCountEl.classList.toggle('show', currentSort === 'popularity');
      }
    });
  }

  function shuffleItems(items) {
    const shuffled = [...items];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }

  function sortItems(items) {
    const sorted = [...items];
    switch (currentSort) {
      case 'popularityMost':
        return sorted.sort((a, b) => (Number(b.total_ratings) || 0) - (Number(a.total_ratings) || 0));
      case 'popularityLeast':
        return sorted.sort((a, b) => (Number(a.total_ratings) || 0) - (Number(b.total_ratings) || 0));
      case 'recent':
      case 'newest':
      case 'addedNewest':
        return sorted.sort((a, b) => (a.htmlIndex || 0) - (b.htmlIndex || 0));
      case 'default':
        return shuffleItems(sorted);
      case 'oldest':
      case 'addedOldest':
        return sorted.sort((a, b) => (b.htmlIndex || 0) - (a.htmlIndex || 0));
      case 'titleAsc':
        return sorted.sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')));
      case 'titleDesc':
        return sorted.sort((a, b) => String(b.title || '').localeCompare(String(a.title || '')));
      case 'ratingHigh':
        return sorted.sort((a, b) => (Number(b.rating) || 0) - (Number(a.rating) || 0));
      case 'ratingLow':
        return sorted.sort((a, b) => (Number(a.rating) || 0) - (Number(b.rating) || 0));
      case 'creator':
        return sorted.sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')));
      case 'favourites':
      case 'availabilityCombined':
      case 'availabilityDownloadable':
      case 'availabilityUnavailable':
        return sorted.sort((a, b) => (a.htmlIndex || 0) - (b.htmlIndex || 0));
      default:
        return sorted.sort((a, b) => (a.htmlIndex || 0) - (b.htmlIndex || 0));
    }
  }

  function getFilteredSortedItems() {
    let filteredItems = dedupeItemsByUuid(itemsData);
    if (currentSort === 'favourites') {
      const favs = loadFavourites();
      filteredItems = filteredItems.filter(item => favs.has(item.uuid));
    }
    if (currentSort === 'availabilityDownloadable') {
      filteredItems = filteredItems.filter(item => downloadDb.has(String(item.uuid).toLowerCase()));
    } else if (currentSort === 'availabilityUnavailable') {
      filteredItems = filteredItems.filter(item => !downloadDb.has(String(item.uuid).toLowerCase()));
    }
    if (currentCreatorFilter) {
      const normalizedCreator = normalizeString(currentCreatorFilter);
      filteredItems = filteredItems.filter(item => normalizeString(item.creator) === normalizedCreator);
    }
    if (currentSort === 'favourites' && currentCategory !== 'all') {
      filteredItems = filteredItems.filter(item => item.category === currentCategory);
    } else if (currentSort !== 'favourites' && currentCategory !== 'all') {
      filteredItems = filteredItems.filter(item => item.category === currentCategory);
    }
    return sortItems(dedupeItemsByUuid(filteredItems));
  }

  function resetPagination() {
    currentPage = 1;
    hasMoreItems = true;
    allFilteredSortedItems = getFilteredSortedItems();
  }

  function formatLargeNumber(value) {
    const num = Number(value) || 0;
    if (num >= 1000000) {
      return `${Math.round(num / 1000000)}M`;
    }
    if (num >= 1000) {
      return `${Math.round(num / 1000)}K`;
    }
    return String(Math.round(num));
  }

  /**
   * Pre-fetch item details for visible cards so ratings show without needing
   * to open the modal. The listing API returns rating=0 and ratingCount=0 for
   * all items; the detail API returns the real values.
   *
   * Called after each render batch completes. Fetches details in parallel for
   * items that haven't been detail-fetched yet, then updates the card's rating
   * display. If the current sort is rating/popularity, triggers a re-sort.
   */
  let detailFetchQueue = new Set();

  function fetchDetailsForVisibleCards() {
    // Collect UUIDs of cards currently in the DOM that haven't been detail-fetched
    const container = document.getElementById('itemContainer');
    if (!container) return;
    const cardEls = container.querySelectorAll('[data-uuid]');
    const toFetch = [];
    cardEls.forEach(el => {
      const uuid = el.dataset.uuid;
      if (!uuid) return;
      const item = itemsData.find(i => String(i.uuid).toLowerCase() === String(uuid).toLowerCase());
      if (item && !item._detailLoaded && !detailFetchQueue.has(uuid)) {
        toFetch.push(item);
        detailFetchQueue.add(uuid);
      }
    });
    if (toFetch.length === 0) return;

    // Fetch details in parallel (limit concurrency to avoid overwhelming)
    const concurrency = 5;
    let index = 0;
    async function fetchNext() {
      while (index < toFetch.length) {
        const item = toFetch[index++];
        await fetchItemDetail(item);
        updateCardRatings(item);
      }
    }
    // Launch `concurrency` workers
    const workers = [];
    for (let i = 0; i < concurrency; i++) workers.push(fetchNext());

    // Detail hydration updates each existing card in place. Rebuilding the
    // whole grid here would reset the user's scroll position.
    Promise.all(workers).catch(() => {});
  }

  /**
   * Update a card's rating display after detail data has been fetched.
   * Replaces the card element entirely with a freshly-built one using the
   * now-complete item data. This ensures the rating/totalRatings blocks are
   * positioned exactly as createItemElement() intends (avoids the layout
   * corruption that happens when patching display styles in place).
   */
  function updateCardRatings(item) {
    if (!item || !item.uuid) return;
    const oldCardEl = document.querySelector(`[data-uuid="${CSS.escape(item.uuid)}"]`);
    if (!oldCardEl) return;
    // Build a fresh card with the updated item data and replace the old one.
    const newCardEl = createItemElement(item);
    oldCardEl.replaceWith(newCardEl);
    shrinkStyle2TitleIfThreeLines(newCardEl);
  }

  function createItemElement(item) {
    const itemEl = document.createElement('div');
    itemEl.className = `item ${currentCardStyle}`;
    itemEl.dataset.uuid = item.uuid;
    itemEl.dataset.category = item.category;

    const prefs = getActiveCardStylePreferences();
    const itemContent = document.createElement('div');
    itemContent.className = `item-content ${currentCardStyle === 'style2' ? 'style-2' : currentCardStyle === 'style3' ? 'style-3' : currentCardStyle === 'style4' ? 'style-4' : ''}`;

    const title = document.createElement('h2');
    const titleText = item.title || '';
    const limits = getCardTextLimits();
    const isStyle1 = currentCardStyle === 'style1';
    const isStyle2 = currentCardStyle === 'style2';
    const isStyle3 = currentCardStyle === 'style3';
    const isStyle4 = currentCardStyle === 'style4';

    if ((isStyle2 || isStyle3) && titleText) {
      title.textContent = titleText;
    } else if (isStyle1 && shouldTruncateText(titleText, limits.title)) {
      if (shouldShowFullText(titleText, limits.title)) {
        title.textContent = titleText;
      } else {
        const truncated = getEllipsisTruncatedText(titleText, limits.title);
        title.className = 'title-scroll';
        title.innerHTML = `
          <span class="title-truncated">${truncated}</span>
          <span class="title-full">${escapeHtml(titleText)}</span>
        `;
        title.dataset.longTitle = 'true';
      }
    } else {
      title.textContent = titleText;
    }

    title.style.display = prefs.showTitle ? '' : 'none';

    const typeText = item.subtitle || categoryNames[item.category] || '';
    const creatorText = item.creator ? `by ${item.creator}` : '';
    const showType = prefs.showType && Boolean(typeText);
    const showCreator = prefs.showCreator && Boolean(creatorText);
    const showRating = prefs.showRating && item.rating != null && Number(item.rating) >= 1;
    const showTotalRatings = prefs.showTotalRatings && item.total_ratings != null && Number(item.total_ratings) >= 1;

    const imgWrapper = document.createElement('div');
    imgWrapper.className = 'img-wrapper';
    imgWrapper.style.display = prefs.showImage ? '' : 'none';
    const img = document.createElement('img');
    img.alt = item.title || '';
    img.loading = 'lazy';
    const loaderOverlay = document.createElement('div');
    loaderOverlay.className = 'img-loading-overlay';
    loaderOverlay.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
    imgWrapper.appendChild(loaderOverlay);
    setupLazyFadeImage(img);
    img.src = item.image || '';
    imgWrapper.appendChild(img);

    if (currentCardStyle === 'style2' || currentCardStyle === 'style3') {
      const sideInfo = document.createElement('div');
      sideInfo.className = 'item-info';
      sideInfo.appendChild(title);

      if (showCreator) {
        const creatorEl = document.createElement('p');
        creatorEl.className = 'subtitle creator-line';
        creatorEl.textContent = creatorText;
        sideInfo.appendChild(creatorEl);
      }

      const metaRow = document.createElement('div');
      metaRow.className = 'style2-meta-row';

      if (showType) {
        const typeEl = document.createElement('p');
        typeEl.className = 'subtitle style2-type';
        typeEl.textContent = typeText;
        metaRow.appendChild(typeEl);
      }

      const iconRow = document.createElement('div');
      iconRow.className = 'item-rating-row';
      iconRow.style.display = showRating || showTotalRatings ? 'inline-flex' : 'none';

      const ratingBlock = document.createElement('div');
      ratingBlock.className = 'rating-block';
      ratingBlock.innerHTML = `<i class="fas fa-star"></i><span>${item.rating != null ? Number(item.rating).toFixed(1) : ''}</span>`;
      ratingBlock.style.display = showRating ? 'inline-flex' : 'none';
      iconRow.appendChild(ratingBlock);

      const totalRatingsBlock = document.createElement('div');
      totalRatingsBlock.className = 'rating-block total-ratings-block';
      totalRatingsBlock.innerHTML = `<i class="fas fa-fire"></i><span>${item.total_ratings != null ? formatLargeNumber(item.total_ratings) : ''}</span>`;
      totalRatingsBlock.style.display = showTotalRatings ? 'inline-flex' : 'none';
      iconRow.appendChild(totalRatingsBlock);

      metaRow.appendChild(iconRow);
      sideInfo.appendChild(metaRow);

      itemContent.appendChild(imgWrapper);
      itemContent.appendChild(sideInfo);
    } else {
      if (isStyle4) {
        itemContent.appendChild(imgWrapper);
      }
      itemContent.appendChild(title);

      const titleRow = document.createElement('div');
      titleRow.className = 'title-row';

      if (showType || showCreator) {
        const combinedText = showType && showCreator ? `${typeText} ${creatorText}` : (showType ? typeText : creatorText);
        const textElement = document.createElement('p');
        textElement.className = 'subtitle';

        const buildSubtitleHtml = () => {
        let html = '';
        if (showType) html += `<span class="type-text">${escapeHtml(typeText)}</span>`;
        if (showType && showCreator) html += ' ';
        if (showCreator) html += `<span class="creator-text">${escapeHtml(creatorText)}</span>`;
        return html;
      };

      if (currentCardStyle === 'style1' && shouldTruncateText(combinedText, limits.subtitle)) {
          if (shouldShowFullText(combinedText, limits.subtitle)) {
            textElement.innerHTML = buildSubtitleHtml();
          } else {
            const truncated = getEllipsisTruncatedText(combinedText, limits.subtitle);
            textElement.classList.add('subtitle-scroll');
            textElement.innerHTML = `
              <span class="subtitle-truncated">${escapeHtml(truncated)}</span>
              <span class="subtitle-full">${buildSubtitleHtml()}</span>
            `;
          }
        } else {
          textElement.innerHTML = buildSubtitleHtml();
        }
        titleRow.appendChild(textElement);
      }

      const showTitleRow = showType || showCreator;
      titleRow.style.display = showTitleRow ? '' : 'none';

      if (isStyle4) {
        const metaRow = document.createElement('div');
        metaRow.className = 'style4-meta-row';

        const leftMeta = document.createElement('div');
        leftMeta.className = 'style4-meta-left';
        if (showTitleRow) {
          const combinedText = showType && showCreator ? `${typeText} ${creatorText}` : (showType ? typeText : creatorText);
          const textElement = document.createElement('p');
          textElement.className = 'subtitle';
          textElement.innerHTML = `${showType ? `<span class="type-text">${escapeHtml(typeText)}</span>` : ''}${showType && showCreator ? ' ' : ''}${showCreator ? `<span class="creator-text">${escapeHtml(creatorText)}</span>` : ''}`;
          leftMeta.appendChild(textElement);
        }

        const setDisplayImportant = (el, show) => {
          if (!el) return;
          if (show) {
            el.style.removeProperty('display');
          } else {
            el.style.setProperty('display', 'none', 'important');
          }
        };

        const ratingRow = document.createElement('div');
        ratingRow.className = 'item-rating-row style4-rating-row';
        setDisplayImportant(ratingRow, showRating || showTotalRatings);

        const ratingBlock = document.createElement('div');
        ratingBlock.className = 'rating-block';
        ratingBlock.innerHTML = `<i class="fas fa-star"></i><span>${item.rating != null ? Number(item.rating).toFixed(1) : ''}</span>`;
        setDisplayImportant(ratingBlock, showRating);
        ratingRow.appendChild(ratingBlock);

        const totalRatingsBlock = document.createElement('div');
        totalRatingsBlock.className = 'rating-block total-ratings-block';
        totalRatingsBlock.innerHTML = `<i class="fas fa-fire"></i><span>${item.total_ratings != null ? formatLargeNumber(item.total_ratings) : ''}</span>`;
        setDisplayImportant(totalRatingsBlock, showTotalRatings);
        ratingRow.appendChild(totalRatingsBlock);

        metaRow.appendChild(leftMeta);
        metaRow.appendChild(ratingRow);
        itemContent.appendChild(metaRow);
      } else {
        itemContent.appendChild(titleRow);

        const ratingRow = document.createElement('div');
        ratingRow.className = 'item-rating-row';

        const ratingBlock = document.createElement('div');
        ratingBlock.className = 'rating-block';
        ratingBlock.innerHTML = `<i class="fas fa-star"></i><span>${item.rating != null ? Number(item.rating).toFixed(1) : ''}</span>`;
        ratingBlock.style.display = showRating ? '' : 'none';
        ratingRow.appendChild(ratingBlock);

        const totalRatingsBlock = document.createElement('div');
        totalRatingsBlock.className = 'rating-block total-ratings-block';
        totalRatingsBlock.innerHTML = `<i class="fas fa-fire"></i><span>${item.total_ratings != null ? formatLargeNumber(item.total_ratings) : ''}</span>`;
        totalRatingsBlock.style.display = showTotalRatings ? '' : 'none';
        ratingRow.appendChild(totalRatingsBlock);

        const showRatingRow = showRating || showTotalRatings;
        ratingRow.style.display = showRatingRow ? '' : 'none';
        if (showRating && showTotalRatings) {
          ratingRow.style.justifyContent = 'space-between';
        } else if (showRating) {
          ratingRow.style.justifyContent = 'flex-start';
        } else {
          ratingRow.style.justifyContent = 'flex-end';
        }
        itemContent.appendChild(ratingRow);
      }

      if (!isStyle4) {
        itemContent.appendChild(imgWrapper);
      }
    }

    itemEl.appendChild(itemContent);

    const description = document.createElement('p');
    description.className = 'description';
    description.style.display = 'none';
    description.textContent = item.description || '';
    itemEl.appendChild(description);

    return itemEl;
  }

  function shrinkStyle2TitleIfThreeLines(itemEl) {
    if (!itemEl || !(itemEl.classList.contains('style2') || itemEl.classList.contains('style3')) || window.innerWidth > 768) return;

    const titleEl = itemEl.querySelector('.item-info h2');
    const creatorEl = itemEl.querySelector('.item-info .creator-line');
    const typeEl = itemEl.querySelector('.item-info .style2-type');
    const iconRow = itemEl.querySelector('.item-rating-row');

    const preserveOriginalFontSize = el => {
      if (!el) return;
      if (!el.dataset.originalFontSize) {
        const computed = window.getComputedStyle(el);
        const current = parseFloat(computed.fontSize);
        if (current) el.dataset.originalFontSize = current;
      }
    };

    const restoreFontSize = el => {
      if (!el) return;
      if (el.dataset.originalFontSize) {
        el.style.fontSize = `${parseFloat(el.dataset.originalFontSize).toFixed(2)}px`;
      } else {
        el.style.fontSize = '';
      }
    };

    const shrinkElement = (el, factor) => {
      if (!el) return;
      preserveOriginalFontSize(el);
      const originalSize = parseFloat(el.dataset.originalFontSize);
      if (originalSize) {
        el.style.fontSize = `${Math.max(originalSize * (1 - factor), 10).toFixed(2)}px`;
      }
    };

    const elementsOverlap = (a, b) => {
      if (!a || !b) return false;
      const rectA = a.getBoundingClientRect();
      const rectB = b.getBoundingClientRect();
      return !(rectA.right <= rectB.left || rectA.left >= rectB.right || rectA.bottom <= rectB.top || rectA.top >= rectB.bottom);
    };

    if (titleEl) {
      const titleStyle = window.getComputedStyle(titleEl);
      const titleLineHeight = parseFloat(titleStyle.lineHeight);
      if (titleLineHeight) {
        const titleLines = Math.round(titleEl.offsetHeight / titleLineHeight);
        if (titleLines >= 3) {
          shrinkElement(titleEl, 0.2);
        } else if (titleLines >= 2) {
          shrinkElement(titleEl, 0.1);
        } else {
          restoreFontSize(titleEl);
        }
      }
    }

    if (creatorEl) {
      const creatorStyle = window.getComputedStyle(creatorEl);
      const creatorLineHeight = parseFloat(creatorStyle.lineHeight);
      if (creatorLineHeight) {
        const creatorLines = Math.round(creatorEl.offsetHeight / creatorLineHeight);
        if (creatorLines >= 2) {
          shrinkElement(creatorEl, 0.1);
        } else {
          restoreFontSize(creatorEl);
        }
      }
    }

    if (typeEl && iconRow) {
      const typeOverflow = typeEl.scrollWidth > typeEl.clientWidth + 1;
      const rowOverlap = elementsOverlap(typeEl, iconRow);
      if (typeOverflow || rowOverlap) {
        shrinkElement(typeEl, 0.1);
        shrinkElement(iconRow, 0.1);
      } else {
        restoreFontSize(typeEl);
        restoreFontSize(iconRow);
      }
    }
  }

  function renderCurrentPage() {
    const container = document.getElementById('itemContainer');
    if (!container) return;
    container.innerHTML = '';
    isRendering = true;
    currentRenderToken += 1;
    const renderToken = currentRenderToken;

    if (!allFilteredSortedItems.length) {
      container.innerHTML = '<div class="no-items">No Results</div>';
      hasMoreItems = false;
      isRendering = false;
      return;
    }

    const endIndex = Math.min(currentPage * ITEMS_PER_PAGE, allFilteredSortedItems.length);
    hasMoreItems = endIndex < allFilteredSortedItems.length;
    const batchSize = 6;
    let nextIndex = 0;

    function appendBatch() {
      if (renderToken !== currentRenderToken) {
        isRendering = false;
        return;
      }
      const batchEnd = Math.min(nextIndex + batchSize, endIndex);
      for (let i = nextIndex; i < batchEnd; i += 1) {
        if (renderToken !== currentRenderToken) {
          isRendering = false;
          return;
        }
        const itemEl = createItemElement(allFilteredSortedItems[i]);
        container.appendChild(itemEl);
        shrinkStyle2TitleIfThreeLines(itemEl);
      }
      nextIndex = batchEnd;
      if (nextIndex < endIndex && renderToken === currentRenderToken) {
        setTimeout(appendBatch, 60);
      } else {
        isRendering = renderToken === currentRenderToken ? false : isRendering;
        // After rendering completes, pre-fetch details for visible cards
        // so ratings show without needing to open each modal
        if (renderToken === currentRenderToken) {
          setTimeout(fetchDetailsForVisibleCards, 100);
        }
      }
    }

    appendBatch();
  }

  function appendAvailableItems() {
    const container = document.getElementById('itemContainer');
    if (!container || !allFilteredSortedItems.length) return;
    if (isRendering) {
      setTimeout(appendAvailableItems, 100);
      return;
    }

    container.querySelector('.no-items')?.remove();
    const existingUuids = new Set(Array.from(container.querySelectorAll('.item')).map(el => String(el.dataset.uuid || '').toLowerCase()));
    const renderedItems = container.querySelectorAll('.item').length;
    const targetCount = Math.min(currentPage * ITEMS_PER_PAGE, allFilteredSortedItems.length);
    if (renderedItems >= targetCount) {
      hasMoreItems = targetCount < allFilteredSortedItems.length;
      return;
    }

    const fragment = document.createDocumentFragment();
    for (let index = renderedItems; index < targetCount; index += 1) {
      const item = allFilteredSortedItems[index];
      const itemUuid = String(item?.uuid || '').toLowerCase();
      if (!itemUuid || existingUuids.has(itemUuid)) continue;
      const itemEl = createItemElement(item);
      fragment.appendChild(itemEl);
      existingUuids.add(itemUuid);
    }
    container.appendChild(fragment);
    container.querySelectorAll('.item:nth-last-child(-n+24)').forEach(shrinkStyle2TitleIfThreeLines);
    hasMoreItems = targetCount < allFilteredSortedItems.length;
    setTimeout(fetchDetailsForVisibleCards, 100);
  }

  function loadMoreItems() {
    if (isRendering || isLoading || !hasMoreItems) return;
    isLoading = true;
    const container = document.getElementById('itemContainer');
    if (!container) {
      isLoading = false;
      return;
    }

    const currentLoadToken = currentRenderToken;
    const loadingDiv = document.createElement('div');
    loadingDiv.className = 'loading-indicator';
    loadingDiv.id = 'loadingIndicator';
    loadingDiv.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Loading';
    container.appendChild(loadingDiv);

    setTimeout(() => {
      if (currentLoadToken !== currentRenderToken) {
        document.getElementById('loadingIndicator')?.remove();
        isLoading = false;
        return;
      }

      document.getElementById('loadingIndicator')?.remove();
      const existingUuids = new Set(Array.from(container.querySelectorAll('.item')).map(el => String(el.dataset.uuid || '').toLowerCase()));
      const startIndex = currentPage * ITEMS_PER_PAGE;
      const endIndex = Math.min((currentPage + 1) * ITEMS_PER_PAGE, allFilteredSortedItems.length);
      for (let i = startIndex; i < endIndex; i += 1) {
        if (currentLoadToken !== currentRenderToken) break;
        const item = allFilteredSortedItems[i];
        const itemUuid = String(item?.uuid || '').toLowerCase();
        if (!itemUuid || existingUuids.has(itemUuid)) continue;
        const itemEl = createItemElement(item);
        container.appendChild(itemEl);
        existingUuids.add(itemUuid);
        shrinkStyle2TitleIfThreeLines(itemEl);
      }
      if (currentLoadToken !== currentRenderToken) {
        isLoading = false;
        return;
      }

      currentPage += 1;
      hasMoreItems = endIndex < allFilteredSortedItems.length;
      isLoading = false;
      // Pre-fetch details for the newly loaded cards
      if (currentLoadToken === currentRenderToken) {
        setTimeout(fetchDetailsForVisibleCards, 100);
      }
    }, 300);
  }

  function setupInfiniteScroll() {
    window.addEventListener('scroll', () => {
      if (isLoading || !hasMoreItems) return;
      if (window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 300) {
        loadMoreItems();
      }
    });
  }

  function updateSortUI() {
    document.querySelectorAll('.sort-option').forEach(option => {
      const sort = option.dataset.sort;
      let active = false;

      if (sort === 'default') {
        active = currentSort === 'default';
      } else if (sort === 'title') {
        active = currentSort.startsWith('title');
      } else if (sort === 'added') {
        active = currentSort === 'addedNewest' || currentSort === 'addedOldest' || currentSort === 'newest' || currentSort === 'oldest';
      } else if (sort === 'rating') {
        active = currentSort === 'ratingHigh' || currentSort === 'ratingLow';
      } else if (sort === 'popularity') {
        active = currentSort === 'popularityMost' || currentSort === 'popularityLeast';
      } else if (sort === 'availability') {
        active = ['availabilityCombined', 'availabilityDownloadable', 'availabilityUnavailable'].includes(currentSort);
      } else if (sort === 'creators') {
        active = currentSort === 'creator';
      } else if (sort === 'favourites') {
        active = currentSort === 'favourites';
      }

      option.classList.toggle('active', active);
    });
    updateSortIndicator();
  }

  function updateSortIndicator() {
    const indicator = document.getElementById('sortIndicator');
    if (!indicator) return;
    if (themePreferences.showSortBadge === false) {
      indicator.style.display = 'none';
      indicator.innerHTML = '';
      return;
    }

    let iconClass = '';
    switch (currentSort) {
      case 'newest':
      case 'recent': iconClass = 'fas fa-arrow-up'; break;
      case 'oldest': iconClass = 'fas fa-arrow-down'; break;
      case 'addedNewest':
      case 'addedOldest': iconClass = 'fas fa-clock'; break;
      case 'favourites': iconClass = 'fas fa-heart'; break;
      case 'titleAsc': iconClass = 'fas fa-sort-alpha-down'; break;
      case 'titleDesc': iconClass = 'fas fa-sort-alpha-up'; break;
      case 'ratingHigh':
      case 'ratingLow': iconClass = 'fas fa-star'; break;
      case 'popularityMost':
      case 'popularityLeast': iconClass = 'fas fa-fire'; break;
      case 'availabilityCombined': iconClass = 'fas fa-list'; break;
      case 'availabilityDownloadable': iconClass = 'fas fa-check-circle'; break;
      case 'availabilityUnavailable': iconClass = 'fas fa-ban'; break;
      case 'creator': iconClass = 'fas fa-user'; break;
      default: iconClass = 'fas fa-random'; break;
    }
    indicator.innerHTML = `<i class="${iconClass}"></i>`;
    indicator.style.display = iconClass ? 'flex' : 'none';
  }

  function renderItems() {
    resetPagination();
    renderCurrentPage();
    updateCategoryCount();
  }

  function initSliderElements() {
    slideTrack = document.getElementById('sliderTrack');
    sliderPrev = document.getElementById('sliderPrev');
    sliderNext = document.getElementById('sliderNext');
    sliderUp = document.getElementById('sliderUp');
    sliderDots = document.getElementById('sliderDots');
    sliderThumbs = document.getElementById('sliderThumbs');
    thumbTrackWrapper = document.getElementById('thumbTrackWrapper');
    thumbTrack = document.getElementById('thumbTrack');
    thumbPrev = document.getElementById('thumbPrev');
    thumbNext = document.getElementById('thumbNext');
    panoramaSlider = document.getElementById('panoramaSlider');

  }

  function extractYouTubeId(url) {
    if (!url) return null;
    // Fixed regex: matches /embed/, /v/, /shorts/, /watch?v=, and youtu.be/ URLs
    const reg = /(?:youtube\.com\/(?:embed\/|v\/|shorts\/|live\/|watch\?v=|watch\?.+&v=)|youtu\.be\/)([^"&?\/\s]{11})/;
    const match = url.match(reg);
    return match ? match[1] : null;
  }

  function buildSlidesFromItem(item) {
    const slides = [];
    // All image/video fields come from the marketplace API only.
    // database.json is NOT consulted for slides — only for download links.
    if (item.image) {
      slides.push({ type: 'image', url: item.image, isPanorama: false });
    }
    if (item.yt_embed) {
      const ytId = extractYouTubeId(item.yt_embed);
      if (ytId) { slides.push({ type: 'youtube', id: ytId, isPanorama: false }); }
    }
    if (Array.isArray(item.extra_images)) {
      item.extra_images.forEach(url => {
        if (url) slides.push({ type: 'image', url, isPanorama: false });
      });
    }
    if (item.panorama_url) {
      slides.push({ type: 'image', url: item.panorama_url, isPanorama: true });
    }
    return slides;
  }

  function renderSlider(slides) {
    if (!slideTrack) initSliderElements();
    if (!slideTrack) return;

    const regularSlides = slides.filter(s => !s.isPanorama);
    const panoramaSlide = slides.find(s => s.isPanorama);
    const totalRegular = regularSlides.length;
    let currentIdx = 0;
    let panoramaMode = false;
    let panoramaPos = 0;
    let slideElements = [];
    let panoramaSlideElement = null;

    // Helper: smoothly animate panorama to a target position
    let panAnimationId = null;
    function animatePanTo(targetPos) {
      if (panAnimationId) cancelAnimationFrame(panAnimationId);
      const start = panoramaPos;
      const diff = targetPos - start;
      const duration = 300; // ms
      const startTime = performance.now();
      const step = (now) => {
        const elapsed = now - startTime;
        const t = Math.min(1, elapsed / duration);
        // easeInOutCubic for smooth feel
        const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        panoramaPos = start + diff * eased;
        const panoImg = panoramaSlideElement?.querySelector('img');
        if (panoImg) panoImg.style.objectPosition = `${panoramaPos}% center`;
        if (panoramaSlider) panoramaSlider.value = String(panoramaPos);
        if (t < 1) {
          panAnimationId = requestAnimationFrame(step);
        } else {
          panAnimationId = null;
          panoramaPos = targetPos;
        }
      };
      panAnimationId = requestAnimationFrame(step);
    }

    // Helper: pan the panorama by fixed steps (for clicks)
    // Snaps to 0/25/50/75/100 so it always lands on a 16:9 slice boundary
    // (panorama = 5 stitched 16:9 images, so each slice = 25%)
    function panPanorama(direction) {
      if (!panoramaMode) return;
      const step = 25;
      // Round to nearest step boundary, then add/subtract one step
      const currentStep = Math.round(panoramaPos / step);
      const targetStep = Math.max(0, Math.min(4, currentStep + direction));
      const target = targetStep * step; // 0, 25, 50, 75, or 100
      animatePanTo(target);
    }

    // Helper: continuous smooth panning (for hold)
    let continuousPanActive = false;
    function continuousPan(direction) {
      if (!panoramaMode || !continuousPanActive) return;
      const speed = 0.8; // % per frame ≈ 48% per second
      panoramaPos = Math.max(0, Math.min(100, panoramaPos + direction * speed));
      const panoImg = panoramaSlideElement?.querySelector('img');
      if (panoImg) panoImg.style.objectPosition = `${panoramaPos}% center`;
      if (panoramaSlider) panoramaSlider.value = String(panoramaPos);
      if (continuousPanActive) {
        requestAnimationFrame(() => continuousPan(direction));
      }
    }

    // Helper: set up hold-to-pan on a button (click = step, hold = smooth scroll)
    function setupHoldToPan(btn, direction) {
      if (!btn) return;
      let holdTimer = null;
      const startHold = (e) => {
        e.preventDefault();
        // Cancel any running animation
        if (panAnimationId) { cancelAnimationFrame(panAnimationId); panAnimationId = null; }
        // Single step pan immediately (13% with smooth animation)
        panPanorama(direction);
        // After 350ms hold, start continuous smooth panning
        holdTimer = setTimeout(() => {
          continuousPanActive = true;
          continuousPan(direction);
        }, 350);
      };
      const stopHold = () => {
        if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
        continuousPanActive = false;
      };
      btn.addEventListener('pointerdown', startHold, { passive: false });
      btn.addEventListener('pointerup', stopHold);
      btn.addEventListener('pointercancel', stopHold);
      btn.addEventListener('pointerleave', stopHold);
    }

    function bindNavigationButton(button, direction) {
      if (!button) return;

      const handleNav = (event) => {
        event.preventDefault();
        event.stopPropagation();

        // Stay in panorama mode when panning; do not fall back to regular slides.
        if (panoramaMode) {
          panPanorama(direction);
          return;
        }
        if (direction < 0 && currentIdx > 0) {
          currentIdx -= 1;
          renderRegular();
        }
        if (direction > 0 && currentIdx < totalRegular - 1) {
          currentIdx += 1;
          renderRegular();
        }
      };

      button.addEventListener('pointerup', handleNav);
      button.addEventListener('pointercancel', (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      button.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ' || event.code === 'Space') {
          event.preventDefault();
          handleNav(event);
        }
      });

      setupHoldToPan(button, direction);
    }

    if (sliderPrev) {
      bindNavigationButton(sliderPrev, -1);
    }

    if (sliderNext) {
      bindNavigationButton(sliderNext, 1);
    }

    if (sliderUp) {
      sliderUp.onclick = () => {
        if (panoramaMode) {
          renderRegular();
        } else if (panoramaSlide) {
          renderPanorama();
        }
      };
    }

    if (thumbPrev) {
      bindNavigationButton(thumbPrev, -1);
    }

    if (thumbNext) {
      bindNavigationButton(thumbNext, 1);
    }

    if (sliderUp) {
      sliderUp.onclick = () => {
        if (panoramaMode) {
          renderRegular();
        } else if (panoramaSlide) {
          renderPanorama();
        }
      };
    }

    function buildSlide(slide, panorama = false) {
      const slideDiv = document.createElement('div');
      slideDiv.className = `slider-slide${panorama ? ' panorama-mode' : ''}`;
      if (slide.type === 'image') {
        const img = document.createElement('img');
        setupLazyFadeImage(img);
        img.src = slide.url;
        img.alt = '';
        img.loading = 'lazy';
        if (panorama) {
          img.style.objectPosition = `${panoramaPos}% center`;
          if (panoramaSlider) {
            panoramaSlider.value = String(panoramaPos);
            panoramaSlider.oninput = () => {
              panoramaPos = Number(panoramaSlider.value);
              img.style.objectPosition = `${panoramaPos}% center`;
            };
          }
        }
        slideDiv.appendChild(img);
      } else if (slide.type === 'youtube') {
        const iframe = document.createElement('iframe');
        iframe.src = `https://www.youtube.com/embed/${slide.id}?autoplay=0&rel=0&modestbranding=1&controls=1&playsinline=1&enablejsapi=1&iv_load_policy=3`;
        iframe.setAttribute('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share');
        iframe.setAttribute('allowfullscreen', 'allowfullscreen');
        iframe.loading = 'lazy';
        iframe.style.border = '0';
        iframe.classList.add('lazy-fade-iframe');
        iframe.addEventListener('load', () => {
          iframe.classList.add('loaded');
        });
        slideDiv.appendChild(iframe);
      }
      return slideDiv;
    }

    function pauseYoutubeIframe(iframe) {
      if (!iframe || !iframe.contentWindow) return;
      iframe.contentWindow.postMessage(JSON.stringify({
        event: 'command',
        func: 'pauseVideo',
        args: []
      }), '*');
    }

    function updateYoutubeSlidePlayback(slideEl, active) {
      const iframe = slideEl.querySelector('iframe');
      if (!iframe) return;
      if (!active) {
        pauseYoutubeIframe(iframe);
      }
    }

    function renderDots() {
      if (!sliderDots) return;
      sliderDots.innerHTML = '';
      for (let i = 0; i < totalRegular; i += 1) {
        const dot = document.createElement('span');
        dot.className = `slider-dot ${i === currentIdx ? 'active' : ''}`;
        dot.dataset.index = i;
        dot.addEventListener('click', () => {
          if (!panoramaMode) {
            currentIdx = i;
            renderRegular();
          }
        });
        sliderDots.appendChild(dot);
      }
    }

    function updateThumbnailActive() {
      if (!thumbTrack) return;
      thumbTrack.querySelectorAll('.thumb-item').forEach((thumb, index) => {
        thumb.classList.toggle('active', index === currentIdx);
      });
    }

    function scrollActiveThumbIntoView() {
      if (!thumbTrack) return;
      const activeThumb = thumbTrack.querySelector('.thumb-item.active');
      if (activeThumb) {
        activeThumb.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
      }
    }

    function renderThumbnails() {
      if (!thumbTrack || !sliderThumbs) return;
      thumbTrack.innerHTML = '';
      if (!totalRegular) {
        sliderThumbs.style.display = 'none';
        return;
      }
      sliderThumbs.style.display = 'flex';
      regularSlides.forEach((slide, index) => {
        const thumb = document.createElement('button');
        thumb.type = 'button';
        thumb.className = `thumb-item${index === currentIdx ? ' active' : ''}`;
        thumb.dataset.index = String(index);
        thumb.addEventListener('click', () => {
          if (panoramaMode) return;
          currentIdx = index;
          renderRegular();
        });

        if (slide.type === 'image') {
          const wrapper = document.createElement('div');
          wrapper.className = 'thumb-image-wrapper';
          const loaderOverlay = document.createElement('div');
          loaderOverlay.className = 'img-loading-overlay';
          loaderOverlay.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
          const img = document.createElement('img');
          setupLazyFadeImage(img);
          img.src = slide.url;
          img.alt = '';
          img.loading = 'lazy';
          wrapper.appendChild(loaderOverlay);
          wrapper.appendChild(img);
          thumb.appendChild(wrapper);
        } else if (slide.type === 'youtube') {
          const img = document.createElement('img');
          img.src = `https://img.youtube.com/vi/${slide.id}/mqdefault.jpg`;
          img.alt = 'YouTube thumbnail';
          img.loading = 'lazy';
          img.addEventListener('error', () => {
            if (!thumb.querySelector('.thumb-placeholder')) {
              thumb.innerHTML = '<div class="thumb-placeholder">YT</div>';
            }
          });
          thumb.appendChild(img);
          const icon = document.createElement('div');
          icon.className = 'thumb-icon';
          icon.innerHTML = '<i class="fab fa-youtube"></i>';
          thumb.appendChild(icon);
        }

        thumbTrack.appendChild(thumb);
      });
      updateThumbnailActive();
      scrollActiveThumbIntoView();
    }

    function updateSliderControls() {
      if (!sliderUp || !sliderThumbs || !thumbTrackWrapper) return;
      if (panoramaMode) {
        if (sliderPrev) sliderPrev.style.display = 'flex';
        if (sliderNext) sliderNext.style.display = 'flex';
        sliderUp.style.display = 'flex';
        if (sliderDots) sliderDots.style.display = 'none';
        sliderThumbs.style.display = 'flex';
        thumbTrackWrapper.style.display = 'none';
        if (panoramaSlider) panoramaSlider.style.display = 'block';
      } else {
        if (sliderPrev) sliderPrev.style.display = currentIdx > 0 ? 'flex' : 'none';
        if (sliderNext) sliderNext.style.display = currentIdx < (totalRegular - 1) ? 'flex' : 'none';
        sliderUp.style.display = panoramaSlide ? 'flex' : 'none';
        if (sliderDots) sliderDots.style.display = totalRegular > 1 ? 'flex' : 'none';
        sliderThumbs.style.display = totalRegular ? 'flex' : 'none';
        thumbTrackWrapper.style.display = 'flex';
        if (panoramaSlider) panoramaSlider.style.display = 'none';
      }
    }

    function renderRegular() {
      panoramaMode = false;
      slideTrack.innerHTML = '';
      slideElements = [];
      panoramaSlideElement = null;

      regularSlides.forEach((slide, index) => {
        const slideElement = buildSlide(slide, false);
        slideElement.dataset.index = String(index);
        slideElements.push(slideElement);
        slideTrack.appendChild(slideElement);
      });

      slideElements.forEach((slideEl, index) => {
        const isActive = index === currentIdx;
        slideEl.classList.toggle('active', isActive);
        updateYoutubeSlidePlayback(slideEl, isActive);
      });

      if (sliderDots) {
        sliderDots.querySelectorAll('.slider-dot').forEach((dot, index) => dot.classList.toggle('active', index === currentIdx));
      }
      updateThumbnailActive();
      scrollActiveThumbIntoView();
      updateSliderControls();
    }

    function renderPanorama() {
      if (!panoramaSlide) return;
      panoramaMode = true;
      panoramaPos = 0;
      slideTrack.innerHTML = '';
      panoramaSlideElement = buildSlide(panoramaSlide, true);
      panoramaSlideElement.dataset.panorama = 'true';
      slideTrack.appendChild(panoramaSlideElement);
      panoramaSlideElement.classList.add('active');
      updateYoutubeSlidePlayback(panoramaSlideElement, true);

      slideElements.forEach(slideEl => {
        updateYoutubeSlidePlayback(slideEl, false);
      });

      if (sliderDots) {
        sliderDots.querySelectorAll('.slider-dot').forEach(dot => dot.classList.toggle('active', false));
      }
      updateSliderControls();
    }

    renderThumbnails();

    if (!totalRegular && panoramaSlide) {
      renderPanorama();
      return;
    }

    if (totalRegular > 1 && regularSlides[1] && regularSlides[1].type === 'youtube') {
      currentIdx = 1;
    }

    renderDots();
    renderRegular();
  }

  function clearSlider() {
    if (slideTrack) slideTrack.innerHTML = '';
    if (sliderDots) sliderDots.innerHTML = '';
    if (thumbTrack) thumbTrack.innerHTML = '';
    if (sliderThumbs) sliderThumbs.style.display = 'none';
  }

  function copyTextToClipboard(text) {
    if (!navigator.clipboard) {
      const ta = document.createElement('textarea');
      ta.value = String(text || '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      return Promise.resolve(true);
    }
    return navigator.clipboard.writeText(String(text || '')).then(() => true).catch(() => false);
  }

  function showCopyFeedback(btn) {
    if (!btn) return;
    btn.classList.add('copied');
    setTimeout(() => btn.classList.remove('copied'), 1500);
  }

  function getRequestHistory() {
    try {
      const raw = localStorage.getItem(REQUEST_RATE_LIMIT_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(value => Number.isFinite(Number(value))).map(Number);
    } catch (err) {
      return [];
    }
  }

  function saveRequestHistory(history) {
    try {
      localStorage.setItem(REQUEST_RATE_LIMIT_KEY, JSON.stringify(history));
    } catch (err) {
      // ignore storage failures
    }
  }

  function getRequestLimitStatus() {
    const now = Date.now();
    const history = getRequestHistory().filter(timestamp => now - timestamp < REQUEST_RATE_LIMIT_WINDOW_MS);
    const allowed = history.length < REQUEST_RATE_LIMIT_MAX;
    const retryAfterMs = history.length > 0 ? Math.max(0, REQUEST_RATE_LIMIT_WINDOW_MS - (now - history[0])) : 0;
    return { allowed, history, retryAfterMs, remaining: Math.max(0, REQUEST_RATE_LIMIT_MAX - history.length), used: Math.min(history.length, REQUEST_RATE_LIMIT_MAX) };
  }

  function getRequestUsageLabel() {
    const { used } = getRequestLimitStatus();
    return `${used}/${REQUEST_RATE_LIMIT_MAX} request`;
  }

  function getProtectedActionCooldownStatus() {
    const remaining = Math.max(0, protectedActionCooldownUntil - Date.now());
    return {
      active: remaining > 0,
      remaining
    };
  }

  function recordRequestSubmission() {
    const now = Date.now();
    const history = getRequestHistory().filter(timestamp => now - timestamp < REQUEST_RATE_LIMIT_WINDOW_MS);
    history.push(now);
    saveRequestHistory(history);
  }

  async function getRequestAuthToken() {
    const now = Date.now();
    if (cachedRequestToken && now < cachedRequestTokenExpiry) {
      return cachedRequestToken;
    }

    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...API_PATH_HEADERS },
      body: JSON.stringify({ action: 'request' })
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch request token: ${response.status}`);
    }

    const data = await response.json();
    const token = data && data.token ? String(data.token) : '';
    if (!token) {
      throw new Error('Request token missing from server response');
    }

    cachedRequestToken = token;
    cachedRequestTokenExpiry = now + 60 * 1000;
    return token;
  }

  async function submitRequestWebhook({ uuid, url }) {
    const payload = {
      username: 'Marketplace Request Bot',
      content: String(url || uuid || 'unknown')
    };

    const token = await getRequestAuthToken();
    const response = await fetch('https://mcsrc.vercel.app/api/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...API_PATH_HEADERS,
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error('Request failed');
    }

    return true;
  }

  function parseMarketplaceIdFromUrl(url) {
    if (!url) return null;
    try {
      const parsed = new URL(url);
      const value = parsed.searchParams.get('id') || parsed.searchParams.get('uuid');
      if (value) return value;

      const segments = parsed.pathname.split('/').filter(Boolean);
      if (segments.length === 0) return null;

      const lastSegment = segments[segments.length - 1];
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(lastSegment)) {
        return lastSegment;
      }

      return null;
    } catch (err) {
      return null;
    }
  }

  function closeShareOverlay() {
    if (!shareOverlayEl) return;
    shareOverlayEl.classList.remove('active');
    updateBottomNavVisibility();
  }

  function closeDownloadPickerOverlay() {
    if (!downloadPickerOverlayEl) return;
    downloadPickerOverlayEl.classList.remove('active');
    updateBottomNavVisibility();
  }

  function ensureDownloadPickerOverlayExists() {
    if (downloadPickerOverlayEl) return;
    downloadPickerOverlayEl = document.createElement('div');
    downloadPickerOverlayEl.id = 'downloadPickerOverlay';
    downloadPickerOverlayEl.className = 'overlay';
    downloadPickerOverlayEl.innerHTML = `
      <div class="download-picker-shell">
        <div class="download-picker-modal" role="dialog" aria-modal="true" aria-label="Download options">
          <button class="close-btn" id="closeDownloadPickerBtn" type="button" aria-label="Close download options">
            <i class="fas fa-times"></i>
          </button>
          <div class="share-title" id="downloadPickerTitle">Download options</div>
          <p class="download-picker-description" id="downloadPickerDescription">Choose a download option.</p>
          <div class="download-picker-actions">
            <button class="download-picker-option disabled" type="button" disabled>
              <span class="option-content"><img class="link-option-icon lootlabs-icon" src="assets/images/f2p_lootlabs.png" alt="Lootlabs logo"><span class="option-label">Download via Lootlabs</span></span>
            </button>
            <button class="download-picker-option disabled" type="button" disabled>
              <span class="option-content"><img class="link-option-icon workink-icon" src="assets/images/f2p_workink.png" alt="Work.Ink logo"><span class="option-label">Download via Work.Ink</span></span>
            </button>
            <a class="download-picker-option download-picker-option-active" id="downloadPickerLinkvertiseBtn" target="_blank" rel="noopener noreferrer">
              <span class="option-content"><img class="link-option-icon linkvertise-icon" src="assets/images/f2p_linkvertise.png" alt="Linkvertise logo"><span class="option-label">Download via Linkvertise</span></span>
            </a>
          </div>
        </div>
        <button class="download-picker-footer-link" id="downloadPickerTutorialBtn" type="button">
          <span><span class="download-picker-tutorial-highlight">Download Tutorial</span></span>
        </button>
      </div>
    `;
    document.body.appendChild(downloadPickerOverlayEl);
    downloadPickerOverlayEl.addEventListener('click', (event) => {
      if (event.target === downloadPickerOverlayEl) closeDownloadPickerOverlay();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && downloadPickerOverlayEl.classList.contains('active')) closeDownloadPickerOverlay();
    });

    const closeBtn = downloadPickerOverlayEl.querySelector('#closeDownloadPickerBtn');
    closeBtn?.addEventListener('click', closeDownloadPickerOverlay);

    const tutorialBtn = downloadPickerOverlayEl.querySelector('#downloadPickerTutorialBtn');
    tutorialBtn?.addEventListener('click', () => {
      closeDownloadPickerOverlay();
      document.getElementById('tutorialSidePanel')?.classList.add('active');
      document.getElementById('themesOverlay')?.classList.add('active');
      document.body.style.overflow = 'hidden';
      updateBottomNavVisibility();
    });
  }

  function openDownloadPickerForUuid(uuid, index) {
    const dbEntry = downloadDb.get(String(uuid).toLowerCase());
    
    // Get link data from keys.json (if available)
    const linkvertiseLinks = dbEntry && Array.isArray(dbEntry.linkvertise_links) ? dbEntry.linkvertise_links : [];
    const workInkLinks = dbEntry && Array.isArray(dbEntry.work_ink_links) ? dbEntry.work_ink_links : (dbEntry && Array.isArray(dbEntry['work.ink_links']) ? dbEntry['work.ink_links'] : []);
    const lootlabsLinks = dbEntry && Array.isArray(dbEntry.lootlabs_links) ? dbEntry.lootlabs_links : [];
    
    // Get HTML hidden link (Linkvertise only)
    const hiddenLinkElement = getHiddenLinkElement(uuid, index);
    const hiddenLinkUrl = hiddenLinkElement ? hiddenLinkElement.href : null;
    
    // For Linkvertise: HTML hidden link takes priority. Check if we have ANY valid link source.
    const hasLinkvertiseHidden = hiddenLinkUrl && hiddenLinkUrl !== 'null' && hiddenLinkUrl !== '';
    const hasLinkvertiseKeysJson = linkvertiseLinks[index];
    const hasLootlabsLink = lootlabsLinks[index];
    const hasWorkInkLink = workInkLinks[index];
    
    // If there's no way to download this item, exit early
    if (!hasLinkvertiseHidden && !hasLinkvertiseKeysJson && !hasLootlabsLink && !hasWorkInkLink) {
      return;
    }
    
    // Use keys.json link for title/size info (only if available)
    const linkForInfo = linkvertiseLinks[index] || workInkLinks[index] || lootlabsLinks[index];

    ensureDownloadPickerOverlayExists();
    const titleEl = downloadPickerOverlayEl.querySelector('#downloadPickerTitle');
    const descriptionEl = downloadPickerOverlayEl.querySelector('#downloadPickerDescription');

    titleEl.textContent = `Download ${linkForInfo && linkForInfo.type ? String(linkForInfo.type).trim() : 'file'}`;
    descriptionEl.textContent = linkForInfo && linkForInfo.size ? `SIZE: ${escapeHtml(linkForInfo.size)}` : 'SIZE: Unknown';

    // Helper: check if a URL is valid (not "null" or empty)
    const isValidUrl = (url) => url && url !== 'null' && url !== '';

    // Get the 3 download options (the order in the HTML is: Lootlabs, Work.Ink, Linkvertise)
    const options = downloadPickerOverlayEl.querySelectorAll('.download-picker-option');
    // options[0] = Lootlabs, options[1] = Work.Ink, options[2] = Linkvertise

    // Lootlabs (index 0)
    const lootlabsLink = lootlabsLinks[index];
    const lootlabsUrl = lootlabsLink ? lootlabsLink.url : '';
    const lootlabsBtn = options[0];
    if (lootlabsBtn) {
      if (isValidUrl(lootlabsUrl)) {
        lootlabsBtn.classList.remove('disabled');
        lootlabsBtn.removeAttribute('disabled');
        if (lootlabsBtn.tagName === 'A') {
          lootlabsBtn.href = lootlabsUrl;
        } else {
          lootlabsBtn.dataset.url = lootlabsUrl;
          lootlabsBtn.onclick = () => { window.open(lootlabsUrl, '_blank', 'noopener'); incrementDownloadCount(uuid); };
        }
        lootlabsBtn.dataset.uuid = uuid;
      } else {
        lootlabsBtn.classList.add('disabled');
        lootlabsBtn.setAttribute('disabled', '');
        if (lootlabsBtn.tagName === 'A') lootlabsBtn.removeAttribute('href');
        lootlabsBtn.onclick = null;
      }
    }

    // Work.Ink (index 1)
    const workInkLink = workInkLinks[index];
    const workInkUrl = workInkLink ? workInkLink.url : '';
    const workInkBtn = options[1];
    if (workInkBtn) {
      if (isValidUrl(workInkUrl)) {
        workInkBtn.classList.remove('disabled');
        workInkBtn.removeAttribute('disabled');
        if (workInkBtn.tagName === 'A') {
          workInkBtn.href = workInkUrl;
        } else {
          workInkBtn.dataset.url = workInkUrl;
          workInkBtn.onclick = () => { window.open(workInkUrl, '_blank', 'noopener'); incrementDownloadCount(uuid); };
        }
        workInkBtn.dataset.uuid = uuid;
      } else {
        workInkBtn.classList.add('disabled');
        workInkBtn.setAttribute('disabled', '');
        if (workInkBtn.tagName === 'A') workInkBtn.removeAttribute('href');
        workInkBtn.onclick = null;
      }
    }

    // Linkvertise (index 2)
    // Priority: HTML hidden link (PRIMARY) -> keys.json fallback (FALLBACK)
    const linkvertiseBtn = options[2];
    const linkvertiseLink = linkvertiseLinks[index];
    const linkvertiseFallbackUrl = linkvertiseLink ? linkvertiseLink.url : '';
    // Use HTML hidden link as primary, fall back to keys.json if not available
    const linkvertiseUrl = hiddenLinkUrl || linkvertiseFallbackUrl;
    if (linkvertiseBtn) {
      if (isValidUrl(linkvertiseUrl)) {
        linkvertiseBtn.classList.remove('disabled');
        linkvertiseBtn.removeAttribute('disabled');
        if (linkvertiseBtn.tagName === 'A') {
          linkvertiseBtn.href = hiddenLinkUrl || linkvertiseFallbackUrl;
          linkvertiseBtn.onclick = (event) => {
            if (hiddenLinkElement) {
              event.preventDefault();
              hiddenLinkElement.target = '_blank';
              hiddenLinkElement.click();
            }
            incrementDownloadCount(uuid);
          };
        } else {
          linkvertiseBtn.dataset.url = linkvertiseUrl;
          linkvertiseBtn.onclick = () => {
            if (hiddenLinkElement) {
              hiddenLinkElement.target = '_blank';
              hiddenLinkElement.click();
            } else if (linkvertiseFallbackUrl) {
              window.open(linkvertiseFallbackUrl, '_blank', 'noopener');
            }
            incrementDownloadCount(uuid);
          };
        }
        linkvertiseBtn.dataset.uuid = uuid;
      } else {
        linkvertiseBtn.classList.add('disabled');
        linkvertiseBtn.setAttribute('disabled', '');
        if (linkvertiseBtn.tagName === 'A') linkvertiseBtn.removeAttribute('href');
        linkvertiseBtn.onclick = null;
      }
    }

    downloadPickerOverlayEl.classList.add('active');
    document.body.style.overflow = 'hidden';
    updateBottomNavVisibility();
  }

  function ensureShareOverlayExists() {
    if (shareOverlayEl) return;
    shareOverlayEl = document.createElement('div');
    shareOverlayEl.id = 'shareOverlay';
    shareOverlayEl.className = 'overlay';
    shareOverlayEl.innerHTML = `
      <div class="share-modal" role="dialog" aria-modal="true" aria-label="Share options">
        <button class="close-btn" id="closeShareOverlayBtn" type="button" aria-label="Close share overlay">
          <i class="fas fa-times"></i>
        </button>
        <div class="share-title">Share</div>
        <div class="share-label">Custom</div>
        <div class="share-link-row">
          <div class="share-url" id="customShareUrl"></div>
          <button class="copy-share-btn" id="copyCustomBtn" type="button" aria-label="Copy custom share link">
            <i class="fas fa-copy"></i>
          </button>
        </div>
        <div class="view-more-toggle" id="shareViewMoreToggle" role="button" tabindex="0" aria-expanded="false">View more</div>
        <div class="share-advanced-links collapsed" id="shareAdvancedLinks">
          <div class="share-label">Short</div>
          <div class="share-link-row">
            <div class="share-url" id="shortShareUrlDlc"></div>
            <button class="copy-share-btn" id="copyShortDlcBtn" type="button" aria-label="Copy DLC link">
              <i class="fas fa-copy"></i>
            </button>
          </div>
          <div class="share-link-row">
            <div class="share-url" id="shortShareUrlNetlify"></div>
            <button class="copy-share-btn" id="copyShortNetlifyBtn" type="button" aria-label="Copy Netlify link">
              <i class="fas fa-copy"></i>
            </button>
          </div>
          <div class="share-label">Medium</div>
          <div class="share-link-row">
            <div class="share-url" id="mediumShareUrlDlc"></div>
            <button class="copy-share-btn" id="copyMediumDlcBtn" type="button" aria-label="Copy DLC link">
              <i class="fas fa-copy"></i>
            </button>
          </div>
          <div class="share-link-row">
            <div class="share-url" id="mediumShareUrlNetlify"></div>
            <button class="copy-share-btn" id="copyMediumNetlifyBtn" type="button" aria-label="Copy Netlify link">
              <i class="fas fa-copy"></i>
            </button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(shareOverlayEl);
    shareOverlayEl.addEventListener('click', (event) => {
      if (event.target === shareOverlayEl) closeShareOverlay();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && shareOverlayEl.classList.contains('active')) closeShareOverlay();
    });

    const closeBtn = shareOverlayEl.querySelector('#closeShareOverlayBtn');
    closeBtn?.addEventListener('click', closeShareOverlay);

    const copyCustomBtn = shareOverlayEl.querySelector('#copyCustomBtn');
    const customUrlEl = shareOverlayEl.querySelector('#customShareUrl');
    copyCustomBtn?.addEventListener('click', async () => {
      if (await copyTextToClipboard(customUrlEl.textContent)) showCopyFeedback(copyCustomBtn);
    });

    const copyShortDlcBtn = shareOverlayEl.querySelector('#copyShortDlcBtn');
    const shortDlcUrl = shareOverlayEl.querySelector('#shortShareUrlDlc');
    copyShortDlcBtn?.addEventListener('click', async () => {
      if (await copyTextToClipboard(shortDlcUrl.textContent)) showCopyFeedback(copyShortDlcBtn);
    });

    const copyShortNetlifyBtn = shareOverlayEl.querySelector('#copyShortNetlifyBtn');
    const shortNetlifyUrl = shareOverlayEl.querySelector('#shortShareUrlNetlify');
    copyShortNetlifyBtn?.addEventListener('click', async () => {
      if (await copyTextToClipboard(shortNetlifyUrl.textContent)) showCopyFeedback(copyShortNetlifyBtn);
    });

    const copyMediumDlcBtn = shareOverlayEl.querySelector('#copyMediumDlcBtn');
    const mediumDlcUrl = shareOverlayEl.querySelector('#mediumShareUrlDlc');
    copyMediumDlcBtn?.addEventListener('click', async () => {
      if (await copyTextToClipboard(mediumDlcUrl.textContent)) showCopyFeedback(copyMediumDlcBtn);
    });

    const copyMediumNetlifyBtn = shareOverlayEl.querySelector('#copyMediumNetlifyBtn');
    const mediumNetlifyUrl = shareOverlayEl.querySelector('#mediumShareUrlNetlify');
    copyMediumNetlifyBtn?.addEventListener('click', async () => {
      if (await copyTextToClipboard(mediumNetlifyUrl.textContent)) showCopyFeedback(copyMediumNetlifyBtn);
    });

    const viewMoreToggle = shareOverlayEl.querySelector('#shareViewMoreToggle');
    const shareAdvancedLinks = shareOverlayEl.querySelector('#shareAdvancedLinks');
    viewMoreToggle?.addEventListener('click', () => {
      if (!shareAdvancedLinks) return;
      const collapsed = shareAdvancedLinks.classList.toggle('collapsed');
      viewMoreToggle.textContent = collapsed ? 'View more' : 'View less';
      viewMoreToggle.setAttribute('aria-expanded', String(!collapsed));
    });
    viewMoreToggle?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        viewMoreToggle.click();
      }
    });
  }

  function openShareOverlayForUuid(uuid) {
    const item = itemsData.find(i => String(i.uuid).toLowerCase() === String(uuid).toLowerCase());
    if (!item) return;
    ensureShareOverlayExists();
    const shortCode = generateShareCode(item.title, item.uuid);
    const mediumCode = generateMediumCode(item);
    const shortUrlDlc = `${SHARE_CODE_BASE_DLC}/#${shortCode}`;
    const shortUrlNetlify = `${SHARE_CODE_BASE_NETLIFY}/#${shortCode}`;
    const mediumUrlDlc = `${SHARE_CODE_BASE_DLC}/#${mediumCode}`;
    const mediumUrlNetlify = `${SHARE_CODE_BASE_NETLIFY}/#${mediumCode}`;

    const customUrl = `${window.location.origin}${useHashRouting ? '/#f2p' : ''}${getItemRoutePath(item)}`;
    shareOverlayEl.querySelector('#customShareUrl').textContent = customUrl;
    shareOverlayEl.querySelector('#shortShareUrlDlc').textContent = shortUrlDlc;
    shareOverlayEl.querySelector('#shortShareUrlNetlify').textContent = shortUrlNetlify;
    shareOverlayEl.querySelector('#mediumShareUrlDlc').textContent = mediumUrlDlc;
    shareOverlayEl.querySelector('#mediumShareUrlNetlify').textContent = mediumUrlNetlify;
    const shareAdvancedLinks = shareOverlayEl.querySelector('#shareAdvancedLinks');
    const viewMoreToggle = shareOverlayEl.querySelector('#shareViewMoreToggle');
    if (shareAdvancedLinks) shareAdvancedLinks.classList.add('collapsed');
    if (viewMoreToggle) {
      viewMoreToggle.textContent = 'View more';
      viewMoreToggle.setAttribute('aria-expanded', 'false');
    }
    shareOverlayEl.classList.add('active');
    document.body.style.overflow = 'hidden';
  }

  function setFavouriteButtonForUuid(uuid) {
    if (!favouriteBtn) return;
    const isFavourited = loadFavourites().has(uuid);
    favouriteBtn.classList.toggle('favourited', isFavourited);
    favouriteBtn.setAttribute('aria-pressed', String(isFavourited));

    const heartIcon = favouriteBtn.querySelector('i');
    if (heartIcon) {
      heartIcon.classList.toggle('favourite-icon-active', isFavourited);
      heartIcon.style.color = isFavourited ? '#ff4d4d' : '';
    }
  }

  function toggleFavouriteForUuid(uuid) {
    const favs = loadFavourites();
    if (favs.has(uuid)) favs.delete(uuid);
    else favs.add(uuid);
    saveFavourites(favs);
    setFavouriteButtonForUuid(uuid);
    if (currentSort === 'favourites') {
      const searchInput = document.getElementById('searchInput');
      if (searchInput && searchInput.value.trim() !== '') {
        performSearch(searchInput.value.toLowerCase());
      } else {
        renderItems();
      }
    }
  }

  /**
   * Send a download request to the Discord webhook via /api/request.
   * Called when the user clicks the "Request" button on an item that isn't
   * in database.json yet. The bot processes the request and adds the item.
   */
  async function sendDownloadRequest(item, btn) {
    if (!item || !item.uuid) return;

    const cooldownStatus = getProtectedActionCooldownStatus();
    if (cooldownStatus.active) {
      btn.disabled = false;
      btn.innerHTML = `
        <div class="link-text">
          <i class="fas fa-hourglass-half link-icon" style="color:#ffb300;"></i>
          <span style="color:#ffb300;">Please wait</span>
        </div>
        <div class="right-group">
          <span class="file-size" style="color:#999;">${Math.ceil(cooldownStatus.remaining / 1000)}s</span>
        </div>
      `;
      return;
    }

    const limitStatus = getRequestLimitStatus();
    if (!limitStatus.allowed) {
      const retryMinutes = Math.max(1, Math.ceil((limitStatus.retryAfterMs || REQUEST_RATE_LIMIT_WINDOW_MS) / 60000));
      btn.disabled = false;
      btn.innerHTML = `
        <div class="link-text">
          <i class="fas fa-hourglass-half link-icon" style="color:#ffb300;"></i>
          <span style="color:#ffb300;">Limit reached</span>
        </div>
        <div class="right-group">
          <span class="file-size" style="color:#999;">Try again in ${retryMinutes}m</span>
        </div>
      `;
      return;
    }

    protectedActionCooldownUntil = Date.now() + PROTECTED_ACTION_COOLDOWN_MS;
    btn.disabled = true;
    btn.innerHTML = `
      <div class="link-text">
        <i class="fas fa-spinner fa-spin link-icon"></i>
        <span>Sending request…</span>
      </div>
      <div class="right-group"></div>
    `;

    try {
      await submitRequestWebhook({ uuid: item.uuid });
      recordRequestSubmission();
      console.log(`Request Sent: ${item.uuid}`);
      btn.innerHTML = `
        <div class="link-text">
          <i class="fas fa-check link-icon" style="color:#4caf50;"></i>
          <span style="color:#4caf50;">Request sent</span>
        </div>
        <div class="right-group">
          <span class="file-size" style="color:#999;">${getRequestUsageLabel()}</span>
        </div>
      `;
    } catch (err) {
      console.error('Request failed:', err);
      btn.disabled = false;
      btn.innerHTML = `
        <div class="link-text">
          <i class="fas fa-exclamation-triangle link-icon" style="color:#ff9800;"></i>
          <span style="color:#ff9800;">Failed — retry?</span>
        </div>
        <div class="right-group">
          <span class="file-size" style="color:#999;">${escapeHtml(err.message || 'Error')}</span>
        </div>
      `;
    }
  }

  async function sendUpdateRequest(item, btn) {
    if (!item || !item.uuid || !btn) return;

    const cooldownStatus = getProtectedActionCooldownStatus();
    if (cooldownStatus.active) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-hourglass-half" aria-hidden="true"></i>';
      btn.classList.add('update-btn-limit');
      btn.title = `Please wait ${Math.ceil(cooldownStatus.remaining / 1000)}s before trying again.`;
      return;
    }

    const limitStatus = getRequestLimitStatus();
    if (!limitStatus.allowed) {
      const retryMinutes = Math.max(1, Math.ceil((limitStatus.retryAfterMs || REQUEST_RATE_LIMIT_WINDOW_MS) / 60000));
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-exclamation-triangle" aria-hidden="true"></i>';
      btn.classList.add('update-btn-limit');
      btn.title = `Update limit reached. Try again in ${retryMinutes} minutes.`;
      return;
    }

    protectedActionCooldownUntil = Date.now() + PROTECTED_ACTION_COOLDOWN_MS;
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i>';

    try {
      await submitRequestWebhook({ uuid: item.uuid });
      recordRequestSubmission();
      console.log(`Update Sent: ${item.uuid}`);
      btn.innerHTML = '<i class="fas fa-check" aria-hidden="true"></i>';
      btn.title = `Update sent (${getRequestUsageLabel()})`;
      btn.classList.add('update-btn-success');
    } catch (err) {
      console.error('Update request failed:', err);
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-sync-alt" aria-hidden="true"></i>';
      btn.title = err.message || 'Update request failed';
    }
  }

  function openItemModal(uuid, replaceHistory = false) {
    const item = itemsData.find(i => String(i.uuid).toLowerCase() === String(uuid).toLowerCase());
    if (!item) return;
    overlayItemUuid = uuid;
    setFavouriteButtonForUuid(uuid);
    modalTitle.textContent = item.title || '';
    const itemType = item.subtitle || categoryNames[item.category] || 'Item';
    const creatorText = item.creator ? `<span class="meta-separator">-</span><span class="clickable-meta" data-meta-type="creator">${escapeHtml(item.creator)}</span>` : '';
    modalType.innerHTML = `<span class="clickable-meta" data-meta-type="type">${escapeHtml(itemType)}</span>${creatorText}`;

    if (item.rating != null && !Number.isNaN(Number(item.rating))) {
      modalRatingValue.textContent = Number(item.rating).toFixed(1);
      modalTotalRatings.innerHTML = `<span class="rating-separator">&nbsp;-&nbsp;</span>${Number(item.total_ratings || 0).toLocaleString()}&nbsp;<span class="rating-icon"><i class="fas fa-fire"></i></span>`;
      modalRating.style.display = 'block';
    } else {
      modalRating.style.display = 'none';
    }

    if (item.description) {
      modalDescription.textContent = item.description;
      modalDescription.style.whiteSpace = 'pre-wrap';
      modalDescription.style.display = 'block';
    } else {
      modalDescription.textContent = '';
      modalDescription.style.display = 'none';
    }

    downloadLinks.innerHTML = '';
    // Determine if this item has a download entry in database.json
    // New format: dbEntry has linkvertise_links, work.ink_links, lootlabs_links
    // Each array mirrors the others (same indices = same file type).
    // We use linkvertise_links as the "primary" to determine what files exist.
    const dbEntry = downloadDb.get(String(item.uuid).toLowerCase());
    const primaryLinks = dbEntry && Array.isArray(dbEntry.linkvertise_links) ? dbEntry.linkvertise_links : [];
    const hasDownloadLinks = primaryLinks.length > 0;

    if (hasDownloadLinks) {
      // Item is in database.json - render one button per file
      primaryLinks.forEach((link, index) => {
        if (!link) return;
        const row = document.createElement('div');
        row.className = 'download-link-row';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'download-link';
        button.dataset.linkIndex = String(index);
        const normalizedType = (link.type || '').toLowerCase().trim();
        const iconClass = downloadLinkIcons[normalizedType] || categoryIcons[item.category] || 'fas fa-puzzle-piece';
        const typeText = link.type ? String(link.type).trim() : categoryNames[item.category] || 'File';
        const labelText = themePreferences.showDownloadPrefix !== false ? `Download ${typeText}` : typeText;
        button.innerHTML = `
          <div class="link-text">
            <i class="${iconClass} link-icon"></i>
            <span>${escapeHtml(labelText)}</span>
          </div>
          <div class="right-group">
            ${link.size ? `<span class="file-size">${escapeHtml(link.size)}</span>` : ''}
          </div>
        `;
        button.addEventListener('click', () => openDownloadPickerForUuid(uuid, index));
        const updateButton = document.createElement('button');
        updateButton.type = 'button';
        updateButton.className = 'update-btn';
        updateButton.setAttribute('aria-label', `Request an update for ${typeText}`);
        updateButton.title = 'Request update';
        updateButton.innerHTML = '<i class="fas fa-sync-alt" aria-hidden="true"></i>';
        updateButton.addEventListener('click', event => {
          event.stopPropagation();
          sendUpdateRequest(item, updateButton);
        });
        row.append(button, updateButton);
        downloadLinks.appendChild(row);
      });
    } else {
      // Item is NOT in database.json - show a "Request" button so the user can
      // request the download link. Clicking it sends the item UUID + marketplace
      // link to the Discord webhook for the bot to process and add to the database.
      const requestBtn = document.createElement('button');
      requestBtn.type = 'button';
      requestBtn.className = 'download-link request-btn';
      requestBtn.innerHTML = `
        <div class="link-text">
          <i class="fas fa-paper-plane link-icon"></i>
          <span>Request</span>
        </div>
        <div class="right-group">
          <span class="file-size" style="color:#999;">Click to request</span>
          <i class="fas fa-external-link-alt link-arrow"></i>
        </div>
      `;
      requestBtn.addEventListener('click', () => sendDownloadRequest(item, requestBtn));
      downloadLinks.appendChild(requestBtn);
    }

    // Render slider with whatever data we have right now (basic thumbnail only
    // from the listing endpoint). Then fetch full detail data from the marketplace
    // API detail endpoint (/api/item?id=<uuid>) which returns real images[],
    // panoramaImage, and trailer (YouTube). Once detail arrives, re-render the
    // slider so the user sees extra screenshots, panorama, and video.
    const initialSlides = buildSlidesFromItem(item);
    renderSlider(initialSlides);
    updateModalViewVisibility();
    overlay.classList.add('active');
    document.body.style.overflow = 'hidden';

    // Lazily fetch full detail (images, panorama, trailer) from marketplace API.
    // Only re-render the slider if this modal is still open for the same item.
    if (!item._detailLoaded) {
      fetchItemDetail(item).then(updatedItem => {
        if (overlayItemUuid === uuid) {
          const newSlides = buildSlidesFromItem(updatedItem);
          // Only re-render if we got new slides (extra images / panorama / trailer)
          if (newSlides.length !== initialSlides.length) {
            renderSlider(newSlides);
          }
        }
      });
    }
    updateBottomNavVisibility();
    updateBrowserPath(getItemRoutePath(item), replaceHistory);
  }

  function closeOverlay() {
    overlay.classList.remove('active');
    closeShareOverlay();
    closeDownloadPickerOverlay();
    document.body.style.overflow = '';
    clearSlider();
    overlayItemUuid = null;
    updateBottomNavVisibility();
    updateBrowserPath(buildContentRoute(), true);
  }

  function extractUuidFromSearchText(text) {
    if (!text) return null;
    let query = String(text).trim();
    if (!query) return null;
    if (query.startsWith('#')) query = query.slice(1);

    const uuidMatch = query.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (uuidMatch) return uuidMatch[0].toLowerCase();
    if (SHARE_CODE_RE.test(query)) {
      const mapped = shareCodeToUuid.get(query.toLowerCase());
      if (mapped) return mapped;
    }
    const mappedMedium = mediumCodeToUuid.get(query.toLowerCase());
    if (mappedMedium) return mappedMedium;
    return null;
  }

  function normalizeString(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function saveThemePreferences() {
    const activeFontStyle = document.querySelector('.font-style-btn.active')?.dataset.fontStyle || 'rubik';
    themePreferences.fontStyle = activeFontStyle;
    const prefs = {
      bgColor: document.getElementById('themeBgColor').value,
      titleColor: document.getElementById('themeTitleColor').value,
      iconsColor: document.getElementById('themeIconsColor').value,
      cardTitleColor: document.getElementById('themeCardTitleColor')?.value,
      cardTypeColor: document.getElementById('themeCardTypeColor')?.value,
      cardCreatorColor: document.getElementById('themeCardCreatorColor')?.value,
      cardRatingsColor: document.getElementById('themeCardRatingsColor')?.value,
      cardPopularityColor: document.getElementById('themeCardPopularityColor')?.value,
      cardDescColor: document.getElementById('themeCardDescColor')?.value,
      cardIconsColor: document.getElementById('themeCardIconsColor')?.value,
      modalTitleColor: document.getElementById('themeModalTitleColor')?.value,
      modalTypeColor: document.getElementById('themeModalTypeColor')?.value,
      modalDescColor: document.getElementById('themeModalDescColor')?.value,
      modalIconsColor: document.getElementById('themeModalIconsColor')?.value,
      modalCreatorColor: document.getElementById('themeModalCreatorColor')?.value,
      modalDownloadColor: document.getElementById('themeModalDownloadColor')?.value,
      modalRatingsColor: document.getElementById('themeModalRatingsColor')?.value,
      modalPopularityColor: document.getElementById('themeModalPopularityColor')?.value,
      showCount: document.getElementById('themeShowCount')?.checked !== false,
      showType: document.getElementById('themeShowType')?.checked !== false,
      showSortBadge: document.getElementById('themeShowSortBadge')?.checked !== false,
      showModalTitle: document.getElementById('themeShowModalTitle')?.checked !== false,
      showModalDescription: document.getElementById('themeShowModalDescription')?.checked !== false,
      showModalType: document.getElementById('themeShowModalType')?.checked !== false,
      showModalCreator: document.getElementById('themeShowModalCreator')?.checked !== false,
      showModalRating: document.getElementById('themeShowModalRating')?.checked !== false,
      showModalPopularity: document.getElementById('themeShowModalPopularity')?.checked !== false,
      showModalImage: document.getElementById('themeShowModalImage')?.checked !== false,
      showModalFavourite: document.getElementById('themeShowModalFavourite')?.checked !== false,
      showModalShare: document.getElementById('themeShowModalShare')?.checked !== false,
      showDownloadPrefix: document.getElementById('themeShowDownloadPrefix')?.checked !== false,
      fontStyle: activeFontStyle,
      activeCardStyle: currentCardStyle,
      cardStyles: cardStylePreferences
    };
    try {
      localStorage.setItem('marketplace_theme', JSON.stringify(prefs));
    } catch (err) {
      // ignore
    }
    applyTheme(prefs);
    // Ensure font buttons reflect saved preference
    document.querySelectorAll('.font-style-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.fontStyle === prefs.fontStyle));
  }

  function updateToggleLabelStates() {
    document.querySelectorAll('.toggle-label input[type="checkbox"]').forEach(input => {
      const label = input.closest('.toggle-label');
      if (label) {
        label.classList.toggle('active', input.checked);
      }
    });
  }

  function updateModalViewVisibility() {
    if (!modalTitle || !modalDescription || !modalRating || !favouriteBtn || !shareBtn) return;
    const showModalTitle = themePreferences.showModalTitle !== false;
    const showModalDescription = themePreferences.showModalDescription !== false;
    const showModalType = themePreferences.showModalType !== false;
    const showModalCreator = themePreferences.showModalCreator !== false;
    const showModalRating = themePreferences.showModalRating !== false;
    const showModalPopularity = themePreferences.showModalPopularity !== false;
    const showModalImage = themePreferences.showModalImage !== false;
    const showModalFavourite = themePreferences.showModalFavourite !== false;
    const showModalShare = themePreferences.showModalShare !== false;

    modalTitle.style.display = showModalTitle ? '' : 'none';
    modalDescription.style.display = showModalDescription ? (modalDescription.textContent ? 'block' : 'none') : 'none';
    const modalTypeType = modalType.querySelector('[data-meta-type="type"]');
    const modalTypeCreator = modalType.querySelector('[data-meta-type="creator"]');
    const modalTypeSeparator = modalType.querySelector('.meta-separator');
    if (modalTypeType) modalTypeType.style.display = showModalType ? '' : 'none';
    if (modalTypeCreator) modalTypeCreator.style.display = showModalCreator ? '' : 'none';
    if (modalTypeSeparator) modalTypeSeparator.style.display = showModalType && showModalCreator ? '' : 'none';
    modalType.style.display = showModalType || showModalCreator ? '' : 'none';
    const modalRatingValueEl = document.getElementById('modalRatingValue');
    const modalTotalRatingsEl = document.getElementById('modalTotalRatings');
    if (modalRatingValueEl) {
      modalRatingValueEl.style.display = showModalRating ? '' : 'none';
    }
    if (modalTotalRatingsEl) {
      modalTotalRatingsEl.style.display = showModalPopularity ? '' : 'none';
    }
    modalRating.style.display = (showModalRating || showModalPopularity) ? (modalRating.textContent.trim() ? 'block' : 'none') : 'none';
    favouriteBtn.style.display = showModalFavourite ? '' : 'none';
    shareBtn.style.display = showModalShare ? '' : 'none';

    const modalSliderContainer = document.getElementById('modalSliderContainer');
    const sliderThumbsEl = document.getElementById('sliderThumbs');
    const sliderUpEl = document.getElementById('sliderUp');

    if (modalSliderContainer) {
      modalSliderContainer.style.display = showModalImage ? '' : 'none';
    }
    if (sliderThumbsEl) {
      sliderThumbsEl.style.display = showModalImage ? 'flex' : 'none';
    }
    if (sliderUpEl) {
      sliderUpEl.style.display = showModalImage ? (sliderUpEl.style.display === 'none' ? '' : sliderUpEl.style.display) : 'none';
    }
  }

  function applyTheme(prefs) {
    const resolvedPrefs = { ...DEFAULT_THEME_PREFERENCES, ...(prefs || {}) };
    const root = document.documentElement;
    root.style.setProperty('--gradient-colors', `linear-gradient(270deg, ${resolvedPrefs.bgColor}, ${resolvedPrefs.bgColor}, ${resolvedPrefs.bgColor})`);
    root.style.setProperty('--text-color', resolvedPrefs.titleColor);
    root.style.setProperty('--icons-color', resolvedPrefs.iconsColor);
    root.style.setProperty('--card-title-color', resolvedPrefs.cardTitleColor);
    root.style.setProperty('--card-type-color', resolvedPrefs.cardTypeColor);
    root.style.setProperty('--card-creator-color', resolvedPrefs.cardCreatorColor);
    root.style.setProperty('--card-ratings-color', resolvedPrefs.cardRatingsColor);
    root.style.setProperty('--card-popularity-color', resolvedPrefs.cardPopularityColor);
    root.style.setProperty('--card-desc-color', resolvedPrefs.cardDescColor);
    root.style.setProperty('--card-icons-color', resolvedPrefs.cardIconsColor);
    root.style.setProperty('--modal-title-color', resolvedPrefs.modalTitleColor);
    root.style.setProperty('--modal-type-color', resolvedPrefs.modalTypeColor);
    root.style.setProperty('--modal-desc-color', resolvedPrefs.modalDescColor);
    root.style.setProperty('--modal-icons-color', resolvedPrefs.modalIconsColor);
    root.style.setProperty('--modal-creator-color', resolvedPrefs.modalCreatorColor);
    root.style.setProperty('--modal-download-color', resolvedPrefs.modalDownloadColor);
    root.style.setProperty('--modal-ratings-color', resolvedPrefs.modalRatingsColor);
    root.style.setProperty('--modal-popularity-color', resolvedPrefs.modalPopularityColor);

    document.querySelectorAll('h1, .sort-option, .sort-dropdown, .settings-btn').forEach(el => { el.style.color = resolvedPrefs.titleColor; });
    
    // Apply main page icons color to main page elements only (NOT modal elements)
    document.querySelectorAll('.category-buttons button, .settings-btn, .search-wrapper button, .slider-prev, .slider-next, .slider-up, .copy-share-btn, .panel-close-btn, .sort-option i, .social-links a, .download-guide-btn').forEach(el => {
      el.style.color = resolvedPrefs.iconsColor;
    });
    
    // Apply modal icons color to modal-specific buttons
    document.querySelectorAll('#downloadOverlay .favourite-btn, #downloadOverlay .share-btn, #downloadOverlay .close-btn, #downloadOverlay .thumb-nav').forEach(el => {
      el.style.color = resolvedPrefs.modalIconsColor;
    });

    let fontFamily = "'Rubik', sans-serif";
    if (resolvedPrefs.fontStyle === 'mcpefont') {
      fontFamily = "'MCPEfont', 'Courier New', monospace";
    } else if (resolvedPrefs.fontStyle === 'montserrat') {
      fontFamily = "'Montserrat', 'Segoe UI', sans-serif";
    } else if (resolvedPrefs.fontStyle === 'oswald') {
      fontFamily = "'Oswald', 'Segoe UI', sans-serif";
    }

    document.body.style.fontFamily = fontFamily;
    document.querySelectorAll('h1, h2, h3, h4, .sort-option, .category-buttons button, .settings-btn').forEach(el => {
      el.style.fontFamily = fontFamily;
    });
    
    // Update font button styling to reflect active font
    document.querySelectorAll('.font-style-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.fontStyle === resolvedPrefs.fontStyle));
  }

  function loadThemePreferences() {
    try {
      const raw = localStorage.getItem('marketplace_theme');
      if (!raw) return;
      const prefs = JSON.parse(raw);
      if (!prefs) return;
      if (prefs.bgColor) document.getElementById('themeBgColor').value = prefs.bgColor;
      if (prefs.titleColor) document.getElementById('themeTitleColor').value = prefs.titleColor;
      if (prefs.iconsColor) document.getElementById('themeIconsColor').value = prefs.iconsColor;
      if (prefs.showCount !== undefined) document.getElementById('themeShowCount').checked = prefs.showCount;
      if (prefs.showType !== undefined) document.getElementById('themeShowType').checked = prefs.showType;
      if (prefs.showSortBadge !== undefined) document.getElementById('themeShowSortBadge').checked = prefs.showSortBadge;
      if (prefs.showModalTitle !== undefined) document.getElementById('themeShowModalTitle').checked = prefs.showModalTitle;
      if (prefs.showModalDescription !== undefined) document.getElementById('themeShowModalDescription').checked = prefs.showModalDescription;
      if (prefs.showModalType !== undefined) document.getElementById('themeShowModalType').checked = prefs.showModalType;
      if (prefs.showModalCreator !== undefined) document.getElementById('themeShowModalCreator').checked = prefs.showModalCreator;
      if (prefs.showModalRating !== undefined) document.getElementById('themeShowModalRating').checked = prefs.showModalRating;
      if (prefs.showModalPopularity !== undefined) document.getElementById('themeShowModalPopularity').checked = prefs.showModalPopularity;
      if (prefs.showModalImage !== undefined) document.getElementById('themeShowModalImage').checked = prefs.showModalImage;
      if (prefs.showModalFavourite !== undefined) document.getElementById('themeShowModalFavourite').checked = prefs.showModalFavourite;
      if (prefs.showModalShare !== undefined) document.getElementById('themeShowModalShare').checked = prefs.showModalShare;
      if (prefs.showDownloadPrefix !== undefined) document.getElementById('themeShowDownloadPrefix').checked = prefs.showDownloadPrefix;
      if (prefs.showCardTitle !== undefined) document.getElementById('themeShowCardTitle').checked = prefs.showCardTitle;
      if (prefs.showCardType !== undefined) document.getElementById('themeShowCardType').checked = prefs.showCardType;
      if (prefs.showCardCreator !== undefined) document.getElementById('themeShowCardCreator').checked = prefs.showCardCreator;
      if (prefs.showCardRating !== undefined) document.getElementById('themeShowCardRating').checked = prefs.showCardRating;
      if (prefs.showCardTotalRatings !== undefined) document.getElementById('themeShowCardTotalRatings').checked = prefs.showCardTotalRatings;
      if (prefs.showCardImage !== undefined) document.getElementById('themeShowCardImage').checked = prefs.showCardImage;
      if (prefs.cardTitleColor) document.getElementById('themeCardTitleColor').value = prefs.cardTitleColor;
      if (prefs.cardTypeColor) document.getElementById('themeCardTypeColor').value = prefs.cardTypeColor;
      if (prefs.cardCreatorColor) document.getElementById('themeCardCreatorColor').value = prefs.cardCreatorColor;
      if (prefs.cardRatingsColor) document.getElementById('themeCardRatingsColor').value = prefs.cardRatingsColor;
      if (prefs.cardPopularityColor) document.getElementById('themeCardPopularityColor').value = prefs.cardPopularityColor;
      if (prefs.cardDescColor) document.getElementById('themeCardDescColor').value = prefs.cardDescColor;
      if (prefs.cardIconsColor) document.getElementById('themeCardIconsColor').value = prefs.cardIconsColor;
      if (prefs.modalTitleColor) document.getElementById('themeModalTitleColor').value = prefs.modalTitleColor;
      if (prefs.modalTypeColor) document.getElementById('themeModalTypeColor').value = prefs.modalTypeColor;
      if (prefs.modalDescColor) document.getElementById('themeModalDescColor').value = prefs.modalDescColor;
      if (prefs.modalIconsColor) document.getElementById('themeModalIconsColor').value = prefs.modalIconsColor;
      if (prefs.modalCreatorColor) document.getElementById('themeModalCreatorColor').value = prefs.modalCreatorColor;
      if (prefs.modalDownloadColor) document.getElementById('themeModalDownloadColor').value = prefs.modalDownloadColor;
      if (prefs.modalRatingsColor) document.getElementById('themeModalRatingsColor').value = prefs.modalRatingsColor;
      if (prefs.modalPopularityColor) document.getElementById('themeModalPopularityColor').value = prefs.modalPopularityColor;
      const fontStyle = prefs.fontStyle || 'rubik';
      document.querySelectorAll('.font-style-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.fontStyle === fontStyle));
      themePreferences = {
        ...DEFAULT_THEME_PREFERENCES,
        showCount: prefs.showCount !== false,
        showType: prefs.showType !== false,
        showSortBadge: prefs.showSortBadge !== false,
        showModalTitle: prefs.showModalTitle !== false,
        showModalDescription: prefs.showModalDescription !== false,
        showModalType: prefs.showModalType !== false,
        showModalCreator: prefs.showModalCreator !== false,
        showModalRating: prefs.showModalRating !== false,
        showModalPopularity: prefs.showModalPopularity !== false,
        showModalImage: prefs.showModalImage !== false,
        showModalFavourite: prefs.showModalFavourite !== false,
        showModalShare: prefs.showModalShare !== false,
        showDownloadPrefix: prefs.showDownloadPrefix !== false,
        fontStyle,
        bgColor: prefs.bgColor || DEFAULT_THEME_PREFERENCES.bgColor,
        titleColor: prefs.titleColor || DEFAULT_THEME_PREFERENCES.titleColor,
        iconsColor: prefs.iconsColor || DEFAULT_THEME_PREFERENCES.iconsColor,
        cardTitleColor: prefs.cardTitleColor || DEFAULT_THEME_PREFERENCES.cardTitleColor,
        cardTypeColor: prefs.cardTypeColor || DEFAULT_THEME_PREFERENCES.cardTypeColor,
        cardCreatorColor: prefs.cardCreatorColor || DEFAULT_THEME_PREFERENCES.cardCreatorColor,
        cardRatingsColor: prefs.cardRatingsColor || DEFAULT_THEME_PREFERENCES.cardRatingsColor,
        cardPopularityColor: prefs.cardPopularityColor || DEFAULT_THEME_PREFERENCES.cardPopularityColor,
        cardDescColor: prefs.cardDescColor || DEFAULT_THEME_PREFERENCES.cardDescColor,
        cardIconsColor: prefs.cardIconsColor || DEFAULT_THEME_PREFERENCES.cardIconsColor,
        modalTitleColor: prefs.modalTitleColor || DEFAULT_THEME_PREFERENCES.modalTitleColor,
        modalTypeColor: prefs.modalTypeColor || DEFAULT_THEME_PREFERENCES.modalTypeColor,
        modalDescColor: prefs.modalDescColor || DEFAULT_THEME_PREFERENCES.modalDescColor,
        modalIconsColor: prefs.modalIconsColor || DEFAULT_THEME_PREFERENCES.modalIconsColor,
        modalCreatorColor: prefs.modalCreatorColor || DEFAULT_THEME_PREFERENCES.modalCreatorColor,
        modalDownloadColor: prefs.modalDownloadColor || DEFAULT_THEME_PREFERENCES.modalDownloadColor,
        modalRatingsColor: prefs.modalRatingsColor || DEFAULT_THEME_PREFERENCES.modalRatingsColor,
        modalPopularityColor: prefs.modalPopularityColor || DEFAULT_THEME_PREFERENCES.modalPopularityColor
      };
      updateToggleLabelStates();
      if (prefs.cardStyles && typeof prefs.cardStyles === 'object') {
        cardStylePreferences = {
          style1: { ...cardStylePreferences.style1, ...prefs.cardStyles.style1 },
          style2: { ...cardStylePreferences.style2, ...prefs.cardStyles.style2 },
          style3: { ...cardStylePreferences.style3, ...prefs.cardStyles.style3 },
          style4: { ...cardStylePreferences.style4, ...prefs.cardStyles.style4 }
        };
      }
      if (prefs.activeCardStyle && cardStylePreferences[prefs.activeCardStyle]) {
        currentCardStyle = prefs.activeCardStyle;
      }
      setActiveCardStyle(currentCardStyle);
      applyTheme(prefs);
      updateCategoryCount();
      updateSortIndicator();
    } catch (err) {
      // ignore theme load issues
    }
  }

  function hideInitialLoader() {
    const loader = document.getElementById('initialLoader');
    if (loader) loader.classList.add('hidden');
    clearInitialLoaderTimers();
    updateBottomNavVisibility();
  }

  let initialLoaderTimers = [];
  let initialLoaderReadyToHide = false;
  let initialLoaderMinHoldPassed = false;

  function clearInitialLoaderTimers() {
    initialLoaderTimers.forEach(timer => clearTimeout(timer));
    initialLoaderTimers.length = 0;
  }

  function setLoaderMainText(text) {
    const el = document.getElementById('loaderMainText');
    if (!el) return;
    el.classList.remove('visible');
    void el.offsetWidth;
    el.textContent = text;
    el.classList.add('visible');
  }

  function setLoaderHelperText(html) {
    const el = document.getElementById('loaderHelperText');
    if (!el) return;
    el.classList.remove('visible');
    void el.offsetWidth;
    el.innerHTML = html || '';
    if (html) el.classList.add('visible');
  }

  function scheduleInitialLoaderSequence() {
    setLoaderMainText('Loading');
    setLoaderHelperText('Need help? <a href="https://discord.gg/W7xgPbbz" target="_blank" rel="noopener noreferrer">Join the Discord</a>');
    clearInitialLoaderTimers();

    initialLoaderTimers.push(setTimeout(() => {
      initialLoaderMinHoldPassed = true;
      if (initialLoaderReadyToHide) hideInitialLoader();
    }, 3000));
  }

  function markInitialLoaderReady() {
    initialLoaderReadyToHide = true;
    if (initialLoaderMinHoldPassed) {
      initialLoaderTimers.push(setTimeout(() => {
        hideInitialLoader();
      }, 650));
    }
  }

  function cycleLogoText() {
    const logo = document.getElementById('logo');
    if (!logo) return;
    logo.classList.remove('logo-animate-in');
    logo.classList.add('logo-animate-out');

    setTimeout(() => {
      const currentText = String(logo.textContent || '').trim().toUpperCase();
      logo.textContent = currentText === 'MCF2P' ? 'MARKET' : 'MCF2P';
      logo.classList.remove('logo-animate-out');
      void logo.offsetWidth;
      logo.classList.add('logo-animate-in');
    }, 650);
  }

  function startLogoCycle() {
    clearInterval(logoCycleInterval);
    logoCycleInterval = setInterval(cycleLogoText, 60000);
  }

  function getBaseItems() {
    let baseItems = dedupeItemsByUuid(itemsData);
    if (currentCategory !== 'all') {
      baseItems = baseItems.filter(item => item.category === currentCategory);
    }
    if (currentSort === 'favourites') {
      const favs = loadFavourites();
      baseItems = baseItems.filter(item => favs.has(item.uuid));
    }
    return sortItems(dedupeItemsByUuid(baseItems));
  }

  function getCategoryCount() {
    return Array.isArray(allFilteredSortedItems) ? allFilteredSortedItems.length : 0;
  }

  function getCategoryLabel() {
    const labels = {
      all: 'All',
      worlds: 'Worlds',
      addons: 'Addons',
      mashups: 'Mashups',
      textures: 'Textures',
      skins: 'Skins'
    };
    if (currentCategory === 'all') {
      return currentSort === 'favourites' ? 'Favourites' : 'All';
    }
    return labels[currentCategory] || String(currentCategory);
  }

  function getCategoryDisplayText() {
    const showCount = themePreferences.showCount !== false;
    const showType = themePreferences.showType !== false;
    const count = getCategoryCount();
    const label = getCategoryLabel();

    if (currentCreatorFilter && currentSort === 'creator') {
      return `${count} ${label}`;
    }

    if (!showCount && !showType) return '';
    if (showCount && showType) return `${count} ${label}`;
    return showCount ? String(count) : label;
  }

  function updateCategoryCount() {
    const countEl = document.getElementById('categoryCount');
    if (!countEl) return;
    const text = getCategoryDisplayText();
    countEl.textContent = text;
    countEl.style.display = text ? '' : 'none';
    positionCategoryCount();
  }

  /**
   * Update the loading progress indicator in the settings/statistics panel
   * AND the small text below the "MARKET" logo.
   * Reads from the global `loadProgress` object which is updated by
   * loadMarketplaceItems() as batches complete.
   */
  let logoProgressAnimationTimer = null;

  function updateLoadProgressIndicator() {
    const done = Number.isFinite(Number(loadProgress.done)) ? Number(loadProgress.done) : 0;
    const total = Number.isFinite(Number(loadProgress.total)) ? Number(loadProgress.total) : 0;
    const itemsLoaded = Number.isFinite(Number(loadProgress.itemsLoaded)) ? Number(loadProgress.itemsLoaded) : 0;
    const complete = loadProgress.complete === true;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;

    // Settings panel indicator (full progress bar)
    const textEl = document.getElementById('loadProgressText');
    const barEl = document.getElementById('loadProgressBar');
    const labelEl = document.getElementById('loadProgressLabel');
    const iconEl = document.getElementById('loadProgressIcon');
    if (textEl && barEl) {
      if (complete) {
        textEl.textContent = `${itemsLoaded.toLocaleString()} Items Loaded`;
        barEl.style.width = '100%';
        barEl.style.background = '#4CAF50';
        if (labelEl) labelEl.textContent = '';
        if (iconEl) { iconEl.className = 'fas fa-check-circle'; iconEl.style.color = '#4CAF50'; }
      } else {
        textEl.textContent = `Loading… ${done.toLocaleString()} / ${total.toLocaleString()} (${pct}%)`;
        barEl.style.width = `${pct}%`;
        if (labelEl) labelEl.textContent = `${itemsLoaded.toLocaleString()} Items Loaded`;
        if (iconEl) { iconEl.className = 'fas fa-cloud-download-alt'; iconEl.style.color = '#5865F2'; }
      }
    }

    // Small text below the MARKET logo (styled as a subtitle of the logo)
    const logoEl = document.getElementById('logoLoadIndicator');
    if (logoEl) {
      if (complete) {
        logoEl.textContent = `${itemsLoaded.toLocaleString()} ITEMS LOADED`;
      } else {
        logoEl.textContent = `LOADING ITEMS ${pct}%`;
      }
      logoEl.style.color = '#ffffff';
      logoEl.style.opacity = '1';
      logoEl.classList.add('animate-progress');
      if (logoProgressAnimationTimer) {
        clearTimeout(logoProgressAnimationTimer);
      }
      logoProgressAnimationTimer = setTimeout(() => {
        logoEl.classList.remove('animate-progress');
        logoProgressAnimationTimer = null;
      }, 360);
    }
  }

  function positionCategoryCount() {
    const countEl = document.getElementById('categoryCount');
    const categoryContainer = document.querySelector('.category-container');
    const activeBtn = document.querySelector('.category-buttons button.active');
    if (!countEl || !categoryContainer || !activeBtn) return;
    const containerRect = categoryContainer.getBoundingClientRect();
    const btnRect = activeBtn.getBoundingClientRect();
    const left = btnRect.left - containerRect.left + btnRect.width / 2;
    const top = categoryContainer.offsetHeight + 4;
    countEl.style.left = `${left}px`;
    countEl.style.top = `${top}px`;
  }

  function clearSearchInput() {
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
      searchInput.value = '';
      clearTimeout(searchTimeout);
    }
  }

  function applyCreatorFilter(creatorName, category = 'all', replaceHistory = false) {
    if (!creatorName) return;
    setContentRoute(category, creatorName);
    currentCategory = category;
    if (currentSort === 'default' || currentSort === 'creator') {
      currentSort = 'creator';
    }
    currentCreatorFilter = creatorName;
    document.querySelectorAll('.category-buttons button').forEach(btn => btn.classList.toggle('active', btn.dataset.filter === category));
    allFilteredSortedItems = getFilteredSortedItems();
    updateSortUI();
    updateCategoryCount();
    currentPage = 1;
    hasMoreItems = allFilteredSortedItems.length > ITEMS_PER_PAGE;
    renderCurrentPage();
    if (replaceHistory) {
      updateBrowserPath(buildContentRoute(), true);
    } else {
      updateBrowserPath(buildContentRoute());
    }
    updateCreatorExitButton();
  }

  function closeSortControls() {
    const overlay = document.getElementById('sortOverlay');
    overlay?.classList.remove('active');
    document.body.style.overflow = '';
  }

  function openSortModal(sortType) {
    const overlay = document.getElementById('sortOverlay');
    const title = document.getElementById('sortModalTitle');
    const content = document.getElementById('sortModalContent');
    if (!overlay || !title || !content) return;

    overlay.classList.add('active');
    content.innerHTML = '';
    let buttons = [];

    const createButton = (label, value) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'sort-modal-button';
      button.textContent = label;
      button.addEventListener('click', () => applySortSelection(value));
      return button;
    };

    if (sortType === 'title') {
      title.textContent = 'Sort by Title';
      buttons = [
        createButton('A → Z', 'titleAsc'),
        createButton('Z → A', 'titleDesc')
      ];
    } else if (sortType === 'added') {
      title.textContent = 'Sort by Added';
      buttons = [
        createButton('Newest First', 'addedNewest'),
        createButton('Oldest First', 'addedOldest')
      ];
    } else if (sortType === 'rating') {
      title.textContent = 'Sort by Rating';
      buttons = [
        createButton('Highest Rated', 'ratingHigh'),
        createButton('Lowest Rated', 'ratingLow')
      ];
    } else if (sortType === 'popularity') {
      title.textContent = 'Sort by Popularity';
      buttons = [
        createButton('Most Popular', 'popularityMost'),
        createButton('Least Popular', 'popularityLeast')
      ];
    } else if (sortType === 'availability') {
      title.textContent = 'Availability';
      buttons = [
        createButton('Combined', 'availabilityCombined'),
        createButton('Downloadable', 'availabilityDownloadable'),
        createButton('Unavailable', 'availabilityUnavailable')
      ];
    } else if (sortType === 'creators') {
      title.textContent = 'Filter by Creator';
      const creators = Array.from(new Set(itemsData.map(item => String(item.creator || '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b));
      const searchWrapper = document.createElement('div');
      searchWrapper.className = 'sort-modal-search';
      searchWrapper.innerHTML = '<input type="text" placeholder="Search creator..." aria-label="Search creator" />';
      const searchInput = searchWrapper.querySelector('input');

      // Show creator count and loading status
      const countLabel = document.createElement('div');
      countLabel.style.cssText = 'font-size: 0.8em; color: #999; padding: 4px 12px; text-align: center;';
      if (loadProgress && !loadProgress.complete) {
        countLabel.textContent = `${creators.length} Creators Loaded`;
      } else {
        countLabel.textContent = `${creators.length} Creators Loaded`;
      }

      const listContainer = document.createElement('div');
      listContainer.className = 'sort-modal-list';
      const creatorButtons = creators.map(name => {
        const button = createButton(name, `creator:${name}`);
        button.dataset.creatorName = name.toLowerCase();
        button.style.textAlign = 'left';
        listContainer.appendChild(button);
        return button;
      });

      searchInput?.addEventListener('input', () => {
        const filter = String(searchInput.value || '').trim().toLowerCase();
        creatorButtons.forEach(button => {
          const creatorName = button.dataset.creatorName || '';
          button.style.display = !filter || creatorName.includes(filter) ? '' : 'none';
        });
      });

      content.appendChild(searchWrapper);
      content.appendChild(countLabel);
      content.appendChild(listContainer);
    } else if (sortType === 'favourites') {
      title.textContent = 'Filter Favourites';
      buttons = [
        createButton('All Favourites', 'favourites:all'),
        createButton('Worlds', 'favourites:worlds'),
        createButton('Addons', 'favourites:addons'),
        createButton('Mashups', 'favourites:mashups'),
        createButton('Textures', 'favourites:textures'),
        createButton('Skins', 'favourites:skins')
      ];
    }

    if (buttons.length) {
      buttons.forEach(btn => content.appendChild(btn));
    }
    document.body.style.overflow = 'hidden';
  }

  function applySortSelection(value) {
    closeSortControls();

    if (value.startsWith('creator:')) {
      currentSort = 'creator';
      currentCreatorFilter = value.split(':')[1];
      currentCategory = 'all';
      document.querySelectorAll('.category-buttons button').forEach(btn => btn.classList.toggle('active', btn.dataset.filter === 'all'));
    } else if (value.startsWith('favourites:')) {
      currentSort = 'favourites';
      currentCreatorFilter = null;
      const category = value.split(':')[1];
      currentCategory = category;
      document.querySelectorAll('.category-buttons button').forEach(btn => btn.classList.toggle('active', btn.dataset.filter === category));
    } else {
      currentSort = value;
      // Keep creator filter active when sorting on a creator page.
    }

    applySort();
    updateCreatorExitButton();
  }

  function applySort() {
    updateSortUI();
    saveCurrentSort();
    currentPage = 1;
    hasMoreItems = true;

    const searchInput = document.getElementById('searchInput');
    const activeSearchQuery = searchInput ? String(searchInput.value || '').trim().toLowerCase() : '';

    if (activeSearchQuery !== '') {
      performSearch(activeSearchQuery);
    } else {
      allFilteredSortedItems = getFilteredSortedItems();
      renderItems();
      updateCategoryCount();
    }
  }

  function performSearch(searchQuery) {
    const container = document.getElementById('itemContainer');
    if (!container) return;
    const query = String(searchQuery || '').trim();

    const refreshCategoryBadge = () => {
      updateCategoryCount();
      positionCategoryCount();
    };

    if (query === '') {
      allFilteredSortedItems = getFilteredSortedItems();
      container.innerHTML = '';
      currentPage = 1;
      hasMoreItems = allFilteredSortedItems.length > ITEMS_PER_PAGE;
      const endIndex = Math.min(ITEMS_PER_PAGE, allFilteredSortedItems.length);
      for (let i = 0; i < endIndex; i += 1) {
        container.appendChild(createItemElement(allFilteredSortedItems[i]));
      }
      if (allFilteredSortedItems.length === 0) {
        container.innerHTML = '<div class="no-items">No Results</div>';
      }
      refreshCategoryBadge();
      // Pre-fetch details for the visible search results so ratings show
      setTimeout(fetchDetailsForVisibleCards, 100);
      return;
    }

    container.innerHTML = '<div class="loading-indicator"><i class="fas fa-spinner fa-spin"></i> Searching</div>';
    setTimeout(() => {
      const directId = extractUuidFromSearchText(query);
      if (directId) {
        const found = itemsData.find(item => String(item.uuid).toLowerCase() === directId);
        if (found) {
          if (currentCategory !== 'all' && found.category !== currentCategory) {
            allFilteredSortedItems = [];
          } else if (currentSort === 'favourites') {
            const favs = loadFavourites();
            allFilteredSortedItems = favs.has(found.uuid) ? [found] : [];
          } else {
            allFilteredSortedItems = [found];
          }
        } else {
          allFilteredSortedItems = [];
        }
        container.innerHTML = '';
        currentPage = 1;
        hasMoreItems = false;
        if (allFilteredSortedItems.length > 0) {
          const itemEl = createItemElement(allFilteredSortedItems[0]);
          container.appendChild(itemEl);
          shrinkStyle2TitleIfThreeLines(itemEl);
        } else {
          container.innerHTML = '<div class="no-items">No Results</div>';
        }
        refreshCategoryBadge();
        // Pre-fetch details for the visible search results so ratings show
        setTimeout(fetchDetailsForVisibleCards, 100);
        return;
      }

      const baseItems = getBaseItems();
      const normalizedQuery = normalizeString(query);
      const filtered = baseItems.filter(item => {
        const titleMatch = normalizeString(item.title).includes(normalizedQuery);
        const creatorMatch = normalizeString(item.creator || '').includes(normalizedQuery);
        const typeMatch = normalizeString(item.subtitle || '').includes(normalizedQuery);
        return titleMatch || creatorMatch || typeMatch;
      });

      allFilteredSortedItems = filtered;
      container.innerHTML = '';
      currentPage = 1;
      hasMoreItems = filtered.length > ITEMS_PER_PAGE;
      const endIndex = Math.min(ITEMS_PER_PAGE, filtered.length);
      for (let i = 0; i < endIndex; i += 1) {
        const itemEl = createItemElement(filtered[i]);
        container.appendChild(itemEl);
        shrinkStyle2TitleIfThreeLines(itemEl);
      }
      if (filtered.length === 0) {
        container.innerHTML = '<div class="no-items">No Results</div>';
      }
      refreshCategoryBadge();
      // Pre-fetch details for the visible search results so ratings show
      setTimeout(fetchDetailsForVisibleCards, 100);
    }, 300);
  }

  function applyModalQuickFilter(metaType, value) {
    const searchInput = document.getElementById('searchInput');
    if (!searchInput || !value) return;
    if (metaType === 'type') {
      const typeToCategory = {
        world: 'worlds',
        addon: 'addons',
        'add-on': 'addons',
        texture: 'textures',
        skin: 'skins',
        mashup: 'mashups'
      };
      const key = String(value).toLowerCase().trim();
      const category = typeToCategory[key] || 'all';
      const categoryBtn = document.querySelector(`.category-buttons button[data-filter="${category}"]`);
      if (categoryBtn) categoryBtn.click();
      searchInput.value = value;
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    searchInput.value = value;
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function updateStatistics() {
    document.getElementById('statAll').textContent = itemsData.length;
    document.getElementById('statWorlds').textContent = itemsData.filter(item => item.category === 'worlds').length;
    document.getElementById('statAddons').textContent = itemsData.filter(item => item.category === 'addons').length;
    document.getElementById('statMashups').textContent = itemsData.filter(item => item.category === 'mashups').length;
    document.getElementById('statTextures').textContent = itemsData.filter(item => item.category === 'textures').length;
    document.getElementById('statSkins').textContent = itemsData.filter(item => item.category === 'skins').length;
    document.getElementById('statFavourites').textContent = loadFavourites().size;
    const uniqueCreators = new Set(itemsData.filter(item => item.creator).map(item => item.creator));
    document.getElementById('statCreators').textContent = uniqueCreators.size;
  }

  function isValidMarketplaceLink(url) {
    if (!url || typeof url !== 'string') return false;
    const trimmed = url.trim();
    if (!trimmed) return false;

    const lower = trimmed.toLowerCase();
    if (!/^https?:\/\//i.test(trimmed)) return false;
    if (!lower.includes('minecraft.net')) return false;

    const hasMarketplacePath = lower.includes('/marketplace') || lower.includes('/pdp') || lower.includes('/product');
    const hasUuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(trimmed);
    return hasMarketplacePath || hasUuid;
  }

  document.addEventListener('click', event => {
    const itemElement = event.target.closest('.item');
    if (itemElement && !event.target.closest('.download-count')) {
      openItemModal(itemElement.dataset.uuid);
    }
  });

  function renderExternalLinks() {
    const socialContainer = document.getElementById('settingsSocialLinks');
    const minecraftSlot = document.getElementById('minecraftLinkSlot');
    const tutorialContainer = document.getElementById('tutorialPanelContent');

    if (socialContainer) {
      socialContainer.innerHTML = externalLinkData.social.map(link => `
        <a class="${link.className}" href="${link.href}" target="_blank" title="${link.title}">
          <i class="${link.icon}"></i>
        </a>
      `).join('');
    }

    if (minecraftSlot) {
      const minecraft = externalLinkData.minecraft;
      minecraftSlot.innerHTML = `
        <a href="${minecraft.href}" target="_blank" class="${minecraft.className}">
          <i class="${minecraft.icon}"></i><span>${minecraft.label}</span>
        </a>
      `;
    }

    if (tutorialContainer) {
      tutorialContainer.innerHTML = externalLinkData.tutorials.map(video => {
        const ytId = extractYouTubeId(video.src);
        const embedUrl = ytId ? `https://www.youtube.com/embed/${ytId}?autoplay=0&rel=0&modestbranding=1&controls=1&playsinline=1&enablejsapi=1&iv_load_policy=3` : video.src;
        return `
        <div class="tutorial-video-section">
          <h3>${video.title}</h3>
          <div class="tutorial-video-frame">
            <iframe src="${embedUrl}" title="${video.label}" loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>
          </div>
        </div>
      `;
      }).join('');
    }
  }

  function initializeModalElements() {
    overlay = document.getElementById('downloadOverlay');
    modalTitle = document.getElementById('modalTitle');
    modalType = document.getElementById('modalType');
    modalRating = document.getElementById('modalRating');
    modalRatingValue = document.getElementById('modalRatingValue');
    modalTotalRatings = document.getElementById('modalTotalRatings');
    modalDescription = document.getElementById('modalDescription');
    downloadLinks = document.getElementById('downloadLinks');
    closeModal = document.getElementById('closeModal');
    favouriteBtn = document.getElementById('favouriteBtn');
    shareBtn = document.getElementById('shareBtn');
    bottomNav = document.getElementById('bottomNav');
  }

  function updateBottomNavVisibility() {
    const themesOverlay = document.getElementById('themesOverlay');
    const navSettingsOverlay = document.getElementById('navSettingsOverlay');
    const statisticsPanel = document.getElementById('statisticsSidePanel');
    const tutorialPanel = document.getElementById('tutorialSidePanel');
    const isAnyPanelOpen = overlay?.classList.contains('active') || shareOverlayEl?.classList.contains('active') || downloadPickerOverlayEl?.classList.contains('active') || themesOverlay?.classList.contains('active') || navSettingsOverlay?.classList.contains('active') || statisticsPanel?.classList.contains('active') || tutorialPanel?.classList.contains('active');
    bottomNav?.classList.toggle('hidden', Boolean(isAnyPanelOpen));
  }

  function buildCatalogUrl(url) {
    const normalized = String(url || '').trim();
    if (!normalized) return normalized;

    try {
      const urlObject = new URL(normalized, window.location.href);
      if (!urlObject.searchParams.has('v')) {
        urlObject.searchParams.set('v', APP_VERSION);
      }
      return urlObject.toString();
    } catch (error) {
      const separator = normalized.includes('?') ? '&' : '?';
      return `${normalized}${separator}v=${APP_VERSION}`;
    }
  }

  function getCachedCatalogData() {
    try {
      const raw = localStorage.getItem(CATALOG_CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      if (Date.now() - (parsed.timestamp || 0) > CATALOG_CACHE_TTL_MS) return null;
      return {
        data: parsed.data,
        version: parsed.version || '',
        timestamp: parsed.timestamp || 0
      };
    } catch (error) {
      return null;
    }
  }

  function setCachedCatalogData(data, version = '') {
    try {
      const payload = { timestamp: Date.now(), data, version };
      localStorage.setItem(CATALOG_CACHE_KEY, JSON.stringify(payload));
      if (version) {
        localStorage.setItem(CATALOG_VERSION_KEY, version);
      } else {
        localStorage.setItem(CATALOG_VERSION_KEY, String(Date.now()));
      }
      localStorage.setItem(CATALOG_LAST_REFRESH_KEY, String(Date.now()));
    } catch (error) {
      // ignore storage failures
    }
  }

  function isBrotliCatalogUrl(candidateUrl) {
    try {
      const urlObject = new URL(String(candidateUrl), window.location.href);
      return urlObject.pathname.toLowerCase().endsWith('.br');
    } catch (error) {
      return String(candidateUrl).toLowerCase().endsWith('.br');
    }
  }

  function isGzipCatalogUrl(candidateUrl) {
    try {
      const urlObject = new URL(String(candidateUrl), window.location.href);
      return urlObject.pathname.toLowerCase().endsWith('.gzip');
    } catch (error) {
      return String(candidateUrl).toLowerCase().endsWith('.gzip');
    }
  }

  function isZstdCatalogUrl(candidateUrl) {
    try {
      const urlObject = new URL(String(candidateUrl), window.location.href);
      return urlObject.pathname.toLowerCase().endsWith('.zst') || urlObject.pathname.toLowerCase().endsWith('.zstd');
    } catch (error) {
      return String(candidateUrl).toLowerCase().endsWith('.zst') || String(candidateUrl).toLowerCase().endsWith('.zstd');
    }
  }

  async function parseCatalogPayload(response, candidateUrl) {
    const contentEncoding = (response.headers.get('content-encoding') || '').toLowerCase();
    const isBrPayload = contentEncoding.includes('br') || isBrotliCatalogUrl(candidateUrl);
    const isGzipPayload = contentEncoding.includes('gzip') || isGzipCatalogUrl(candidateUrl);
    const isZstdPayload = contentEncoding.includes('zstd') || contentEncoding.includes('zstandard') || contentEncoding.includes('x-zstd') || isZstdCatalogUrl(candidateUrl);
    const buffer = await response.arrayBuffer();

    const tryStreamDecode = async (encoding) => {
      if (typeof DecompressionStream === 'undefined') return null;
      try {
        const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream(encoding));
        const text = await new Response(stream).text();
        return text;
      } catch (error) {
        return null;
      }
    };

    if (isZstdPayload) {
      const text = await tryStreamDecode('zstd');
      if (text != null) {
        return JSON.parse(text);
      }
    }

    if (isBrPayload) {
      const text = await tryStreamDecode('br');
      if (text != null) {
        return JSON.parse(text);
      }
    }

    if (isGzipPayload) {
      const text = await tryStreamDecode('gzip');
      if (text != null) {
        return JSON.parse(text);
      }
    }

    const text = new TextDecoder('utf-8').decode(buffer);
    return JSON.parse(text);
  }

  function buildCatalogCandidates() {
    return [{ url: MARKETPLACE_API, label: 'Marketplace API' }];
  }

  async function fetchCatalogFromCandidates(options = {}) {
    const { noCache = false } = options;
    const candidates = buildCatalogCandidates();

    let lastError = null;
    for (const candidate of candidates) {
      try {
        const response = await fetch(candidate.url, { cache: noCache ? 'no-store' : 'default', headers: API_PATH_HEADERS });
        if (!response.ok) {
          throw new Error(`Failed to fetch ${candidate.label}: ${response.status} ${response.statusText}`);
        }
        const parsed = await parseCatalogPayload(response, candidate.url);
        return {
          data: parsed,
          version: response.headers.get('etag') || response.headers.get('last-modified') || APP_VERSION,
          source: candidate.label
        };
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error('Failed to load catalog data');
  }

  async function loadCatalogData() {
    const cachedState = getCachedCatalogData();
    if (cachedState?.data) {
      return cachedState.data;
    }

    const remoteCatalog = await fetchCatalogFromCandidates();
    setCachedCatalogData(remoteCatalog.data, remoteCatalog.version);
    return remoteCatalog.data;
  }

  // === MARKETPLACE API LOADING (replaces database.json as the catalog source) ===

  /**
   * Fetch a single page from the marketplace API proxy.
   * Returns an array of items (24 per page).
   */
  async function fetchMarketplacePage(page) {
    const url = `${MARKETPLACE_API}?page=${page}`;
    const response = await fetch(url, { cache: 'no-store', headers: API_PATH_HEADERS });
    if (!response.ok) {
      throw new Error(`Failed To Load Page = ${page} (${response.statusText || response.status})`);
    }
    const json = await response.json();
    const items = Array.isArray(json.items) ? json.items : [];
    const totalFromApi = Number(json.totalPages || json.totalPagesCount || json.total || json.count || 0);
    if (totalFromApi > 0) {
      const computedPages = Math.ceil(totalFromApi / 24);
      MARKETPLACE_TOTAL_PAGES = computedPages > 0 ? computedPages : null;
    }
    return items;
  }

  /**
   * Fetch multiple marketplace pages in parallel.
   * Returns a flat array of items.
   */
  async function fetchMarketplacePagesParallel(pages) {
    const results = await Promise.all(
      pages.map(p => fetchMarketplacePage(p).catch(err => {
        const reason = String(err.message || '').replace(/^Marketplace API page \d+ failed:\s*/i, '');
        console.warn(reason || `Failed To Load Page = ${p}`);
        return [];
      }))
    );
    return results.flat();
  }

  /**
   * Convert a marketplace API item into the schema the UI expects.
   * The marketplace item has: id, type, title, creator, description, rating,
   * ratingCount, price, usdPrice, isFree, image, images, panoramaImage,
   * contentPieces, creationDate, worldType.
   * The UI expects: uuid, name/title, image/image_url, category, subtitle,
   * creator, description, yt_embed, panorama_url, rating, total_ratings,
   * extra_images, links, htmlIndex.
   */
  function transformMarketplaceItem(item, htmlIndex) {
    const normalizedType = normalizeMarketplaceType(item.type);
    const category = TYPE_TO_CATEGORY[normalizedType] || 'addons';
    const subtitle = TYPE_TO_SUBTITLE[normalizedType] || categoryNames[category] || 'Item';
    const result = {
      uuid: item.id,
      title: item.title || '',
      name: item.title || '',
      image: item.image || '',
      image_url: item.image || '',
      category,
      subtitle,
      creator: item.creator || '',
      description: item.description || '',
      yt_embed: item.trailer || '',
      panorama_url: item.panoramaImage || '',
      rating: item.rating != null ? Number(item.rating) : null,
      total_ratings: item.ratingCount != null ? Number(item.ratingCount) : 0,
      extra_images: Array.isArray(item.images) ? item.images : [],
      links: [],
      htmlIndex,
      _detailLoaded: false,
      _marketplace: item
    };

    // Apply cached detail data if available so ratings/popularity hydrate immediately
    // instead of waiting for the detail request to finish on a fresh visit.
    const cached = detailCache[result.uuid];
    if (cached) {
      if (cached.rating != null) result.rating = cached.rating;
      if (cached.total_ratings != null) result.total_ratings = cached.total_ratings;
      if (cached.extra_images && cached.extra_images.length > 0) result.extra_images = cached.extra_images;
      if (cached.panorama_url) result.panorama_url = cached.panorama_url;
      if (cached.yt_embed) result.yt_embed = cached.yt_embed;
      if (cached.description) result.description = cached.description;
      result._detailLoaded = true;
    }

    return result;
  }

  /**
   * Load the detail cache from localStorage. Called once at startup.
   */
  function loadDetailCache() {
    try {
      const raw = localStorage.getItem(DETAIL_CACHE_KEY);
      if (raw) {
        detailCache = JSON.parse(raw);
        if (!detailCache || typeof detailCache !== 'object') detailCache = {};
      }
    } catch (e) {
      detailCache = {};
    }
  }

  function dedupeItemsByUuid(items) {
    const unique = [];
    const seen = new Set();
    for (const item of Array.isArray(items) ? items : []) {
      const uuid = item && (item.uuid || item.id);
      if (!uuid) continue;
      const key = String(uuid).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(item);
    }
    return unique;
  }

  function applyMarketplaceDetailData(item, detail) {
    if (!item || !detail) return item;

    if (Array.isArray(detail.images) && detail.images.length > 0) {
      item.extra_images = detail.images;
    } else if (Array.isArray(detail.imageUrls) && detail.imageUrls.length > 0) {
      item.extra_images = detail.imageUrls;
    }

    if (detail.panoramaUrl) {
      item.panorama_url = detail.panoramaUrl;
    } else if (detail.panoramaImage) {
      item.panorama_url = detail.panoramaImage;
    }

    if (detail.videoUrl) {
      item.yt_embed = detail.videoUrl;
    } else if (detail.trailer) {
      item.yt_embed = detail.trailer;
    } else if (detail.youtubeUrl) {
      item.yt_embed = detail.youtubeUrl;
    }

    if (detail.rating != null) item.rating = Number(detail.rating);
    if (detail.totalRatings != null) {
      item.total_ratings = Number(detail.totalRatings);
    } else if (detail.ratingCount != null) {
      item.total_ratings = Number(detail.ratingCount);
    } else if (detail.total_ratings != null) {
      item.total_ratings = Number(detail.total_ratings);
    }

    if (detail.description) item.description = detail.description;
    item._detailLoaded = true;
    return item;
  }

  function readMarketplaceSyncFingerprint() {
    try {
      return localStorage.getItem(MARKETPLACE_SYNC_KEY) || null;
    } catch (e) {
      return null;
    }
  }

  function writeMarketplaceSyncFingerprint(fingerprint) {
    try {
      if (fingerprint) localStorage.setItem(MARKETPLACE_SYNC_KEY, String(fingerprint));
    } catch (e) {
      // ignore storage errors
    }
  }

  async function getMarketplaceUpstreamFingerprint() {
    try {
      const response = await fetch(`${MARKETPLACE_API}?page=1`, { cache: 'no-store', headers: API_PATH_HEADERS });
      if (!response.ok) return null;
      const json = await response.json();
      const items = Array.isArray(json.items) ? json.items : [];
      const total = Number(json.total || json.totalItems || items.length || 0);
      const sample = items
        .slice(0, 12)
        .map(item => String(item.id || item.uuid || item.title || ''))
        .join('|');
      return `${total}:${sample}`;
    } catch (e) {
      return null;
    }
  }

  /**
   * Save a single item's detail data to the cache + localStorage.
   * Throttled to avoid writing too frequently.
   */
  let detailCacheSaveTimer = null;
  function saveDetailToCache(uuid, item) {
    if (!uuid || !item) return;
    detailCache[uuid] = {
      rating: item.rating,
      total_ratings: item.total_ratings,
      extra_images: item.extra_images,
      panorama_url: item.panorama_url,
      yt_embed: item.yt_embed,
      description: item.description
    };
    // Throttle localStorage writes to once per 3 seconds
    if (detailCacheSaveTimer) return;
    detailCacheSaveTimer = setTimeout(() => {
      detailCacheSaveTimer = null;
      try {
        localStorage.setItem(DETAIL_CACHE_KEY, JSON.stringify(detailCache));
      } catch (e) {
        // localStorage might be full — try removing old caches to make room
        console.warn('Could not save detail cache:', e.message);
      }
    }, 3000);
  }

  /**
   * Fetch detailed item data from the marketplace API detail endpoint.
   * The listing endpoint returns empty images/panoramaImage/trailer, but the
   * detail endpoint (/api/item?id=<uuid>) returns the full data.
   *
   * After fetching, we update the item in itemsData with the real values
   * for extra_images, panorama_url, and yt_embed.
   *
   * Returns the updated item (or the original on error).
   */
  async function fetchItemDetail(item) {
    if (item._detailLoaded) return item;
    try {
      const url = `https://mcsrc.vercel.app/api/items?id=${encodeURIComponent(item.uuid)}`;
      const response = await fetch(url, { cache: 'force-cache', headers: API_PATH_HEADERS });
      if (!response.ok) {
        item._detailLoaded = true;
        return item;
      }
      const json = await response.json();
      const detail = json.item || json;
      if (detail) {
        applyMarketplaceDetailData(item, detail);
      }
      // Save to localStorage cache so sorting works on next page load
      // without needing to refetch all details
      saveDetailToCache(item.uuid, item);
    } catch (e) {
      console.warn(`Failed to fetch detail for ${item.uuid}:`, e.message);
      item._detailLoaded = true;
    }
    return item;
  }

  /**
   * IndexedDB helpers for caching the full 36,805 items (too big for localStorage).
   * IndexedDB has a much larger quota (50MB+ vs 5-10MB for localStorage).
   */
  function idbOpen() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) { reject(new Error('IndexedDB not supported')); return; }
      const req = indexedDB.open(MARKETPLACE_IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(MARKETPLACE_IDB_STORE)) {
          db.createObjectStore(MARKETPLACE_IDB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbGet(key) {
    try {
      const db = await idbOpen();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(MARKETPLACE_IDB_STORE, 'readonly');
        const store = tx.objectStore(MARKETPLACE_IDB_STORE);
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    } catch (e) { return null; }
  }

  async function idbSet(key, value) {
    try {
      const db = await idbOpen();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(MARKETPLACE_IDB_STORE, 'readwrite');
        const store = tx.objectStore(MARKETPLACE_IDB_STORE);
        store.put(value, key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) { return false; }
  }

  async function idbDelete(key) {
    try {
      const db = await idbOpen();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(MARKETPLACE_IDB_STORE, 'readwrite');
        const store = tx.objectStore(MARKETPLACE_IDB_STORE);
        const req = store.delete(key);
        req.onsuccess = () => resolve(true);
        req.onerror = () => reject(req.error);
      });
    } catch (e) { return false; }
  }

  function getMarketplaceTotalPages() {
    return Number.isFinite(MARKETPLACE_TOTAL_PAGES) && MARKETPLACE_TOTAL_PAGES > 0 ? MARKETPLACE_TOTAL_PAGES : 0;
  }

  /**
   * Load all marketplace items with caching.
   * Stops when the live API reports no more pages instead of relying on a
   * hardcoded page count.
   */
  // Global progress tracker for background loading — read by the settings panel
  // indicator and the loader UI.
  let loadProgress = { done: 0, total: getMarketplaceTotalPages(), itemsLoaded: 0, complete: false };
  let marketplaceLocalStorageDisabled = false;

  // Avoid trusting an old partial catalog cache. Earlier interrupted loads can
  // leave a truncated item list in IndexedDB/localStorage and make the UI show
  // a misleading count like 13,056 instead of the full 30k+ catalog.
  const MIN_VALID_CACHE_ITEMS = 20000;
  let marketplaceCacheWrite = Promise.resolve();

  function saveMarketplaceCacheData(items, done, complete, sourceFingerprint = null) {
    const uniqueItems = dedupeItemsByUuid(items);
    const cacheData = {
      items: uniqueItems,
      done,
      total: getMarketplaceTotalPages(),
      complete: Boolean(complete),
      at: Date.now(),
      sourceFingerprint: sourceFingerprint || readMarketplaceSyncFingerprint()
    };

    marketplaceCacheWrite = marketplaceCacheWrite
      .then(() => idbSet(MARKETPLACE_IDB_KEY, cacheData))
      .then(ok => {
        if (ok) {
          console.log(`Saved Cache: ${uniqueItems.length} Items, Complete = ${complete ? 'True' : 'False'}`);
        }
      })
      .catch(() => {});

    if (marketplaceLocalStorageDisabled) return;

    try {
      const cacheString = JSON.stringify(cacheData);
      const MAX_LOCAL_CACHE_BYTES = 4 * 1024 * 1024;
      if (cacheString.length > MAX_LOCAL_CACHE_BYTES) {
        marketplaceLocalStorageDisabled = true;
        return;
      }
      localStorage.setItem(MARKETPLACE_CACHE_KEY, cacheString);
    } catch (e) {
      marketplaceLocalStorageDisabled = true;
      try { localStorage.removeItem(MARKETPLACE_CACHE_KEY); } catch (e2) { /* ignore */ }
    }
  }

  async function restoreSavedMarketplaceProgress() {
    let cached = null;
    try {
      const cachedText = localStorage.getItem(MARKETPLACE_CACHE_KEY);
      if (cachedText) cached = JSON.parse(cachedText);
    } catch (e) { /* continue with IndexedDB */ }

    if (!cached || !Array.isArray(cached.items) || !Number.isFinite(Number(cached.total)) || Number(cached.total) <= 0) {
      cached = await idbGet(MARKETPLACE_IDB_KEY);
    }
    if (!cached || !Array.isArray(cached.items) || !cached.at) return;
    if (Date.now() - cached.at >= MARKETPLACE_CACHE_TTL_MS) return;

    const done = Number(cached.done);
    const total = Number(cached.total);
    if (!Number.isFinite(done) || done <= 0 || !Number.isFinite(total) || total <= 0) return;

    MARKETPLACE_TOTAL_PAGES = total;
    loadProgress.done = done;
    loadProgress.total = total;
    loadProgress.itemsLoaded = cached.items.length;
    loadProgress.complete = Boolean(cached.complete);
    const pct = Math.min(100, Math.round((done / total) * 100));
    setLoaderMainText(loadProgress.complete ? 'Loaded' : `Loading ${pct}%`);
    setLoaderHelperText(loadProgress.complete ? '' : 'Fetching Data');
    updateLoadProgressIndicator();
  }

  async function loadMarketplaceItems(onProgress, onBatch) {
    const upstreamFingerprint = await getMarketplaceUpstreamFingerprint();
    const lastKnownFingerprint = readMarketplaceSyncFingerprint();
    const hasCatalogChanged = Boolean(upstreamFingerprint) && lastKnownFingerprint !== upstreamFingerprint;
    const shouldUseCachedCatalog = !hasCatalogChanged && lastKnownFingerprint;

    let resumedItems = null;
    let resumedDone = 0;

    if (shouldUseCachedCatalog) {
      try {
        const cached = await idbGet(MARKETPLACE_IDB_KEY);
        if (cached && Array.isArray(cached.items) && cached.at && Date.now() - cached.at < MARKETPLACE_CACHE_TTL_MS) {
          if (cached.complete && cached.items.length >= MIN_VALID_CACHE_ITEMS) {
            console.log(`Using IndexedDB Cached: ${cached.items.length} Items`);
            loadProgress.done = getMarketplaceTotalPages();
            loadProgress.total = getMarketplaceTotalPages();
            loadProgress.itemsLoaded = cached.items.length;
            loadProgress.complete = true;
            if (typeof onProgress === 'function') onProgress(loadProgress.done, loadProgress.total);
            if (typeof onBatch === 'function') onBatch(dedupeItemsByUuid(cached.items), loadProgress);
            return dedupeItemsByUuid(cached.items);
          }

          if (cached.done && cached.items.length > 0) {
            console.log(`Resuming Cache: ${cached.items.length} Items`);
            resumedItems = dedupeItemsByUuid(cached.items);
            resumedDone = Math.min(Number(cached.done), getMarketplaceTotalPages() || Number.MAX_SAFE_INTEGER);
          } else if (cached.items && cached.items.length < MIN_VALID_CACHE_ITEMS) {
            await idbDelete(MARKETPLACE_IDB_KEY);
          }
        }
      } catch (e) { /* fall through to localStorage */ }

      try {
        const cachedText = localStorage.getItem(MARKETPLACE_CACHE_KEY);
        if (cachedText) {
          const parsed = JSON.parse(cachedText);
          if (parsed && Array.isArray(parsed.items) && parsed.at && Date.now() - parsed.at < MARKETPLACE_CACHE_TTL_MS) {
            if (parsed.complete && parsed.items.length >= MIN_VALID_CACHE_ITEMS) {
              console.log(`Using IndexedDB Cached: ${parsed.items.length} Items`);
              loadProgress.done = getMarketplaceTotalPages();
              loadProgress.total = getMarketplaceTotalPages();
              loadProgress.itemsLoaded = parsed.items.length;
              loadProgress.complete = true;
              if (typeof onProgress === 'function') onProgress(loadProgress.done, loadProgress.total);
              if (typeof onBatch === 'function') onBatch(dedupeItemsByUuid(parsed.items), loadProgress);
              return dedupeItemsByUuid(parsed.items);
            }

            if (parsed.done && parsed.items.length > 0 && !resumedItems) {
              console.log(`Resuming from partial cached marketplace data: ${parsed.items.length} items, page ${parsed.done}`);
              resumedItems = dedupeItemsByUuid(parsed.items);
              resumedDone = Math.min(Number(parsed.done), getMarketplaceTotalPages() || Number.MAX_SAFE_INTEGER);
            } else if (parsed.items && parsed.items.length < MIN_VALID_CACHE_ITEMS) {
              localStorage.removeItem(MARKETPLACE_CACHE_KEY);
            }
          }
        }
      } catch (e) { /* ignore */ }
    }

    if (upstreamFingerprint) {
      writeMarketplaceSyncFingerprint(upstreamFingerprint);
    }

    let allItems = [];
    let transformed = [];
    let startPage = 1;

    if (resumedItems && resumedItems.length > 0 && resumedDone > 0) {
      allItems = dedupeItemsByUuid(resumedItems);
      transformed = dedupeItemsByUuid(resumedItems);
      startPage = resumedDone + 1;
      loadProgress.done = resumedDone;
      loadProgress.total = getMarketplaceTotalPages();
      loadProgress.itemsLoaded = transformed.length;
      loadProgress.complete = false;
      if (typeof onProgress === 'function') onProgress(loadProgress.done, loadProgress.total);
      if (typeof onBatch === 'function') onBatch(transformed, loadProgress);
    } else {
      // === PHASE 1: Fetch first 10 pages (240 items) and render immediately ===
      loadProgress.done = 0;
      loadProgress.total = getMarketplaceTotalPages();
      loadProgress.itemsLoaded = 0;
      loadProgress.complete = false;
      if (typeof onProgress === 'function') onProgress(0, loadProgress.total || 0);

      const initialPageCount = 1;
      const initialPages = Array.from({ length: initialPageCount }, (_, i) => i + 1);
      const initialItems = dedupeItemsByUuid(await fetchMarketplacePagesParallel(initialPages));
      allItems = [...initialItems];
      transformed = initialItems.map((item, i) => transformMarketplaceItem(item, i));
      loadProgress.done = initialPageCount;
      loadProgress.itemsLoaded = transformed.length;
      loadProgress.total = getMarketplaceTotalPages();
      if (typeof onProgress === 'function') onProgress(initialPageCount, loadProgress.total || initialPageCount);
      if (typeof onBatch === 'function') onBatch(transformed, loadProgress);
      saveMarketplaceCacheData(transformed, loadProgress.done, false, upstreamFingerprint);
      startPage = initialPageCount + 1;
    }

    // === PHASE 2: Fetch the remaining pages in the background until the API
    // reports no more results. This avoids hardcoded page limits.
    const batchSize = MARKETPLACE_PARALLEL_PAGES;
    let currentPage = startPage;
    let consecutiveEmptyBatches = 0;
    while (true) {
      const totalKnown = getMarketplaceTotalPages();
      const maxPage = totalKnown > 0 ? totalKnown : currentPage + batchSize - 1;
      const batchEnd = Math.min(currentPage + batchSize - 1, maxPage);
      const batch = Array.from({ length: Math.max(0, batchEnd - currentPage + 1) }, (_, i) => currentPage + i);
      if (batch.length === 0) break;

      const items = dedupeItemsByUuid(await fetchMarketplacePagesParallel(batch));
      if (!items.length) {
        consecutiveEmptyBatches += 1;
        if (consecutiveEmptyBatches >= 2 || (totalKnown > 0 && batchEnd >= totalKnown)) {
          break;
        }
        currentPage = batchEnd + 1;
        continue;
      }

      consecutiveEmptyBatches = 0;
      allItems = dedupeItemsByUuid(allItems.concat(items));
      const newTransformed = items.map((item, i) =>
        transformMarketplaceItem(item, allItems.length - items.length + i)
      );
      transformed = dedupeItemsByUuid(transformed.concat(newTransformed));
      loadProgress.done = Math.max(loadProgress.done, batchEnd);
      loadProgress.itemsLoaded = transformed.length;
      loadProgress.total = getMarketplaceTotalPages() || Math.max(loadProgress.done, transformed.length);
      if (typeof onProgress === 'function') onProgress(loadProgress.done, loadProgress.total);
      if (typeof onBatch === 'function') onBatch(transformed, loadProgress);
      saveMarketplaceCacheData(transformed, loadProgress.done, false, upstreamFingerprint);

      if (totalKnown > 0 && batchEnd >= totalKnown) break;
      currentPage = batchEnd + 1;
      if (currentPage > Number.MAX_SAFE_INTEGER / 2) break;
    }

    loadProgress.complete = true;
    loadProgress.total = getMarketplaceTotalPages() || Math.max(loadProgress.done, transformed.length);
    saveMarketplaceCacheData(transformed, loadProgress.total || loadProgress.done, true, upstreamFingerprint);
    if (typeof onProgress === 'function') onProgress(loadProgress.total || loadProgress.done, loadProgress.total || loadProgress.done);
    if (typeof onBatch === 'function') onBatch(transformed, loadProgress);
    return transformed;
  }

  /**
   * Load the public keys.json database fresh on every page load.
   * Only the live source URL is used; there is no fallback or cached copy.
   */
  async function loadDownloadDatabase() {
    if (downloadDbLoaded) return downloadDb;

    let lastError = null;

    for (let attempt = 1; attempt <= DOWNLOAD_DB_RETRY_ATTEMPTS; attempt += 1) {
      const controller = new AbortController();
      const timeoutMs = attempt * 60000; // 60s, 120s, 180s for attempts 1, 2, 3
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(DOWNLOAD_DB_URL, {
          method: 'GET',
          mode: 'cors',
          cache: 'reload',
          credentials: 'omit',
          redirect: 'follow',
          signal: controller.signal,
          headers: {
            Accept: 'application/json',
            ...API_PATH_HEADERS
          }
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        const entries = Array.isArray(data) ? data : (data.items || []);
        const map = new Map();
        for (const entry of entries) {
          if (entry && entry.uuid) {
            map.set(String(entry.uuid).toLowerCase(), entry);
          }
        }

        downloadDb = map;
        downloadDbLoaded = true;
        console.log(`Successfully Loaded: ${map.size} Keys`);
        return downloadDb;
      } catch (error) {
        lastError = error;
        const statusMatch = String(error?.message || '').match(/\bHTTP\s+(\d{3})\b/i);
        const status = error?.status || error?.response?.status || statusMatch?.[1] || 'Unknown';
        console.error(`Failed To Load Keys: ${status}`);
      } finally {
        clearTimeout(timeoutId);
      }
    }

    console.error(`Failed To Load Keys: ${DOWNLOAD_DB_RETRY_ATTEMPTS} Attempts`);
    downloadDb = new Map();
    downloadDbLoaded = true;
    throw lastError || new Error('Failed To Load Keys: Unknown');
  }

  async function refreshCatalogDataIfNeeded() {
    try {
      const cachedState = getCachedCatalogData();
      const lastRefreshTimestamp = Number(localStorage.getItem(CATALOG_LAST_REFRESH_KEY) || 0);
      if (cachedState && Date.now() - lastRefreshTimestamp < CATALOG_REFRESH_TTL_MS) {
        return null;
      }

      const remoteCatalog = await fetchCatalogFromCandidates({ noCache: true });
      const cachedVersion = cachedState?.version || localStorage.getItem(CATALOG_VERSION_KEY) || '';
      const remoteVersion = remoteCatalog.version || APP_VERSION;

      if (remoteVersion !== cachedVersion) {
        setCachedCatalogData(remoteCatalog.data, remoteVersion);
        return remoteCatalog.data;
      }

      localStorage.setItem(CATALOG_LAST_REFRESH_KEY, String(Date.now()));
      return null;
    } catch (error) {
      return null;
    }
  }

  document.addEventListener('DOMContentLoaded', async () => {
    scheduleInitialLoaderSequence();
    initializeModalElements();
    renderExternalLinks();
    loadDetailCache(); // load cached ratings/images from localStorage
    initSliderElements();
    createStars();

    let dataLoaded = false;
    let loadError = null;

    try {
      // Restore the last saved percentage before waiting on other requests.
      await restoreSavedMarketplaceProgress();
      if (!loadProgress.done) {
        setLoaderMainText('Loading');
        setLoaderHelperText('Fetching Data');
      }

      // Load the public keys.json database before the marketplace data so item
      // download links resolve correctly and do not fall back to the request flow.
      await loadDownloadDatabase().catch(err => {
        console.warn('Download database failed to load (non-fatal):', err);
      });

      // Load marketplace items in the BACKGROUND.
      // The onBatch callback fires after each batch of pages is fetched.
      // We do NOT await the full load — that would block the event loop and
      // freeze the UI (modal clicks, etc.) until all 1,534 pages are fetched.
      // Instead we kick it off and let it run in the background.
      let firstBatchRendered = false;
      // Track the current render token so background batches don't trigger
      // re-renders that would interrupt the user (flicker / modal freeze).
      let backgroundLoadDone = false;
      // Track whether we've processed the initial route (deep link from URL).
      // We defer this until after the first batch of items loads, otherwise
      // findItemByRouteParts/findCreatorNameBySlug search an empty itemsData.
      let initialRouteProcessed = false;

      const processHashRouteIfNeeded = () => {
        const path = getEffectiveRoutePath();
        const isHashRoute = window.location.hash.startsWith('#f2p') || window.location.hash.startsWith('#/');
        if (!isHashRoute || initialRouteProcessed) return;

        const routeSegments = String(path || '/').split('/').filter(Boolean);
        const isItemRoute = routeSegments.length >= 3;
        if (isItemRoute && !findItemByRouteParts(
          getCategoryFromPathSegment(routeSegments[0]),
          routeSegments[1],
          routeSegments[2]
        )) {
          return;
        }

        initialRouteProcessed = true;
        processRoutePath(path, true);
      };

      loadMarketplaceItems(
        (done, total) => {
          // onProgress — update the loader text and the global loadProgress
          const pct = total > 0 ? Math.round((done / total) * 100) : 0;
          if (!firstBatchRendered) {
            setLoaderMainText(`Loading ${pct}%`);
            if (done === 0) {
              setLoaderHelperText(`Fetching Data`);
            } else if (done < total) {
              setLoaderHelperText(`Fetching Data`);
            }
          }
          updateLoadProgressIndicator();
        },
        (allItemsSoFar, progress) => {
          // onBatch — called after each batch of pages is fetched.
          // CRITICAL: Update itemsData here so getBaseItems() and renderItems()
          // can see the items.
          itemsData = allItemsSoFar;
          processHashRouteIfNeeded();

          if (!firstBatchRendered && allItemsSoFar.length > 0) {
            // FIRST BATCH — render and hide loader.
            firstBatchRendered = true;
            loadDownloadCounts();
            buildShareCodeIndex();
            Promise.allSettled(allItemsSoFar.slice(0, 12).map(item => !item._detailLoaded ? fetchItemDetail(item) : Promise.resolve(item)))
              .catch(() => {});
            allFilteredSortedItems = getBaseItems();
            renderItems();
            updateCategoryCount();
            setupInfiniteScroll();
            dataLoaded = true;
            markInitialLoaderReady();
            // Process the initial route NOW that itemsData is populated.
            // This handles deep links like #f2p/skins/teplight/shadow-guardian
            // (opens item modal) and #f2p/endorah (filters by creator).
            processHashRouteIfNeeded();
          } else if (firstBatchRendered && !backgroundLoadDone) {
            // SUBSEQUENT BATCHES — update itemsData silently.
            // Do NOT call renderItems() here — that would clear the container
            // and re-render from scratch, causing:
            //   1. Flickering on every batch
            //   2. Modal freeze (re-render blocks the main thread)
            // Instead, just update allFilteredSortedItems so infinite scroll
            // picks up the new items naturally as the user scrolls.
            // The category count is updated text-only (no DOM rebuild).
            allFilteredSortedItems = getBaseItems();
            updateCategoryCount();
            // Update hasMoreItems so infinite scroll knows there's more to load
            appendAvailableItems();
          }
          updateLoadProgressIndicator();

          // When background loading is complete, do ONE final re-render
          // (only if the user hasn't scrolled deep into the list).
          if (progress.complete) {
            backgroundLoadDone = true;
            allFilteredSortedItems = getBaseItems();
            updateCategoryCount();
            // Append newly available cards without clearing the list or changing
            // the user's scroll position.
            appendAvailableItems();
            // Pre-fetch details for any visible cards that don't have them yet
            setTimeout(fetchDetailsForVisibleCards, 200);
          }
        }
      ).catch(err => {
        console.error('Marketplace loading failed:', err);
        if (!firstBatchRendered) {
          const container = document.getElementById('itemContainer');
          if (container) container.innerHTML = '<div class="no-items">Unable to load Data</div>';
          markInitialLoaderReady();
        }
      });

      // If we hit the cache path (onBatch never fires), render immediately.
      // loadMarketplaceItems returns the full array synchronously when cached.
      // We detect this by checking after a microtask if firstBatchRendered is still false.
      // This must also process the deep-link route so URLs like #f2p/skins/... still open.
      if (!initialRouteProcessed && itemsData.length > 0) {
        processHashRouteIfNeeded();
      }

      const hash = getHashFromUrl();
      if (hash) {
        const searchInput = document.getElementById('searchInput');
        if (searchInput) {
          searchInput.value = hash;
          searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }

      if (window.location.hash.startsWith('#f2p/') || window.location.hash === '#f2p') {
        useHashRouting = true;
      } else if (window.location.hash.startsWith('#/')) {
        useHashRouting = true;
        window.location.replace('/#f2p' + window.location.hash.slice(1));
        return;
      } else if (window.location.pathname !== '/' && window.location.pathname !== '/index.html') {
        useHashRouting = true;
        window.location.replace('/#f2p' + window.location.pathname + window.location.search + window.location.hash);
        return;
      }

      creatorExitBtn = document.getElementById('creatorExitBtn');
      creatorExitBtn?.addEventListener('click', () => {
        currentCreatorFilter = null;
        currentCategory = 'all';
        setContentRoute('all', null);
        document.querySelectorAll('.category-buttons button').forEach(btn => btn.classList.toggle('active', btn.dataset.filter === 'all'));
        allFilteredSortedItems = getBaseItems();
        renderItems();
        updateCategoryCount();
        updateSortUI();
        updateSortIndicator();
        saveCurrentSort();
        updateBrowserPath('/');
        updateCreatorExitButton();
      });

      const logo = document.getElementById('logo');
      logo?.addEventListener('click', () => window.location.reload());
      logo?.classList.add('logo-animate-in');
      startLogoCycle();
      loadThemePreferences();
      updateToggleLabelStates();
      updateModalViewVisibility();
      // NOTE: processRoutePath is now deferred until after the first batch
      // of items loads (see the onBatch callback above). Calling it here
      // would search an empty itemsData and fail to open item modals or
      // filter by creator from deep links.
      document.getElementById('themeShowCount')?.addEventListener('change', event => {
        themePreferences.showCount = event.target.checked;
        saveThemePreferences();
        updateCategoryCount();
      });
      document.getElementById('themeShowType')?.addEventListener('change', event => {
        themePreferences.showType = event.target.checked;
        saveThemePreferences();
        updateCategoryCount();
      });
      document.getElementById('themeShowSortBadge')?.addEventListener('change', event => {
        themePreferences.showSortBadge = event.target.checked;
        saveThemePreferences();
        updateSortIndicator();
      });
      document.getElementById('themeShowModalTitle')?.addEventListener('change', event => {
        themePreferences.showModalTitle = event.target.checked;
        saveThemePreferences();
        updateModalViewVisibility();
      });
      document.getElementById('themeShowModalDescription')?.addEventListener('change', event => {
        themePreferences.showModalDescription = event.target.checked;
        saveThemePreferences();
        updateModalViewVisibility();
      });
      document.getElementById('themeShowModalType')?.addEventListener('change', event => {
        themePreferences.showModalType = event.target.checked;
        saveThemePreferences();
        updateModalViewVisibility();
      });
      document.getElementById('themeShowModalCreator')?.addEventListener('change', event => {
        themePreferences.showModalCreator = event.target.checked;
        saveThemePreferences();
        updateModalViewVisibility();
      });
      document.getElementById('themeShowModalRating')?.addEventListener('change', event => {
        themePreferences.showModalRating = event.target.checked;
        saveThemePreferences();
        updateModalViewVisibility();
      });
      document.getElementById('themeShowModalPopularity')?.addEventListener('change', event => {
        themePreferences.showModalPopularity = event.target.checked;
        saveThemePreferences();
        updateModalViewVisibility();
      });
      document.getElementById('themeShowModalImage')?.addEventListener('change', event => {
        themePreferences.showModalImage = event.target.checked;
        saveThemePreferences();
        updateModalViewVisibility();
      });
      document.getElementById('themeShowModalFavourite')?.addEventListener('change', event => {
        themePreferences.showModalFavourite = event.target.checked;
        saveThemePreferences();
        updateModalViewVisibility();
      });
      document.getElementById('themeShowModalShare')?.addEventListener('change', event => {
        themePreferences.showModalShare = event.target.checked;
        saveThemePreferences();
        updateModalViewVisibility();
      });
      document.getElementById('themeShowDownloadPrefix')?.addEventListener('change', event => {
        themePreferences.showDownloadPrefix = event.target.checked;
        saveThemePreferences();
      });
      ['themeBgColor','themeTitleColor','themeIconsColor','themeCardTitleColor','themeCardTypeColor','themeCardCreatorColor','themeCardRatingsColor','themeCardPopularityColor','themeCardDescColor','themeCardIconsColor','themeModalTitleColor','themeModalTypeColor','themeModalDescColor','themeModalIconsColor','themeModalCreatorColor','themeModalDownloadColor','themeModalRatingsColor','themeModalPopularityColor'].forEach(id => {
        const input = document.getElementById(id);
        if (input) {
          input.addEventListener('input', () => {
            saveThemePreferences();
          });
        }
      });
      document.querySelectorAll('.toggle-label input[type="checkbox"]').forEach(input => {
        input.addEventListener('change', () => {
          const label = input.closest('.toggle-label');
          if (label) {
            label.classList.toggle('active', input.checked);
          }
        });
      });
      // Ensure all toggle labels reflect current checked state on load
      document.querySelectorAll('.toggle-label input[type="checkbox"]').forEach(input => {
        const label = input.closest('.toggle-label');
        if (label) {
          label.classList.toggle('active', input.checked);
        }
      });
      document.getElementById('themeShowCardTitle')?.addEventListener('change', event => {
        setCardPreference('showTitle', event.target.checked);
        saveThemePreferences();
        renderItems();
      });
      document.getElementById('themeShowCardType')?.addEventListener('change', event => {
        setCardPreference('showType', event.target.checked);
        saveThemePreferences();
        renderItems();
      });
      document.getElementById('themeShowCardCreator')?.addEventListener('change', event => {
        setCardPreference('showCreator', event.target.checked);
        saveThemePreferences();
        renderItems();
      });
      document.getElementById('themeShowCardRating')?.addEventListener('change', event => {
        setCardPreference('showRating', event.target.checked);
        saveThemePreferences();
        renderItems();
      });
      document.getElementById('themeShowCardTotalRatings')?.addEventListener('change', event => {
        setCardPreference('showTotalRatings', event.target.checked);
        saveThemePreferences();
        renderItems();
      });
      document.getElementById('themeShowCardImage')?.addEventListener('change', event => {
        setCardPreference('showImage', event.target.checked);
        saveThemePreferences();
        renderItems();
      });
      document.querySelectorAll('.style-select-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          setActiveCardStyle(btn.dataset.cardStyle);
          saveThemePreferences();
        });
      });

      document.getElementById('applyCardStyleBtn')?.addEventListener('click', () => {
        saveThemePreferences();
      });

      document.getElementById('resetCardStyleBtn')?.addEventListener('click', () => {
        currentCardStyle = 'style1';
        cardStylePreferences = {
          style1: { showTitle: true, showType: true, showCreator: true, showRating: true, showTotalRatings: true, showImage: true },
          style2: { showTitle: true, showType: true, showCreator: true, showRating: true, showTotalRatings: true, showImage: true },
          style3: { showTitle: true, showType: true, showCreator: true, showRating: true, showTotalRatings: true, showImage: true },
          style4: { showTitle: true, showType: true, showCreator: true, showRating: true, showTotalRatings: true, showImage: true }
        };
        // Reset card colors to defaults
        document.getElementById('themeCardTitleColor').value = '#ffffff';
        document.getElementById('themeCardTypeColor').value = '#cccccc';
        document.getElementById('themeCardCreatorColor').value = '#cccccc';
        document.getElementById('themeCardRatingsColor').value = '#ffffff';
        document.getElementById('themeCardPopularityColor').value = '#ffffff';
        // Update theme preferences
        themePreferences.cardTitleColor = '#ffffff';
        themePreferences.cardTypeColor = '#cccccc';
        themePreferences.cardCreatorColor = '#cccccc';
        themePreferences.cardRatingsColor = '#ffffff';
        themePreferences.cardPopularityColor = '#ffffff';
        // Update CSS variables
        const root = document.documentElement;
        root.style.setProperty('--card-title-color', '#ffffff');
        root.style.setProperty('--card-type-color', '#cccccc');
        root.style.setProperty('--card-creator-color', '#cccccc');
        root.style.setProperty('--card-ratings-color', '#ffffff');
        root.style.setProperty('--card-popularity-color', '#ffffff');
        updateCardStylePanelInputs();
        renderItems();
        saveThemePreferences();
      });

      document.getElementById('applyModalViewBtn')?.addEventListener('click', () => {
        saveThemePreferences();
      });

      document.getElementById('resetModalViewBtn')?.addEventListener('click', () => {
        const defaultModalSettings = {
          themeShowModalTitle: true,
          themeShowModalDescription: true,
          themeShowModalType: true,
          themeShowModalCreator: true,
          themeShowModalRating: true,
          themeShowModalPopularity: true,
          themeShowModalImage: true,
          themeShowModalFavourite: true,
          themeShowModalShare: true,
          themeShowDownloadPrefix: true
        };
        Object.entries(defaultModalSettings).forEach(([id, value]) => {
          const input = document.getElementById(id);
          if (input) input.checked = value;
        });

        themePreferences.showModalTitle = true;
        themePreferences.showModalDescription = true;
        themePreferences.showModalType = true;
        themePreferences.showModalCreator = true;
        themePreferences.showModalRating = true;
        themePreferences.showModalPopularity = true;
        themePreferences.showModalImage = true;
        themePreferences.showModalFavourite = true;
        themePreferences.showModalShare = true;
        themePreferences.showDownloadPrefix = true;

        // Reset modal color inputs to defaults
        document.getElementById('themeModalTitleColor').value = '#ffffff';
        document.getElementById('themeModalTypeColor').value = '#6495ed';
        document.getElementById('themeModalIconsColor').value = '#ffffff';
        document.getElementById('themeModalDescColor').value = '#dddddd';
        document.getElementById('themeModalCreatorColor').value = '#6495ed';
        document.getElementById('themeModalDownloadColor').value = '#ffffff';
        document.getElementById('themeModalRatingsColor').value = '#f5d76e';
        document.getElementById('themeModalPopularityColor').value = '#f5d76e';

        themePreferences.modalTitleColor = '#ffffff';
        themePreferences.modalTypeColor = '#6495ed';
        themePreferences.modalIconsColor = '#ffffff';
        themePreferences.modalDescColor = '#dddddd';
        themePreferences.modalCreatorColor = '#6495ed';
        themePreferences.modalDownloadColor = '#ffffff';
        themePreferences.modalRatingsColor = '#f5d76e';
        themePreferences.modalPopularityColor = '#f5d76e';

        updateToggleLabelStates();
        updateModalViewVisibility();
        saveThemePreferences();
      });

      const tutorialPanel = document.getElementById('tutorialSidePanel');
      const statisticsPanel = document.getElementById('statisticsSidePanel');
      const themesOverlay = document.getElementById('themesOverlay');
      const closeTutorialBtn = document.getElementById('closeTutorialBtn');
      const closeStatisticsBtn = document.getElementById('closeStatisticsBtn');
      const navSettingsOverlay = document.getElementById('navSettingsOverlay');
      const closeNavSettings = document.getElementById('closeNavSettings');

      function closeAllSidePanels() {
        const bottomSettingsBtn = document.getElementById('bottomSettingsBtn');
        const bottomHomeBtn = document.getElementById('bottomHomeBtn');

        tutorialPanel?.classList.remove('active');
        statisticsPanel?.classList.remove('active');
        document.getElementById('themesPanel')?.classList.remove('active');
        document.getElementById('cardStylePanel')?.classList.remove('active');
        document.getElementById('modalViewPanel')?.classList.remove('active');
        themesOverlay?.classList.remove('active');
        navSettingsOverlay?.classList.remove('active');
        document.body.style.overflow = '';

        if (bottomSettingsBtn?.classList.contains('active')) {
          document.querySelectorAll('.bottom-nav-btn').forEach(btn => btn.classList.remove('active'));
          bottomHomeBtn?.classList.add('active');
        }

        updateBottomNavVisibility();
      }

      function openSidePanel(panel) {
        closeAllSidePanels();
        if (!themesOverlay) return;
        themesOverlay.classList.add('active');
        document.body.style.overflow = 'hidden';
        if (panel === 'tutorial') tutorialPanel?.classList.add('active');
        if (panel === 'statistics') statisticsPanel?.classList.add('active');
        updateBottomNavVisibility();
      }

      document.getElementById('openThemesBtn')?.addEventListener('click', () => {
        closeAllSidePanels();
        document.getElementById('themesPanel')?.classList.add('active');
        document.getElementById('themesOverlay')?.classList.add('active');
        document.body.style.overflow = 'hidden';
        updateBottomNavVisibility();
      });
      document.getElementById('openCardViewBtn')?.addEventListener('click', () => {
        closeAllSidePanels();
        document.getElementById('cardStylePanel')?.classList.add('active');
        document.getElementById('themesOverlay')?.classList.add('active');
        document.body.style.overflow = 'hidden';
        updateCardStylePanelInputs();
        document.getElementById('themeShowCardTitle')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        updateBottomNavVisibility();
      });
      document.getElementById('openModalViewBtn')?.addEventListener('click', () => {
        closeAllSidePanels();
        document.getElementById('themesOverlay')?.classList.add('active');
        document.getElementById('modalViewPanel')?.classList.add('active');
        document.body.style.overflow = 'hidden';
        updateBottomNavVisibility();
      });
      document.getElementById('closeModalViewBtn')?.addEventListener('click', closeAllSidePanels);
      document.getElementById('openTutorialBtn')?.addEventListener('click', () => {
        closeAllSidePanels();
        openSidePanel('tutorial');
      });
      document.getElementById('openStatsBtn')?.addEventListener('click', () => {
        closeAllSidePanels();
        openSidePanel('statistics');
        updateStatistics?.();
      });

      closeNavSettings?.addEventListener('click', closeAllSidePanels);
      closeTutorialBtn?.addEventListener('click', closeAllSidePanels);
      closeStatisticsBtn?.addEventListener('click', closeAllSidePanels);
      document.getElementById('closeCardStyleBtn')?.addEventListener('click', closeAllSidePanels);
      themesOverlay?.addEventListener('click', closeAllSidePanels);
      navSettingsOverlay?.addEventListener('click', event => {
        if (event.target === navSettingsOverlay) closeAllSidePanels();
      });
    } catch (err) {
      loadError = err;
      console.error('Failed to load data.json', err);
      const container = document.getElementById('itemContainer');
      if (container) {
        container.innerHTML = '<div class="no-items">Unable to load Data</div>';
      }
    } finally {
      if (dataLoaded) {
        setTimeout(() => markInitialLoaderReady(), 900);
      } else {
        setTimeout(() => markInitialLoaderReady(), 1800);
      }
    }

    const searchInputEl = document.getElementById('searchInput');
    const searchBtn = document.getElementById('searchBtn');
    const requestButton = document.getElementById('requestButton');
    const placeholderOptions = ['Welcome', 'Search', 'Request', 'Name', 'Link', 'UUID', 'Free', 'Download', 'F2P'];
    let placeholderIndex = 0;
    let placeholderTimer = null;
    let placeholderFocused = false;
    let placeholderPhase = 'typing';
    let placeholderFrame = 0;
    let placeholderWait = 0;

    function updatePlaceholder() {
      if (!searchInputEl || placeholderFocused || searchInputEl.value.trim() !== '') return;
      const fullText = placeholderOptions[placeholderIndex];
      if (placeholderPhase === 'typing') {
        placeholderFrame += 1;
        searchInputEl.placeholder = fullText.slice(0, placeholderFrame);
        if (placeholderFrame >= fullText.length) {
          placeholderPhase = 'hold';
          placeholderWait = 6;
        }
      } else if (placeholderPhase === 'hold') {
        placeholderWait -= 1;
        if (placeholderWait <= 0) {
          placeholderPhase = 'deleting';
        }
      } else if (placeholderPhase === 'deleting') {
        placeholderFrame -= 1;
        searchInputEl.placeholder = fullText.slice(0, placeholderFrame);
        if (placeholderFrame <= 0) {
          placeholderIndex = (placeholderIndex + 1) % placeholderOptions.length;
          placeholderPhase = 'typing';
        }
      }
    }

    function startPlaceholderAnimation() {
      stopPlaceholderAnimation();
      placeholderPhase = 'typing';
      placeholderFrame = 0;
      placeholderIndex = 0;
      searchInputEl.placeholder = '';
      placeholderTimer = window.setInterval(updatePlaceholder, 150);
    }

    function stopPlaceholderAnimation() {
      if (placeholderTimer !== null) {
        window.clearInterval(placeholderTimer);
        placeholderTimer = null;
      }
    }

    searchInputEl?.addEventListener('input', event => {
      const value = String(event.target.value || '').toLowerCase();
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => performSearch(value), 500);
    });

    searchInputEl?.addEventListener('focus', () => {
      placeholderFocused = true;
      stopPlaceholderAnimation();
      if (searchInputEl.value.trim() === '') {
        searchInputEl.placeholder = '';
      }
    });

    searchInputEl?.addEventListener('blur', () => {
      placeholderFocused = false;
      if (searchInputEl.value.trim() === '') {
        startPlaceholderAnimation();
      }
    });

    searchInputEl?.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        performSearch(String(searchInputEl.value || '').toLowerCase());
      }
    });

    searchBtn?.addEventListener('click', () => {
      performSearch(String(searchInputEl?.value || '').toLowerCase());
    });

    requestButton?.addEventListener('click', async () => {
      const url = String(searchInputEl?.value || '').trim();
      if (!isValidMarketplaceLink(url)) {
        document.getElementById('alertOverlay')?.classList.add('active');
        return;
      }

      const limitStatus = getRequestLimitStatus();
      if (!limitStatus.allowed) {
        const retryMinutes = Math.max(1, Math.ceil((limitStatus.retryAfterMs || REQUEST_RATE_LIMIT_WINDOW_MS) / 60000));
        document.getElementById('alertOverlay')?.classList.add('active');
        console.warn(`Request limit reached. Try again in ${retryMinutes} minutes.`);
        return;
      }

      const btn = requestButton;
      const uuid = parseMarketplaceIdFromUrl(url);
      try {
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
        await submitRequestWebhook({ uuid, url });
        recordRequestSubmission();
        document.getElementById('successOverlay')?.classList.add('active');
      } catch (err) {
        console.error('Request failed', err);
        document.getElementById('alertOverlay')?.classList.add('active');
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-paper-plane"></i>';
      }
    });

    startPlaceholderAnimation();

    document.querySelectorAll('.category-buttons button').forEach(button => {
      button.addEventListener('click', () => {
        document.querySelectorAll('.category-buttons button').forEach(btn => btn.classList.remove('active'));
        button.classList.add('active');
        const selectedCategory = button.dataset.filter || 'all';
        currentCategory = selectedCategory;

        if (currentCreatorFilter) {

          allFilteredSortedItems = getFilteredSortedItems();
          renderItems();
          updateCategoryCount();
          updateBrowserPath(buildContentRoute());
          return;
        }

        setContentRoute(currentCategory, null);
        const searchInput = document.getElementById('searchInput');
        if (searchInput && searchInput.value.trim() !== '') {
          performSearch(searchInput.value.toLowerCase());
        } else {
          allFilteredSortedItems = getBaseItems();
          renderItems();
          updateCategoryCount();
        }
        updateBrowserPath(buildContentRoute());
      });
    });

    window.addEventListener('resize', positionCategoryCount);

    const settingsBtn = document.getElementById('settingsBtn');
    const sortDropdown = document.getElementById('sortDropdown');
    const bottomHomeBtn = document.getElementById('bottomHomeBtn');
    const bottomModsBtn = document.getElementById('bottomModsBtn');
    const bottomSettingsBtn = document.getElementById('bottomSettingsBtn');

    modalType?.addEventListener('click', event => {
      const meta = event.target.closest('.clickable-meta');
      if (!meta) return;
      const metaType = meta.dataset.metaType;

      if (metaType === 'type') {
        const filterValue = String(meta.textContent || '').toLowerCase().trim();
        const typeMap = {
          world: 'worlds',
          worlds: 'worlds',
          addon: 'addons',
          addons: 'addons',
          'add-on': 'addons',
          mashup: 'mashups',
          mashups: 'mashups',
          texture: 'textures',
          textures: 'textures',
          skin: 'skins',
          skins: 'skins'
        };
        const category = typeMap[filterValue] || 'all';
        currentCategory = category;
        document.querySelectorAll('.category-buttons button').forEach(btn => btn.classList.toggle('active', btn.dataset.filter === category));
        allFilteredSortedItems = getBaseItems();
        renderItems();
        updateCategoryCount();
        closeOverlay();
      } else if (metaType === 'creator') {
        const creatorName = String(meta.textContent || '').trim();
        applyCreatorFilter(creatorName);
        closeOverlay();
      }
    });

    settingsBtn?.addEventListener('click', event => {
      event.stopPropagation();
      settingsBtn.classList.toggle('active');
      sortDropdown?.classList.toggle('active');
    });

    bottomHomeBtn?.addEventListener('click', () => {
      document.querySelectorAll('.bottom-nav-btn').forEach(btn => btn.classList.remove('active'));
      bottomHomeBtn.classList.add('active');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    bottomModsBtn?.addEventListener('click', () => {
      document.querySelectorAll('.bottom-nav-btn').forEach(btn => btn.classList.remove('active'));
      bottomModsBtn.classList.add('active');
      window.open('https://www.youtube.com/@Vultir', '_blank', 'noopener noreferrer');
    });

    bottomSettingsBtn?.addEventListener('click', () => {
      document.querySelectorAll('.bottom-nav-btn').forEach(btn => btn.classList.remove('active'));
      bottomSettingsBtn.classList.add('active');
      closeAllSidePanels();
      document.getElementById('navSettingsOverlay')?.classList.add('active');
      document.body.style.overflow = 'hidden';
      updateBottomNavVisibility();
    });

    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') closeAllSidePanels();
    });

    document.querySelectorAll('.sort-option').forEach(option => {
      option.addEventListener('click', () => {
        const selectedSort = option.dataset.sort || 'default';
        sortDropdown?.classList.remove('active');
        settingsBtn?.classList.remove('active');

        if (selectedSort === 'default') {
          currentSort = 'default';
          currentCreatorFilter = null;
          applySort();
          closeSortControls();
          return;
        }

        openSortModal(selectedSort);
      });
    });

    document.getElementById('closeSortModal')?.addEventListener('click', closeSortControls);
    document.getElementById('sortOverlay')?.addEventListener('click', event => {
      if (event.target === document.getElementById('sortOverlay')) {
        closeSortControls();
      }
    });

    document.querySelectorAll('.font-style-btn').forEach(button => {
      button.addEventListener('click', () => {
        document.querySelectorAll('.font-style-btn').forEach(btn => btn.classList.remove('active'));
        button.classList.add('active');
        // Keep themePreferences in sync with UI selection
        if (typeof themePreferences === 'object') {
          themePreferences.fontStyle = button.dataset.fontStyle;
        }
      });
    });

document.getElementById('themesOverlay')?.addEventListener('click', closeAllSidePanels);

    document.getElementById('applyThemeBtn')?.addEventListener('click', () => {
      const activeFontStyle = document.querySelector('.font-style-btn.active')?.dataset.fontStyle || 'rubik';
      const prefs = {
        bgColor: document.getElementById('themeBgColor').value,
        titleColor: document.getElementById('themeTitleColor').value,
        iconsColor: document.getElementById('themeIconsColor').value,
        cardTitleColor: document.getElementById('themeCardTitleColor')?.value,
        cardTypeColor: document.getElementById('themeCardTypeColor')?.value,
        cardCreatorColor: document.getElementById('themeCardCreatorColor')?.value,
        cardRatingsColor: document.getElementById('themeCardRatingsColor')?.value,
        cardPopularityColor: document.getElementById('themeCardPopularityColor')?.value,
        cardDescColor: document.getElementById('themeCardDescColor')?.value,
        cardIconsColor: document.getElementById('themeCardIconsColor')?.value,
        modalTitleColor: document.getElementById('themeModalTitleColor')?.value,
        modalTypeColor: document.getElementById('themeModalTypeColor')?.value,
        modalDescColor: document.getElementById('themeModalDescColor')?.value,
        modalIconsColor: document.getElementById('themeModalIconsColor')?.value,
        modalCreatorColor: document.getElementById('themeModalCreatorColor')?.value,
        modalDownloadColor: document.getElementById('themeModalDownloadColor')?.value,
        modalRatingsColor: document.getElementById('themeModalRatingsColor')?.value,
        modalPopularityColor: document.getElementById('themeModalPopularityColor')?.value,
        fontStyle: activeFontStyle
      };
      saveThemePreferences();
    });

    document.getElementById('resetThemeBtn')?.addEventListener('click', () => {
      const root = document.documentElement;
      const defaults = DEFAULT_THEME_PREFERENCES;
      root.style.setProperty('--gradient-colors', `linear-gradient(270deg, ${defaults.bgColor}, ${defaults.bgColor}, ${defaults.bgColor})`);
      root.style.setProperty('--text-color', defaults.titleColor);
      root.style.setProperty('--icons-color', defaults.iconsColor);
      root.style.setProperty('--card-title-color', defaults.cardTitleColor);
      root.style.setProperty('--card-type-color', defaults.cardTypeColor);
      root.style.setProperty('--card-creator-color', defaults.cardCreatorColor);
      root.style.setProperty('--card-ratings-color', defaults.cardRatingsColor);
      root.style.setProperty('--card-popularity-color', defaults.cardPopularityColor);
      root.style.setProperty('--card-desc-color', defaults.cardDescColor);
      root.style.setProperty('--card-icons-color', defaults.cardIconsColor);
      root.style.setProperty('--modal-title-color', defaults.modalTitleColor);
      root.style.setProperty('--modal-type-color', defaults.modalTypeColor);
      root.style.setProperty('--modal-desc-color', defaults.modalDescColor);
      root.style.setProperty('--modal-icons-color', defaults.modalIconsColor);
      root.style.setProperty('--modal-creator-color', defaults.modalCreatorColor);
      root.style.setProperty('--modal-download-color', defaults.modalDownloadColor);
      root.style.setProperty('--modal-ratings-color', defaults.modalRatingsColor);
      root.style.setProperty('--modal-popularity-color', defaults.modalPopularityColor);
      document.querySelectorAll('.item h2, h1, h2, h3, h4, .sort-option, .sort-dropdown, .settings-btn').forEach(el => { el.style.color = ''; });
      document.querySelectorAll('.subtitle').forEach(el => { el.style.color = ''; });
      document.querySelectorAll('.item-rating-row .rating-block i, .item-rating-row .rating-block span').forEach(el => { el.style.color = ''; });
      document.querySelectorAll('.category-buttons button, .settings-btn, .search-wrapper button, .favourite-btn, .share-btn, .close-btn, .slider-prev, .slider-next, .slider-up, .copy-share-btn, .panel-close-btn, .sort-option i, .social-links a, .download-link .link-icon, .download-link .link-arrow, .download-guide-btn').forEach(el => { el.style.color = ''; });
      document.querySelectorAll('.modal-title, .modal-type, .modal-description, .download-link .link-icon, .link-arrow').forEach(el => { el.style.color = ''; });
      document.body.style.fontFamily = "'Rubik', sans-serif";
      document.querySelectorAll('h1, h2, h3, h4, .item h2, .modal-title, .sort-option, .category-buttons button, .settings-btn').forEach(el => { el.style.fontFamily = ''; });
      const setIfExists = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
      const setCheckedIfExists = (id, val) => { const el = document.getElementById(id); if (el) el.checked = val; };
      setIfExists('themeBgColor', defaults.bgColor);
      setIfExists('themeTitleColor', defaults.titleColor);
      setIfExists('themeIconsColor', defaults.iconsColor);
      setIfExists('themeCardTitleColor', defaults.cardTitleColor);
      setIfExists('themeCardTypeColor', defaults.cardTypeColor);
      setIfExists('themeCardCreatorColor', defaults.cardCreatorColor);
      setIfExists('themeCardRatingsColor', defaults.cardRatingsColor);
      setIfExists('themeCardPopularityColor', defaults.cardPopularityColor);
      setIfExists('themeCardDescColor', defaults.cardDescColor);
      setIfExists('themeCardIconsColor', defaults.cardIconsColor);
      setIfExists('themeModalTitleColor', defaults.modalTitleColor);
      setIfExists('themeModalTypeColor', defaults.modalTypeColor);
      setIfExists('themeModalDescColor', defaults.modalDescColor);
      setIfExists('themeModalIconsColor', defaults.modalIconsColor);
      setIfExists('themeModalCreatorColor', defaults.modalCreatorColor);
      setIfExists('themeModalDownloadColor', defaults.modalDownloadColor);
      setIfExists('themeModalRatingsColor', defaults.modalRatingsColor);
      setIfExists('themeModalPopularityColor', defaults.modalPopularityColor);
      setCheckedIfExists('themeShowType', true);
      setCheckedIfExists('themeShowCount', true);
      setCheckedIfExists('themeShowSortBadge', true);
      themePreferences = { ...DEFAULT_THEME_PREFERENCES };
      updateToggleLabelStates();
      document.querySelectorAll('.font-style-btn').forEach(btn => btn.classList.remove('active'));
      const defaultFontBtn = document.querySelector('.font-style-btn[data-font-style="rubik"]');
      defaultFontBtn?.classList.add('active');
      applyTheme(themePreferences);
      updateSortIndicator();
      saveThemePreferences();
    });

    document.getElementById('closeThemesBtn')?.addEventListener('click', () => {
      if (typeof closeAllSidePanels === 'function') {
        closeAllSidePanels();
      } else {
        document.getElementById('themesPanel')?.classList.remove('active');
        document.getElementById('themesOverlay')?.classList.remove('active');
        document.body.style.overflow = '';
      }
    });

    document.addEventListener('click', event => {
      const sortDropdownElement = document.getElementById('sortDropdown');
      if (sortDropdownElement && settingsBtn && !sortDropdownElement.contains(event.target) && !settingsBtn.contains(event.target)) {
        settingsBtn.classList.remove('active');
        sortDropdownElement.classList.remove('active');
      }
    });

    window.addEventListener('popstate', event => {
      const path = event.state?.path || getEffectiveRoutePath();
      processRoutePath(path, true);
    });

    window.addEventListener('hashchange', () => {
      const path = getEffectiveRoutePath();
      processRoutePath(path, true);
    });

    closeModal?.addEventListener('click', closeOverlay);
    overlay?.addEventListener('click', event => { if (event.target === overlay) closeOverlay(); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && overlay?.classList.contains('active')) closeOverlay(); });

    const alertCloseBtn = document.getElementById('alertCloseBtn');
    const alertOverlay = document.getElementById('alertOverlay');
    alertCloseBtn?.addEventListener('click', () => { alertOverlay?.classList.remove('active'); });
    alertOverlay?.addEventListener('click', event => { if (event.target === alertOverlay) alertOverlay.classList.remove('active'); });

    const successCloseBtn = document.getElementById('successCloseBtn');
    const successOverlay = document.getElementById('successOverlay');
    successCloseBtn?.addEventListener('click', () => { successOverlay?.classList.remove('active'); });
    successOverlay?.addEventListener('click', event => { if (event.target === successOverlay) successOverlay.classList.remove('active'); });

    favouriteBtn?.addEventListener('click', event => {
      event.stopPropagation();
      if (!overlayItemUuid) return;
      toggleFavouriteForUuid(overlayItemUuid);
    });

    shareBtn?.addEventListener('click', event => {
      event.stopPropagation();
      if (!overlayItemUuid) return;
      openShareOverlayForUuid(overlayItemUuid);
    });

    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        const swCode = `
          const CACHE_NAME='marketplace-v2';
          const IMAGE_CACHE_NAME='marketplace-images-v1';
          const IMAGE_URL_PATTERN=/\\.(jpg|jpeg|png|webp|avif|gif|svg)(\\?.*)?$/i;
          const APP_VERSION='${APP_VERSION}';
          // The old database.json catalog is no longer used as the data source —
          // we now fetch from the marketplace API proxy at /api/marketplace.
          // database.json is still fetched (as a sidecar for download links only),
          // but it should bypass the cache-first strategy below.
          const CATALOG_URLS=[].map(url => {
            const urlObject = new URL(url, self.location.href);
            if (!urlObject.searchParams.has('v')) {
              urlObject.searchParams.set('v', APP_VERSION);
            }
            return urlObject.toString();
          });

          self.addEventListener('install', event => {
            event.waitUntil(self.skipWaiting());
          });

          self.addEventListener('activate', event => {
            event.waitUntil(
              caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME && key !== IMAGE_CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim())
            );
          });

          self.addEventListener('fetch', event => {
            const request = event.request;
            if (request.method !== 'GET') return;

            const url = new URL(request.url);
            const isImage = request.destination === 'image' || IMAGE_URL_PATTERN.test(url.pathname);
            const isCatalog = false; // marketplace API is now the data source — no catalog caching needed

            if (isCatalog) {
              event.respondWith(
                caches.open(CACHE_NAME).then(cache => {
                  return cache.match(request).then(cachedResponse => {
                    const networkPromise = fetch(request, { cache: 'no-store' }).then(networkResponse => {
                      if (networkResponse && networkResponse.ok) {
                        cache.put(request, networkResponse.clone());
                      }
                      return networkResponse;
                    }).catch(() => null);

                    if (cachedResponse) {
                      networkPromise.catch(() => {});
                      return cachedResponse;
                    }

                    return networkPromise.then(networkResponse => {
                      if (networkResponse && networkResponse.ok) {
                        return networkResponse;
                      }
                      return new Response(JSON.stringify({ error: 'Offline' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
                    });
                  });
                })
              );
              return;
            }

            if (isImage) {
              event.respondWith(
                caches.open(IMAGE_CACHE_NAME).then(cache => {
                  return cache.match(request).then(cachedResponse => {
                    const networkPromise = fetch(request, { cache: 'default' }).then(networkResponse => {
                      if (networkResponse && networkResponse.ok) {
                        cache.put(request, networkResponse.clone());
                      }
                      return networkResponse;
                    }).catch(() => null);

                    if (cachedResponse) {
                      networkPromise.catch(() => {});
                      return cachedResponse;
                    }

                    return networkPromise.then(networkResponse => {
                      if (networkResponse && networkResponse.ok) {
                        return networkResponse;
                      }
                      return new Response('Offline', { status: 503 });
                    });
                  });
                })
              );
            }
          });
        `;
        const blob = new Blob([swCode], { type: 'application/javascript' });
        const swUrl = URL.createObjectURL(blob);
        navigator.serviceWorker.register(swUrl).then(() => URL.revokeObjectURL(swUrl)).catch(() => {});
      });
    }
  });
})();
