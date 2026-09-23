// EchoTranslate Options Script

document.addEventListener('DOMContentLoaded', async () => {
  const apiUrlInput = document.getElementById('api_url');
  const modelNameInput = document.getElementById('model_name');
  const maxConcurrentInput = document.getElementById('max_concurrent');
  const timeoutInput = document.getElementById('request_timeout_ms');
  const promptInput = document.getElementById('prompt_template');
  const autoTranslateCheckbox = document.getElementById('auto_translate_english');
  const showOriginalHoverInput = document.getElementById('show_original_on_hover');
  const btnSave = document.getElementById('btn-save');
  const btnTest = document.getElementById('btn-test');
  const btnClearCache = document.getElementById('btn-clear-cache');
  const statusMessage = document.getElementById('status-message');
  const cacheSizeSpan = document.getElementById('cache-size');
  
  // Load current config
  async function loadConfig() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_CONFIG' });
      if (response) {
        apiUrlInput.value = response.api_url || '';
        modelNameInput.value = response.model_name || '';
        maxConcurrentInput.value = response.max_concurrent || 4;
        timeoutInput.value = response.request_timeout_ms || 30000;
        promptInput.value = response.prompt_template || '';
        if (autoTranslateCheckbox) {
          autoTranslateCheckbox.checked = response.auto_translate_english !== false;
        }
        if (showOriginalHoverInput) {
          showOriginalHoverInput.checked = response.show_original_on_hover === true;
        }
      }
    } catch (e) {
      console.error('Failed to load config:', e);
    }
  }
  
  // Update cache size display
  async function updateCacheSize() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_CACHE_SIZE' });
      if (response) {
        cacheSizeSpan.textContent = `缓存中: ${response.size} 条`;
      }
    } catch (e) {
      // Ignore
    }
  }
  
  // Show status message
  function showStatus(message, type) {
    statusMessage.textContent = message;
    statusMessage.className = 'status-message ' + type;
    setTimeout(() => {
      statusMessage.className = 'status-message';
    }, 3000);
  }
  
  // Save config
  btnSave.addEventListener('click', async () => {
    const config = {
      api_url: apiUrlInput.value.trim(),
      model_name: modelNameInput.value.trim(),
      max_concurrent: parseInt(maxConcurrentInput.value) || 4,
      request_timeout_ms: parseInt(timeoutInput.value) || 30000,
      prompt_template: promptInput.value,
      auto_translate_english: autoTranslateCheckbox ? autoTranslateCheckbox.checked : true,
      show_original_on_hover: showOriginalHoverInput ? showOriginalHoverInput.checked : false
    };
    
    try {
      await chrome.runtime.sendMessage({ type: 'SAVE_CONFIG', config });
      showStatus('设置已保存', 'success');
    } catch (e) {
      showStatus('保存失败: ' + e.message, 'error');
    }
  });
  
  // Test connection
  btnTest.addEventListener('click', async () => {
    btnTest.disabled = true;
    btnTest.textContent = '测试中...';
    
    try {
      const response = await chrome.runtime.sendMessage({ type: 'CHECK_HEALTH' });
      if (response && response.online) {
        showStatus('连接成功！AI 服务正常', 'success');
      } else {
        showStatus('连接失败：无法访问 AI 服务', 'error');
      }
    } catch (e) {
      showStatus('连接失败: ' + e.message, 'error');
    } finally {
      btnTest.disabled = false;
      btnTest.textContent = '测试连接';
    }
  });
  
  // Clear cache
  btnClearCache.addEventListener('click', async () => {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' });
      if (response) {
        showStatus(`已清空 ${response.cleared} 条缓存`, 'success');
        updateCacheSize();
      }
    } catch (e) {
      showStatus('清空缓存失败', 'error');
    }
  });
  
  // Initialize
  loadConfig();
  updateCacheSize();
});
