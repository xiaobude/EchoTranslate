// EchoTranslate Background Service Worker
// Handles API calls, concurrent request management, and caching

let config = null;
let requestQueue = [];
let activeRequests = 0;
let translationCancelled = false;

// Default config
const DEFAULT_CONFIG = {
  api_url: "http://localhost:8080/v1/chat/completions",
  model_name: "spark-x2.5-4b",
  max_concurrent: 4,
  request_timeout_ms: 30000,
  auto_translate_english: true,
  prompt_template: "你是一个专业的翻译器。请将以下外文内容准确流畅地翻译成中文。\n\n重要规则：\n1. 只输出翻译结果，绝对不要添加任何解释、注释、说明或备注\n2. 不要添加'注：'、'说明：'、'翻译说明'等任何额外文字\n3. 保持专业术语准确\n4. 代码、变量名、函数名、品牌名保持原样不变\n5. 保持 Markdown 格式\n6. 如果原文是宣传性标题，直接翻译，不要解释\n\n待翻译文本：\n"
};

// Load config from storage
async function loadConfig() {
  try {
    const stored = await chrome.storage.local.get('echo_config');
    if (stored.echo_config) {
      config = stored.echo_config;
      // Auto-correct model casing if old config had Spark-X2.5-4b
      if (config.model_name === 'Spark-X2.5-4b') {
        config.model_name = 'spark-x2.5-4b';
        chrome.storage.local.set({ echo_config: config });
      }
    } else {
      config = { ...DEFAULT_CONFIG };
    }
  } catch (e) {
    console.error('Failed to load config:', e);
    config = { ...DEFAULT_CONFIG };
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

// Check API health and dynamically retrieve active model name
async function checkHealth() {
  try {
    const cfg = await getConfig();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    
    const response = await fetch(cfg.api_url.replace('/chat/completions', '/models'), {
      signal: controller.signal,
      method: 'GET'
    });
    clearTimeout(timeout);
    if (!response.ok) return { online: false };
    const data = await response.json();
    const activeModel = data.data && data.data[0] ? data.data[0].id : (data.models && data.models[0] ? data.models[0].name : cfg.model_name);
    
    // If active model differs, update local state
    if (activeModel && config && config.model_name !== activeModel) {
      config.model_name = activeModel;
      saveConfig({ model_name: activeModel });
    }
    return { online: true, model: activeModel };
  } catch (e) {
    return { online: false };
  }
}

// High-performance bounded LRU in-memory cache for 0ms lookups
// Keeps recent / active pages (Reddit lists, current article) hot in RAM
// Automatically evicts oldest entries to prevent memory expansion; older items persist on disk
const MAX_MEMORY_CACHE_ITEMS = 1500;
const memoryCache = new Map(); // hash -> { text, translation, timestamp }

// Helper to keep memoryCache bounded via LRU (Least Recently Used)
function putMemoryCache(hash, item) {
  if (memoryCache.has(hash)) {
    memoryCache.delete(hash);
  } else if (memoryCache.size >= MAX_MEMORY_CACHE_ITEMS) {
    // Evict oldest (least recently used) item from RAM
    const oldestKey = memoryCache.keys().next().value;
    memoryCache.delete(oldestKey);
  }
  memoryCache.set(hash, item);
}

// Access memory cache and refresh its LRU position
function getMemoryCache(hash) {
  if (!memoryCache.has(hash)) return null;
  const item = memoryCache.get(hash);
  memoryCache.delete(hash);
  memoryCache.set(hash, item); // move to most recent end
  return item;
}

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

// Sanitizer function to strip thinking tags, reasoning traces, and leaked prompt templates
function cleanTranslationResult(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let str = raw.trim();

  // 1. Tag-based removal (<think>...</think>, <thought>...</thought>, <reasoning>...</reasoning>, [thought]...[/thought])
  str = str.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  str = str.replace(/<thought>[\s\S]*?<\/thought>/gi, '').trim();
  str = str.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '').trim();
  str = str.replace(/\[thought\][\s\S]*?\[\/thought\]/gi, '').trim();
  str = str.replace(/\[reasoning\][\s\S]*?\[\/reasoning\]/gi, '').trim();

  // 2. Unbalanced closing tags (drop everything up to closing tag)
  const closeTags = ['</think>', '</thought>', '</reasoning>', '[/thought]', '[/THOUGHT]', '[/reasoning]', '[/REASONING]'];
  for (const tag of closeTags) {
    if (str.includes(tag)) {
      const parts = str.split(tag);
      str = parts[parts.length - 1].trim();
    }
  }

  // 3. Dangling opening tags
  str = str.replace(/^<think>[\s\S]*/i, '').trim();
  str = str.replace(/^<thought>[\s\S]*/i, '').trim();

  // 4. Repeated prompt headers
  if (str.includes('待翻译文本：')) {
    const parts = str.split('待翻译文本：');
    str = parts[parts.length - 1].trim();
  }

  // 5. Reasoning/CoT without tags (e.g. models outputting chain-of-thought in content)
  const isReasoningPolluted = /(?:需要翻译成中文|保持原样|可能术语|变量名|专业术语|确保没有解释|只输出翻译结果|思考过程)/i.test(str);
  if (isReasoningPolluted) {
    const outputMatch = str.match(/(?:可能输出|最终翻译|翻译结果|译文|最终输出|输出)[：:]\s*([^\n\r]+)/i);
    if (outputMatch && outputMatch[1]) {
      let candidate = outputMatch[1].trim();
      candidate = candidate.replace(/\s*需要(准确|保持|流畅|只输出|注意)[\s\S]*$/i, '').trim();
      if (candidate) {
        str = candidate;
      }
    } else {
      const lines = str.split(/[\n\r]+/);
      const cleanLines = lines.filter(l => !/(?:需要翻译|保持原样|术语|变量名|确保没有|只输出|思考)/i.test(l));
      if (cleanLines.length > 0) {
        str = cleanLines[cleanLines.length - 1].trim();
      }
    }
  }

  // 6. Strip translator notes, explanation blocks, or trailing comments (e.g. "> 注：原文...", "（注：...）", "注：...")
  str = str.replace(/(?:\s*>|\n>)\s*(?:\*{1,2})?(?:注|译注|译者注|备注|说明|提示)(?:\*{1,2})?[：:][\s\S]*$/i, '');
  str = str.replace(/\n\s*(?:[\*\[（\(]\s*)?(?:注|译注|译者注|备注|说明)(?:\*{1,2})?[：:][\s\S]*$/i, '');
  str = str.replace(/\s+(?:>|—|-|\/)\s*(?:\*{1,2})?(?:注|译注|译者注|备注|说明)[：:][\s\S]*$/i, '');
  str = str.replace(/[\(（]\s*(?:注|译注|译者注|说明)[：:][^\)）]*[\)）]\s*$/i, '');
  str = str.replace(/\s+(?:注|译注|译者注)[：:][\s\S]*$/i, '');

  // 7. Clean leading/trailing quotes if wrapped
  if ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith('“') && str.endsWith('”')) || (str.startsWith("'") && str.endsWith("'"))) {
    str = str.slice(1, -1).trim();
  }

  return str;
}

// Get from cache (memory first, then storage)
async function getFromCache(text) {
  const hash = simpleHash(text);
  
  // 1. Memory check (0ms)
  let mem = getMemoryCache(hash);
  if (mem) {
    const cleaned = cleanTranslationResult(mem.translation);
    if (cleaned !== mem.translation) {
      mem.translation = cleaned;
      saveToCache(text, cleaned);
    }
    return mem;
  }

  // 2. Storage check
  try {
    const key = `echo_cache_${hash}`;
    const stored = await chrome.storage.local.get(key);
    if (stored[key]) {
      const item = stored[key];
      const cleaned = cleanTranslationResult(item.translation);
      if (cleaned !== item.translation) {
        item.translation = cleaned;
        saveToCache(text, cleaned);
      }
      putMemoryCache(hash, item);
      return item;
    }
  } catch (e) {}

  return null;
}

// Batch get from cache for instantaneous page translation
async function getBatchCache(texts) {
  const results = {};
  const missingKeys = [];
  const keyToText = {};

  for (const text of texts) {
    const hash = simpleHash(text);
    const mem = getMemoryCache(hash);
    if (mem) {
      const cleaned = cleanTranslationResult(mem.translation);
      if (cleaned !== mem.translation) {
        mem.translation = cleaned;
        saveToCache(text, cleaned);
      }
      results[text] = mem.translation;
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
          const cleaned = cleanTranslationResult(val.translation);
          if (cleaned !== val.translation) {
            val.translation = cleaned;
            saveToCache(val.text, cleaned);
          }
          putMemoryCache(hash, val);
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
  const cleanText = cleanTranslationResult(translation);
  const hash = simpleHash(text);
  const item = {
    text: text,
    translation: cleanText,
    timestamp: Date.now()
  };
  putMemoryCache(hash, item);
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
        model: cfg.model_name || "spark-x2.5-4b",
        messages: [
          { role: 'system', content: '你是专业翻译引擎。直接输出目标语言的翻译结果，严禁输出任何思考过程、分析、解释、前缀，也严禁添加任何“注：”、“译注：”、“说明：”等译者备注。' },
          { role: 'user', content: cfg.prompt_template + text }
        ],
        temperature: 0.1,
        max_tokens: 2000,
        chat_template_kwargs: {
          enable_thinking: false
        }
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

    // Robust extraction: prefer msg.content; ignore msg.reasoning_content
    let translation = (msg.content || '').trim();
    if (!translation && msg.reasoning_content) {
      translation = msg.reasoning_content.trim();
    }
    
    // Clean thinking traces and reasoning artifacts
    translation = cleanTranslationResult(translation);
    
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
