// content.js - 内容脚本，注入到B站番剧页面
console.log('B站剧透弹幕过滤器已注入页面');

// 当前页面信息
let currentEpisodeInfo = null;
let spoilerDanmakuIds = new Set();
let isFilterEnabled = true;

// 注入脚本到页面上下文
function injectScript() {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('inject.js');
  script.onload = function() {
    this.remove();
  };
  (document.head || document.documentElement).appendChild(script);
}

// 获取当前番剧信息
function getEpisodeInfo() {
  // 等待页面加载完成
  const observer = new MutationObserver((mutations, obs) => {
    // 从URL获取episode ID
    const match = window.location.pathname.match(/\/bangumi\/play\/(ep\d+)/);
    if (match) {
      const episodeId = match[1];
      
      // 获取番剧标题
      const titleElement = document.querySelector('.media-info-title-t, .media-title');
      const episodeElement = document.querySelector('.ep-info-title, .video-title');
      
      if (titleElement) {
        currentEpisodeInfo = {
          episodeId: episodeId,
          animeTitle: titleElement.textContent.trim(),
          episodeTitle: episodeElement ? episodeElement.textContent.trim() : '',
          url: window.location.href
        };
        
        console.log('当前番剧信息:', currentEpisodeInfo);
        obs.disconnect();
        
        // 自动开始分析
        startAnalysis();
      }
    }
  });
  
  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
}

// 开始分析弹幕
async function startAnalysis() {
  if (!currentEpisodeInfo) {
    console.error('无法获取番剧信息');
    return;
  }
  
  showNotification('正在分析弹幕中的剧透内容...');
  
  try {
    // 获取弹幕数据
    const danmakuList = await fetchDanmakuData();
    
    if (danmakuList.length === 0) {
      showNotification('未找到弹幕数据');
      return;
    }
    
    // 发送给background script进行分析
    const response = await chrome.runtime.sendMessage({
      type: 'ANALYZE_DANMAKU',
      data: {
        ...currentEpisodeInfo,
        danmakuList: danmakuList
      }
    });
    
    if (response.success) {
      const { spoilerIds, spoilerCount, totalDanmaku } = response.data;
      spoilerDanmakuIds = new Set(spoilerIds);
      
      showNotification(
        `分析完成！检测到 ${spoilerCount}/${totalDanmaku} 条剧透弹幕`,
        'success'
      );
      
      // 应用过滤
      applyFilter();
    } else {
      showNotification('分析失败: ' + response.error, 'error');
    }
  } catch (error) {
    console.error('分析过程出错:', error);
    showNotification('分析出错，请检查控制台', 'error');
  }
}

// 获取弹幕数据
async function fetchDanmakuData() {
  // 从页面获取cid
  const cid = await getCidFromPage();
  
  if (!cid) {
    throw new Error('无法获取视频CID');
  }
  
  // 获取弹幕XML
  const danmakuUrl = `https://comment.bilibili.com/${cid}.xml`;
  const response = await fetch(danmakuUrl);
  const text = await response.text();
  
  // 解析弹幕XML
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(text, 'text/xml');
  const danmakuElements = xmlDoc.querySelectorAll('d');
  
  const danmakuList = [];
  danmakuElements.forEach(element => {
    const attrs = element.getAttribute('p').split(',');
    danmakuList.push({
      id: attrs[7], // dmid
      content: element.textContent,
      progress: parseFloat(attrs[0]) * 1000, // 转换为毫秒
      mode: parseInt(attrs[1]),
      fontsize: parseInt(attrs[2]),
      color: parseInt(attrs[3]),
      timestamp: parseInt(attrs[4]),
      pool: parseInt(attrs[5]),
      userid: attrs[6]
    });
  });
  
  return danmakuList;
}

// 从页面获取CID
function getCidFromPage() {
  return new Promise((resolve) => {
    // 方法1：从window.__INITIAL_STATE__获取
    if (window.__INITIAL_STATE__ && window.__INITIAL_STATE__.epInfo) {
      resolve(window.__INITIAL_STATE__.epInfo.cid);
      return;
    }
    
    // 方法2：监听网络请求
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.name.includes('/x/player/playurl')) {
          const url = new URL(entry.name);
          const cid = url.searchParams.get('cid');
          if (cid) {
            observer.disconnect();
            resolve(cid);
          }
        }
      }
    });
    
    observer.observe({ entryTypes: ['resource'] });
    
    // 超时处理
    setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, 10000);
  });
}

// 应用弹幕过滤
function applyFilter() {
  if (!isFilterEnabled || spoilerDanmakuIds.size === 0) {
    return;
  }
  
  // 向页面注入过滤规则
  window.postMessage({
    type: 'BILIBILI_SPOILER_FILTER',
    action: 'SET_FILTER',
    spoilerIds: Array.from(spoilerDanmakuIds)
  }, '*');
}

// 显示通知
function showNotification(message, type = 'info') {
  const notification = document.createElement('div');
  notification.className = `spoiler-filter-notification ${type}`;
  notification.textContent = message;
  
  document.body.appendChild(notification);
  
  setTimeout(() => {
    notification.classList.add('show');
  }, 100);
  
  setTimeout(() => {
    notification.classList.remove('show');
    setTimeout(() => notification.remove(), 300);
  }, 3000);
}

// 监听来自popup的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'TOGGLE_FILTER') {
    isFilterEnabled = request.enabled;
    if (isFilterEnabled) {
      applyFilter();
      showNotification('剧透过滤已开启');
    } else {
      // 移除过滤
      window.postMessage({
        type: 'BILIBILI_SPOILER_FILTER',
        action: 'REMOVE_FILTER'
      }, '*');
      showNotification('剧透过滤已关闭');
    }
    sendResponse({ success: true });
  }
  
  if (request.type === 'REANALYZE') {
    startAnalysis();
    sendResponse({ success: true });
  }
});

// 页面加载完成后初始化
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

function init() {
  injectScript();
  getEpisodeInfo();
  
  // 监听URL变化（单页应用）
  let lastUrl = location.href;
  new MutationObserver(() => {
    const url = location.href;
    if (url !== lastUrl) {
      lastUrl = url;
      if (url.includes('/bangumi/play/')) {
        spoilerDanmakuIds.clear();
        getEpisodeInfo();
      }
    }
  }).observe(document, { subtree: true, childList: true });
}