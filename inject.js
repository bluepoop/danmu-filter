// inject.js - 注入到页面上下文，直接操作弹幕
(function() {
  console.log('剧透过滤器注入脚本已加载');
  
  let spoilerIds = new Set();
  let originalDanmakuList = null;
  
  // 监听来自content script的消息
  window.addEventListener('message', (event) => {
    if (event.data.type === 'BILIBILI_SPOILER_FILTER') {
      if (event.data.action === 'SET_FILTER') {
        spoilerIds = new Set(event.data.spoilerIds);
        applyDanmakuFilter();
      } else if (event.data.action === 'REMOVE_FILTER') {
        removeDanmakuFilter();
      }
    }
  });
  
  // 劫持弹幕加载函数
  function hookDanmakuLoader() {
    // 保存原始的XMLHttpRequest
    const originalXHR = window.XMLHttpRequest;
    
    // 创建新的XMLHttpRequest类
    window.XMLHttpRequest = function() {
      const xhr = new originalXHR();
      
      // 劫持open方法
      const originalOpen = xhr.open;
      xhr.open = function(method, url, ...args) {
        // 检查是否是弹幕请求
        if (url.includes('api.bilibili.com/x/v1/dm/list.so') || 
            url.includes('api.bilibili.com/x/v2/dm/') ||
            url.includes('comment.bilibili.com')) {
          
          // 劫持响应
          const originalOnReadyStateChange = xhr.onreadystatechange;
          xhr.onreadystatechange = function() {
            if (xhr.readyState === 4 && xhr.status === 200) {
              // 处理弹幕数据
              if (url.includes('.xml')) {
                // XML格式弹幕
                const modifiedResponse = filterDanmakuXML(xhr.responseText);
                Object.defineProperty(xhr, 'responseText', {
                  value: modifiedResponse,
                  writable: false
                });
              }
            }
            
            if (originalOnReadyStateChange) {
              originalOnReadyStateChange.apply(xhr, arguments);
            }
          };
        }
        
        return originalOpen.apply(xhr, [method, url, ...args]);
      };
      
      return xhr;
    };
  }
  
  // 过滤XML格式的弹幕
  function filterDanmakuXML(xmlText) {
    if (spoilerIds.size === 0) {
      return xmlText;
    }
    
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlText, 'text/xml');
    const danmakuElements = xmlDoc.querySelectorAll('d');
    
    danmakuElements.forEach(element => {
      const attrs = element.getAttribute('p').split(',');
      const dmid = attrs[7];
      
      if (spoilerIds.has(dmid)) {
        // 替换剧透弹幕内容
        element.textContent = '[已屏蔽剧透弹幕]';
        // 或直接移除
        // element.remove();
      }
    });
    
    const serializer = new XMLSerializer();
    return serializer.serializeToString(xmlDoc);
  }
  
  // 实时过滤页面上的弹幕元素
  function applyDanmakuFilter() {
    // 创建MutationObserver监听弹幕容器
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === 1 && node.classList && 
              (node.classList.contains('bili-danmaku-item') || 
               node.classList.contains('danmaku-item'))) {
            
            // 检查弹幕ID是否在剧透列表中
            const dmid = node.getAttribute('data-danmaku-id') || 
                         node.getAttribute('data-dmid');
            
            if (dmid && spoilerIds.has(dmid)) {
              // 标记为剧透并隐藏
              node.classList.add('spoiler-filtered');
              node.style.opacity = '0.1';
              node.style.pointerEvents = 'none';
              
              // 或完全隐藏
              // node.style.display = 'none';
            }
          }
        });
      });
    });
    
    // 开始观察弹幕容器
    const danmakuContainer = document.querySelector('.bpx-player-dm-wrap, .bilibili-player-video-danmaku');
    if (danmakuContainer) {
      observer.observe(danmakuContainer, {
        childList: true,
        subtree: true
      });
    }
    
    console.log(`已启用剧透过滤，共过滤 ${spoilerIds.size} 条弹幕`);
  }
  
  // 移除弹幕过滤
  function removeDanmakuFilter() {
    // 恢复所有被过滤的弹幕
    document.querySelectorAll('.spoiler-filtered').forEach(element => {
      element.classList.remove('spoiler-filtered');
      element.style.opacity = '';
      element.style.pointerEvents = '';
    });
    
    spoilerIds.clear();
    console.log('已关闭剧透过滤');
  }
  
  // 初始化
  hookDanmakuLoader();
})();