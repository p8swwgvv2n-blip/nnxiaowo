/* ============================================================
   暖暖小窝 - Background Service Worker
   管理 WebSocket 连接、自动更新、角标计数、会话保持
   ============================================================ */

let ws = null;
let currentUsername = '';
let serverHttpUrl = '';
let serverWsUrl = '';
let unreadCount = 0;
let roomState = null; // 保存房间状态
let lanIps = [];

// 监听来自 popup 的消息
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'connect') {
    serverWsUrl = msg.serverUrl;
    serverHttpUrl = msg.serverUrl.replace('ws://', 'http://').replace(/:\d+$/, ':9000');
    connectWS(msg.serverUrl, msg.username)
      .then(() => {
        // 保存会话
        chrome.storage.local.set({
          session: { username: msg.username, serverUrl: msg.serverUrl }
        });
        checkForUpdate();
        sendResponse({ success: true });
      })
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  } else if (msg.type === 'disconnect') {
    disconnectWS();
    // 清除会话
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
    // 返回当前会话状态
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
    // 从保存的会话恢复连接
    chrome.storage.local.get(['session'], (result) => {
      if (result.session && result.session.username && result.session.serverUrl) {
        serverWsUrl = result.session.serverUrl;
        serverHttpUrl = result.session.serverUrl.replace('ws://', 'http://').replace(/:\d+$/, ':9000');
        connectWS(result.session.serverUrl, result.session.username)
          .then(() => {
            checkForUpdate();
            sendResponse({ success: true, session: result.session });
          })
          .catch(e => sendResponse({ success: false, error: e.message }));
      } else {
        sendResponse({ success: false, error: '无保存的会话' });
      }
    });
    return true;
  }
});

async function connectWS(serverUrl, username) {
  return new Promise((resolve, reject) => {
    if (ws) {
      ws.close();
      ws = null;
    }

    currentUsername = username;
    unreadCount = 0;
    roomState = null;
    lanIps = [];
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
      roomState = null;
      chrome.runtime.sendMessage({
        type: 'ws-disconnected'
      }).catch(() => {});
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
  if (ws) {
    ws.close();
    ws = null;
  }
  currentUsername = '';
  roomState = null;
  lanIps = [];
  unreadCount = 0;
  chrome.action.setBadgeText({ text: '' });
}

// 语义化版本比较：返回 -1 (v1<v2), 0 (相等), 1 (v1>v2)
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

    // 只在服务器版本 > 本地版本时提示更新
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
