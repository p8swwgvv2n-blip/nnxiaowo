/* ============================================================
   暖暖小窝 - 浏览器插件版 JavaScript
   ============================================================ */

// 全局变量
let myUsername = '';
let members = [];
let chatHistory = {};
let todos = [];
let foods = ['黄焖鸡', '麻辣烫', '牛肉面', '寿司', '炸鸡', '沙拉', '饺子', '螺蛳粉'];
let currentChat = null;
let todoFilter = 'all';
let quoteMsg = null; // 引用的消息

// ============================================================
// 端到端加密 (E2EE) 模块
// 使用 ECDH 密钥交换 + AES-GCM 对称加密
// ============================================================
const e2ee = {
  myKeyPair: null,      // {publicKey, privateKey} - CryptoKey
  sharedKeys: {},       // chatKey -> CryptoKey (AES-GCM)

  // 生成 ECDH 密钥对
  async generateKeyPair() {
    this.myKeyPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveKey']
    );
  },

  // 导出公钥为 Base64
  async exportPublicKey() {
    const exported = await crypto.subtle.exportKey('raw', this.myKeyPair.publicKey);
    return btoa(String.fromCharCode(...new Uint8Array(exported)));
  },

  // 导入对方公钥并派生共享密钥
  async deriveSharedKey(peerPublicKeyB64, chatKey) {
    if (this.sharedKeys[chatKey]) return this.sharedKeys[chatKey];

    const peerPublicKeyBytes = Uint8Array.from(atob(peerPublicKeyB64), c => c.charCodeAt(0));
    const peerPublicKey = await crypto.subtle.importKey(
      'raw',
      peerPublicKeyBytes,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      []
    );

    const sharedKey = await crypto.subtle.deriveKey(
      { name: 'ECDH', public: peerPublicKey },
      this.myKeyPair.privateKey,
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );

    this.sharedKeys[chatKey] = sharedKey;
    return sharedKey;
  },

  // 加密消息
  async encrypt(plainText, chatKey) {
    const key = this.sharedKeys[chatKey];
    if (!key) throw new Error('未建立加密密钥');

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plainText);

    const cipherBuffer = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv },
      key,
      encoded
    );

    return {
      ciphertext: btoa(String.fromCharCode(...new Uint8Array(cipherBuffer))),
      iv: btoa(String.fromCharCode(...iv))
    };
  },

  // 解密消息
  async decrypt(ciphertextB64, ivB64, chatKey) {
    const key = this.sharedKeys[chatKey];
    if (!key) throw new Error('未建立加密密钥');

    const cipherBytes = Uint8Array.from(atob(ciphertextB64), c => c.charCodeAt(0));
    const ivBytes = Uint8Array.from(atob(ivB64), c => c.charCodeAt(0));

    const plainBuffer = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: ivBytes },
      key,
      cipherBytes
    );

    return new TextDecoder().decode(plainBuffer);
  }
};

const avatarColors = ['#E89AB2','#B89AD4','#9AB8E8','#E8C49A','#9AD4C8','#E89A9A','#A8D49A','#D4D49A'];
function getColor(name) { let h=0; for(let i=0;i<name.length;i++) h=name.charCodeAt(i)+((h<<5)-h); return avatarColors[Math.abs(h)%avatarColors.length]; }
function getInitial(name) { return name.charAt(0); }
function formatTime(d) { return d.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}); }
function getChatKey(a, b) { return [a, b].sort().join('<->'); }

function showStatus(msg, type) {
  const el = document.getElementById('login-status');
  el.textContent = msg;
  el.className = 'login-status ' + (type || '');
}

function clearStatus() {
  document.getElementById('login-status').textContent = '';
}

// ============================================================
// 自动更新提示
// ============================================================
function showUpdateBanner(currentVer, newVer, updateUrl) {
  const banner = document.getElementById('update-banner');
  if (!banner) return;
  banner.innerHTML = `
    <span>发现新版本 ${newVer}（当前 ${currentVer}）</span>
    <button class="btn btn-primary" style="padding:4px 10px;font-size:11px;" onclick="window.open('${updateUrl}', '_blank')">下载更新</button>
    <span style="cursor:pointer;opacity:0.5;" onclick="this.parentElement.style.display='none'">×</span>
  `;
  banner.style.display = 'flex';
}

// ============================================================
// 连接管理
// ============================================================
function connect() {
  myUsername = document.getElementById('username-input').value.trim();
  const serverUrl = document.getElementById('server-input').value.trim();

  if (!myUsername) { showStatus('请先输入昵称', 'error'); return; }
  if (!serverUrl) { showStatus('请输入服务器地址', 'error'); return; }

  showStatus('正在连接...', '');

  // 通过 background script 连接
  chrome.runtime.sendMessage({
    type: 'connect',
    username: myUsername,
    serverUrl: serverUrl
  }, (response) => {
    if (response && response.success) {
      // 连接成功，等待 room-joined 消息
    } else {
      showStatus(response ? response.error : '连接失败', 'error');
    }
  });
}

function disconnect() {
  chrome.runtime.sendMessage({ type: 'disconnect' });
  document.getElementById('app-shell').classList.remove('active');
  document.getElementById('login-page').style.display = 'flex';
  myUsername = '';
  members = [];
  chatHistory = {};
  todos = [];
  currentChat = null;
  document.getElementById('lan-ip-display').style.display = 'none';
  document.getElementById('lan-ip-display').textContent = '';
  document.getElementById('quote-bar').style.display = 'none';
  quoteMsg = null;
}

// 监听来自 background 的消息
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'ws-message') {
    handleMessage(msg.data);
  } else if (msg.type === 'ws-error') {
    showStatus(msg.error, 'error');
  } else if (msg.type === 'ws-disconnected') {
    // 不立即显示断开提示，等待自动重连
    // 3秒后如果仍未连接则显示提示
    setTimeout(() => {
      chrome.runtime.sendMessage({ type: 'get-session' }, (session) => {
        if (session && !session.isConnected) {
          showStatus('服务器连接断开，正在重连...', 'error');
        }
      });
    }, 3000);
  } else if (msg.type === 'update-available') {
    showUpdateBanner(msg.currentVersion, msg.newVersion, msg.updateUrl);
  }
});

function send(data) {
  chrome.runtime.sendMessage({ type: 'ws-send', data: data });
}

// ============================================================
// 消息处理
// ============================================================
function handleMessage(data) {
  switch(data.type) {
    case 'room-joined':
      members = data.members || [];
      if (data.state) {
        chatHistory = data.state.chat_history || {};
        todos = data.state.todos || [];
        foods = data.state.foods || foods;
      }
      if (data.lan_ips) {
        showLanIps(data.lan_ips);
      }
      enterApp();
      break;

    case 'member-joined':
      members = data.members || [];
      updateMemberCount();
      renderContacts();
      break;

    case 'member-left':
      members = data.members || [];
      updateMemberCount();
      renderContacts();
      break;

    case 'e2ee-key-offer':
      // 收到对方公钥，派生共享密钥并回复自己的公钥
      (async () => {
        const peerName = data.from;
        const chatKey = getChatKey(myUsername, peerName);
        await e2ee.deriveSharedKey(data.public_key, chatKey);
        // 回复公钥
        const myPub = await e2ee.exportPublicKey();
        send({ type: 'e2ee-key-answer', public_key: myPub, to_user: peerName });
      })();
      break;

    case 'e2ee-key-answer':
      // 收到对方回复的公钥，派生共享密钥
      (async () => {
        const peerName = data.from;
        const chatKey = getChatKey(myUsername, peerName);
        await e2ee.deriveSharedKey(data.public_key, chatKey);
      })();
      break;

    case 'chat':
      // 解密消息
      (async () => {
        const msg = data.message;
        const ck = getChatKey(msg.from, msg.to);
        if (msg.encrypted && msg.ciphertext && msg.iv) {
          try {
            const plainText = await e2ee.decrypt(msg.ciphertext, msg.iv, ck);
            const parsed = JSON.parse(plainText);
            msg.text = parsed.text || '';
            msg.quote = parsed.quote || null;
            msg.encrypted = false;
          } catch(e) {
            msg.text = '🔒 无法解密此消息';
          }
        }
        if (!chatHistory[ck]) chatHistory[ck] = [];
        chatHistory[ck].push(msg);
        if (currentChat && (msg.from === currentChat || msg.to === currentChat)) {
          renderMessages();
        }
        renderContacts();
        if (msg.to === myUsername) playNotificationSound();
      })();
      break;

    case 'chat-receipt':
      break;

    case 'chat-read-notify':
      const rk = data.chat_key;
      const rids = data.msg_ids || [];
      if (chatHistory[rk]) {
        chatHistory[rk].forEach(m => {
          if (rids.includes(m.id)) m.read = true;
        });
      }
      if (currentChat) {
        const curKey = getChatKey(myUsername, currentChat);
        if (curKey === rk) renderMessages();
      }
      renderContacts();
      break;

    case 'todo-added':
      todos.push(data.todo);
      renderTodos();
      break;

    case 'todo-toggled':
      const t = todos.find(t => t.id === data.id);
      if (t) t.done = !t.done;
      renderTodos();
      break;

    case 'todo-deleted':
      todos = todos.filter(t => t.id !== data.id);
      renderTodos();
      break;

    case 'food-added':
      if (!foods.includes(data.food)) foods.push(data.food);
      renderFoodTags();
      renderWheel();
      break;

    case 'food-removed':
      foods = foods.filter(f => f !== data.food);
      renderFoodTags();
      renderWheel();
      break;

    case 'kicked':
      showStatus(data.message || '你已在其他设备登录', 'error');
      setTimeout(disconnect, 2000);
      break;

    case 'sync':
      // 完整状态同步（重连后恢复历史）
      if (data.state) {
        chatHistory = data.state.chat_history || {};
        todos = data.state.todos || [];
        foods = data.state.foods || foods;
      }
      if (data.members) {
        members = data.members;
        updateMemberCount();
      }
      renderAll();
      break;

    case 'error':
      showStatus(data.message || '发生错误', 'error');
      break;
  }
}

// ============================================================
// 进入应用
// ============================================================
async function enterApp() {
  document.getElementById('login-page').style.display = 'none';
  document.getElementById('app-shell').classList.add('active');
  updateMemberCount();
  renderAll();

  // 生成 ECDH 密钥对
  await e2ee.generateKeyPair();

  // 广播公钥给所有在线成员
  const pubKey = await e2ee.exportPublicKey();
  send({ type: 'e2ee-key-offer', public_key: pubKey });

  // 清除角标
  chrome.runtime.sendMessage({ type: 'clear-badge' });
}

function showLanIps(ips) {
  const ipDisplay = document.getElementById('lan-ip-display');
  if (ipDisplay && ips && ips.length > 0) {
    const filteredIps = ips.filter(ip => !ip.startsWith('127.'));
    if (filteredIps.length > 0) {
      ipDisplay.textContent = filteredIps.join(' / ');
      ipDisplay.style.display = 'inline';
    }
  }
}

function updateMemberCount() {
  document.getElementById('member-count').textContent = members.length + ' 人在线';
}

function renderAll() {
  renderContacts();
  renderTodos();
  renderWheel();
  renderFoodTags();
}

// ============================================================
// 联系人渲染
// ============================================================
function renderContacts() {
  const list = document.getElementById('contact-list');
  const search = document.getElementById('contact-search-input').value.toLowerCase();
  const others = members.filter(m => m !== myUsername).filter(m => !search || m.toLowerCase().includes(search));

  list.innerHTML = others.map(name => {
    const chatKey = getChatKey(myUsername, name);
    const msgs = chatHistory[chatKey] || [];
    const last = msgs[msgs.length - 1];
    const unread = msgs.filter(m => m.to === myUsername && !m.read).length;
    const color = getColor(name);
    const isOnline = members.includes(name);
    return `
      <div class="contact-item ${currentChat === name ? 'active' : ''}" data-name="${name}">
        <div class="contact-avatar" style="background:${color}">
          ${getInitial(name)}
          <span class="online-dot ${isOnline ? 'online' : 'offline'}"></span>
        </div>
        <div class="contact-info">
          <div class="contact-name">${name}</div>
          <div class="contact-last">${last ? last.text.substring(0, 15) : '暂无消息'}</div>
        </div>
      </div>
    `;
  }).join('');

  list.querySelectorAll('.contact-item').forEach(item => {
    item.addEventListener('click', () => {
      currentChat = item.dataset.name;
      document.getElementById('chat-empty').style.display = 'none';
      document.getElementById('chat-active-view').style.display = 'flex';
      document.getElementById('chat-header-name').textContent = currentChat;
      renderMessages();
      renderContacts();
    });
  });
}

// ============================================================
// 消息渲染
// ============================================================
function renderMessages() {
  if (!currentChat) return;
  const container = document.getElementById('chat-messages');
  const chatKey = getChatKey(myUsername, currentChat);
  const msgs = chatHistory[chatKey] || [];

  container.innerHTML = msgs.map((m, idx) => {
    const isSent = m.from === myUsername;
    const readLabel = isSent ? (m.read ? '已读' : '未读') : '';
    const readClass = isSent ? (m.read ? 'read' : 'unread') : '';
    const quoteHtml = m.quote ? `<div class="msg-quote"><span class="quote-author">${m.quote.from}:</span> ${m.quote.text}</div>` : '';
    return `
      <div class="msg-row ${isSent ? 'sent' : 'received'}">
        <div>
          ${quoteHtml}
          <div class="msg-bubble">${m.text}</div>
          <div class="msg-time">
            ${formatTime(new Date(m.time))}
            ${isSent ? `<span class="msg-read-status ${readClass}">${readLabel}</span>` : ''}
            <span class="msg-quote-btn" data-idx="${idx}" title="引用回复">↩</span>
          </div>
        </div>
      </div>
    `;
  }).join('');

  container.scrollTop = container.scrollHeight;

  // 引用按钮事件
  container.querySelectorAll('.msg-quote-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx);
      const msg = msgs[idx];
      if (msg) setQuote(msg);
    });
  });

  markAsRead();
}

function setQuote(msg) {
  quoteMsg = { from: msg.from, text: msg.text, id: msg.id };
  const bar = document.getElementById('quote-bar');
  bar.innerHTML = `
    <div class="quote-bar-content">
      <span class="quote-bar-author">${msg.from}:</span>
      <span class="quote-bar-text">${msg.text.substring(0, 30)}${msg.text.length > 30 ? '...' : ''}</span>
    </div>
    <span class="quote-bar-cancel" title="取消引用">×</span>
  `;
  bar.style.display = 'flex';

  bar.querySelector('.quote-bar-cancel').addEventListener('click', () => {
    quoteMsg = null;
    bar.style.display = 'none';
  });

  document.getElementById('chat-input').focus();
}

function markAsRead() {
  if (!currentChat) return;
  const chatKey = getChatKey(myUsername, currentChat);
  const msgs = chatHistory[chatKey] || [];
  const unreadIds = msgs.filter(m => m.to === myUsername && !m.read).map(m => m.id);

  if (unreadIds.length === 0) return;

  msgs.forEach(m => {
    if (m.to === myUsername && !m.read) m.read = true;
  });

  send({
    type: 'chat-read',
    chat_key: chatKey,
    msg_ids: unreadIds,
    to_user: currentChat
  });

  renderContacts();
}

// ============================================================
// 发送消息
// ============================================================
async function sendChat() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text || !currentChat) return;

  const msgId = 'msg-' + Date.now();
  const msg = {
    id: msgId,
    from: myUsername,
    to: currentChat,
    text: text,
    time: new Date().toISOString(),
    read: false
  };

  if (quoteMsg) {
    msg.quote = { from: quoteMsg.from, text: quoteMsg.text, id: quoteMsg.id };
  }

  const chatKey = getChatKey(myUsername, currentChat);
  if (!chatHistory[chatKey]) chatHistory[chatKey] = [];
  chatHistory[chatKey].push(msg);
  renderMessages();
  renderContacts();

  // 尝试加密消息
  const sendData = {
    type: 'chat',
    msg_id: msgId,
    to_user: currentChat
  };

  const sharedKey = e2ee.sharedKeys[chatKey];
  if (sharedKey) {
    const payload = { text: text };
    if (quoteMsg) {
      payload.quote = { from: quoteMsg.from, text: quoteMsg.text, id: quoteMsg.id };
    }
    const encrypted = await e2ee.encrypt(JSON.stringify(payload), chatKey);
    sendData.encrypted = true;
    sendData.ciphertext = encrypted.ciphertext;
    sendData.iv = encrypted.iv;
  } else {
    // 未建立加密密钥时回退到明文（仅初始连接阶段）
    sendData.text = text;
    if (quoteMsg) {
      sendData.quote = { from: quoteMsg.from, text: quoteMsg.text, id: quoteMsg.id };
    }
    // 同时触发密钥交换
    const myPub = await e2ee.exportPublicKey();
    send({ type: 'e2ee-key-offer', public_key: myPub, to_user: currentChat });
  }

  send(sendData);

  input.value = '';
  input.style.height = 'auto';

  // 清除引用
  quoteMsg = null;
  document.getElementById('quote-bar').style.display = 'none';
}

// ============================================================
// 待办渲染
// ============================================================
function renderTodos() {
  const list = document.getElementById('todo-list');
  const filtered = todos.filter(t => {
    if (todoFilter === 'active') return !t.done;
    if (todoFilter === 'done') return t.done;
    return true;
  });

  document.getElementById('todo-total').textContent = todos.length;
  document.getElementById('todo-done').textContent = todos.filter(t => t.done).length;

  list.innerHTML = filtered.map(t => `
    <div class="todo-item ${t.done ? 'done' : ''}">
      <div class="todo-checkbox ${t.done ? 'checked' : ''}" data-id="${t.id}"></div>
      <span class="todo-text">${t.text}</span>
      <span class="todo-priority-tag ${t.priority}">${t.priority === 'high' ? '高' : t.priority === 'medium' ? '中' : '低'}</span>
      <button class="todo-delete" data-id="${t.id}">×</button>
    </div>
  `).join('');

  list.querySelectorAll('.todo-checkbox').forEach(cb => {
    cb.addEventListener('click', () => {
      send({ type: 'todo-toggle', id: cb.dataset.id });
    });
  });

  list.querySelectorAll('.todo-delete').forEach(btn => {
    btn.addEventListener('click', () => {
      send({ type: 'todo-delete', id: btn.dataset.id });
    });
  });
}

// ============================================================
// 午餐转盘
// ============================================================
let wheelRotation = 0;
let isSpinning = false;

function renderWheel() {
  const svg = document.getElementById('wheel-svg');
  if (foods.length === 0) {
    svg.innerHTML = '<circle cx="100" cy="100" r="100" fill="#F7F3DF"/><text x="100" y="105" text-anchor="middle" fill="#9A8B7A" font-size="14">添加食物选项</text>';
    return;
  }

  const sliceAngle = 360 / foods.length;
  const colors = ['#E89AB2','#B89AD4','#9AB8E8','#E8C49A','#9AD4C8','#E89A9A','#A8D49A','#D4D49A'];

  let paths = '';
  foods.forEach((food, i) => {
    const startAngle = i * sliceAngle;
    const endAngle = startAngle + sliceAngle;
    const startRad = (startAngle - 90) * Math.PI / 180;
    const endRad = (endAngle - 90) * Math.PI / 180;
    const x1 = 100 + 100 * Math.cos(startRad);
    const y1 = 100 + 100 * Math.sin(startRad);
    const x2 = 100 + 100 * Math.cos(endRad);
    const y2 = 100 + 100 * Math.sin(endRad);
    const largeArc = sliceAngle > 180 ? 1 : 0;

    const midAngle = (startAngle + endAngle) / 2;
    const midRad = (midAngle - 90) * Math.PI / 180;
    const textX = 100 + 60 * Math.cos(midRad);
    const textY = 100 + 60 * Math.sin(midRad);
    const textRotation = midAngle > 180 ? midAngle - 270 : midAngle - 90;

    paths += `<path d="M100,100 L${x1},${y1} A100,100 0 ${largeArc},1 ${x2},${y2} Z" fill="${colors[i % colors.length]}"/>`;
    paths += `<text x="${textX}" y="${textY}" text-anchor="middle" dominant-baseline="middle" fill="#794F27" font-size="11" font-weight="700" transform="rotate(${textRotation}, ${textX}, ${textY})">${food.substring(0, 4)}</text>`;
  });

  svg.innerHTML = paths;
}

function spinWheel() {
  if (isSpinning || foods.length === 0) return;
  isSpinning = true;

  const wheel = document.getElementById('lunch-wheel');
  const result = document.getElementById('lunch-result');
  const btn = document.getElementById('spin-btn');

  result.style.display = 'none';
  btn.disabled = true;

  const extraRotations = 5 * 360;
  const randomAngle = Math.random() * 360;
  wheelRotation += extraRotations + randomAngle;

  wheel.style.transform = `rotate(${wheelRotation}deg)`;

  setTimeout(() => {
    const normalizedAngle = (360 - (wheelRotation % 360)) % 360;
    const sliceAngle = 360 / foods.length;
    const winnerIndex = Math.floor(normalizedAngle / sliceAngle);
    const winner = foods[winnerIndex % foods.length];

    result.style.display = 'block';
    document.getElementById('result-text').textContent = '今天就吃：' + winner + '！';
    btn.disabled = false;
    isSpinning = false;
  }, 3200);
}

function renderFoodTags() {
  const container = document.getElementById('food-tags');
  container.innerHTML = foods.map(f => `
    <span class="food-tag">
      ${f}
      <span class="food-tag-remove" data-food="${f}">×</span>
    </span>
  `).join('');

  container.querySelectorAll('.food-tag-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      send({ type: 'food-remove', food: btn.dataset.food });
    });
  });
}

// ============================================================
// 提示音
// ============================================================
function playNotificationSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.setValueAtTime(1100, ctx.currentTime + 0.1);
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.3);
  } catch(e) {}
}

// ============================================================
// 初始化
// ============================================================
(function() {
  // 打开插件时清除角标
  chrome.runtime.sendMessage({ type: 'clear-badge' });

  // 检查是否有保存的会话，自动恢复
  chrome.runtime.sendMessage({ type: 'get-session' }, (session) => {
    if (session && session.isConnected && session.username) {
      // 已连接，直接进入应用
      myUsername = session.username;
      members = session.members || [];
      if (session.lanIps && session.lanIps.length > 0) {
        showLanIps(session.lanIps);
      }
      enterApp();
    } else if (session && session.serverUrl && !session.isConnected) {
      // 有会话但断开了，尝试重连
      showStatus('正在恢复连接...', '');
      chrome.runtime.sendMessage({ type: 'reconnect' }, (response) => {
        if (response && response.success) {
          // 重连成功，等待 room-joined
        } else {
          // 重连失败，显示登录页
          clearStatus();
        }
      });
    }
    // 否则显示登录页
  });

  // 从存储恢复服务器地址
  chrome.storage.local.get(['serverUrl'], (result) => {
    if (result.serverUrl) {
      document.getElementById('server-input').value = result.serverUrl;
    }
  });

  // 进入按钮
  document.getElementById('enter-btn').addEventListener('click', () => {
    // 保存服务器地址
    const serverUrl = document.getElementById('server-input').value.trim();
    chrome.storage.local.set({ serverUrl: serverUrl });
    connect();
  });

  document.getElementById('username-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('enter-btn').click();
  });

  // 退出
  document.getElementById('leave-room-btn').addEventListener('click', disconnect);

  // 标签页切换
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.page).classList.add('active');
    });
  });

  // 聊天输入
  const chatInput = document.getElementById('chat-input');
  chatInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
  chatInput.addEventListener('input', () => {
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 80) + 'px';
  });
  document.getElementById('send-btn').addEventListener('click', sendChat);

  // 联系人搜索
  document.getElementById('contact-search-input').addEventListener('input', renderContacts);

  // 待办
  document.getElementById('todo-add-btn').addEventListener('click', () => {
    const input = document.getElementById('todo-input');
    const priority = document.getElementById('todo-priority').value;
    const text = input.value.trim();
    if (!text) return;
    send({
      type: 'todo-add',
      todo: { id: 'todo-' + Date.now(), text: text, priority: priority, done: false }
    });
    input.value = '';
  });
  document.getElementById('todo-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('todo-add-btn').click();
  });

  document.querySelectorAll('.filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      todoFilter = chip.dataset.filter;
      renderTodos();
    });
  });

  // 午餐
  document.getElementById('spin-btn').addEventListener('click', spinWheel);
  document.getElementById('food-add-btn').addEventListener('click', () => {
    const input = document.getElementById('food-input');
    const food = input.value.trim();
    if (!food) return;
    send({ type: 'food-add', food: food });
    input.value = '';
  });
  document.getElementById('food-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('food-add-btn').click();
  });
})();
