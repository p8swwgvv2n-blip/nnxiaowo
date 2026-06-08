/* ============================================================
   暖暖小窝 - Background Service Worker
   管理 WebSocket 连接、自动更新、角标计数、会话保持
   ============================================================ */

let ws = null;
let currentUsername = '';
let serverHttpUrl = '';
let serverWsUrl = '';
let unreadCount = 0;
let roomState = null;
let lanIps = [];
let isReconnecting = false;

// ============================================================
// 保持 Service Worker 存活 (Manifest V3 会杀死空闲的 SW)
// 使用自连接 port + alarms 双重保活
// ============================================================
let keepAlivePort = null;

function startKeepAlive() {
  if (keepAlivePort) return;
  try {
    keepAlivePort = chrome.runtime.connect({ name: 'keepalive' });
    keepAlivePort.onDisconnect.addListener(() => {
      keepAlivePort = null;
      // 如果还有用户名，说明应该保持连接，重新建立 port
      if (currentUsername) {
        setTimeout(startKeepAlive, 1000);
      }
    });
  } catch(e) {}
}

function stopKeepAlive() {
  if (keepAlivePort) {
    try { keepAlivePort.disconnect(); } catch(e) {}
    keepAlivePort = null;
  }
}

// alarms 作为备用保活机制
chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send('ping'); } catch(e) {}
      console.log('[keepalive] ping sent, ws still alive');
    } else if (!isReconnecting && currentUsername && serverWsUrl) {
      console.log('[keepalive] ws disconnected, attempting reconnect...');
      autoReconnect();
    }
    // 确保 keepalive port 存在
    if (currentUsername && !keepAlivePort) {
      console.log('[keepalive] port lost, restarting keepalive');
      startKeepAlive();
    }
  }
});

// ============================================================
// 自动重连
// ============================================================
async function autoReconnect() {
  if (isReconnecting || !currentUsername || !serverWsUrl) return;
  isReconnecting = true;

  try {
    await connectWS(serverWsUrl, currentUsername);
    // 重连成功后请求完整状态同步
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'sync-request' }));
    }
  } catch(e) {
    console.error('自动重连失败:', e);
  } finally {
    isReconnecting = false;
  }
}

// ============================================================
// 监听来自 popup 的消息
// ============================================================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'connect') {
    serverWsUrl = msg.serverUrl;
    serverHttpUrl = msg.serverUrl.replace('ws://', 'http://').replace(/:\d+$/, ':9000');
    connectWS(msg.serverUrl, msg.username)
      .then(() => {
        chrome.storage.local.set({
          session: { username: msg.username, serverUrl: msg.serverUrl }
        });
        checkForUpdate();
        // 请求状态同步
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'sync-request' }));
        }
        sendResponse({ success: true });
      })
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  } else if (msg.type === 'disconnect') {
    disconnectWS();
    chrome.storage.local.remove('session');
    sendResponse({ success: true });
  } else if (msg.type === 'ws-send') {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg.data));
    }
    sendResponse({ success: true });
  } else if (msg.type === 'clear-badge') {
    unreadCount = 0;
    chrome.action.setBadgeText({ text: '' });
    sendResponse({ success: true });
  } else if (msg.type === 'get-session') {
    const isConnected = ws && ws.readyState === WebSocket.OPEN;
    sendResponse({
      isConnected: isConnected,
      username: currentUsername,
      serverUrl: serverWsUrl,
      members: roomState ? roomState.members : [],
      lanIps: lanIps,
      unreadCount: unreadCount
    });
  } else if (msg.type === 'reconnect') {
    chrome.storage.local.get(['session'], async (result) => {
      if (result.session && result.session.username && result.session.serverUrl) {
        serverWsUrl = result.session.serverUrl;
        serverHttpUrl = result.session.serverUrl.replace('ws://', 'http://').replace(/:\d+$/, ':9000');
        try {
          await connectWS(result.session.serverUrl, result.session.username);
          checkForUpdate();
          // 请求状态同步
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'sync-request' }));
          }
          sendResponse({ success: true, session: result.session });
        } catch(e) {
          sendResponse({ success: false, error: e.message });
        }
      } else {
        sendResponse({ success: false, error: '无保存的会话' });
      }
    });
    return true;
  } else if (msg.type === 'get-badge') {
    sendResponse({ count: unreadCount });
  }
});

// ============================================================
// WebSocket 连接
// ============================================================
async function connectWS(serverUrl, username) {
  return new Promise((resolve, reject) => {
    if (ws) {
      ws.close();
      ws = null;
    }

    currentUsername = username;
    unreadCount = 0;
    chrome.action.setBadgeText({ text: '' });

    try {
      ws = new WebSocket(serverUrl);
    } catch (e) {
      reject(new Error('无效的服务器地址'));
      return;
    }

    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: 'join',
        username: username
      }));
      // 连接成功后启动 keepalive
      startKeepAlive();
      resolve();
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        // 保存房间状态
        if (data.type === 'room-joined') {
          roomState = data;
          lanIps = data.lan_ips || [];
        } else if (data.type === 'member-joined' || data.type === 'member-left') {
          if (roomState) {
            roomState.members = data.members || [];
          }
        } else if (data.type === 'sync') {
          // 完整状态同步
          if (data.state) {
            roomState = {
              members: data.members || [],
              state: data.state,
              lan_ips: lanIps
            };
          }
        }

        // 聊天消息增加角标
        if (data.type === 'chat' && data.message && data.message.to === currentUsername) {
          unreadCount++;
          chrome.action.setBadgeText({ text: String(unreadCount) });
          chrome.action.setBadgeBackgroundColor({ color: '#E85D4A' });
        }

        chrome.runtime.sendMessage({
          type: 'ws-message',
          data: data
        }).catch(() => {});
      } catch (e) {
        console.error('消息解析错误:', e);
      }
    };

    ws.onerror = () => {
      chrome.runtime.sendMessage({
        type: 'ws-error',
        error: '无法连接服务器，请检查服务器地址'
      }).catch(() => {});
      reject(new Error('无法连接服务器'));
    };

    ws.onclose = () => {
      // 不清除 roomState，等待重连
      chrome.runtime.sendMessage({
        type: 'ws-disconnected'
      }).catch(() => {});

      // 自动重连（如果不是手动断开）
      if (!isReconnecting && currentUsername && serverWsUrl) {
        setTimeout(() => autoReconnect(), 3000);
      }
    };

    setTimeout(() => {
      if (ws && ws.readyState === WebSocket.CONNECTING) {
        ws.close();
        reject(new Error('连接超时'));
      }
    }, 10000);
  });
}

function disconnectWS() {
  stopKeepAlive();
  if (ws) {
    ws.close();
    ws = null;
  }
  currentUsername = '';
  serverWsUrl = '';
  serverHttpUrl = '';
  roomState = null;
  lanIps = [];
  unreadCount = 0;
  chrome.action.setBadgeText({ text: '' });
}

// ============================================================
// 版本检查
// ============================================================
function compareVersion(v1, v2) {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);
  const len = Math.max(parts1.length, parts2.length);
  for (let i = 0; i < len; i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 < p2) return -1;
    if (p1 > p2) return 1;
  }
  return 0;
}

async function checkForUpdate() {
  if (!serverHttpUrl) return;

  try {
    const response = await fetch(serverHttpUrl + '/api/version');
    const data = await response.json();
    const currentVersion = chrome.runtime.getManifest().version;

    if (data.version && compareVersion(currentVersion, data.version) < 0) {
      chrome.runtime.sendMessage({
        type: 'update-available',
        currentVersion: currentVersion,
        newVersion: data.version,
        updateUrl: serverHttpUrl + (data.update_url || '/extension/')
      }).catch(() => {});
    }
  } catch (e) {
    console.error('检查更新失败:', e);
  }
}
