/* ============================================================
   暖暖小窝 - Background Service Worker
   管理 WebSocket 连接、自动更新、角标计数
   ============================================================ */

let ws = null;
let currentUsername = '';
let serverHttpUrl = '';
let unreadCount = 0;

// 监听来自 popup 的消息
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'connect') {
    serverHttpUrl = msg.serverUrl.replace('ws://', 'http://').replace(/:\d+$/, ':9000');
    connectWS(msg.serverUrl, msg.username)
      .then(() => {
        checkForUpdate();
        sendResponse({ success: true });
      })
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  } else if (msg.type === 'disconnect') {
    disconnectWS();
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
  } else if (msg.type === 'get-unread') {
    sendResponse({ count: unreadCount });
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
  unreadCount = 0;
  chrome.action.setBadgeText({ text: '' });
}

async function checkForUpdate() {
  if (!serverHttpUrl) return;

  try {
    const response = await fetch(serverHttpUrl + '/api/version');
    const data = await response.json();
    const currentVersion = chrome.runtime.getManifest().version;

    if (data.version && data.version !== currentVersion) {
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
