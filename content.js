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
  console.log('开始获取番剧信息...');
  
  // 等待页面加载完成
  const observer = new MutationObserver((mutations, obs) => {
    let episodeId = null;
    
    // 方法1: 从URL获取episode ID（ep格式）
    const epMatch = window.location.pathname.match(/\/bangumi\/play\/(ep\d+)/);
    if (epMatch) {
      episodeId = epMatch[1];
      console.log('从URL获取到episode ID (ep格式):', episodeId);
    }
    
    // 方法2: 从URL获取season ID（ss格式），需要进一步查找当前episode
    const ssMatch = window.location.pathname.match(/\/bangumi\/play\/(ss\d+)/);
    if (ssMatch && !episodeId) {
      console.log('检测到ss格式URL，查找当前播放的episode...');
      
      // 从__NEXT_DATA__中获取当前episode
      if (window.__NEXT_DATA__?.props?.pageProps?.dehydratedState) {
        try {
          const state = JSON.stringify(window.__NEXT_DATA__.props.pageProps.dehydratedState);
          const epIdMatch = state.match(/"ep_id":(\d+)/);
          if (epIdMatch) {
            episodeId = 'ep' + epIdMatch[1];
            console.log('从页面数据获取到episode ID:', episodeId);
          }
        } catch (e) {
          console.error('解析页面数据失败:', e);
        }
      }
      
      // 如果还是没找到，从URL的hash或query参数中找
      if (!episodeId) {
        const urlParams = new URLSearchParams(window.location.search);
        const epParam = urlParams.get('ep_id');
        if (epParam) {
          episodeId = 'ep' + epParam;
          console.log('从URL参数获取到episode ID:', episodeId);
        }
      }
    }
    
    if (episodeId) {
      // 获取番剧标题 - 更新选择器
      const titleElement = document.querySelector('.media-info-title-t, .media-title, [class*="mediainfo_mediaTitle"]');
      const episodeElement = document.querySelector('.ep-info-title, .video-title, [class*="epinfo_ep_title"]');
      
      if (titleElement || document.title) {
        currentEpisodeInfo = {
          episodeId: episodeId,
          animeTitle: titleElement ? titleElement.textContent.trim() : document.title.split('-')[0].trim(),
          episodeTitle: episodeElement ? episodeElement.textContent.trim() : '',
          url: window.location.href
        };
        
        console.log('✅ 当前番剧信息:', currentEpisodeInfo);
        obs.disconnect();
        
        // 延迟2秒后开始分析，确保页面完全加载
        setTimeout(() => {
          startAnalysis();
        }, 2000);
      }
    }
  });
  
  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
  
  // 超时保护：如果10秒还没找到，尝试直接获取
  setTimeout(() => {
    if (!currentEpisodeInfo) {
      console.log('超时，尝试直接获取...');
      observer.disconnect();
      
      // 最后的尝试
      const ssMatch = window.location.pathname.match(/\/bangumi\/play\/(ss\d+)/);
      if (ssMatch) {
        // 使用一个默认的episode ID
        currentEpisodeInfo = {
          episodeId: ssMatch[1], // 暂时使用ss ID
          animeTitle: document.title.split('-')[0].trim(),
          episodeTitle: '',
          url: window.location.href
        };
        console.log('使用备用方案，番剧信息:', currentEpisodeInfo);
        startAnalysis();
      }
    }
  }, 10000);
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
    
    console.log(`成功获取 ${danmakuList.length} 条弹幕`);
    
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
    showNotification('分析出错: ' + error.message, 'error');
  }
}

// 获取弹幕数据 - 完全重写
async function fetchDanmakuData() {
  try {
    // 方法1：从API请求历史中获取CID
    const cid = await getCidFromPage();
    
    if (!cid) {
      throw new Error('无法获取视频CID');
    }
    
    console.log('获取到CID:', cid);
    
    // 获取弹幕XML
    const danmakuUrl = `https://comment.bilibili.com/${cid}.xml`;
    console.log('正在获取弹幕:', danmakuUrl);
    
    const response = await fetch(danmakuUrl);
    if (!response.ok) {
      throw new Error(`弹幕请求失败: ${response.status}`);
    }
    
    const text = await response.text();
    console.log('弹幕XML长度:', text.length);
    
    // 解析弹幕XML
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(text, 'text/xml');
    const danmakuElements = xmlDoc.querySelectorAll('d');
    
    console.log('解析到弹幕数量:', danmakuElements.length);
    
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
  } catch (error) {
    console.error('获取弹幕数据失败:', error);
    throw error;
  }
}

// 从页面获取CID - 完全重写
function getCidFromPage() {
  return new Promise((resolve, reject) => {
    console.log('开始获取CID...');
    
    // 方法1：从__NEXT_DATA__获取（如果存在）
    if (window.__NEXT_DATA__) {
      console.log('尝试从__NEXT_DATA__获取');
      try {
        const nextData = window.__NEXT_DATA__;
        // 需要根据实际结构调整路径
        if (nextData.props?.pageProps?.videoInfo?.cid) {
          const cid = nextData.props.pageProps.videoInfo.cid;
          console.log('从__NEXT_DATA__获取CID成功:', cid);
          resolve(cid);
          return;
        }
      } catch (e) {
        console.log('__NEXT_DATA__解析失败:', e);
      }
    }
    
    // 方法2：从window.player获取
    if (window.player) {
      console.log('尝试从window.player获取');
      try {
        // 尝试多种可能的路径
        const possiblePaths = [
          () => window.player.getCid?.(),
          () => window.player.cid,
          () => window.player.config?.cid,
          () => window.player.videoInfo?.cid
        ];
        
        for (const getter of possiblePaths) {
          try {
            const cid = getter();
            if (cid) {
              console.log('从window.player获取CID成功:', cid);
              resolve(cid);
              return;
            }
          } catch (e) {}
        }
      } catch (e) {
        console.log('window.player解析失败:', e);
      }
    }
    
    // 方法3：从Performance API获取（最可靠）
    console.log('尝试从Network请求获取');
    const checkNetworkRequests = () => {
      const entries = performance.getEntriesByType('resource');
      
      // 查找包含cid参数的请求
      for (const entry of entries) {
        try {
          if (entry.name.includes('api.bilibili.com') && entry.name.includes('cid=')) {
            const url = new URL(entry.name);
            const cid = url.searchParams.get('cid');
            if (cid) {
              console.log('从Network请求获取CID成功:', cid);
              resolve(cid);
              return true;
            }
          }
        } catch (e) {}
      }
      return false;
    };
    
    // 立即检查一次
    if (checkNetworkRequests()) {
      return;
    }
    
    // 如果没找到，等待新的请求
    console.log('等待API请求...');
    let checkCount = 0;
    const maxChecks = 50; // 最多检查5秒
    
    const intervalId = setInterval(() => {
      checkCount++;
      
      if (checkNetworkRequests()) {
        clearInterval(intervalId);
        return;
      }
      
      if (checkCount >= maxChecks) {
        clearInterval(intervalId);
        console.error('获取CID超时');
        reject(new Error('无法获取CID：未找到相关API请求'));
      }
    }, 100);
  });
}

// 应用弹幕过滤
function applyFilter() {
  if (!isFilterEnabled || spoilerDanmakuIds.size === 0) {
    return;
  }
  
  console.log(`准备过滤 ${spoilerDanmakuIds.size} 条剧透弹幕`);
  
  // 向页面注入过滤规则
  window.postMessage({
    type: 'BILIBILI_SPOILER_FILTER',
    action: 'SET_FILTER',
    spoilerIds: Array.from(spoilerDanmakuIds)
  }, '*');
}

// 显示通知
function showNotification(message, type = 'info') {
  console.log(`[通知-${type}]`, message);
  
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
  console.log('收到popup消息:', request.type);
  
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
    return false;
  }
  
  if (request.type === 'REANALYZE') {
    startAnalysis();
    sendResponse({ success: true });
    return false;
  }
});

// 页面加载完成后初始化
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

function init() {
  console.log('初始化剧透过滤器...');
  injectScript();
  
  // 等待页面元素加载
  setTimeout(() => {
    getEpisodeInfo();
  }, 1000);
  
  // 监听URL变化（单页应用）
  let lastUrl = location.href;
  new MutationObserver(() => {
    const url = location.href;
    if (url !== lastUrl) {
      lastUrl = url;
      console.log('检测到URL变化:', url);
      if (url.includes('/bangumi/play/')) {
        spoilerDanmakuIds.clear();
        setTimeout(() => {
          getEpisodeInfo();
        }, 1000);
      }
    }
  }).observe(document, { subtree: true, childList: true });
}