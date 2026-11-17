
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 2e6 });

const PORT = process.env.PORT || 3000;
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';
const AI_API_KEY = process.env.OPENAI_API_KEY || '';
const AI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const DATA_FILE = path.join(__dirname, 'data.json');
const UPLOAD_DIR = path.join(__dirname, 'uploads');

if (ADMIN_SECRET.length < 8) {
  console.error('ADMIN_SECRETに8文字以上を設定してください');
  process.exit(1);
}

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ROLES = ['Owner', 'Admin', 'Moderator', 'Member', 'Regular'];

const PERMISSION_LABELS = {
  kick: 'キック',
  ban: 'BAN',
  unban: 'BAN解除',
  mute: 'ミュート',
  unmute: 'ミュート解除',
  lock: 'チャットロック',
  unlock: 'ロック解除',
  slowmode: 'スローモード',
  pin: 'メッセージ固定',
  unpin: '固定解除',
  ng_add: 'NGワード追加',
  ng_remove: 'NGワード削除',
  clear: '履歴削除'
};

const PERMISSION_KEYS = Object.keys(PERMISSION_LABELS);

const DEFAULT_PERMISSIONS = {
  Owner: Object.fromEntries(PERMISSION_KEYS.map(k => [k, true])),
  Admin: Object.fromEntries(PERMISSION_KEYS.map(k => [k, true])),
  Moderator: Object.fromEntries(PERMISSION_KEYS.map(k => [
    k, ['kick', 'mute', 'unmute', 'slowmode', 'pin', 'unpin'].includes(k)
  ])),
  Member: Object.fromEntries(PERMISSION_KEYS.map(k => [k, false])),
  Regular: Object.fromEntries(PERMISSION_KEYS.map(k => [k, false]))
};

function defaultData() {
  return {
    rolesByUsername: {},
    avatarByUsername: {},
    permissions: JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS)),
    bannedUsers: [],
    mutedUsers: [],
    ngWords: [],
    messages: [],
    rooms: [{ id: 'lobby', name: 'ロビー', passwordHash: null }],
    chatLocked: false,
    slowMode: 0,
    pinnedMessage: null,
    adminLogs: []
  };
}

function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) return defaultData();

    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const d = { ...defaultData(), ...raw };

    d.rolesByUsername ||= {};
    d.avatarByUsername ||= {};
    d.bannedUsers ||= [];
    d.mutedUsers ||= [];
    d.ngWords ||= [];
    d.messages ||= [];
    d.rooms ||= defaultData().rooms;
    d.adminLogs ||= [];

    d.permissions = {
      ...DEFAULT_PERMISSIONS,
      ...(raw.permissions || {})
    };

    for (const role of ROLES) {
      d.permissions[role] = {
        ...DEFAULT_PERMISSIONS[role],
        ...(d.permissions[role] || {})
      };
    }

    // Ownerは常に全権限、Regularは常に管理権限なし
    d.permissions.Owner = { ...DEFAULT_PERMISSIONS.Owner };
    d.permissions.Regular = { ...DEFAULT_PERMISSIONS.Regular };

    d.messages = d.messages.slice(-500);
    d.adminLogs = d.adminLogs.slice(-500);

    return d;
  } catch (error) {
    console.error('data.json読み込みエラー:', error);
    return defaultData();
  }
}

let data = loadData();
const users = new Map();

let saveTimer;

function saveData() {
  clearTimeout(saveTimer);

  saveTimer = setTimeout(() => {
    const temp = DATA_FILE + '.tmp';

    try {
      fs.writeFileSync(temp, JSON.stringify(data, null, 2), {
        mode: 0o600
      });
      fs.renameSync(temp, DATA_FILE);
    } catch (error) {
      console.error('保存エラー:', error);
    }
  }, 100);
}

function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;

  const x = Buffer.from(a);
  const y = Buffer.from(b);

  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function hasPermission(user, permission) {
  if (!user) return false;
  if (user.role === 'Owner') return true;

  return data.permissions[user.role]?.[permission] === true;
}

function roleLevel(role) {
  return ({
    Owner: 5,
    Admin: 4,
    Moderator: 3,
    Member: 2,
    Regular: 1
  })[role] || 0;
}

function notify(socket, message) {
  socket.emit('system_message', message);
}

function logAction(admin, action, target) {
  data.adminLogs.push({
    admin,
    action,
    target,
    time: new Date().toISOString()
  });

  data.adminLogs = data.adminLogs.slice(-500);
  saveData();
}

function findUser(username) {
  if (!username) return null;

  for (const [id, user] of users.entries()) {
    if (user.username.toLowerCase() === username.toLowerCase()) {
      return { id, user };
    }
  }

  return null;
}

function roomById(id) {
  return data.rooms.find(room => room.id === id);
}

function roomMessages(roomId) {
  return data.messages.filter(m => m.roomId === roomId).slice(-200);
}

function publicRooms() {
  return data.rooms.map(room => ({
    id: room.id,
    name: room.name,
    locked: !!room.passwordHash
  }));
}

function userList(roomId) {
  return [...users.values()]
    .filter(user => user.roomId === roomId)
    .map(user => ({
      username: user.username,
      role: user.role,
      avatarUrl: user.avatarUrl || ''
    }));
}

function broadcastUsers(roomId) {
  io.to(roomId).emit('user_list', userList(roomId));
}

function validAvatarUrl(url) {
  if (typeof url !== 'string' || url.length > 1000) return false;

  // 自分のサーバーにアップロードした画像
  if (/^\/uploads\/[a-zA-Z0-9._-]+$/.test(url)) return true;

  // 外部URLはHTTPSのみ許可
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

app.use(express.json({ limit: '1mb' }));
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(__dirname, { index: false }));

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, crypto.randomUUID() + ext);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = /^(image\/(jpeg|png|gif|webp)|video\/(mp4|webm|ogg))$/;
    cb(null, allowed.test(file.mimetype));
  }
});

const avatarUpload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(null, /^image\/(jpeg|png|gif|webp)$/.test(file.mimetype));
  }
});

function handleUpload(middleware, req, res, next) {
  middleware.single('file')(req, res, error => {
    if (error) {
      return res.status(400).json({
        error: 'ファイル形式またはサイズを確認してください'
      });
    }

    const socketId = String(req.body?.socketId || '');
    const user = users.get(socketId);

    if (!user) {
      if (req.file) {
        try { fs.unlinkSync(req.file.path); } catch (_) {}
      }
      return res.status(401).json({ error: 'ログイン状態を確認できません' });
    }

    next(user);
  });
}

app.post('/api/upload', (req, res) => {
  handleUpload(upload, req, res, user => {
    if (!req.file) return res.status(400).json({ error: 'ファイルがありません' });

    res.json({
      url: '/uploads/' + req.file.filename,
      name: req.file.originalname,
      type: req.file.mimetype
    });
  });
});

app.post('/api/avatar', (req, res) => {
  handleUpload(avatarUpload, req, res, user => {
    if (!req.file) return res.status(400).json({ error: '画像を選択してください' });

    const url = '/uploads/' + req.file.filename;
    user.avatarUrl = url;
    data.avatarByUsername[user.username.toLowerCase()] = url;
    saveData();

    io.emit('profile_updated', {
      username: user.username,
      avatarUrl: url
    });

    res.json({ url });
  });
});

app.post('/api/ai', async (req, res) => {
  if (!AI_API_KEY) {
    return res.status(503).json({
      error: 'AI機能は未設定です。OPENAI_API_KEYを設定してください。'
    });
  }

  const prompt = typeof req.body?.prompt === 'string'
    ? req.body.prompt.trim().slice(0, 2000)
    : '';

  if (!prompt) return res.status(400).json({ error: '質問を入力してください' });

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${AI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [
          {
            role: 'system',
            content: 'あなたは親切な日本語アシスタントです。'
          },
          { role: 'user', content: prompt }
        ],
        max_tokens: 500
      })
    });

    const result = await response.json();

    if (!response.ok) {
      console.error('AI API error:', result);
      return res.status(502).json({ error: 'AIから返答を取得できませんでした' });
    }

    res.json({
      answer: result.choices?.[0]?.message?.content || '返答がありません'
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'AI通信エラー' });
  }
});

io.on('connection', socket => {

  socket.on('join', payload => {
    if (users.has(socket.id)) return;

    const username = String(payload?.username || '').trim().slice(0, 20);
    const roomId = String(payload?.roomId || 'lobby');
    const roomPassword = String(payload?.roomPassword || '');

    if (!username) return socket.emit('login_error', 'ユーザー名を入力してください');

    const room = roomById(roomId);
    if (!room) return socket.emit('login_error', 'ルームが見つかりません');

    if (
      room.passwordHash &&
      !safeCompare(hashPassword(roomPassword), room.passwordHash)
    ) {
      return socket.emit('login_error', 'ルームパスワードが違います');
    }

    const key = username.toLowerCase();
    const isOwner = safeCompare(payload?.adminCode, ADMIN_SECRET);

    if (data.bannedUsers.includes(key)) {
      return socket.emit('login_error', 'あなたはBANされています');
    }

    for (const [id, existing] of users.entries()) {
      if (existing.username.toLowerCase() !== key) continue;

      if (!isOwner) {
        return socket.emit('login_error', 'そのユーザー名は使用中です');
      }

      io.to(id).emit('system_message', 'Ownerが再ログインしました');
      users.delete(id);
      io.in(id).disconnectSockets(true);
    }

    let role = isOwner ? 'Owner' : data.rolesByUsername[key];

    if (!ROLES.includes(role) || role === 'Owner') role = 'Regular';
    if (isOwner) role = 'Owner';

    const user = {
      username,
      role,
      roomId,
      avatarUrl: data.avatarByUsername[key] || '',
      lastMessage: 0
    };

    users.set(socket.id, user);
    socket.join(roomId);

    socket.emit('joined', {
      username,
      role,
      roomId,
      roomName: room.name,
      avatarUrl: user.avatarUrl,
      rooms: publicRooms(),
      messages: roomMessages(roomId),
      pinnedMessage: roomId === 'lobby' ? data.pinnedMessage : null,
      permissions: data.permissions[role]
    });

    broadcastUsers(roomId);
    io.to(roomId).emit('system_message', `${username} が入室しました`);
  });

  socket.on('get_permissions', () => {
    const user = users.get(socket.id);
    if (!user || user.role !== 'Owner') return;

    socket.emit('permissions_data', data.permissions);
  });

  socket.on('set_avatar', payload => {
    const user = users.get(socket.id);
    if (!user) return;

    const url = String(payload?.url || '');

    if (!validAvatarUrl(url)) {
      return notify(socket, '画像URLはHTTPS、またはアップロード画像を指定してください');
    }

    user.avatarUrl = url;
    data.avatarByUsername[user.username.toLowerCase()] = url;
    saveData();

    io.emit('profile_updated', {
      username: user.username,
      avatarUrl: url
    });

    notify(socket, 'プロフィールアイコンを変更しました');
  });

  socket.on('chat_message', raw => {
    const user = users.get(socket.id);
    if (!user) return;

    if (data.chatLocked && user.role !== 'Owner') {
      return notify(socket, 'チャットはロック中です');
    }

    if (data.mutedUsers.includes(user.username.toLowerCase())) {
      return notify(socket, 'ミュート中です');
    }

    if (typeof raw !== 'string') return;

    const text = raw.trim().slice(0, 1000);
    if (!text) return;

    if (Date.now() - user.lastMessage < data.slowMode * 1000) {
      return notify(socket, `あと${data.slowMode}秒待ってください`);
    }

    if (data.ngWords.some(word => text.toLowerCase().includes(word.toLowerCase()))) {
      return notify(socket, 'NGワードが含まれています');
    }

    user.lastMessage = Date.now();

    const message = {
      id: crypto.randomUUID(),
      username: user.username,
      role: user.role,
      avatarUrl: user.avatarUrl || '',
      roomId: user.roomId,
      text,
      time: new Date().toLocaleTimeString('ja-JP')
    };

    data.messages.push(message);
    data.messages = data.messages.slice(-500);
    saveData();

    io.to(user.roomId).emit('chat_message', message);
  });

  socket.on('media_message', payload => {
    const user = users.get(socket.id);
    if (!user || !payload || typeof payload.url !== 'string') return;

    if (!/^\/uploads\/[a-zA-Z0-9._-]+$/.test(payload.url)) return;

    const message = {
      id: crypto.randomUUID(),
      username: user.username,
      role: user.role,
      avatarUrl: user.avatarUrl || '',
      roomId: user.roomId,
      text: '',
      media: {
        url: payload.url,
        type: String(payload.type || ''),
        name: String(payload.name || '').slice(0, 120)
      },
      time: new Date().toLocaleTimeString('ja-JP')
    };

    data.messages.push(message);
    data.messages = data.messages.slice(-500);
    saveData();

    io.to(user.roomId).emit('chat_message', message);
  });

  socket.on('create_room', payload => {
    const user = users.get(socket.id);
    if (!user) return;

    const name = String(payload?.name || '').trim().slice(0, 30);
    const password = String(payload?.password || '');

    if (!name) return notify(socket, 'ルーム名を入力してください');
    if (data.rooms.length >= 50) return notify(socket, 'ルーム数の上限です');

    if (data.rooms.some(r => r.name.toLowerCase() === name.toLowerCase())) {
      return notify(socket, '同じ名前のルームがあります');
    }

    if (password.length > 100) return notify(socket, 'パスワードが長すぎます');

    data.rooms.push({
      id: crypto.randomUUID(),
      name,
      passwordHash: password ? hashPassword(password) : null
    });

    saveData();
    io.emit('rooms_updated', publicRooms());
    notify(socket, 'ルームを作成しました');
  });

  socket.on('switch_room', payload => {
    const user = users.get(socket.id);
    if (!user) return;

    const room = roomById(String(payload?.roomId || ''));
    if (!room) return notify(socket, 'ルームが見つかりません');

    const password = String(payload?.password || '');

    if (
      room.passwordHash &&
      !safeCompare(hashPassword(password), room.passwordHash)
    ) {
      return notify(socket, 'ルームパスワードが違います');
    }

    const oldRoom = user.roomId;

    socket.leave(oldRoom);
    user.roomId = room.id;
    socket.join(room.id);

    broadcastUsers(oldRoom);
    broadcastUsers(room.id);

    socket.emit('room_changed', {
      roomId: room.id,
      roomName: room.name,
      messages: roomMessages(room.id)
    });

    io.to(room.id).emit('system_message', `${user.username} が入室しました`);
  });

  socket.on('admin_action', payload => {
    const user = users.get(socket.id);
    if (!user) return;

    const action = String(payload?.action || '');
    const target = String(payload?.target || '').trim().slice(0, 20);
    const value = payload?.value;

    // ランク変更はOwner専用
    if (action === 'rank') {
      if (user.role !== 'Owner') return notify(socket, 'ランク変更はOwner専用です');

      if (!target || !ROLES.includes(value) || value === 'Owner') {
        return notify(socket, '設定内容が無効です');
      }

      const found = findUser(target);

      if (!found || found.user.role === 'Owner') {
        return notify(socket, '対象ユーザーが見つからないか変更できません');
      }

      found.user.role = value;
      data.rolesByUsername[found.user.username.toLowerCase()] = value;
      saveData();

      io.to(found.id).emit('role_updated', {
        username: found.user.username,
        role: value,
        permissions: data.permissions[value]
      });

      broadcastUsers(found.user.roomId);
      return notify(socket, `${target} のランクを ${value} に変更しました`);
    }

    // 権限設定はOwner専用
    if (action === 'set_permissions') {
      if (user.role !== 'Owner') return notify(socket, '権限設定はOwner専用です');

      const role = payload.role;

      if (!['Admin', 'Moderator', 'Member'].includes(role)) {
        return notify(socket, '設定対象のランクが無効です');
      }

      for (const key of PERMISSION_KEYS) {
        data.permissions[role][key] = payload.permissions?.[key] === true;
      }

      data.permissions.Owner = { ...DEFAULT_PERMISSIONS.Owner };
      data.permissions.Regular = { ...DEFAULT_PERMISSIONS.Regular };

      saveData();

      for (const [id, connected] of users.entries()) {
        io.to(id).emit('permissions_updated', {
          role: connected.role,
          permissions: data.permissions[connected.role]
        });
      }

      return notify(socket, `${role} の権限設定を保存しました`);
    }

    if (!PERMISSION_KEYS.includes(action)) {
      return notify(socket, '不明な管理操作です');
    }

    // すべての管理操作をサーバー側で権限確認
    if (!hasPermission(user, action)) {
      return notify(socket, 'この操作を実行する権限がありません');
    }

    const found = findUser(target);

    if (['kick', 'ban', 'mute'].includes(action) && found) {
      if (
        found.user.role === 'Owner' ||
        roleLevel(found.user.role) >= roleLevel(user.role)
      ) {
        return notify(socket, '自分と同じか上位ランクのユーザーには実行できません');
      }
    }

    switch (action) {
      case 'kick': {
        if (!found) return notify(socket, 'ユーザーが見つかりません');

        const oldRoom = found.user.roomId;
        io.to(found.id).emit('system_message', '管理者にキックされました');
        users.delete(found.id);
        io.in(found.id).disconnectSockets(true);
        broadcastUsers(oldRoom);
        break;
      }

      case 'ban': {
        if (!target) return notify(socket, '対象ユーザーを入力してください');

        if (!data.bannedUsers.includes(target.toLowerCase())) {
          data.bannedUsers.push(target.toLowerCase());
        }

        if (found) {
          const oldRoom = found.user.roomId;
          io.to(found.id).emit('system_message', 'BANされました');
          users.delete(found.id);
          io.in(found.id).disconnectSockets(true);
          broadcastUsers(oldRoom);
        }

        saveData();
        break;
      }

      case 'unban':
        data.bannedUsers = data.bannedUsers.filter(x => x !== target.toLowerCase());
        saveData();
        break;

      case 'mute':
        if (!found) return notify(socket, 'ユーザーが見つかりません');
        if (!data.mutedUsers.includes(target.toLowerCase())) {
          data.mutedUsers.push(target.toLowerCase());
        }
        saveData();
        break;

      case 'unmute':
        data.mutedUsers = data.mutedUsers.filter(x => x !== target.toLowerCase());
        saveData();
        break;

      case 'lock':
        data.chatLocked = true;
        saveData();
        io.emit('system_message', 'チャットがロックされました');
        break;

      case 'unlock':
        data.chatLocked = false;
        saveData();
        io.emit('system_message', 'チャットのロックが解除されました');
        break;

      case 'slowmode':
        data.slowMode = Math.max(0, Math.min(60, Number(value) || 0));
        saveData();
        break;

      case 'pin':
        data.pinnedMessage = String(value || '').trim().slice(0, 500);
        io.to(user.roomId).emit('pinned_message', data.pinnedMessage);
        saveData();
        break;

      case 'unpin':
        data.pinnedMessage = null;
        io.to(user.roomId).emit('pinned_message', null);
        saveData();
        break;

      case 'ng_add': {
        const word = String(value || '').trim().slice(0, 50);
        if (!word) return notify(socket, 'NGワードを入力してください');
        if (!data.ngWords.includes(word)) data.ngWords.push(word);
        saveData();
        break;
      }

      case 'ng_remove':
        data.ngWords = data.ngWords.filter(
          word => word.toLowerCase() !== String(value || '').toLowerCase()
        );
        saveData();
        break;

      case 'clear':
        data.messages = data.messages.filter(m => m.roomId !== user.roomId);
        io.to(user.roomId).emit('clear_messages');
        saveData();
        break;
    }

    logAction(user.username, action.toUpperCase(), target || String(value || ''));
    notify(socket, '管理操作を実行しました');
  });

  // WebRTCのシグナリング
  socket.on('call_join', () => {
    const user = users.get(socket.id);
    if (!user) return;

    socket.to(user.roomId).emit('call_peer_joined', {
      socketId: socket.id,
      username: user.username
    });
  });

  socket.on('webrtc_signal', payload => {
    const user = users.get(socket.id);
    if (!user || typeof payload?.to !== 'string') return;

    const target = users.get(payload.to);
    if (!target || target.roomId !== user.roomId) return;

    io.to(payload.to).emit('webrtc_signal', {
      from: socket.id,
      signal: payload.signal
    });
  });

  socket.on('call_leave', () => {
    const user = users.get(socket.id);
    if (user) socket.to(user.roomId).emit('call_peer_left', socket.id);
  });

  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (!user) return;

    users.delete(socket.id);
    socket.to(user.roomId).emit('system_message', `${user.username} が退室しました`);
    broadcastUsers(user.roomId);
    socket.to(user.roomId).emit('call_peer_left', socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`チャットサーバー起動: ${PORT}`);
});
