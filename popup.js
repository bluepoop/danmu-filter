document.addEventListener('DOMContentLoaded', () => {
  // 加载设置
  loadSettings();
  
  // 保存API Key
  document.getElementById('saveBtn').addEventListener('click', () => {
    const apiKey = document.getElementById('apiKey').value;
    chrome.runtime.sendMessage({
      type: 'UPDATE_API_KEY',
      apiKey: apiKey
    }, (response) => {
      if (response.success) {
        alert('API Key已保存');
        loadSettings();
      }
    });
  });
  
  // 切换过滤
  document.getElementById('toggleBtn').addEventListener('click', () => {
    chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
      chrome.tabs.sendMessage(tabs[0].id, {
        type: 'TOGGLE_FILTER',
        enabled: true
      });
    });
  });
  
  // 重新分析
  document.getElementById('reanalyzeBtn').addEventListener('click', () => {
    chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
      chrome.tabs.sendMessage(tabs[0].id, {
        type: 'REANALYZE'
      });
    });
  });
});

function loadSettings() {
  chrome.storage.sync.get(['kimiApiKey'], (result) => {
    if (result.kimiApiKey) {
      document.getElementById('apiKey').value = result.kimiApiKey;
      document.getElementById('apiStatus').textContent = '已配置';
    }
  });
  
  chrome.runtime.sendMessage({type: 'GET_CACHE_STATUS'}, (response) => {
    document.getElementById('cacheSize').textContent = response.cacheSize;
  });
}