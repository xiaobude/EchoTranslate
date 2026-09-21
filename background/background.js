// EchoTranslate Background Service Worker
// Handles API calls, concurrent request management, and caching

let config = null;
let requestQueue = [];
let activeRequests = 0;
let translationCancelled = false;

// Default config
const DEFAULT_CONFIG = {
  api_url: "http://localhost:8080/v1/chat/completions",
  model_name: "NeoHorse-1-4b",
  max_concurrent: 4,
  request_timeout_ms: 30000,
  auto_translate_english: true,
  prompt_template: "你是一个专业的技术文档翻译器。请将以下英文技术文档翻译成中文：\n- 保持专业术语准确\n- 代码、变量名、函数名保持英文不变\n- 保持 Markdown 格式\n- 只输出翻译结果，不要解释\n\n待翻译文本：\n"
};

// Load config from storage
async function loadConfig() {
  try {
    const stored = await chrome.storage.local.get('echo_config');
    if (stored.echo_config) {
      config = stored.echo_config;
    } else {
      config = DEFAULT_CONFIG;
    }
  } catch (e) {
    console.error('Failed to load config:', e);
    config = DEFAULT_CONFIG;
  }
}

// Save config to storage
async function saveConfig(newConfig) {
  try {
    config = { ...config, ...newConfig };
    await chrome.storage.local.set({ echo_config: config });
  } catch (e) {
    console.error('Failed to save config:', e);
  }
}

// Get config
async function getConfig() {
  if (!config) {
    await loadConfig();
  }
  return config;
}

// Check API health
async function checkHealth() {
  try {
    const cfg = await getConfig();
    // Try to get models list or just check connectivity
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    
    const response = await fetch(cfg.api_url.replace('/chat/completions', '/models'), {
      signal: controller.signal,
      method: 'GET'
    });
    clearTimeout(timeout);
    return response.ok;
  } catch (e) {
    return false;
  }
}

// High-performance in-memory cache for 0ms lookups
const memoryCache = new Map(); // hash -> { text, translation, timestamp }

// Generate simple hash for caching
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

// Check single cache item
async function getFromCache(text) {
  const hash = simpleHash(text);
  if (memoryCache.has(hash)) {
    return memoryCache.get(hash);
  }
  try {
    const key = `echo_cache_${hash}`;
    const cached = await chrome.storage.local.get(key);
    if (cached && cached[key]) {
      memoryCache.set(hash, cached[key]);
      return cached[key];
    }
  } catch (e) {}
  return null;
}

// Check batch cache items in ONE roundtrip (instant 0ms response)
async function getBatchCache(texts) {
  const results = {};
  const missingKeys = [];
  const keyToText = {};

  for (const text of texts) {
    const hash = simpleHash(text);
    if (memoryCache.has(hash)) {
      results[text] = memoryCache.get(hash).translation;
    } else {
      const key = `echo_cache_${hash}`;
      missingKeys.push(key);
      keyToText[key] = text;
    }
  }

  if (missingKeys.length > 0) {
    try {
      const stored = await chrome.storage.local.get(missingKeys);
      for (const [key, val] of Object.entries(stored)) {
        if (val && val.translation) {
          const hash = key.replace('echo_cache_', '');
          memoryCache.set(hash, val);
          const origText = keyToText[key] || val.text;
          results[origText] = val.translation;
        }
      }
    } catch (e) {}
  }

  return results;
}

// Save to cache (memory + persistent storage)
async function saveToCache(text, translation) {
  const hash = simpleHash(text);
  const item = {
    text: text,
    translation: translation,
    timestamp: Date.now()
  };
  memoryCache.set(hash, item);
  try {
    await chrome.storage.local.set({
      [`echo_cache_${hash}`]: item
    });
  } catch (e) {
    console.error('Failed to save cache:', e);
  }
}

// Translate single segment via API
async function translateSegment(text) {
  const cfg = await getConfig();
  
  // Check cache first
  const cached = await getFromCache(text);
  if (cached) {
    return cached.translation;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), cfg.request_timeout_ms);

  try {
    const response = await fetch(cfg.api_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: cfg.model_name,
        messages: [
          { role: 'user', content: cfg.prompt_template + text },
          { role: 'assistant', content: '</think>' }
        ],
        temperature: 0.1,
        max_tokens: 2000
      }),
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const msg = data.choices && data.choices[0] ? data.choices[0].message : null;
    if (!msg) {
      throw new Error('Invalid API response format');
    }

    let translation = (msg.content || '').trim();
    if (!translation && msg.reasoning_content) {
      translation = msg.reasoning_content.trim();
    }
    // Clean up any remaining </think> tag
    translation = translation.replace(/^<\/think>\s*/i, '').trim();
    
    // Save to cache
    await saveToCache(text, translation);
    
    return translation;
  } catch (e) {
    clearTimeout(timeout);
    if (e.name === 'AbortError') {
      throw new Error('Request timeout');
    }
    throw e;
  }
}

// Process request queue with concurrency limit
async function processQueue() {
  if (requestQueue.length === 0 || activeRequests >= config.max_concurrent) {
    return;
  }

  const item = requestQueue.shift();
  activeRequests++;

  try {
    let translation;
    try {
      translation = await translateSegment(item.text);
    } catch (e) {
      // Retry once
      try {
        translation = await translateSegment(item.text);
      } catch (e2) {
        item.callback(null, e2.message);
        activeRequests--;
        processQueue();
        return;
      }
    }
    item.callback(translation, null);
  } catch (e) {
    item.callback(null, e.message);
  } finally {
    activeRequests--;
    processQueue();
  }
}

// Enqueue translation request
function enqueueTranslation(text, callback) {
  requestQueue.push({ text, callback });
  processQueue();
}

// Cancel all pending translations
function cancelTranslations() {
  translationCancelled = true;
  const pending = requestQueue.length;
  requestQueue = [];
  return pending;
}

// Clear translation cache
async function clearCache() {
  memoryCache.clear();
  try {
    const all = await chrome.storage.local.get(null);
    const keysToDelete = Object.keys(all).filter(key => key.startsWith('echo_cache_'));
    if (keysToDelete.length > 0) {
      await chrome.storage.local.remove(keysToDelete);
    }
    return keysToDelete.length;
  } catch (e) {
    console.error('Failed to clear cache:', e);
    return 0;
  }
}

// Get cache size
async function getCacheSize() {
  try {
    const all = await chrome.storage.local.get(null);
    return Object.keys(all).filter(key => key.startsWith('echo_cache_')).length;
  } catch (e) {
    return 0;
  }
}

// Tab active translation state tracker: tabId -> boolean
const tabTranslationStates = new Map();

// Set toolbar icon state: 'active' (green) or 'inactive' (blue)
function setIconState(tabId, state) {
  const isActive = (state === 'active' || state === true);
  const iconPath = isActive ? {
    16: '/icons/icon16_active.png',
    48: '/icons/icon48_active.png',
    128: '/icons/icon128_active.png'
  } : {
    16: '/icons/icon16.png',
    48: '/icons/icon48.png',
    128: '/icons/icon128.png'
  };

  const numericTabId = tabId != null ? Number(tabId) : null;
  if (numericTabId) {
    tabTranslationStates.set(numericTabId, isActive);
    chrome.action.setIcon({ tabId: numericTabId, path: iconPath }, () => {
      if (chrome.runtime.lastError) {}
    });
  } else {
    // Fallback to active tab
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab && tab.id) {
        tabTranslationStates.set(tab.id, isActive);
        chrome.action.setIcon({ tabId: tab.id, path: iconPath }, () => {
          if (chrome.runtime.lastError) {}
        });
      }
    }).catch(() => {});
  }
}

// Sync icon state immediately when user switches tabs
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const tabId = activeInfo.tabId;
  let isActive = tabTranslationStates.get(tabId);
  if (isActive === undefined) {
    try {
      const state = await chrome.tabs.sendMessage(tabId, { type: 'GET_STATE' });
      isActive = !!(state && (state.isTranslating || state.translatedSegments > 0));
      tabTranslationStates.set(tabId, isActive);
    } catch (e) {
      isActive = false;
    }
  }
  setIconState(tabId, isActive);
});

// Clean up state when tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  tabTranslationStates.delete(tabId);
});

// Reset state when tab navigates to a new page
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    tabTranslationStates.delete(tabId);
    setIconState(tabId, false);
  }
});

// Message handling from content script and popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'GET_CONFIG':
      getConfig().then(cfg => sendResponse(cfg)).catch(err => sendResponse(null));
      return true;
    case 'SAVE_CONFIG':
      saveConfig(message.config).then(() => sendResponse({ success: true })).catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    case 'CHECK_HEALTH':
      checkHealth().then(online => sendResponse({ online })).catch(() => sendResponse({ online: false }));
      return true;
    case 'TRANSLATE':
      enqueueTranslation(message.text, (translation, error) => {
        sendResponse({ translation, error });
      });
      return true;
    case 'GET_BATCH_CACHE':
      getBatchCache(message.texts || []).then(cached => sendResponse({ cached })).catch(() => sendResponse({ cached: {} }));
      return true;
    case 'CANCEL_TRANSLATIONS':
      sendResponse({ cancelled: cancelTranslations() });
      return false;
    case 'CLEAR_CACHE':
      clearCache().then(cleared => sendResponse({ cleared })).catch(() => sendResponse({ cleared: 0 }));
      return true;
    case 'GET_CACHE_SIZE':
      getCacheSize().then(size => sendResponse({ size })).catch(() => sendResponse({ size: 0 }));
      return true;
    case 'UPDATE_BADGE': {
      const targetTabId = (message.tabId != null) ? Number(message.tabId) : (sender && sender.tab ? sender.tab.id : null);
      if (targetTabId) {
        chrome.action.setBadgeText({ text: message.text || '', tabId: targetTabId });
        if (message.color) {
          chrome.action.setBadgeBackgroundColor({ color: message.color, tabId: targetTabId });
        }
        if (message.iconState) {
          setIconState(targetTabId, message.iconState);
        }
      }
      sendResponse({ success: true });
      return false;
    }
    case 'SET_ICON_STATE': {
      const targetTabId = (message.tabId != null) ? Number(message.tabId) : (sender && sender.tab ? sender.tab.id : null);
      setIconState(targetTabId, message.state);
      sendResponse({ success: true });
      return false;
    }
    default:
      return false;
  }
});

// Single-click toolbar icon to directly translate or restore (like Google Translate)
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_TRANSLATE' });
  } catch (err) {
    // If content script is not yet injected on this tab, inject dynamically and trigger
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content/content.js']
      });
      await chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ['content/content.css']
      });
      chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_TRANSLATE' });
    } catch (e) {
      console.error('Failed to trigger translation on tab:', e);
    }
  }
});

// Initialize
loadConfig();
