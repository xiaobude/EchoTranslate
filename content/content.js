// EchoTranslate Content Script
// Scans page, extracts text, translates, and renders results

let translationState = {
  isTranslating: false,
  autoTranslate: false, // Keep translation active during SPA navigation
  pendingRecheck: false,
  totalSegments: 0,
  translatedSegments: 0,
  failedSegments: 0,
  segments: [],
  mode: 'translated' // Default to 'translated' (仅译文)
};

// Detect if text is mostly Chinese (>25% Chinese characters)
function isChinese(text) {
  if (!text || text.length === 0) return false;
  const chineseChars = text.match(/[\u4e00-\u9fff]/g);
  const ratio = chineseChars ? chineseChars.length / text.length : 0;
  return ratio > 0.25;
}

// Detect if text contains English content
function isEnglish(text) {
  if (!text || text.length === 0) return false;
  const englishChars = text.match(/[a-zA-Z]/g);
  if (!englishChars || englishChars.length < 3) return false;
  const ratio = englishChars.length / text.length;
  return ratio > 0.2;
}

// File extension regex for skipping filenames in repository viewers/lists
const FILE_EXT_REGEX = /\.(gguf|bin|safetensors|pt|pth|onnx|h5|ckpt|tflite|md|txt|py|js|ts|jsx|tsx|json|yaml|yml|toml|xml|html|css|scss|c|cpp|h|hpp|rs|go|java|kt|rb|php|sh|bat|ps1|csv|tsv|zip|tar|gz|7z|rar|whl|exe|dll|so|dylib|gitattributes|gitignore|dockerignore|env|lock)$/i;

function isFileName(text) {
  if (!text) return false;
  const clean = text.trim();
  if (clean.startsWith('.') && clean.length < 35 && !clean.includes(' ')) return true;
  if (FILE_EXT_REGEX.test(clean) && !clean.includes('\n') && clean.split(/\s+/).length <= 2) return true;
  return false;
}

// Tags to strictly skip
const skipTags = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'SVG', 'PRE', 'CODE',
  'CANVAS', 'VIDEO', 'AUDIO', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT',
  'KBD', 'SAMP'
]);

// Semantic content tags
const targetTags = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'TH', 'TD', 'DD', 'DT', 'FIGCAPTION'
]);

// Determine if an element represents translatable text
function isTargetElement(node) {
  if (targetTags.has(node.tagName)) {
    // If LI is a complex layout container (contains div, table, form, grid, flex row), do NOT treat the whole LI as a text segment!
    if (node.tagName === 'LI') {
      if (node.querySelector && node.querySelector('div, table, form, ul, ol, section, p, h1, h2, h3, h4, h5, h6')) {
        return false;
      }
      if (node.className && typeof node.className === 'string' && (node.className.includes('grid') || node.className.includes('row') || node.className.includes('flex'))) {
        return false;
      }
      if (node.querySelectorAll && node.querySelectorAll('a, button, input').length > 1) {
        return false;
      }
    }
    // If TD/TH is a complex layout container, do not treat whole cell as a single text block
    if (node.tagName === 'TD' || node.tagName === 'TH') {
      if (node.querySelector && node.querySelector('div, table, form, p, ul, ol')) {
        return false;
      }
    }
    return true;
  }
  // Support Reddit custom slots and common blog/forum titles
  if (node.hasAttribute && node.hasAttribute('slot')) {
    const slot = node.getAttribute('slot');
    if (slot === 'title' || slot === 'text-body' || slot === 'comment') return true;
  }
  // Standalone headline links or titles
  if (node.tagName === 'A' && (node.classList.contains('title') || node.getAttribute('data-click-id') === 'body')) {
    return true;
  }
  return false;
}

// Smart root container selection
function getContentRoots() {
  // 1. If it's a dedicated documentation/README block (like GitHub) with rich content
  const docSelectors = ['#readme', 'article.markdown-body', '.markdown-section'];
  for (const sel of docSelectors) {
    const el = document.querySelector(sel);
    if (el && el.innerText && el.innerText.trim().length > 100) {
      return [el];
    }
  }

  // 2. Universal fallback for Reddit, Wikipedia, blogs, news, etc.
  return [document.body];
}

// Recursive collection supporting both Light DOM and Shadow DOM
function collectFromNode(root, segments, segmentIdRef) {
  if (!root) return;

  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_ELEMENT,
    {
      acceptNode: (node) => {
        if (skipTags.has(node.tagName)) {
          return NodeFilter.FILTER_REJECT;
        }
        if (node.classList && (
          node.classList.contains('highlight') ||
          node.classList.contains('octicon') ||
          node.classList.contains('badge') ||
          node.classList.contains('echo-translated-item')
        )) {
          return NodeFilter.FILTER_REJECT;
        }
        // Reject file trees and code repository directory browsers (HuggingFace, GitHub, etc.)
        if (node.closest && node.closest([
          'ul[class*="grid"]',
          'li[class*="grid"]',
          '[aria-label="Files"]',
          '[aria-label="Directory content"]',
          '.js-navigation-container',
          'table.files',
          '.file-wrap',
          '.react-directory-row',
          '[data-target="file-tree"]'
        ].join(','))) {
          return NodeFilter.FILTER_REJECT;
        }
        if (isTargetElement(node)) {
          return NodeFilter.FILTER_ACCEPT;
        }
        return NodeFilter.FILTER_SKIP;
      }
    }
  );

  let node;
  while ((node = walker.nextNode())) {
    // Skip if already translated
    if (node.dataset && node.dataset.echoTranslated) continue;
    if (node.classList && node.classList.contains('echo-translated-item')) continue;

    // Skip navigation and site chrome
    if (node.closest && node.closest('nav, header, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"]')) {
      continue;
    }

    // Skip file download links and resolvers
    if (node.closest && node.closest('a[download], a[href*="/resolve/"], a[href*="/raw/"]')) {
      continue;
    }

    // If this node contains other target tags, let the child elements be translated instead
    if (node.querySelector && node.querySelector('p, h1, h2, h3, h4, h5, h6, li, blockquote, [slot="title"], [slot="text-body"], [slot="comment"]')) {
      continue;
    }

    const text = (node.innerText || node.textContent || '').trim();
    if (text.length < 3) continue;
    if (isFileName(text)) continue;
    if (isChinese(text) || !isEnglish(text)) continue;

    segments.push({
      id: segmentIdRef.current++,
      element: node,
      text: text,
      originalHtml: node.innerHTML
    });
  }

  // Support Web Components / Shadow DOM (e.g. Reddit's shreddit-post, shreddit-comment)
  if (root.querySelectorAll) {
    const allCustom = root.querySelectorAll('*');
    for (const el of allCustom) {
      if (el.shadowRoot) {
        collectFromNode(el.shadowRoot, segments, segmentIdRef);
      }
    }
  }
}

// Extract translatable text nodes across document
function extractSegments() {
  const segments = [];
  const segmentIdRef = { current: 0 };
  const roots = getContentRoots();

  for (const root of roots) {
    collectFromNode(root, segments, segmentIdRef);
  }

  return segments;
}

// In-page progress & badge update (no intrusive banner)
function updateProgress() {
  const { totalSegments, translatedSegments, failedSegments } = translationState;
  const percent = totalSegments > 0 ? Math.round((translatedSegments / totalSegments) * 100) : 0;
  
  try {
    if (translationState.isTranslating) {
      chrome.runtime.sendMessage({
        type: 'UPDATE_BADGE',
        text: `${percent}%`,
        color: '#4285f4',
        iconState: 'active'
      });
      chrome.runtime.sendMessage({
        type: 'SET_ICON_STATE',
        state: 'active'
      });
    } else if (totalSegments > 0 && translatedSegments > 0) {
      chrome.runtime.sendMessage({
        type: 'UPDATE_BADGE',
        text: '',
        color: '#22c55e',
        iconState: 'active'
      });
      chrome.runtime.sendMessage({
        type: 'SET_ICON_STATE',
        state: 'active'
      });
    }

    // Broadcast to popup if open
    chrome.runtime.sendMessage({
      type: 'PROGRESS_UPDATE',
      total: totalSegments,
      translated: translatedSegments,
      failed: failedSegments,
      percent: percent,
      isTranslating: translationState.isTranslating
    }).catch(() => {});
  } catch (e) {
    // Ignore context invalidation
  }
}

// Switch display mode
function switchMode(mode) {
  translationState.mode = mode;
  
  if (mode === 'translated') {
    // Switch to 仅译文: remove any bilingual sibling items, replace node text in-place
    document.querySelectorAll('.echo-translated-item').forEach(el => el.remove());
    for (const seg of translationState.segments) {
      if (seg.translation && seg.element) {
        seg.element.textContent = seg.translation;
        seg.element.style.display = '';
      }
    }
  } else {
    // Switch to 双语对照: restore original text to node, and insert translation below it
    for (const seg of translationState.segments) {
      if (seg.translation && seg.element && seg.element.dataset.echoOriginal) {
        seg.element.innerHTML = seg.element.dataset.echoOriginal;
        seg.element.style.display = '';
        
        const parent = seg.element.parentNode;
        if (parent && !parent.querySelector(`.echo-translated-item[data-seg-id="${seg.id}"]`)) {
          const transEl = document.createElement('div');
          transEl.className = 'echo-translated-item';
          transEl.dataset.segId = seg.id;
          transEl.textContent = seg.translation;
          parent.insertBefore(transEl, seg.element.nextSibling);
        }
      }
    }
  }
}

// Restore original content
function restoreOriginal() {
  document.querySelectorAll('.echo-translated-item').forEach(item => item.remove());
  document.querySelectorAll('[data-echo-original]').forEach(item => {
    item.innerHTML = item.dataset.echoOriginal;
    item.classList.remove('echo-original-item', 'echo-original-container', 'echo-translated-text');
    item.removeAttribute('title');
    item.style.display = '';
    delete item.dataset.echoOriginal;
    delete item.dataset.echoTranslated;
  });
  
  translationState.autoTranslate = false;
  translationState.pendingRecheck = false;
  translationState.isTranslating = false;
  translationState.totalSegments = 0;
  translationState.translatedSegments = 0;
  translationState.failedSegments = 0;
  try {
    chrome.runtime.sendMessage({ type: 'UPDATE_BADGE', text: '', iconState: 'inactive' });
    chrome.runtime.sendMessage({ type: 'SET_ICON_STATE', state: 'inactive' });
  } catch (e) {}
}

// Insert translated text (in-place text replacement for 仅译文 to preserve Web Components & slots)
function insertTranslation(segment, translation) {
  const node = segment.element;
  if (!node || node.dataset.echoTranslated) return;
  
  node.dataset.echoTranslated = 'true';
  node.dataset.echoOriginal = node.innerHTML;
  node.title = '原文: ' + segment.text;

  if (translationState.mode === 'translated') {
    // 仅译文模式 (像谷歌翻译一样就地替换，保留所有 slot="title"、类名、链接与排版位置)
    node.textContent = translation;
    node.classList.add('echo-translated-text');
  } else {
    // 双语对照模式：在下方插入独立行
    const tagName = node.tagName.toUpperCase();
    const transEl = document.createElement(
      ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P'].includes(tagName) ? tagName : 'div'
    );
    transEl.className = 'echo-translated-item';
    transEl.textContent = translation;
    transEl.dataset.segId = segment.id;

    if (tagName === 'LI' || tagName === 'TD' || tagName === 'TH') {
      node.classList.add('echo-original-container');
      node.appendChild(transEl);
    } else {
      node.classList.add('echo-original-item');
      if (node.parentNode) {
        node.parentNode.insertBefore(transEl, node.nextSibling);
      } else {
        node.appendChild(transEl);
      }
    }
  }
}

// Translate a single segment
async function translateSegment(segment) {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'TRANSLATE',
      text: segment.text
    });
    
    if (response && response.translation) {
      segment.translation = response.translation;
      insertTranslation(segment, response.translation);
      return true;
    } else if (response && response.error) {
      console.error('Translation error:', response.error);
      return false;
    }
    return false;
  } catch (e) {
    console.error('Failed to translate segment:', e);
    return false;
  }
}

// Start translation (supports incremental for dynamic SPA navigation)
async function startTranslation(incremental = false) {
  if (translationState.isTranslating) {
    translationState.pendingRecheck = true;
    return;
  }
  
  translationState.autoTranslate = true;
  translationState.isTranslating = true;
  try {
    chrome.runtime.sendMessage({ type: 'SET_ICON_STATE', state: 'active' });
  } catch (e) {}

  // Extract segments (already-translated items are automatically skipped)
  const newSegments = extractSegments();
  
  if (newSegments.length === 0) {
    translationState.isTranslating = false;
    updateProgress();
    return;
  }

  if (!incremental) {
    translationState.segments = newSegments;
    translationState.totalSegments = newSegments.length;
    translationState.translatedSegments = 0;
    translationState.failedSegments = 0;
  } else {
    translationState.segments.push(...newSegments);
    translationState.totalSegments = translationState.segments.length;
  }
  updateProgress();
  
  // Translate segments with concurrency matching np=4
  let index = 0;
  const concurrency = 4;
  let active = 0;
  
  while (index < newSegments.length || active > 0) {
    while (active < concurrency && index < newSegments.length) {
      const segment = newSegments[index];
      index++;
      active++;
      
      translateSegment(segment).then(success => {
        if (success) {
          translationState.translatedSegments++;
        } else {
          translationState.failedSegments++;
        }
        active--;
        updateProgress();
      });
    }
    
    if (active > 0) {
      await new Promise(resolve => setTimeout(resolve, 80));
    }
  }
  
  translationState.isTranslating = false;
  updateProgress();

  if (translationState.pendingRecheck) {
    translationState.pendingRecheck = false;
    setTimeout(() => {
      if (translationState.autoTranslate) {
        startTranslation(true);
      }
    }, 500);
  }
}

// Message handling
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'TOGGLE_TRANSLATE':
      if (translationState.isTranslating) {
        sendResponse({ status: 'translating' });
      } else if (translationState.translatedSegments > 0) {
        restoreOriginal();
        sendResponse({ status: 'restored' });
      } else {
        startTranslation();
        sendResponse({ status: 'started' });
      }
      break;
    case 'GET_STATE':
      sendResponse({
        isTranslating: translationState.isTranslating,
        totalSegments: translationState.totalSegments,
        translatedSegments: translationState.translatedSegments,
        failedSegments: translationState.failedSegments,
        mode: translationState.mode,
        autoTranslate: translationState.autoTranslate
      });
      break;
    case 'START_TRANSLATE':
      if (translationState.translatedSegments > 0 && !translationState.isTranslating) {
        switchMode(message.mode || translationState.mode);
        sendResponse({ success: true, alreadyTranslated: true });
      } else {
        startTranslation();
        sendResponse({ success: true });
      }
      break;
    case 'RESTORE':
      restoreOriginal();
      sendResponse({ success: true });
      break;
    case 'SWITCH_MODE':
      switchMode(message.mode);
      sendResponse({ success: true });
      break;
    default:
      sendResponse({ status: 'unknown' });
  }
});

// SPA Route Change Listener (e.g. clicking an interesting topic on Reddit)
let lastUrl = location.href;

function onUrlChange() {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    if (translationState.autoTranslate) {
      // Small delay to let Reddit mount the post details DOM
      setTimeout(() => {
        if (translationState.autoTranslate) {
          startTranslation(true);
        }
      }, 600);
      // Secondary check for slower loading comments
      setTimeout(() => {
        if (translationState.autoTranslate) {
          startTranslation(true);
        }
      }, 1800);
    }
  }
}

// Intercept browser history navigation
const origPushState = history.pushState;
history.pushState = function(...args) {
  origPushState.apply(this, args);
  onUrlChange();
};

const origReplaceState = history.replaceState;
history.replaceState = function(...args) {
  origReplaceState.apply(this, args);
  onUrlChange();
};

window.addEventListener('popstate', onUrlChange);
setInterval(onUrlChange, 800);

// Dynamic Content / Infinite Scroll Observer (Debounced)
let mutationTimer = null;
const dynamicObserver = new MutationObserver((mutations) => {
  if (!translationState.autoTranslate || translationState.isTranslating) return;

  let hasRelevantNodes = false;
  for (const m of mutations) {
    if (m.addedNodes && m.addedNodes.length > 0) {
      for (const n of m.addedNodes) {
        if (n.nodeType === Node.ELEMENT_NODE && !n.classList?.contains('echo-translated-item')) {
          hasRelevantNodes = true;
          break;
        }
      }
    }
    if (hasRelevantNodes) break;
  }

  if (hasRelevantNodes) {
    clearTimeout(mutationTimer);
    mutationTimer = setTimeout(() => {
      if (translationState.autoTranslate && !translationState.isTranslating) {
        startTranslation(true);
      }
    }, 1200);
  }
});

dynamicObserver.observe(document.body, { childList: true, subtree: true });

// Automatically detect if the current page is in English
function isPageEnglish() {
  const htmlLang = (document.documentElement.lang || '').toLowerCase();
  if (htmlLang.startsWith('zh')) return false;

  // Sample visible semantic nodes
  const samples = document.querySelectorAll('p, h1, h2, h3, article, [slot="title"], #readme');
  let englishChars = 0;
  let chineseChars = 0;
  let totalChars = 0;

  let count = 0;
  for (const el of samples) {
    if (count++ > 20) break;
    const txt = (el.innerText || '').trim();
    if (txt.length < 5) continue;
    totalChars += txt.length;
    const en = txt.match(/[a-zA-Z]/g);
    if (en) englishChars += en.length;
    const zh = txt.match(/[\u4e00-\u9fff]/g);
    if (zh) chineseChars += zh.length;
  }

  // Fallback to title and body preview if samples are too small
  if (totalChars < 25) {
    const preview = (document.title + ' ' + (document.body ? document.body.innerText.slice(0, 500) : '')).trim();
    const en = preview.match(/[a-zA-Z]/g);
    const zh = preview.match(/[\u4e00-\u9fff]/g);
    totalChars = preview.length;
    englishChars = en ? en.length : 0;
    chineseChars = zh ? zh.length : 0;
  }

  if (totalChars === 0) return false;
  const enRatio = englishChars / totalChars;
  const zhRatio = chineseChars / totalChars;

  // If Chinese ratio is > 15%, it's a Chinese site (Bilibili, Zhihu, etc.)
  if (zhRatio > 0.15) return false;

  // If English ratio is > 35% or html lang is en and ratio > 20%
  if (enRatio > 0.35 || (htmlLang.startsWith('en') && enRatio > 0.2)) {
    return true;
  }

  return false;
}

// Auto-translate on page load if enabled in settings
(async () => {
  try {
    const cfg = await chrome.runtime.sendMessage({ type: 'GET_CONFIG' });
    if (cfg && cfg.auto_translate_english !== false) {
      setTimeout(() => {
        if (!translationState.isTranslating && translationState.translatedSegments === 0) {
          if (isPageEnglish()) {
            startTranslation();
          }
        }
      }, 700);
    }
  } catch (e) {}
})();
