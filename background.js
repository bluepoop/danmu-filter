// background.js - 后台服务工作器
console.log('B站剧透弹幕过滤器 - 后台服务已启动');

// 存储已分析的弹幕缓存
const danmakuCache = new Map();

// Kimi API 配置
let kimiApiKey = '';
let kimiApiUrl = 'https://api.moonshot.cn/v1/chat/completions';

// 初始化：从存储中获取API Key
chrome.storage.sync.get(['kimiApiKey'], (result) => {
  if (result.kimiApiKey) {
    kimiApiKey = result.kimiApiKey;
    console.log('已加载Kimi API Key');
  }
});

// 监听来自content script的消息 - 修复版
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('收到消息:', request.type);
  
  if (request.type === 'ANALYZE_DANMAKU') {
    // 立即返回true表示异步响应
    (async () => {
      try {
        console.log('开始分析弹幕...');
        const result = await analyzeDanmaku(request.data);
        console.log('分析完成，发送响应');
        sendResponse({ success: true, data: result });
      } catch (error) {
        console.error('分析失败:', error);
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true; // 重要！保持消息通道开启
  }
  
  if (request.type === 'UPDATE_API_KEY') {
    kimiApiKey = request.apiKey;
    chrome.storage.sync.set({ kimiApiKey: request.apiKey }, () => {
      console.log('API Key已更新');
      sendResponse({ success: true });
    });
    return true;
  }
  
  if (request.type === 'GET_CACHE_STATUS') {
    const response = { 
      cacheSize: danmakuCache.size,
      hasApiKey: !!kimiApiKey 
    };
    console.log('返回缓存状态:', response);
    sendResponse(response);
    return false; // 同步响应
  }
  
  // 未知消息类型
  console.warn('未知的消息类型:', request.type);
  return false;
});

// 分析弹幕内容是否包含剧透
async function analyzeDanmaku(data) {
  const { episodeId, danmakuList, animeTitle, episodeTitle } = data;
  
  console.log(`开始分析 ${animeTitle} ${episodeTitle}`);
  console.log(`Episode ID: ${episodeId}, 弹幕数: ${danmakuList.length}`);
  
  // 检查缓存
  const cacheKey = `${episodeId}`;
  if (danmakuCache.has(cacheKey)) {
    console.log('✅ 使用缓存的分析结果:', cacheKey);
    return danmakuCache.get(cacheKey);
  }
  
  if (!kimiApiKey) {
    console.error('❌ 未配置Kimi API Key');
    throw new Error('请先配置Kimi API Key');
  }
  
  // 将弹幕列表分批处理 - 智能批次控制
  const batchSize = 150; // 增加每批数量，减少总批次
  const maxBatchesPerRun = 3; // 每次最多处理3批（匹配RPM=3限制）
  const spoilerIds = new Set();
  const totalBatches = Math.ceil(danmakuList.length / batchSize);
  
  console.log(`共 ${totalBatches} 批，每批 ${batchSize} 条`);
  console.log(`本次将处理前 ${Math.min(maxBatchesPerRun, totalBatches)} 批（避免API限流）`);
  
  let successfulBatches = 0;
  let consecutiveErrors = 0;
  
  for (let i = 0; i < danmakuList.length && successfulBatches < maxBatchesPerRun; i += batchSize) {
    const batch = danmakuList.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    
    console.log(`处理第 ${batchNum}/${totalBatches} 批...`);
    
    const batchText = batch.map((d, idx) => 
      `${i + idx}. [${formatTime(d.progress)}] ${d.content}`
    ).join('\n');
    
    try {
      console.log(`调用Kimi API (批次${batchNum})...`);
      const result = await callKimiAPI(batchText, animeTitle, episodeTitle);
      console.log(`批次${batchNum} API响应:`, result.substring(0, 100));
      
      const spoilerIndices = parseSpoilerIndices(result);
      console.log(`批次${batchNum} 发现剧透: ${spoilerIndices.length} 条`);
      
      spoilerIndices.forEach(idx => {
        if (batch[idx - i]) {
          spoilerIds.add(batch[idx - i].id);
        }
      });
      
      successfulBatches++;
      consecutiveErrors = 0;
      
      // 添加延迟避免API限流（成功后等待）
      if (successfulBatches < maxBatchesPerRun && i + batchSize < danmakuList.length) {
        console.log('等待1秒以避免限流...');
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
    } catch (error) {
      console.error(`批次${batchNum} API调用失败:`, error.message);
      consecutiveErrors++;
      
      // 如果是限流错误，停止处理更多批次
      if (error.message.includes('rate_limit') || error.message.includes('429')) {
        console.log('⚠️ 触发API限流，停止本次分析');
        console.log(`已成功分析 ${successfulBatches} 批，识别 ${spoilerIds.size} 条剧透`);
        break;
      }
      
      // 如果连续失败3次，停止
      if (consecutiveErrors >= 3) {
        console.log('⚠️ 连续失败次数过多，停止分析');
        break;
      }
    }
  }
  
  console.log(`✅ 本次分析完成: 成功处理 ${successfulBatches} 批，共识别 ${spoilerIds.size} 条剧透`);
  
  if (successfulBatches < totalBatches) {
    console.log(`ℹ️ 注意: 还有 ${totalBatches - successfulBatches} 批未处理（受API限流保护）`);
    console.log('💡 提示: 已识别的剧透会被缓存，刷新页面可继续使用当前结果');
  }
  
  // 缓存结果
  const result = {
    episodeId,
    spoilerIds: Array.from(spoilerIds),
    analyzedAt: Date.now(),
    totalDanmaku: danmakuList.length,
    spoilerCount: spoilerIds.size
  };
  
  console.log('✅ 分析完成:', result);
  
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

  console.log(`发送API请求，Token估计: ${prompt.length / 2}`);

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
    const errorText = await response.text();
    console.error('API错误响应:', errorText);
    throw new Error(`Kimi API请求失败: ${response.status} - ${errorText}`);
  }
  
  const data = await response.json();
  console.log('API调用成功，Token使用:', data.usage);
  
  return data.choices[0].message.content;
}

// 解析Kimi API返回的剧透索引
function parseSpoilerIndices(result) {
  if (!result || result === '无' || result.includes('没有剧透')) {
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
      console.log('清理过期缓存:', key);
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