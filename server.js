const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const ADMIN_SECRET = process.env.ADMIN_SECRET;

if (!ADMIN_SECRET || ADMIN_SECRET.length < 8) {
    console.error(
        'ADMIN_SECRETに8文字以上の秘密の文字列を設定してください'
    );
    process.exit(1);
}

const PORT = process.env.PORT || 3000;

// ユーザー管理
const users = new Map();
const bannedUsers = new Set();
const mutedUsers = new Set();

// チャット設定
let chatLocked = false;
let slowMode = 0;
let pinnedMessage = null;
let ngWords = [];

// メッセージ保存
const messages = [];
const MAX_MESSAGES = 200;

// 管理ログ
const adminLogs = [];

// ランク設定
const ALLOWED_ROLES = new Set([
    'Admin',
    'Moderator',
    'Member',
    'Regular'
]);

// HTML配信
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Socket.IO接続
io.on('connection', (socket) => {
    console.log('接続:', socket.id);

    // 入室
    socket.on('join', ({ username, adminCode } = {}) => {
        if (users.has(socket.id)) return;

        if (typeof username !== 'string') return;

        username = username.trim().slice(0, 20);

        if (!username) {
            socket.emit(
                'system_message',
                'ユーザー名を入力してください'
            );
            return;
        }

        const normalizedName = username.toLowerCase();

        // BAN確認
        if (bannedUsers.has(normalizedName)) {
            socket.emit(
                'system_message',
                'あなたはBANされています'
            );
            return;
        }

        // 同名ユーザーの重複を防ぐ
        for (const existingUser of users.values()) {
            if (
                existingUser.username.toLowerCase() === normalizedName
            ) {
                socket.emit(
                    'system_message',
                    'そのユーザー名はすでに使用されています'
                );
                return;
            }
        }

        // 管理者パスワード確認
        const isOwner = safeCompare(adminCode, ADMIN_SECRET);

        const role = isOwner ? 'Owner' : 'Regular';

        const user = {
            username,
            role,
            lastMessage: 0
        };

        users.set(socket.id, user);

        // 入室完了
        socket.emit('joined', {
            username,
            role,
            messages,
            pinnedMessage
        });

        // ユーザー一覧更新
        io.emit('user_list', getUserList());

        io.emit(
            'system_message',
            `${username} が入室しました`
        );

        console.log(`${username} が入室しました (${role})`);
    });

    // メッセージ送信
    socket.on('chat_message', (text) => {
        const user = users.get(socket.id);

        if (!user) return;

        // チャットロック
        if (chatLocked && user.role !== 'Owner') {
            socket.emit(
                'system_message',
                '現在チャットはロックされています'
            );
            return;
        }

        // ミュート確認
        if (mutedUsers.has(user.username.toLowerCase())) {
            socket.emit(
                'system_message',
                'ミュート中です'
            );
            return;
        }

        if (typeof text !== 'string') return;

        text = text.trim().slice(0, 1000);

        if (!text) return;

        const now = Date.now();

        // スローモード
        if (now - user.lastMessage < slowMode * 1000) {
            socket.emit(
                'system_message',
                `スローモード中です。${slowMode}秒待ってください`
            );
            return;
        }

        // NGワード確認
        for (const word of ngWords) {
            if (
                word &&
                text.toLowerCase().includes(word.toLowerCase())
            ) {
                socket.emit(
                    'system_message',
                    'NGワードが含まれています'
                );
                return;
            }
        }

        user.lastMessage = now;

        const message = {
            id: `${now}-${Math.random().toString(36).slice(2, 9)}`,
            username: user.username,
            role: user.role,
            text,
            time: new Date().toLocaleTimeString('ja-JP')
        };

        messages.push(message);

        if (messages.length > MAX_MESSAGES) {
            messages.shift();
        }

        io.emit('chat_message', message);
    });

    // 管理者操作
    socket.on(
        'admin_action',
        ({ action, target, value } = {}) => {
            const user = users.get(socket.id);

            // 現在はOwnerのみ管理操作可能
            if (!user || user.role !== 'Owner') {
                socket.emit(
                    'system_message',
                    '管理者権限が必要です'
                );
                return;
            }

            target =
                typeof target === 'string'
                    ? target.trim().slice(0, 20)
                    : '';

            switch (action) {
                // キック
                case 'kick': {
                    const targetSocket = findUser(target);

                    if (!targetSocket) {
                        notify(
                            socket,
                            'ユーザーが見つかりません'
                        );
                        break;
                    }

                    if (targetSocket.user.role === 'Owner') {
                        notify(
                            socket,
                            'Ownerはキックできません'
                        );
                        break;
                    }

                    io.to(targetSocket.id).emit(
                        'system_message',
                        '管理者にキックされました'
                    );

                    users.delete(targetSocket.id);

                    io.to(targetSocket.id).disconnectSockets(true);

                    io.emit(
                        'system_message',
                        `${targetSocket.user.username} がキックされました`
                    );

                    io.emit('user_list', getUserList());

                    logAction(
                        user.username,
                        'KICK',
                        targetSocket.user.username
                    );

                    break;
                }

                // BAN
                case 'ban': {
                    if (!target) {
                        notify(socket, '対象ユーザーを入力してください');
                        break;
                    }

                    const targetSocket = findUser(target);

                    if (targetSocket && targetSocket.user.role === 'Owner') {
                        notify(socket, 'OwnerはBANできません');
                        break;
                    }

                    bannedUsers.add(target.toLowerCase());

                    disconnectTarget(target, 'BANされました');

                    logAction(user.username, 'BAN', target);

                    notify(socket, `${target} をBANしました`);

                    break;
                }

                // BAN解除
                case 'unban': {
                    if (!target) {
                        notify(socket, '対象ユーザーを入力してください');
                        break;
                    }

                    bannedUsers.delete(target.toLowerCase());

                    notify(
                        socket,
                        `${target} のBANを解除しました`
                    );

                    logAction(user.username, 'UNBAN', target);

                    break;
                }

                // ミュート
                case 'mute': {
                    if (!target) {
                        notify(socket, '対象ユーザーを入力してください');
                        break;
                    }

                    const targetSocket = findUser(target);

                    if (targetSocket && targetSocket.user.role === 'Owner') {
                        notify(socket, 'Ownerはミュートできません');
                        break;
                    }

                    mutedUsers.add(target.toLowerCase());

                    notify(socket, `${target} をミュートしました`);

                    logAction(user.username, 'MUTE', target);

                    break;
                }

                // ミュート解除
                case 'unmute': {
                    mutedUsers.delete(target.toLowerCase());

                    notify(
                        socket,
                        `${target} のミュートを解除しました`
                    );

                    logAction(user.username, 'UNMUTE', target);

                    break;
                }

                // チャットロック
                case 'lock': {
                    chatLocked = true;

                    io.emit(
                        'system_message',
                        'チャットがロックされました'
                    );

                    logAction(user.username, 'LOCK', '');

                    break;
                }

                // ロック解除
                case 'unlock': {
                    chatLocked = false;

                    io.emit(
                        'system_message',
                        'チャットのロックが解除されました'
                    );

                    logAction(user.username, 'UNLOCK', '');

                    break;
                }

                // スローモード
                case 'slowmode': {
                    const seconds = Number(value);

                    slowMode = Number.isFinite(seconds)
                        ? Math.max(0, Math.min(60, seconds))
                        : 0;

                    notify(
                        socket,
                        `スローモードを${slowMode}秒に設定しました`
                    );

                    logAction(
                        user.username,
                        'SLOWMODE',
                        String(slowMode)
                    );

                    break;
                }

                // 固定メッセージ
                case 'pin': {
                    if (typeof value !== 'string') {
                        notify(socket, '文章を入力してください');
                        break;
                    }

                    pinnedMessage = value.trim().slice(0, 500);

                    if (!pinnedMessage) {
                        notify(socket, '文章を入力してください');
                        break;
                    }

                    io.emit('pinned_message', pinnedMessage);

                    notify(socket, 'メッセージを固定しました');

                    logAction(user.username, 'PIN', pinnedMessage);

                    break;
                }

                // 固定解除
                case 'unpin': {
                    pinnedMessage = null;

                    io.emit('pinned_message', null);

                    notify(socket, '固定メッセージを解除しました');

                    logAction(user.username, 'UNPIN', '');

                    break;
                }

                // NGワード追加
                case 'ng_add': {
                    if (
                        typeof value !== 'string' ||
                        !value.trim()
                    ) {
                        notify(socket, 'NGワードを入力してください');
                        break;
                    }

                    const word = value.trim().slice(0, 50);

                    if (
                        !ngWords.some(
                            existing =>
                                existing.toLowerCase() ===
                                word.toLowerCase()
                        )
                    ) {
                        ngWords.push(word);
                    }

                    notify(socket, 'NGワードを追加しました');

                    logAction(user.username, 'NG_ADD', word);

                    break;
                }

                // NGワード削除
                case 'ng_remove': {
                    if (typeof value !== 'string') {
                        notify(socket, 'NGワードを入力してください');
                        break;
                    }

                    const word = value.trim();

                    ngWords = ngWords.filter(
                        existing =>
                            existing.toLowerCase() !==
                            word.toLowerCase()
                    );

                    notify(socket, 'NGワードを削除しました');

                    logAction(user.username, 'NG_REMOVE', word);

                    break;
                }

                // 全メッセージ削除
                case 'clear': {
                    messages.length = 0;

                    io.emit('clear_messages');

                    notify(socket, 'チャット履歴を削除しました');

                    logAction(user.username, 'CLEAR', '');

                    break;
                }

                // ★ ランク変更
                case 'rank': {
                    if (!target) {
                        notify(
                            socket,
                            '対象ユーザー名を入力してください'
                        );
                        break;
                    }

                    if (
                        typeof value !== 'string' ||
                        !ALLOWED_ROLES.has(value)
                    ) {
                        notify(
                            socket,
                            '選択したランクは無効です'
                        );
                        break;
                    }

                    const targetSocket = findUser(target);

                    if (!targetSocket) {
                        notify(
                            socket,
                            '対象ユーザーが見つかりません。オンラインのユーザーを指定してください'
                        );
                        break;
                    }

                    // Ownerのランクは変更不可
                    if (targetSocket.user.role === 'Owner') {
                        notify(
                            socket,
                            'Ownerのランクは変更できません'
                        );
                        break;
                    }

                    const oldRole = targetSocket.user.role;

                    // サーバー上のランクを更新
                    targetSocket.user.role = value;

                    // 本人に新しいランクを通知
                    io.to(targetSocket.id).emit('role_updated', {
                        username: targetSocket.user.username,
                        role: value
                    });

                    // ユーザー一覧を全員に更新
                    io.emit('user_list', getUserList());

                    // 管理ログに記録
                    logAction(
                        user.username,
                        'RANK',
                        `${targetSocket.user.username}: ${oldRole} -> ${value}`
                    );

                    notify(
                        socket,
                        `${targetSocket.user.username} のランクを ${value} に変更しました`
                    );

                    io.emit(
                        'system_message',
                        `${targetSocket.user.username} のランクが ${value} に変更されました`
                    );

                    break;
                }

                default: {
                    notify(socket, '不明な管理者コマンドです');
                }
            }
        }
    );

    // 切断
    socket.on('disconnect', () => {
        const user = users.get(socket.id);

        if (user) {
            users.delete(socket.id);

            io.emit(
                'system_message',
                `${user.username} が退室しました`
            );

            io.emit('user_list', getUserList());

            console.log(`${user.username} が退室しました`);
        }
    });
});

// パスワード比較
function safeCompare(input, secret) {
    if (typeof input !== 'string') return false;

    const a = Buffer.from(input);
    const b = Buffer.from(secret);

    if (a.length !== b.length) return false;

    return crypto.timingSafeEqual(a, b);
}

// ユーザー一覧
function getUserList() {
    return [...users.values()].map(user => ({
        username: user.username,
        role: user.role
    }));
}

// ユーザー検索
function findUser(username) {
    if (!username) return null;

    const normalized = username.toLowerCase();

    for (const [id, user] of users.entries()) {
        if (user.username.toLowerCase() === normalized) {
            return {
                id,
                user
            };
        }
    }

    return null;
}

// 対象ユーザーを切断
function disconnectTarget(username, reason) {
    const targetSocket = findUser(username);

    if (!targetSocket) return;

    io.to(targetSocket.id).emit('system_message', reason);

    users.delete(targetSocket.id);

    io.to(targetSocket.id).disconnectSockets(true);

    io.emit('user_list', getUserList());
}

// 通知
function notify(socket, message) {
    socket.emit('system_message', message);
}

// 管理ログ
function logAction(admin, action, target) {
    adminLogs.push({
        admin,
        action,
        target,
        time: new Date().toISOString()
    });

    if (adminLogs.length > 500) {
        adminLogs.shift();
    }
}

// サーバー起動
server.listen(PORT, () => {
    console.log(`チャットサーバー起動: ポート ${PORT}`);
});
