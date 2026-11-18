
// ============================================
// MINNIT CHAT - server.js
// Node.js 18以上 / Express / Socket.IO
// ============================================

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 5e6 });

const PORT = process.env.PORT || 3000;
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';

if (ADMIN_SECRET.length < 8) {
  console.error('ADMIN_SECRETに8文字以上を設定してください');
  process.exit(1);
}

const DATA_FILE = path.join(__dirname, 'data.json');
const UPLOAD_DIR = path.join(__dirname, 'uploads');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use(express.json({ limit: '1mb' }));
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(__dirname, { index: false }));

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// --------------------------------------------
// データ
// --------------------------------------------

const ROLES = ['Owner', 'Admin', 'Moderator', 'Member', 'Regular'];

const PERMISSIONS = [
  'kick', 'ban', 'unban', 'mute', 'unmute',
  'lock', 'unlock', 'slowmode', 'pin', 'unpin',
  'ng_add', 'ng_remove', 'clear'
];

const DEFAULT_PERMISSIONS = {
  Owner: Object.fromEntries(PERMISSIONS.map(x => [x, true])),
  Admin: Object.fromEntries(PERMISSIONS.map(x => [x, true])),
  Moderator: Object.fromEntries(PERMISSIONS.map(x => [
    x, ['kick', 'mute', 'unmute', 'slowmode', 'pin', 'unpin'].includes(x)
  ])),
  Member: Object.fromEntries(PERMISSIONS.map(x => [x, false])),
  Regular: Object.fromEntries(PERMISSIONS.map(x => [x, false]))
};

function defaultData() {
  return {
    accounts: {},
    rolesByUsername: {},
    permissions: structuredClone(DEFAULT_PERMISSIONS),
    bannedUsers: [],
    mutedUsers: [],
    ngWords: [],
    messages: [],
    privateMessages: [],
    rooms: [{
      id: 'lobby',
      name: 'ロビー',
      type: 'public',
      passwordHash: null,
      quizQuestion: '',
      quizHash: null,
      invited: []
    }],
    friendships: [],
    friendRequests: [],
    blocks: {},
    notifications: {},
    reactions: {},
    chatLocked: false,
    slowMode: 0,
    pinnedMessage: null,
    adminLogs: []
  };
}

function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) return defaultData();

    const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const d = { ...defaultData(), ...saved };

    for (const key of [
      'accounts', 'rolesByUsername', 'friendships',
      'friendRequests', 'blocks', 'notifications',
      'reactions'
    ]) d[key] ||= {};

    for (const key of [
      'bannedUsers', 'mutedUsers', 'ngWords',
      'messages', 'privateMessages', 'rooms', 'adminLogs'
    ]) d[key] ||= [];

    d.permissions = {
      ...DEFAULT_PERMISSIONS,
      ...(saved.permissions || {})
    };

    for (const role of ROLES) {
      d.permissions[role] = {
        ...DEFAULT_PERMISSIONS[role],
        ...(d.permissions[role] || {})
      };
    }

    d.permissions.Owner = { ...DEFAULT_PERMISSIONS.Owner };
    d.permissions.Regular = { ...DEFAULT_PERMISSIONS.Regular };

    return d;
  } catch (e) {
    console.error('データ読み込みエラー:', e);
    return defaultData();
  }
}

let data = loadData();
const users = new Map();
let saveTimer;

function saveData() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const temp = DATA_FILE + '.tmp';
      fs.writeFileSync(temp, JSON.stringify(data, null, 2), {
        mode: 0o600
      });
      fs.renameSync(temp, DATA_FILE);
    } catch (e) {
      console.error('保存エラー:', e);
    }
  }, 100);
}

// --------------------------------------------
// 共通処理
// --------------------------------------------

function id() {
  return crypto.randomUUID();
}

function cleanName(value) {
  return String(value || '').trim().slice(0, 20);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function checkPassword(password, saved) {
  if (!saved || typeof saved !== 'string') return false;
  const [salt, hash] = saved.split(':');
  if (!salt || !hash) return false;

  const actual = crypto.scryptSync(String(password), salt, 64);
  const expected = Buffer.from(hash, 'hex');

  return actual.length === expected.length &&
    crypto.timingSafeEqual(actual, expected);
}

function findOnline(username) {
  const key = String(username || '').toLowerCase();
  for (const [socketId, user] of users) {
    if (user.username.toLowerCase() === key) {
      return { socketId, user };
    }
  }
  return null;
}

function getUser(socket) {
  return users.get(socket.id);
}

function notify(socket, message) {
  socket.emit('system_message', String(message));
}

function notifyAccount(accountId, item) {
  data.notifications[accountId] ||= [];
  data.notifications[accountId].unshift({
    id: id(),
    ...item,
    read: false,
    time: Date.now()
  });
  data.notifications[accountId] =
    data.notifications[accountId].slice(0, 100);

  for (const [socketId, user] of users) {
    if (user.accountId === accountId) {
      io.to(socketId).emit('notifications', data.notifications[accountId]);
    }
  }
  saveData();
}

function accountByName(username) {
  return data.accounts[String(username || '').toLowerCase()];
}

function isBlocked(a, b) {
  return (data.blocks[a] || []).includes(b);
}

function areFriends(a, b) {
  return data.friendships.some(pair =>
    pair.includes(a) && pair.includes(b)
  );
}

function sendFriends(socket) {
  const user = getUser(socket);
  if (!user) return;

  const list = data.friendships
    .filter(pair => pair.includes(user.accountId))
    .map(pair => pair.find(x => x !== user.accountId))
    .filter(other => !isBlocked(user.accountId, other))
    .map(other => {
      const account = Object.values(data.accounts)
        .find(x => x.id === other);
      if (!account) return null;

      const online = [...users.values()].find(x => x.accountId === other);

      return {
        username: account.username,
        displayName: account.displayName,
        avatar: account.avatar || '',
        online: !!online
      };
    })
    .filter(Boolean);

  socket.emit('friends_list', list);
}

function roomById(roomId) {
  return data.rooms.find(r => r.id === roomId);
}

function canEnterRoom(user, room, password, answer) {
  if (!room || !user) return false;

  if (user.role === 'Owner' || user.role === 'Admin') return true;

  if (room.type === 'private') {
    return (room.invited || []).includes(user.accountId);
  }

  if (room.type === 'password') {
    return checkPassword(password, room.passwordHash);
  }

  if (room.type === 'quiz') {
    return checkPassword(
      String(answer || '').trim().toLowerCase(),
      room.quizHash
    );
  }

  return true;
}

function visibleRooms(user) {
  return data.rooms
    .filter(room =>
      room.type !== 'private' ||
      user.role === 'Owner' ||
      user.role === 'Admin' ||
      (room.invited || []).includes(user.accountId)
    )
    .map(room => ({
      id: room.id,
      name: room.name,
      type: room.type,
      locked: room.type !== 'public'
    }));
}

function roomMessages(roomId, accountId) {
  return data.messages
    .filter(m =>
      m.roomId === roomId &&
      !isBlocked(accountId, m.accountId)
    )
    .slice(-200);
}

function permission(user, key) {
  return user && (
    user.role === 'Owner' ||
    data.permissions[user.role]?.[key] === true
  );
}

function roleLevel(role) {
  return ({
    Owner: 5, Admin: 4, Moderator: 3,
    Member: 2, Regular: 1
  })[role] || 0;
}

function userList(roomId, viewerId) {
  return [...users.values()]
    .filter(u =>
      u.roomId === roomId &&
      !isBlocked(viewerId, u.accountId)
    )
    .map(u => ({
      username: u.username,
      displayName: u.displayName,
      role: u.role,
      avatar: u.avatar || ''
    }));
}

function broadcastUsers(roomId) {
  for (const [socketId, user] of users) {
    if (user.roomId === roomId) {
      io.to(socketId).emit(
        'user_list',
        userList(roomId, user.accountId)
      );
    }
  }
}

function profile(account) {
  return {
    username: account.username,
    displayName: account.displayName,
    bio: account.bio || '',
    avatar: account.avatar || ''
  };
}

// --------------------------------------------
// アップロード
// --------------------------------------------

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, id() + ext);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(null, /^image\/(jpeg|png|gif|webp)$/.test(file.mimetype));
  }
});

app.post('/api/avatar', upload.single('file'), (req, res) => {
  const socketId = String(req.body.socketId || '');
  const user = users.get(socketId);

  if (!user) return res.status(401).json({ error: 'ログインしてください' });
  if (!req.file) return res.status(400).json({ error: '画像を選択してください' });

  const url = '/uploads/' + req.file.filename;
  const account = data.accounts[user.username.toLowerCase()];
  account.avatar = url;
  user.avatar = url;
  saveData();

  io.emit('profile_updated', {
    username: user.username,
    avatar: url
  });

  res.json({ url });
});

// --------------------------------------------
// Socket.IO
// --------------------------------------------

io.on('connection', socket => {

  // 新規アカウント登録
  socket.on('register', payload => {
    const username = cleanName(payload?.username);
    const password = String(payload?.password || '');
    const displayName = String(payload?.displayName || username)
      .trim().slice(0, 30);

    const key = username.toLowerCase();

    if (!/^[a-zA-Z0-9_ぁ-んァ-ヶ一-龠-]{2,20}$/.test(username)) {
      return socket.emit('auth_error', 'ユーザー名は2〜20文字で入力してください');
    }

    if (password.length < 8 || password.length > 100) {
      return socket.emit('auth_error', 'パスワードは8〜100文字にしてください');
    }

    if (data.accounts[key]) {
      return socket.emit('auth_error', 'そのユーザー名は既に使われています');
    }

    data.accounts[key] = {
      id: id(),
      username,
      displayName: displayName || username,
      passwordHash: hashPassword(password),
      avatar: '',
      bio: '',
      createdAt: Date.now()
    };

    saveData();
    socket.emit('auth_success', { message: 'アカウントを作成しました。ログインしてください。' });
  });

  // ログイン
  socket.on('login', payload => {
    if (users.has(socket.id)) return;

    const username = cleanName(payload?.username);
    const password = String(payload?.password || '');
    const key = username.toLowerCase();
    const account = data.accounts[key];

    if (!account || !checkPassword(password, account.passwordHash)) {
      return socket.emit('auth_error', 'ユーザー名またはパスワードが違います');
    }

    if (data.bannedUsers.includes(key)) {
      return socket.emit('auth_error', 'このアカウントはBANされています');
    }

    const existing = findOnline(username);
    if (existing) {
      return socket.emit('auth_error', 'このアカウントは既にログイン中です');
    }

    const adminCode = String(payload?.adminCode || '');
    const isOwner = adminCode.length === ADMIN_SECRET.length &&
      crypto.timingSafeEqual(Buffer.from(adminCode), Buffer.from(ADMIN_SECRET));

    let role = isOwner ? 'Owner' : data.rolesByUsername[key] || 'Regular';
    if (!ROLES.includes(role)) role = 'Regular';

    const user = {
      accountId: account.id,
      username: account.username,
      displayName: account.displayName,
      bio: account.bio || '',
      avatar: account.avatar || '',
      role,
      roomId: 'lobby',
      lastMessage: 0
    };

    users.set(socket.id, user);
    socket.join('lobby');

    socket.emit('logged_in', {
      ...profile(account),
      role,
      permissions: data.permissions[role],
      rooms: visibleRooms(user),
      messages: roomMessages('lobby', user.accountId),
      notifications: data.notifications[user.accountId] || [],
      friends: [],
      blocks: data.blocks[user.accountId] || []
    });

    sendFriends(socket);
    broadcastUsers('lobby');
  });

  // プロフィール取得
  socket.on('get_profile', payload => {
    const user = getUser(socket);
    if (!user) return;

    const account = accountByName(payload?.username);
    if (!account) return notify(socket, 'ユーザーが見つかりません');

    socket.emit('profile_data', {
      ...profile(account),
      isFriend: areFriends(user.accountId, account.id),
      blocked: isBlocked(user.accountId, account.id)
    });
  });

  // プロフィール編集
  socket.on('update_profile', payload => {
    const user = getUser(socket);
    if (!user) return;

    const account = accountByName(user.username);
    account.displayName = String(payload?.displayName || user.username).trim().slice(0, 30);
    account.bio = String(payload?.bio || '').trim().slice(0, 300);
    user.displayName = account.displayName;
    user.bio = account.bio;

    saveData();
    socket.emit('profile_data', profile(account));
    broadcastUsers(user.roomId);
    notify(socket, 'プロフィールを更新しました');
  });

  // アイコンURL変更
  socket.on('set_avatar', payload => {
    const user = getUser(socket);
    if (!user) return;

    const url = String(payload?.url || '');
    if (url && !/^https:\/\/.{1,900}$/.test(url) &&
        !/^\/uploads\/[a-zA-Z0-9._-]+$/.test(url)) {
      return notify(socket, 'HTTPSの画像URLを入力してください');
    }

    const account = accountByName(user.username);
    account.avatar = url;
    user.avatar = url;
    saveData();

    io.emit('profile_updated', {
      username: user.username,
      avatar: url
    });
  });

  // フレンド申請
  socket.on('friend_request', payload => {
    const user = getUser(socket);
    if (!user) return;

    const target = accountByName(payload?.username);
    if (!target || target.id === user.accountId) {
      return notify(socket, '相手のユーザー名を確認してください');
    }

    if (isBlocked(user.accountId, target.id) || isBlocked(target.id, user.accountId)) {
      return notify(socket, 'このユーザーには申請できません');
    }

    if (areFriends(user.accountId, target.id)) {
      return notify(socket, '既にフレンドです');
    }

    const duplicate = data.friendRequests.some(r =>
      r.from === user.accountId && r.to === target.id
    );
    if (duplicate) return notify(socket, '申請済みです');

    data.friendRequests.push({
      id: id(),
      from: user.accountId,
      to: target.id,
      fromName: user.username,
      time: Date.now()
    });

    notifyAccount(target.id, {
      type: 'friend_request',
      from: user.username,
      text: `${user.username} からフレンド申請が届きました`
    });

    saveData();
    notify(socket, 'フレンド申請を送りました');
  });

  // フレンド申請への返事
  socket.on('friend_request_reply', payload => {
    const user = getUser(socket);
    if (!user) return;

    const request = data.friendRequests.find(r =>
      r.id === payload?.id && r.to === user.accountId
    );
    if (!request) return notify(socket, '申請が見つかりません');

    data.friendRequests = data.friendRequests.filter(r => r.id !== request.id);

    if (payload.accept === true &&
        !isBlocked(user.accountId, request.from) &&
        !isBlocked(request.from, user.accountId)) {
      data.friendships.push([user.accountId, request.from]);

      const sender = Object.values(data.accounts)
        .find(a => a.id === request.from);

      if (sender) {
        notifyAccount(sender.id, {
          type: 'friend_accepted',
          from: user.username,
          text: `${user.username} がフレンド申請を承認しました`
        });
      }
    }

    saveData();
    sendFriends(socket);

    for (const [socketId, other] of users) {
      if (other.accountId === request.from) sendFriends(io.sockets.sockets.get(socketId));
    }

    notify(socket, payload.accept ? 'フレンドになりました' : '申請を拒否しました');
  });

  // フレンド一覧・申請一覧
  socket.on('get_friends', () => sendFriends(socket));

  socket.on('get_friend_requests', () => {
    const user = getUser(socket);
    if (!user) return;

    const requests = data.friendRequests
      .filter(r => r.to === user.accountId)
      .map(r => ({ id: r.id, username: r.fromName, time: r.time }));

    socket.emit('friend_requests', requests);
  });

  // ブロック / 解除
  socket.on('block_user', payload => {
    const user = getUser(socket);
    if (!user) return;

    const target = accountByName(payload?.username);
    if (!target || target.id === user.accountId) return;

    data.blocks[user.accountId] ||= [];
    if (!data.blocks[user.accountId].includes(target.id)) {
      data.blocks[user.accountId].push(target.id);
    }

    saveData();
    socket.emit('blocks_updated', data.blocks[user.accountId]);
    sendFriends(socket);
    broadcastUsers(user.roomId);
    socket.emit('messages_refresh', roomMessages(user.roomId, user.accountId));
    notify(socket, 'ブロックしました');
  });

  socket.on('unblock_user', payload => {
    const user = getUser(socket);
    if (!user) return;

    const target = accountByName(payload?.username);
    if (!target) return;

    data.blocks[user.accountId] =
      (data.blocks[user.accountId] || []).filter(x => x !== target.id);

    saveData();
    socket.emit('blocks_updated', data.blocks[user.accountId]);
    sendFriends(socket);
    broadcastUsers(user.roomId);
    socket.emit('messages_refresh', roomMessages(user.roomId, user.accountId));
    notify(socket, 'ブロックを解除しました');
  });

  // 通知を既読にする
  socket.on('read_notifications', () => {
    const user = getUser(socket);
    if (!user) return;

    data.notifications[user.accountId] =
      (data.notifications[user.accountId] || []).map(n => ({ ...n, read: true }));

    saveData();
    socket.emit('notifications', data.notifications[user.accountId]);
  });

  // プライベートメッセージ
  socket.on('private_message', payload => {
    const user = getUser(socket);
    if (!user) return;

    const target = accountByName(payload?.to);
    const text = String(payload?.text || '').trim().slice(0, 2000);

    if (!target || !text) return;

    if (!areFriends(user.accountId, target.id) ||
        isBlocked(user.accountId, target.id) ||
        isBlocked(target.id, user.accountId)) {
      return notify(socket, '相互にフレンドの相手にだけ送信できます');
    }

    const message = {
      id: id(),
      from: user.username,
      to: target.username,
      fromId: user.accountId,
      toId: target.id,
      text,
      time: Date.now()
    };

    data.privateMessages.push(message);
    data.privateMessages = data.privateMessages.slice(-3000);
    saveData();

    socket.emit('private_message', message);

    for (const [socketId, other] of users) {
      if (other.accountId === target.id) {
        io.to(socketId).emit('private_message', message);
        notifyAccount(target.id, {
          type: 'private_message',
          from: user.username,
          text: `${user.username} からメッセージが届きました`
        });
      }
    }
  });

  socket.on('get_private_messages', payload => {
    const user = getUser(socket);
    if (!user) return;

    const target = accountByName(payload?.username);
    if (!target ||
        !areFriends(user.accountId, target.id) ||
        isBlocked(user.accountId, target.id) ||
        isBlocked(target.id, user.accountId)) {
      return notify(socket, 'この相手とのDMは利用できません');
    }

    const messages = data.privateMessages.filter(m =>
      (m.fromId === user.accountId && m.toId === target.id) ||
      (m.fromId === target.id && m.toId === user.accountId)
    );

    socket.emit('private_history', {
      username: target.username,
      messages: messages.slice(-200)
    });
  });

  // リアクション
  socket.on('reaction', payload => {
    const user = getUser(socket);
    if (!user) return;

    const message = data.messages.find(m =>
      m.id === payload?.messageId && m.roomId === user.roomId
    );
    if (!message || isBlocked(user.accountId, message.accountId)) return;

    const emoji = String(payload?.emoji || '');
    if (!['❤️', '👍', '😂', '😮', '😢', '🔥', '👏', '🎉'].includes(emoji)) return;

    data.reactions[message.id] ||= {};
    data.reactions[message.id][emoji] ||= [];

    const list = data.reactions[message.id][emoji];
    const index = list.indexOf(user.accountId);

    if (index >= 0) list.splice(index, 1);
    else list.push(user.accountId);

    saveData();

    io.to(user.roomId).emit('reaction_updated', {
      messageId: message.id,
      reactions: data.reactions[message.id]
    });
  });

  // ルーム作成
  socket.on('create_room', payload => {
    const user = getUser(socket);
    if (!user) return;

    const name = String(payload?.name || '').trim().slice(0, 30);
    const type = ['public', 'password', 'quiz', 'private'].includes(payload?.type)
      ? payload.type : 'public';

    if (!name) return notify(socket, 'ルーム名を入力してください');
    if (data.rooms.length >= 50) return notify(socket, 'ルーム数の上限です');
    if (data.rooms.some(r => r.name.toLowerCase() === name.toLowerCase())) {
      return notify(socket, '同じ名前のルームがあります');
    }

    const room = {
      id: id(),
      name,
      type,
      passwordHash: null,
      quizQuestion: '',
      quizHash: null,
      invited: [user.accountId]
    };

    if (type === 'password') {
      const password = String(payload?.password || '');
      if (password.length < 1 || password.length > 100) {
        return notify(socket, 'パスワードを設定してください');
      }
      room.passwordHash = hashPassword(password);
    }

    if (type === 'quiz') {
      const question = String(payload?.question || '').trim().slice(0, 200);
      const answer = String(payload?.answer || '').trim().toLowerCase();
      if (!question || !answer) return notify(socket, 'クイズと答えを設定してください');
      room.quizQuestion = question;
      room.quizHash = hashPassword(answer);
    }

    data.rooms.push(room);
    saveData();

    io.emit('rooms_updated', visibleRooms(user));
    notify(socket, 'ルームを作成しました');
  });

  socket.on('switch_room', payload => {
    const user = getUser(socket);
    if (!user) return;

    const room = roomById(String(payload?.roomId || ''));
    if (!room) return notify(socket, 'ルームが見つかりません');

    if (!canEnterRoom(user, room, payload?.password, payload?.answer)) {
      if (room.type === 'quiz') {
        return socket.emit('quiz_required', {
          roomId: room.id,
          question: room.quizQuestion
        });
      }
      return notify(socket, 'このルームには入室できません');
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
      messages: roomMessages(room.id, user.accountId)
    });
  });

  // メッセージ送信
  socket.on('chat_message', raw => {
    const user = getUser(socket);
    if (!user) return;

    if (data.chatLocked && user.role !== 'Owner') {
      return notify(socket, 'チャットはロック中です');
    }

    if (data.mutedUsers.includes(user.username.toLowerCase())) {
      return notify(socket, 'ミュート中です');
    }

    const text = String(raw || '').trim().slice(0, 1000);
    if (!text) return;

    if (Date.now() - user.lastMessage < data.slowMode * 1000) {
      return notify(socket, `あと${data.slowMode}秒待ってください`);
    }

    if (data.ngWords.some(w => text.toLowerCase().includes(w.toLowerCase()))) {
      return notify(socket, 'NGワードが含まれています');
    }

    user.lastMessage = Date.now();

    const message = {
      id: id(),
      accountId: user.accountId,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      avatarUrl: user.avatar,
      roomId: user.roomId,
      text,
      time: new Date().toLocaleTimeString('ja-JP')
    };

    data.messages.push(message);
    data.messages = data.messages.slice(-1000);
    saveData();

    for (const [socketId, other] of users) {
      if (other.roomId === user.roomId &&
          !isBlocked(other.accountId, user.accountId)) {
        io.to(socketId).emit('chat_message', message);
      }
    }
  });

  // 管理者操作
  socket.on('admin_action', payload => {
    const user = getUser(socket);
    if (!user) return;

    const action = String(payload?.action || '');
    const target = cleanName(payload?.target);
    const value = payload?.value;

    if (action === 'rank') {
      if (user.role !== 'Owner') return notify(socket, 'Owner専用です');
      if (!ROLES.includes(value) || value === 'Owner') return;

      const found = findOnline(target);
      if (!found || found.user.role === 'Owner') return notify(socket, '対象が見つかりません');

      found.user.role = value;
      data.rolesByUsername[found.user.username.toLowerCase()] = value;

      io.to(found.socketId).emit('role_updated', {
        role: value,
        permissions: data.permissions[value]
      });

      broadcastUsers(found.user.roomId);
      saveData();
      return notify(socket, 'ランクを変更しました');
    }

    if (action === 'set_permissions') {
      if (user.role !== 'Owner') return notify(socket, 'Owner専用です');
      const role = payload.role;
      if (!['Admin', 'Moderator', 'Member'].includes(role)) return;

      for (const key of PERMISSIONS) {
        data.permissions[role][key] = payload.permissions?.[key] === true;
      }

      saveData();

      for (const [socketId, other] of users) {
        io.to(socketId).emit('permissions_updated', {
          role: other.role,
          permissions: data.permissions[other.role]
        });
      }

      socket.emit('permissions_data', data.permissions);
      return notify(socket, '権限設定を保存しました');
    }

    if (!PERMISSIONS.includes(action) || !permission(user, action)) {
      return notify(socket, 'この操作を実行する権限がありません');
    }

    const found = findOnline(target);

    if (['kick', 'ban', 'mute'].includes(action) && found &&
        (found.user.role === 'Owner' ||
         roleLevel(found.user.role) >= roleLevel(user.role))) {
      return notify(socket, '同じか上位ランクには実行できません');
    }

    switch (action) {
      case 'kick':
        if (!found) return notify(socket, 'ユーザーが見つかりません');
        io.to(found.socketId).emit('system_message', 'キックされました');
        users.delete(found.socketId);
        io.in(found.socketId).disconnectSockets(true);
        break;

      case 'ban':
        if (!target) return;
        if (!data.bannedUsers.includes(target.toLowerCase())) {
          data.bannedUsers.push(target.toLowerCase());
        }
        if (found) {
          io.to(found.socketId).emit('system_message', 'BANされました');
          users.delete(found.socketId);
          io.in(found.socketId).disconnectSockets(true);
        }
        break;

      case 'unban':
        data.bannedUsers = data.bannedUsers.filter(x => x !== target.toLowerCase());
        break;

      case 'mute':
        if (!found) return notify(socket, 'ユーザーが見つかりません');
        if (!data.mutedUsers.includes(target.toLowerCase())) data.mutedUsers.push(target.toLowerCase());
        break;

      case 'unmute':
        data.mutedUsers = data.mutedUsers.filter(x => x !== target.toLowerCase());
        break;

      case 'lock':
        data.chatLocked = true;
        io.emit('system_message', 'チャットがロックされました');
        break;

      case 'unlock':
        data.chatLocked = false;
        io.emit('system_message', 'チャットのロックが解除されました');
        break;

      case 'slowmode':
        data.slowMode = Math.max(0, Math.min(60, Number(value) || 0));
        break;

      case 'pin':
        data.pinnedMessage = String(value || '').trim().slice(0, 500);
        io.to(user.roomId).emit('pinned_message', data.pinnedMessage);
        break;

      case 'unpin':
        data.pinnedMessage = null;
        io.to(user.roomId).emit('pinned_message', null);
        break;

      case 'ng_add': {
        const word = String(value || '').trim().slice(0, 50);
        if (word && !data.ngWords.includes(word)) data.ngWords.push(word);
        break;
      }

      case 'ng_remove':
        data.ngWords = data.ngWords.filter(w =>
          w.toLowerCase() !== String(value || '').toLowerCase()
        );
        break;

      case 'clear':
        data.messages = data.messages.filter(m => m.roomId !== user.roomId);
        io.to(user.roomId).emit('clear_messages');
        break;
    }

    saveData();
    notify(socket, '管理操作を実行しました');
  });

  // 権限データ
  socket.on('get_permissions', () => {
    const user = getUser(socket);
    if (user?.role === 'Owner') socket.emit('permissions_data', data.permissions);
  });

  // ------------------------------------------
  // 通話シグナリング
  // ------------------------------------------

  socket.on('call_join', payload => {
    const user = getUser(socket);
    if (!user) return;

    const roomId = String(payload?.roomId || user.roomId);
    if (roomId !== user.roomId) return;

    socket.to(roomId).emit('call_peer_joined', {
      socketId: socket.id,
      username: user.username
    });
  });

  socket.on('private_call_request', payload => {
    const user = getUser(socket);
    if (!user) return;

    const target = accountByName(payload?.username);
    if (!target ||
        !areFriends(user.accountId, target.id) ||
        isBlocked(user.accountId, target.id) ||
        isBlocked(target.id, user.accountId)) {
      return notify(socket, 'フレンドとのみ個別通話できます');
    }

    for (const [socketId, other] of users) {
      if (other.accountId === target.id) {
        io.to(socketId).emit('private_call_incoming', {
          from: user.username,
          socketId: socket.id
        });
      }
    }
  });

  socket.on('webrtc_signal', payload => {
    const user = getUser(socket);
    if (!user || typeof payload?.to !== 'string') return;

    const target = users.get(payload.to);
    if (!target) return;

    const sameRoom = target.roomId === user.roomId;
    const friends = areFriends(user.accountId, target.accountId);
    const blocked = isBlocked(user.accountId, target.accountId) ||
      isBlocked(target.accountId, user.accountId);

    if (blocked || (!sameRoom && !friends)) return;

    io.to(payload.to).emit('webrtc_signal', {
      from: socket.id,
      signal: payload.signal
    });
  });

  socket.on('call_leave', () => {
    const user = getUser(socket);
    if (user) socket.to(user.roomId).emit('call_peer_left', socket.id);
  });

  // 切断
  socket.on('disconnect', () => {
    const user = getUser(socket);
    if (!user) return;

    users.delete(socket.id);
    broadcastUsers(user.roomId);
    socket.to(user.roomId).emit('call_peer_left', socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`Minnit Chat 起動: ${PORT}`);
});
