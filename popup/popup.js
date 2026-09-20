// EchoTranslate Google-Style Popup Script

document.addEventListener('DOMContentLoaded', async () => {
  const btnOrigLang = document.getElementById('btn-orig-lang');
  const btnTargetLang = document.getElementById('btn-target-lang');
  const progressFill = document.getElementById('progress-fill');
  const statusText = document.getElementById('status-text');
  const statusIndicator = document.getElementById('status-indicator');
  const btnOptions = document.getElementById('btn-options');
  const chkBilingual = document.getElementById('chk-bilingual');
  const chkAutoTranslate = document.getElementById('chk-auto-translate');

  let currentTabId = null;

  // 1. Get active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    currentTabId = tab.id;
  }

  // Safe message sender that auto-injects content script if needed
  async function sendTabMessage(message) {
    if (!currentTabId) return null;
    try {
      return await chrome.tabs.sendMessage(currentTabId, message);
    } catch (e) {
      // Content script might not be injected yet on this tab
      try {
        await chrome.scripting.executeScript({
          target: { tabId: currentTabId },
          files: ['content/content.js']
        });
        await chrome.scripting.insertCSS({
          target: { tabId: currentTabId },
          files: ['content/content.css']
        });
        return await chrome.tabs.sendMessage(currentTabId, message);
      } catch (err) {
        console.error('Failed to communicate with tab:', err);
        return null;
      }
    }
  }

  // 2. Check local LLM service health
  try {
    const health = await chrome.runtime.sendMessage({ type: 'CHECK_HEALTH' });
    if (health && health.online) {
      statusIndicator.className = 'status-dot online';
      statusIndicator.title = 'Local LLM 在线 (NeoHorse-1-4b)';
    } else {
      statusIndicator.className = 'status-dot offline';
      statusIndicator.title = 'Local LLM 离线 (请确认 llama-server 8080)';
    }
  } catch (e) {
    statusIndicator.className = 'status-dot offline';
  }

  // 3. Query current page translation state
  const state = await sendTabMessage({ type: 'GET_STATE' });
  if (state) {
    if (state.mode === 'bilingual') {
      chkBilingual.checked = true;
    }
    
    if (state.isTranslating) {
      btnTargetLang.classList.add('active');
      btnOrigLang.classList.remove('active');
      const pct = state.totalSegments > 0 ? Math.round((state.translatedSegments / state.totalSegments) * 100) : 0;
      progressFill.style.width = pct + '%';
      statusText.textContent = `正在翻译... ${state.translatedSegments}/${state.totalSegments} 段 (${pct}%)`;
    } else if (state.translatedSegments > 0) {
      btnTargetLang.classList.add('active');
      btnOrigLang.classList.remove('active');
      progressFill.style.width = '100%';
      statusText.textContent = `已翻译为中文 (${state.translatedSegments} 段)`;
    } else {
      btnOrigLang.classList.add('active');
      btnTargetLang.classList.remove('active');
      progressFill.style.width = '0%';
      statusText.textContent = '原文';
    }
  }

  // 4. Click [ 中文 (简体) ] -> Translate
  btnTargetLang.addEventListener('click', async () => {
    btnTargetLang.classList.add('active');
    btnOrigLang.classList.remove('active');
    statusText.textContent = '准备翻译...';
    progressFill.style.width = '15%';

    const mode = chkBilingual.checked ? 'bilingual' : 'translated';
    await sendTabMessage({ type: 'START_TRANSLATE', mode });
  });

  // 5. Click [ 检测到的语言 (英文) ] -> Restore
  btnOrigLang.addEventListener('click', async () => {
    btnOrigLang.classList.add('active');
    btnTargetLang.classList.remove('active');
    progressFill.style.width = '0%';
    statusText.textContent = '已恢复原文';

    await sendTabMessage({ type: 'RESTORE' });
  });

  // 6. Toggle Bilingual Checkbox
  chkBilingual.addEventListener('change', async () => {
    const mode = chkBilingual.checked ? 'bilingual' : 'translated';
    await sendTabMessage({ type: 'SWITCH_MODE', mode });
  });

  // Load auto_translate_english config
  try {
    const cfg = await chrome.runtime.sendMessage({ type: 'GET_CONFIG' });
    if (cfg && chkAutoTranslate) {
      chkAutoTranslate.checked = cfg.auto_translate_english !== false;
    }
  } catch (e) {}

  // Toggle auto_translate_english
  if (chkAutoTranslate) {
    chkAutoTranslate.addEventListener('change', async () => {
      await chrome.runtime.sendMessage({
        type: 'SAVE_CONFIG',
        config: { auto_translate_english: chkAutoTranslate.checked }
      });
    });
  }

  // 7. Open Options
  btnOptions.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // 8. Real-time progress updates from content script
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'PROGRESS_UPDATE') {
      if (message.isTranslating) {
        btnTargetLang.classList.add('active');
        btnOrigLang.classList.remove('active');
        progressFill.style.width = message.percent + '%';
        statusText.textContent = `正在翻译... ${message.translated}/${message.total} 段 (${message.percent}%)`;
      } else if (message.total > 0) {
        progressFill.style.width = '100%';
        statusText.textContent = `已翻译为中文 (${message.translated} 段)`;
      }
    }
  });
});
