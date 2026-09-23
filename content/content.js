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

// Pending flag to ensure dynamically loaded elements (e.g. comments streaming in) are never dropped
let pendingDynamicTranslate = false;

// Detect if text is mostly Chinese (>25% Chinese characters)
function isChinese(text) {
  if (!text || text.length === 0) return false;
  const chineseChars = text.match(/[\u4e00-\u9fff]/g);
  const ratio = chineseChars ? chineseChars.length / text.length : 0;
  return ratio > 0.25;
}

// Detect if text contains translatable foreign content (English, Japanese, Korean, Russian, European, etc.)
function isTranslatable(text) {
  if (!text || text.length < 2) return false;
  // If already Chinese, skip
  if (isChinese(text)) return false;
  // Skip pure numbers, punctuation, dates, symbols
  const clean = text.replace(/[\s\d\p{P}\p{S}]/gu, '');
  if (clean.length < 2) return false;
  return true;
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
  'CANVAS', 'VIDEO', 'AUDIO', 'INPUT', 'TEXTAREA', 'SELECT',
  'KBD', 'SAMP'
]);

// Semantic content tags
const targetTags = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'TH', 'TD', 'DD', 'DT', 'FIGCAPTION',
  'STRONG', 'B', 'SUMMARY', 'CAPTION'
]);

// Determine if an element represents translatable text
function isTargetElement(node) {
  if (targetTags.has(node.tagName)) {
    // If STRONG or B is inside another semantic text element, let parent handle it
    if ((node.tagName === 'STRONG' || node.tagName === 'B') && node.closest('p, h1, h2, h3, h4, h5, h6, li, blockquote, dd, dt, th, td')) {
      return false;
    }
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

  // Navigation links, category items, and action buttons (e.g. Newegg menus, shopping categories)
  if (node.tagName === 'A' || node.tagName === 'BUTTON') {
    // If inside a text block, let the parent block translate cohesively with links preserved
    if (node.closest('p, blockquote, dd, dt')) {
      return false;
    }
    // If it wraps complex layout containers, let the child elements be collected individually
    if (node.querySelector && node.querySelector('p, h1, h2, h3, h4, h5, h6, li, table, form, ul, ol')) {
      return false;
    }
    return true;
  }

  // Support Reddit custom slots and common menu/tab roles
  if (node.hasAttribute && (
    node.getAttribute('slot') === 'title' ||
    node.getAttribute('slot') === 'text-body' ||
    node.getAttribute('slot') === 'comment' ||
    node.getAttribute('role') === 'menuitem' ||
    node.getAttribute('role') === 'tab'
  )) {
    return true;
  }

  // Menu column headers and category titles (e.g. Newegg "Desktop", "Peripherals" spans/divs)
  if (node.tagName === 'SPAN' || node.tagName === 'DIV') {
    if (node.className && typeof node.className === 'string' && /(?:menu|nav|category|filter|header.*nav).*title/i.test(node.className)) {
      if (!node.querySelector('p, h1, h2, h3, h4, h5, h6, li, div, table')) {
        return true;
      }
    }
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

    // Skip file download links and resolvers
    if (node.closest && node.closest('a[download], a[href*="/resolve/"], a[href*="/raw/"]')) {
      continue;
    }

    // If this node contains other target tags, let the child elements be translated instead
    if (node.querySelector && node.querySelector('p, h1, h2, h3, h4, h5, h6, li, blockquote')) {
      continue;
    }

    const text = (node.innerText || node.textContent || '').trim();
    if (text.length < 2) continue;
    if (isFileName(text)) continue;
    if (!isTranslatable(text)) continue;

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
  const segmentIdRef = { current: (translationState.segments ? translationState.segments.length : 0) };
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

// Helper to escape HTML characters
function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Update an element's text while preserving any child icons (<svg>, <img>, icon classes)
function updateElementContentPreservingIcons(el, newText) {
  const icons = Array.from(el.querySelectorAll('svg, img, i, [class*="octicon"], [class*="icon"], [class*="ico"], [class*="fa"]'));
  
  if (icons.length > 0) {
    const iconClones = icons.map(icon => icon.cloneNode(true));
    el.innerHTML = '';
    iconClones.forEach(icon => {
      el.appendChild(icon);
      el.appendChild(document.createTextNode(' '));
    });
    el.appendChild(document.createTextNode(newText));
  } else {
    el.textContent = newText;
  }
}

// Safely apply translation to an element without destroying links or icons
function applyTranslationToElement(node, translation) {
  if (!node) return;

  // 1. If the node itself is an anchor link <a>
  if (node.tagName === 'A') {
    updateElementContentPreservingIcons(node, translation);
    return;
  }

  // 2. If the node wraps a single anchor link <a> (e.g. GitHub Trending <h2><a href="...">...</a></h2>)
  const links = node.querySelectorAll('a');
  if (links.length === 1) {
    const link = links[0];
    const linkText = (link.textContent || '').trim();
    const nodeText = (node.textContent || '').trim();
    // If the link contains the bulk of the text
    if (linkText.length > 0 && (linkText === nodeText || linkText.length >= nodeText.length * 0.6)) {
      updateElementContentPreservingIcons(link, translation);
      return;
    }
  }

  // 3. If node contains multiple links or inline links
  if (links.length > 0) {
    const linkMap = [];
    links.forEach(a => {
      const text = (a.textContent || '').trim();
      if (text.length > 0) {
        linkMap.push({
          text: text,
          html: a.outerHTML
        });
      }
    });

    let htmlWithLinks = escapeHtml(translation);
    let matchedAny = false;
    for (const item of linkMap) {
      if (htmlWithLinks.includes(item.text)) {
        htmlWithLinks = htmlWithLinks.replace(item.text, item.html);
        matchedAny = true;
      }
    }
    
    if (matchedAny) {
      node.innerHTML = htmlWithLinks;
      return;
    }
  }

  // 4. If node has child elements with icons (e.g. leading svg icon)
  if (node.children.length > 0) {
    updateElementContentPreservingIcons(node, translation);
    return;
  }

  // 5. Default fallback
  node.textContent = translation;
}

// Switch display mode
function switchMode(mode) {
  translationState.mode = mode;
  
  if (mode === 'translated') {
    // Switch to 仅译文: remove any bilingual sibling items, replace node text in-place
    document.querySelectorAll('.echo-translated-item').forEach(el => el.remove());
    for (const seg of translationState.segments) {
      if (seg.translation && seg.element) {
        if (seg.element.dataset.echoOriginal) {
          seg.element.innerHTML = seg.element.dataset.echoOriginal;
        }
        applyTranslationToElement(seg.element, seg.translation);
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
  
  pendingDynamicTranslate = false;
  translationState.autoTranslate = false;
  translationState.pendingRecheck = false;
  translationState.isTranslating = false;
  translationState.segments = [];
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
  node.dataset.echoOriginalText = segment.text;
  
  // Only show original text on hover if enabled in settings
  if (translationState.showOriginalOnHover) {
    node.title = '原文: ' + segment.text;
  }

  if (translationState.mode === 'translated') {
    // 仅译文模式 (像谷歌翻译一样就地替换，保留所有 slot="title"、类名、链接与排版位置)
    applyTranslationToElement(node, translation);
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

// Trigger deferred translations if new DOM mutations occurred during translation
function checkPendingDynamic() {
  if (pendingDynamicTranslate && translationState.autoTranslate) {
    pendingDynamicTranslate = false;
    setTimeout(() => {
      if (translationState.autoTranslate && !translationState.isTranslating) {
        startTranslation(true);
      }
    }, 200);
  }
}

// Start translation (supports incremental for dynamic SPA navigation)
async function startTranslation(incremental = false) {
  if (translationState.isTranslating) {
    pendingDynamicTranslate = true;
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
    checkPendingDynamic();
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
  
  // --- Step 1: Batch Cache Lookup (Instant 0ms display for visited pages) ---
  const textsToLookup = newSegments.map(s => s.text);
  let cachedMap = {};
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'GET_BATCH_CACHE',
      texts: textsToLookup
    });
    if (res && res.cached) {
      cachedMap = res.cached;
    }
  } catch (e) {}

  // Apply all cached translations immediately in one pass
  const remainingSegments = [];
  for (const seg of newSegments) {
    if (cachedMap[seg.text]) {
      seg.translation = cachedMap[seg.text];
      insertTranslation(seg, seg.translation);
      translationState.translatedSegments++;
    } else {
      remainingSegments.push(seg);
    }
  }
  updateProgress();

  // If all segments were already cached, finish immediately without calling AI
  if (remainingSegments.length === 0) {
    translationState.isTranslating = false;
    updateProgress();
    checkPendingDynamic();
    return;
  }

  // --- Step 2: Translate remaining un-cached segments via LLM concurrency queue ---
  let index = 0;
  const concurrency = 4;
  let active = 0;
  
  while (index < remainingSegments.length || active > 0) {
    while (active < concurrency && index < remainingSegments.length) {
      const segment = remainingSegments[index];
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
  checkPendingDynamic();
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
    case 'SET_SHOW_ORIGINAL_ON_HOVER':
      translationState.showOriginalOnHover = message.enabled;
      // Update all translated elements
      document.querySelectorAll('[data-echo-translated="true"]').forEach(node => {
        if (message.enabled && node.dataset.echoOriginalText) {
          node.title = '原文: ' + node.dataset.echoOriginalText;
        } else {
          node.removeAttribute('title');
        }
      });
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
      // 1. Cancel previous pending background requests from previous page
      try {
        chrome.runtime.sendMessage({ type: 'CANCEL_TRANSLATIONS' });
      } catch (e) {}

      // 2. Reset view state so the count accurately reflects the new page instead of keeping stale feed counts
      translationState.segments = [];
      translationState.totalSegments = 0;
      translationState.translatedSegments = 0;
      translationState.failedSegments = 0;
      translationState.isTranslating = false;
      pendingDynamicTranslate = false;
      updateProgress();

      // 3. Progressive detection as Reddit mounts the post & comment elements
      const delaySchedule = [300, 800, 1600, 2600];
      for (const delay of delaySchedule) {
        setTimeout(() => {
          if (translationState.autoTranslate) {
            startTranslation(true);
          }
        }, delay);
      }
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

// Dynamic Content / Infinite Scroll / Dropdown Menu Observer (Debounced)
let mutationTimer = null;
const dynamicObserver = new MutationObserver((mutations) => {
  if (!translationState.autoTranslate) return;

  let hasRelevantNodes = false;
  for (const m of mutations) {
    if (m.type === 'childList' && m.addedNodes && m.addedNodes.length > 0) {
      for (const n of m.addedNodes) {
        if (n.nodeType === Node.ELEMENT_NODE && !n.classList?.contains('echo-translated-item')) {
          hasRelevantNodes = true;
          break;
        }
      }
    } else if (m.type === 'attributes') {
      const el = m.target;
      if (el && el.nodeType === Node.ELEMENT_NODE) {
        const cls = typeof el.className === 'string' ? el.className : '';
        if (/(?:menu|dropdown|nav|popup|flyout|expand|active|open|show)/i.test(cls) || el.getAttribute?.('aria-expanded') === 'true') {
          hasRelevantNodes = true;
          break;
        }
      }
    }
    if (hasRelevantNodes) break;
  }

  if (hasRelevantNodes) {
    if (translationState.isTranslating) {
      // Mark pending so newly arrived comment or menu nodes will be translated as soon as current batch finishes
      pendingDynamicTranslate = true;
    } else {
      clearTimeout(mutationTimer);
      mutationTimer = setTimeout(() => {
        if (translationState.autoTranslate && !translationState.isTranslating) {
          startTranslation(true);
        }
      }, 500);
    }
  }
});

dynamicObserver.observe(document.body, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['class', 'aria-expanded']
});

// Listen for user scroll (infinite scroll for Reddit/Twitter comments)
let scrollTimer = null;
window.addEventListener('scroll', () => {
  if (!translationState.autoTranslate) return;
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => {
    if (translationState.autoTranslate && !translationState.isTranslating) {
      startTranslation(true);
    } else if (translationState.isTranslating) {
      pendingDynamicTranslate = true;
    }
  }, 800);
}, { passive: true });

// Automatically detect if the current page is foreign (English, Japanese, etc.)
function isPageForeign() {
  const htmlLang = (document.documentElement.lang || '').toLowerCase();
  if (htmlLang.startsWith('zh')) return false;

  // Sample visible semantic nodes
  const samples = document.querySelectorAll('p, h1, h2, h3, article, [slot="title"], #readme');
  let foreignChars = 0;
  let chineseChars = 0;
  let totalChars = 0;

  let count = 0;
  for (const el of samples) {
    if (count++ > 20) break;
    const txt = (el.innerText || '').trim();
    if (txt.length < 5) continue;
    totalChars += txt.length;
    // Latin, Cyrillic, Greek, Japanese Hiragana/Katakana, Korean Hangul, European accented
    const foreign = txt.match(/[a-zA-Z\u0400-\u04FF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF\u00C0-\u024F]/g);
    if (foreign) foreignChars += foreign.length;
    const zh = txt.match(/[\u4e00-\u9fff]/g);
    if (zh) chineseChars += zh.length;
  }

  // Fallback to title and body preview if samples are too small
  if (totalChars < 25) {
    const preview = (document.title + ' ' + (document.body ? document.body.innerText.slice(0, 500) : '')).trim();
    const foreign = preview.match(/[a-zA-Z\u0400-\u04FF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF\u00C0-\u024F]/g);
    const zh = preview.match(/[\u4e00-\u9fff]/g);
    totalChars = preview.length;
    foreignChars = foreign ? foreign.length : 0;
    chineseChars = zh ? zh.length : 0;
  }

  if (totalChars === 0) return false;
  const foreignRatio = foreignChars / totalChars;
  const zhRatio = chineseChars / totalChars;

  // If Chinese ratio is > 15%, it's a Chinese site (Bilibili, Zhihu, etc.)
  if (zhRatio > 0.15) return false;

  // If foreign letters ratio is > 30% or html lang is not zh and ratio > 15%
  if (foreignRatio > 0.30 || (!htmlLang.startsWith('zh') && foreignRatio > 0.15)) {
    return true;
  }

  return false;
}

// Load settings and auto-translate on page load if enabled
(async () => {
  try {
    const cfg = await chrome.runtime.sendMessage({ type: 'GET_CONFIG' });
    if (cfg) {
      // Load show_original_on_hover setting
      translationState.showOriginalOnHover = cfg.show_original_on_hover === true;
    }
    if (cfg && cfg.auto_translate_english !== false) {
      setTimeout(() => {
        if (!translationState.isTranslating && translationState.translatedSegments === 0) {
          if (isPageForeign()) {
            startTranslation();
          }
        }
      }, 700);
    }
  } catch (e) {}
})();

