const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const ADMIN_SECRET = process.env.ADMIN_SECRET;

if (!ADMIN_SECRET || ADMIN_SECRET.length < 16) {
    console.error('ADMIN_SECRETに16文字以上の秘密の文字列を設定してください');
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

app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 接続処理
io.on('connection', (socket) => {
    console.log('接続:', socket.id);

    socket.on('join', ({ username, adminCode } = {}) => {
        if (typeof username !== 'string') return;

        username = username.trim().slice(0, 20);

        if (!username) return;
        if (bannedUsers.has(username.toLowerCase())) {
            socket.emit('system_message', 'あなたはBANされています');
            return;
        }

        const isAdmin = safeCompare(adminCode, ADMIN_SECRET);

        users.set(socket.id, {
            username,
            role: isAdmin ? 'Owner' : 'Regular',
            lastMessage: 0
        });

        socket.emit('joined', {
            username,
            role: isAdmin ? 'Owner' : 'Regular',
            messages
        });

        io.emit('user_list', getUserList());
        io.emit('system_message', `${username} が入室しました`);
    });

    // メッセージ送信
    socket.on('chat_message', (text) => {
        const user = users.get(socket.id);
        if (!user) return;

        if (chatLocked && user.role !== 'Owner') {
            socket.emit('system_message', '現在チャットはロックされています');
            return;
        }

        if (mutedUsers.has(user.username.toLowerCase())) {
            socket.emit('system_message', 'ミュート中です');
            return;
        }

        if (typeof text !== 'string') return;
        text = text.trim().slice(0, 1000);
        if (!text) return;

        const now = Date.now();

        if (now - user.lastMessage < slowMode * 1000) {
            socket.emit('system_message', 'スローモード中です');
            return;
        }

        user.lastMessage = now;

        for (const word of ngWords) {
            if (text.toLowerCase().includes(word.toLowerCase())) {
                socket.emit('system_message', 'NGワードが含まれています');
                return;
            }
        }

        const message = {
            id: `${now}-${Math.random().toString(36).slice(2, 9)}`,
            username: user.username,
            role: user.role,
            text,
            time: new Date().toLocaleTimeString('ja-JP')
        };

        messages.push(message);
        if (messages.length > MAX_MESSAGES) messages.shift();

        io.emit('chat_message', message);
    });

    // 管理者コマンド
    socket.on('admin_action', ({ action, target, value } = {}) => {
        const user = users.get(socket.id);
        if (!user || user.role !== 'Owner') {
            socket.emit('system_message', '管理者権限が必要です');
            return;
        }

        target = typeof target === 'string' ? target.trim() : '';

        switch (action) {
            case 'kick': {
                const targetSocket = findUser(target);
                if (!targetSocket) return notify(socket, 'ユーザーが見つかりません');

                targetSocket.emit('system_message', '管理者にキックされました');
                users.delete(targetSocket.id);
                targetSocket.disconnect(true);

                io.emit('system_message', `${target} をキックしました`);
                break;
            }

            case 'ban':
                bannedUsers.add(target.toLowerCase());
                disconnectTarget(target, 'BANされました');
                logAction(user.username, 'BAN', target);
                break;

            case 'unban':
                bannedUsers.delete(target.toLowerCase());
                notify(socket, `${target} のBANを解除しました`);
                break;

            case 'mute':
                mutedUsers.add(target.toLowerCase());
                notify(socket, `${target} をミュートしました`);
                break;

            case 'unmute':
                mutedUsers.delete(target.toLowerCase());
                notify(socket, `${target} のミュートを解除しました`);
                break;

            case 'lock':
                chatLocked = true;
                io.emit('system_message', 'チャットがロックされました');
                break;

            case 'unlock':
                chatLocked = false;
                io.emit('system_message', 'チャットのロックが解除されました');
                break;

            case 'slowmode':
                slowMode = Math.max(0, Math.min(60, Number(value) || 0));
                notify(socket, `スローモードを ${slowMode} 秒に設定しました`);
                break;

            case 'pin':
                pinnedMessage = String(value || '').slice(0, 500);
                io.emit('pinned_message', pinnedMessage);
                break;

            case 'unpin':
                pinnedMessage = null;
                io.emit('pinned_message', null);
                break;

            case 'ng_add':
                if (typeof value === 'string' && value.trim()) {
                    ngWords.push(value.trim().slice(0, 50));
                    notify(socket, 'NGワードを追加しました');
                }
                break;

            case 'ng_remove':
                ngWords = ngWords.filter(w => w !== value);
                notify(socket, 'NGワードを削除しました');
                break;

            case 'clear':
                messages.length = 0;
                io.emit('clear_messages');
                notify(socket, 'チャット履歴を削除しました');
                break;

            case 'rank':
                notify(socket, 'このサンプルではOwner以外へのランク変更は未実装です');
                break;

            default:
                notify(socket, '不明な管理者コマンドです');
        }
    });

    socket.on('disconnect', () => {
        const user = users.get(socket.id);
        if (user) {
            users.delete(socket.id);
            io.emit('system_message', `${user.username} が退室しました`);
            io.emit('user_list', getUserList());
        }
    });
});

// 補助関数
function safeCompare(input, secret) {
    if (typeof input !== 'string') return false;

    const a = Buffer.from(input);
    const b = Buffer.from(secret);

    const crypto = require('crypto');

    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

function getUserList() {
    return [...users.values()].map(u => ({
        username: u.username,
        role: u.role
    }));
}

function findUser(username) {
    for (const [id, user] of users.entries()) {
        if (user.username.toLowerCase() === username.toLowerCase()) {
            return { id, emit: (event, data) => io.to(id).emit(event, data), disconnect: () => io.in(id).disconnectSockets(true) };
        }
    }
    return null;
}

function disconnectTarget(username, reason) {
    for (const [id, user] of users.entries()) {
        if (user.username.toLowerCase() === username.toLowerCase()) {
            io.to(id).emit('system_message', reason);
            users.delete(id);
            io.in(id).disconnectSockets(true);
        }
    }
}

function notify(socket, message) {
    socket.emit('system_message', message);
}

function logAction(admin, action, target) {
    adminLogs.push({
        admin,
        action,
        target,
        time: new Date().toISOString()
    });

    if (adminLogs.length > 500) adminLogs.shift();
}

server.listen(PORT, () => {
    console.log(`チャットサーバー起動: http://localhost:${PORT}`);
});
