/* ============================================================
   暖暖小窝 - Background Service Worker
   管理 WebSocket 连接
   ============================================================ */

let ws = null;
let currentUsername = '';

// 监听来自 popup 的消息
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'connect') {
    connectWS(msg.serverUrl, msg.username)
      .then(() => sendResponse({ success: true }))
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true; // 异步响应
  } else if (msg.type === 'disconnect') {
    disconnectWS();
    sendResponse({ success: true });
  } else if (msg.type === 'ws-send') {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg.data));
    }
    sendResponse({ success: true });
  }
});

async function connectWS(serverUrl, username) {
  return new Promise((resolve, reject) => {
    // 关闭旧连接
    if (ws) {
      ws.close();
      ws = null;
    }

    currentUsername = username;

    try {
      ws = new WebSocket(serverUrl);
    } catch (e) {
      reject(new Error('无效的服务器地址'));
      return;
    }

    ws.onopen = () => {
      // 发送 join 消息
      ws.send(JSON.stringify({
        type: 'join',
        username: username
      }));
      resolve();
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        // 转发给 popup
        chrome.runtime.sendMessage({
          type: 'ws-message',
          data: data
        }).catch(() => {
          // popup 可能已关闭，忽略
        });
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

    // 超时处理
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
}
