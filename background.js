// background.js - 后台服务工作器
console.log('B站剧透弹幕过滤器 - 后台服务已启动');

// 存储已分析的弹幕缓存
const danmakuCache = new Map();

// Kimi API 配置
let kimiApiKey = 'sk-IhqAvEsDiLLUQY4fIpJQhkjQ9iF6FFWjWGNgfClqEWm6CkMW';
let kimiApiUrl = 'https://api.moonshot.cn/v1/chat/completions';

// 初始化：从存储中获取API Key
chrome.storage.sync.get(['kimiApiKey'], (result) => {
  if (result.kimiApiKey) {
    kimiApiKey = result.kimiApiKey;
    console.log('已加载Kimi API Key');
  }
});

// 监听来自content script的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'ANALYZE_DANMAKU') {
    analyzeDanmaku(request.data)
      .then(result => sendResponse({ success: true, data: result }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // 保持消息通道开启以进行异步响应
  }
  
  if (request.type === 'UPDATE_API_KEY') {
    kimiApiKey = request.apiKey;
    chrome.storage.sync.set({ kimiApiKey: request.apiKey });
    sendResponse({ success: true });
  }
  
  if (request.type === 'GET_CACHE_STATUS') {
    sendResponse({ 
      cacheSize: danmakuCache.size,
      hasApiKey: !!kimiApiKey 
    });
  }
});

// 分析弹幕内容是否包含剧透
async function analyzeDanmaku(data) {
  const { episodeId, danmakuList, animeTitle, episodeTitle } = data;
  
  // 检查缓存
  const cacheKey = `${episodeId}`;
  if (danmakuCache.has(cacheKey)) {
    console.log('使用缓存的分析结果:', cacheKey);
    return danmakuCache.get(cacheKey);
  }
  
  if (!kimiApiKey) {
    throw new Error('请先配置Kimi API Key');
  }
  
  // 将弹幕列表分批处理（每批100条）
  const batchSize = 100;
  const spoilerIds = new Set();
  
  for (let i = 0; i < danmakuList.length; i += batchSize) {
    const batch = danmakuList.slice(i, i + batchSize);
    const batchText = batch.map((d, idx) => 
      `${i + idx}. [${formatTime(d.progress)}] ${d.content}`
    ).join('\n');
    
    try {
      const result = await callKimiAPI(batchText, animeTitle, episodeTitle);
      const spoilerIndices = parseSpoilerIndices(result);
      
      spoilerIndices.forEach(idx => {
        if (batch[idx - i]) {
          spoilerIds.add(batch[idx - i].id);
        }
      });
    } catch (error) {
      console.error('Kimi API调用失败:', error);
    }
  }
  
  // 缓存结果
  const result = {
    episodeId,
    spoilerIds: Array.from(spoilerIds),
    analyzedAt: Date.now(),
    totalDanmaku: danmakuList.length,
    spoilerCount: spoilerIds.size
  };
  
  danmakuCache.set(cacheKey, result);
  
  // 保存到持久化存储
  chrome.storage.local.set({
    [`cache_${cacheKey}`]: result
  });
  
  return result;
}

// 调用Kimi API进行剧透分析
async function callKimiAPI(danmakuText, animeTitle, episodeTitle) {
  const prompt = `你是一个专业的番剧剧透检测助手。请分析以下来自番剧《${animeTitle}》${episodeTitle}的弹幕内容，识别其中包含剧透的弹幕。

剧透判断标准：
1. 透露后续剧情发展
2. 暴露关键转折或反转
3. 揭示角色命运（死亡、背叛等）
4. 提及尚未出现的人物或事件
5. 讨论结局相关内容
6. 来自原作党的剧情透露

请只返回包含剧透的弹幕序号，用逗号分隔，如果没有剧透则返回"无"。
注意：仅当弹幕明确包含剧透信息时才标记，普通的感想、吐槽、表情不算剧透。

弹幕列表：
${danmakuText}`;

  const response = await fetch(kimiApiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${kimiApiKey}`
    },
    body: JSON.stringify({
      model: 'moonshot-v1-8k',
      messages: [
        {
          role: 'system',
          content: '你是一个专业的剧透检测助手，擅长识别番剧弹幕中的剧透内容。'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.3,
      max_tokens: 500
    })
  });
  
  if (!response.ok) {
    throw new Error(`Kimi API请求失败: ${response.status}`);
  }
  
  const data = await response.json();
  return data.choices[0].message.content;
}

// 解析Kimi API返回的剧透索引
function parseSpoilerIndices(result) {
  if (result === '无' || result.includes('没有剧透')) {
    return [];
  }
  
  const indices = [];
  const matches = result.match(/\d+/g);
  
  if (matches) {
    matches.forEach(match => {
      const idx = parseInt(match, 10);
      if (!isNaN(idx)) {
        indices.push(idx);
      }
    });
  }
  
  return indices;
}

// 格式化时间（毫秒转为 分:秒）
function formatTime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

// 定期清理过期缓存（超过7天）
setInterval(() => {
  const now = Date.now();
  const expireTime = 7 * 24 * 60 * 60 * 1000; // 7天
  
  for (const [key, value] of danmakuCache) {
    if (now - value.analyzedAt > expireTime) {
      danmakuCache.delete(key);
      chrome.storage.local.remove(`cache_${key}`);
    }
  }
}, 60 * 60 * 1000); // 每小时检查一次

// 从持久化存储恢复缓存
chrome.storage.local.get(null, (items) => {
  Object.keys(items).forEach(key => {
    if (key.startsWith('cache_')) {
      const episodeId = key.replace('cache_', '');
      danmakuCache.set(episodeId, items[key]);
    }
  });
  console.log(`已恢复 ${danmakuCache.size} 个缓存项`);
});