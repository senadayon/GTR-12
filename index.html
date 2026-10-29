const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';
const DATA_FILE = path.join(__dirname, 'data.json');

const RANKS = [
    'Owner',
    'Admin',
    'Moderator',
    'Member',
    'Regular'
];

const PERMISSION_KEYS = [
    'kick',
    'ban',
    'unban',
    'mute',
    'unmute',
    'lock',
    'unlock',
    'slowmode',
    'pin',
    'unpin',
    'ng_add',
    'ng_remove',
    'clear'
];

const DEFAULT_PERMISSIONS = {
    Owner: Object.fromEntries(
        PERMISSION_KEYS.map(key => [key, true])
    ),

    Admin: Object.fromEntries(
        PERMISSION_KEYS.map(key => [key, true])
    ),

    Moderator: {
        kick: true,
        ban: false,
        unban: false,
        mute: true,
        unmute: true,
        lock: false,
        unlock: false,
        slowmode: true,
        pin: true,
        unpin: true,
        ng_add: false,
        ng_remove: false,
        clear: false
    },

    Member: Object.fromEntries(
        PERMISSION_KEYS.map(key => [key, false])
    ),

    Regular: Object.fromEntries(
        PERMISSION_KEYS.map(key => [key, false])
    )
};

function createDefaultData() {
    return {
        roles: {},
        permissions: JSON.parse(
            JSON.stringify(DEFAULT_PERMISSIONS)
        ),
        bans: [],
        mutes: [],
        ng: [],
        messages: [],
        locked: false,
        slow: 0,
        pin: null,
        logs: []
    };
}

function loadData() {
    const defaults = createDefaultData();

    try {
        if (!fs.existsSync(DATA_FILE)) {
            fs.writeFileSync(
                DATA_FILE,
                JSON.stringify(defaults, null, 2)
            );

            return defaults;
        }

        const saved = JSON.parse(
            fs.readFileSync(DATA_FILE, 'utf8')
        );

        const data = {
            ...defaults,
            ...saved
        };

        data.roles = saved.roles || {};

        data.permissions = {
            ...defaults.permissions,
            ...(saved.permissions || {})
        };

        for (const rank of RANKS) {
            data.permissions[rank] = {
                ...DEFAULT_PERMISSIONS[rank],
                ...(data.permissions[rank] || {})
            };
        }

        return data;
    } catch (error) {
        console.error('データ読み込みエラー:', error);
        return defaults;
    }
}

let data = loadData();

const connectedUsers = new Map();

function saveData() {
    try {
        fs.writeFileSync(
            DATA_FILE,
            JSON.stringify(data, null, 2)
        );
    } catch (error) {
        console.error('データ保存エラー:', error);
    }
}

function cleanText(value, maxLength = 500) {
    return String(value ?? '')
        .trim()
        .slice(0, maxLength);
}

function findUser(username) {
    for (const [id, user] of connectedUsers.entries()) {
        if (
            user.username.toLowerCase() ===
            username.toLowerCase()
        ) {
            return {
                id,
                ...user
            };
        }
    }

    return null;
}

function getUserList() {
    return [...connectedUsers.values()].map(user => ({
        username: user.username,
        role: user.role,
        muted: data.mutes.includes(
            user.username.toLowerCase()
        )
    }));
}

function broadcastUserList() {
    io.emit('user_list', getUserList());
}

function systemMessage(text) {
    io.emit('system_message', {
        text,
        at: new Date().toISOString()
    });
}

function logAction(actor, action, target = '') {
    data.logs.unshift({
        actor,
        action,
        target,
        at: new Date().toISOString()
    });

    data.logs = data.logs.slice(0, 100);

    saveData();
}

function hasPermission(user, permission) {
    return Boolean(
        user &&
        data.permissions[user.role] &&
        data.permissions[user.role][permission]
    );
}

function rankLevel(rank) {
    return RANKS.indexOf(rank);
}

function canModerateTarget(actor, target) {
    if (!target) {
        return true;
    }

    return rankLevel(target.role) > rankLevel(actor.role);
}

function sendPermissionData(socket, user) {
    if (!socket || !user) {
        return;
    }

    socket.emit('permissions_data', {
        role: user.role,
        permissions: data.permissions,
        chatLocked: data.locked,
        slowMode: data.slow,
        pinnedMessage: data.pin,
        ngWords: data.ng
    });
}

app.use(express.static(
    path.join(__dirname, 'public')
));

app.get('/health', (req, res) => {
    res.json({
        ok: true
    });
});

io.on('connection', socket => {

    // =========================
    // ログイン
    // =========================

    socket.on('join', (input, callback) => {
        const username = cleanText(
            typeof input === 'object'
                ? input.username
                : input,
            24
        );

        const secret = typeof input === 'object'
            ? String(input.secret || '')
            : '';

        const reply = typeof callback === 'function'
            ? callback
            : () => {};

        if (
            !username ||
            !/^[\p{L}\p{N}_ -]+$/u.test(username)
        ) {
            return reply({
                ok: false,
                error: 'ユーザー名を正しく入力してください。'
            });
        }

        if (
            data.bans.includes(username.toLowerCase())
        ) {
            return reply({
                ok: false,
                error: 'このユーザー名はBANされています。'
            });
        }

        if (findUser(username)) {
            return reply({
                ok: false,
                error: 'そのユーザー名は使用中です。'
            });
        }

        let role =
            data.roles[username.toLowerCase()] ||
            'Regular';

        // Ownerはサーバー側の秘密鍵で認証
        if (
            ADMIN_SECRET &&
            secret &&
            secret === ADMIN_SECRET
        ) {
            role = 'Owner';

            data.roles[username.toLowerCase()] =
                'Owner';

            saveData();
        }

        if (!RANKS.includes(role)) {
            role = 'Regular';
        }

        const user = {
            username,
            role,
            lastMessageAt: 0
        };

        connectedUsers.set(socket.id, user);

        socket.emit('joined', {
            username,
            role,
            messages: data.messages,
            chatLocked: data.locked,
            slowMode: data.slow,
            pinnedMessage: data.pin
        });

        sendPermissionData(socket, user);

        broadcastUserList();

        reply({
            ok: true,
            username,
            role
        });

        systemMessage(
            `${username} が参加しました。`
        );
    });

    // =========================
    // メッセージ送信
    // =========================

    socket.on('chat_message', rawText => {
        const user = connectedUsers.get(socket.id);

        if (!user) {
            return;
        }

        const text = cleanText(rawText, 500);

        if (!text) {
            return;
        }

        if (
            data.mutes.includes(
                user.username.toLowerCase()
            )
        ) {
            return socket.emit('system_message', {
                text: 'ミュート中のため送信できません。'
            });
        }

        if (
            data.locked &&
            !['Owner', 'Admin'].includes(user.role)
        ) {
            return socket.emit('system_message', {
                text: 'チャットはロックされています。'
            });
        }

        const remaining =
            data.slow * 1000 -
            (Date.now() - user.lastMessageAt);

        if (data.slow > 0 && remaining > 0) {
            return socket.emit('system_message', {
                text: `スローモード中です。あと${Math.ceil(
                    remaining / 1000
                )}秒待ってください。`
            });
        }

        const lowerText = text.toLowerCase();

        if (
            data.ng.some(word =>
                lowerText.includes(word.toLowerCase())
            )
        ) {
            return socket.emit('system_message', {
                text: 'NGワードが含まれています。'
            });
        }

        user.lastMessageAt = Date.now();

        const message = {
            id: `${Date.now()}-${Math.random()
                .toString(36)
                .slice(2, 8)}`,
            username: user.username,
            role: user.role,
            text,
            at: new Date().toISOString()
        };

        data.messages.push(message);

        data.messages = data.messages.slice(-300);

        saveData();

        io.emit('chat_message', message);
    });

    // =========================
    // 管理者操作
    // =========================

    socket.on('admin_action', payload => {
        const actor = connectedUsers.get(socket.id);

        if (!actor || !payload) {
            return;
        }

        const action = cleanText(payload.action, 30);
        const targetName = cleanText(payload.target, 24);
        const value = payload.value;

        // -------------------------
        // ランク変更
        // -------------------------

        if (action === 'rank') {
            if (actor.role !== 'Owner') {
                return socket.emit('system_message', {
                    text: 'ランク変更はOwnerのみ実行できます。'
                });
            }

            const newRank = cleanText(value, 20);

            if (!RANKS.includes(newRank)) {
                return socket.emit('system_message', {
                    text: '指定されたランクが無効です。'
                });
            }

            if (!targetName) {
                return socket.emit('system_message', {
                    text: '対象ユーザー名を入力してください。'
                });
            }

            // オンライン・オフライン両方のランクを保存
            data.roles[targetName.toLowerCase()] =
                newRank;

            const target = findUser(targetName);

            if (target) {
                const liveUser =
                    connectedUsers.get(target.id);

                liveUser.role = newRank;

                const targetSocket =
                    io.sockets.sockets.get(target.id);

                if (targetSocket) {
                    targetSocket.data.role = newRank;

                    targetSocket.emit('role_updated', {
                        role: newRank
                    });

                    sendPermissionData(
                        targetSocket,
                        liveUser
                    );
                }
            }

            saveData();

            logAction(
                actor.username,
                `rank:${newRank}`,
                targetName
            );

            broadcastUserList();

            socket.emit('system_message', {
                text: `${targetName} のランクを ${newRank} に変更しました。`
            });

            return;
        }

        // -------------------------
        // ランクごとの権限変更
        // -------------------------

        if (action === 'set_permissions') {
            if (actor.role !== 'Owner') {
                return socket.emit('system_message', {
                    text: '権限変更はOwnerのみ実行できます。'
                });
            }

            const rank = cleanText(payload.rank, 20);

            if (
                !['Admin', 'Moderator', 'Member']
                    .includes(rank)
            ) {
                return socket.emit('system_message', {
                    text: 'このランクの権限は変更できません。'
                });
            }

            if (!value || typeof value !== 'object') {
                return;
            }

            data.permissions[rank] = {
                ...DEFAULT_PERMISSIONS[rank]
            };

            for (const key of PERMISSION_KEYS) {
                if (typeof value[key] === 'boolean') {
                    data.permissions[rank][key] =
                        value[key];
                }
            }

            saveData();

            logAction(
                actor.username,
                `permissions:${rank}`
            );

            for (const [id, user] of connectedUsers) {
                const userSocket =
                    io.sockets.sockets.get(id);

                sendPermissionData(userSocket, user);
            }

            io.emit('permissions_updated', {
                permissions: data.permissions
            });

            socket.emit('system_message', {
                text: `${rank} の権限を更新しました。`
            });

            return;
        }

        // -------------------------
        // その他の操作の権限確認
        // -------------------------

        if (
            !PERMISSION_KEYS.includes(action) ||
            !hasPermission(actor, action)
        ) {
            return socket.emit('system_message', {
                text: 'この操作を行う権限がありません。'
            });
        }

        // Kick / BAN / Mute / Unmute
        if (
            ['kick', 'ban', 'mute', 'unmute']
                .includes(action)
        ) {
            if (!targetName) {
                return socket.emit('system_message', {
                    text: '対象ユーザー名を入力してください。'
                });
            }

            const target = findUser(targetName);

            if (!canModerateTarget(actor, target)) {
                return socket.emit('system_message', {
                    text: '自分と同じか上位ランクには実行できません。'
                });
            }

            if (action === 'kick' || action === 'ban') {
                if (
                    action === 'ban' &&
                    !data.bans.includes(
                        targetName.toLowerCase()
                    )
                ) {
                    data.bans.push(
                        targetName.toLowerCase()
                    );
                }

                if (target) {
                    const targetSocket =
                        io.sockets.sockets.get(target.id);

                    targetSocket?.emit('kicked', {
                        text: action === 'ban'
                            ? 'BANされました。'
                            : '退出させられました。'
                    });

                    targetSocket?.disconnect(true);
                }

                saveData();

                logAction(
                    actor.username,
                    action,
                    targetName
                );

                broadcastUserList();

                return;
            }

            if (
                action === 'mute' &&
                !data.mutes.includes(
                    targetName.toLowerCase()
                )
            ) {
                data.mutes.push(
                    targetName.toLowerCase()
                );
            }

            if (action === 'unmute') {
                data.mutes = data.mutes.filter(
                    name =>
                        name !== targetName.toLowerCase()
                );
            }

            saveData();

            logAction(
                actor.username,
                action,
                targetName
            );

            broadcastUserList();

            systemMessage(
                `${targetName} を${
                    action === 'mute'
                        ? 'ミュート'
                        : 'ミュート解除'
                }しました。`
            );

            return;
        }

        // BAN解除
        if (action === 'unban') {
            data.bans = data.bans.filter(
                name =>
                    name !== targetName.toLowerCase()
            );

            saveData();

            logAction(
                actor.username,
                'unban',
                targetName
            );

            socket.emit('system_message', {
                text: `${targetName} のBANを解除しました。`
            });

            return;
        }

        // チャットロック
        if (action === 'lock' || action === 'unlock') {
            data.locked = action === 'lock';

            saveData();

            logAction(actor.username, action);

            io.emit('chat_settings', {
                chatLocked: data.locked,
                slowMode: data.slow
            });

            systemMessage(
                data.locked
                    ? 'チャットをロックしました。'
                    : 'チャットのロックを解除しました。'
            );

            return;
        }

        // スローモード
        if (action === 'slowmode') {
            const seconds = Number(value);

            if (
                !Number.isFinite(seconds) ||
                seconds < 0 ||
                seconds > 3600
            ) {
                return socket.emit('system_message', {
                    text: '0〜3600秒で指定してください。'
                });
            }

            data.slow = Math.floor(seconds);

            saveData();

            logAction(
                actor.username,
                `slowmode:${data.slow}`
            );

            io.emit('chat_settings', {
                chatLocked: data.locked,
                slowMode: data.slow
            });

            systemMessage(
                data.slow
                    ? `スローモードを${data.slow}秒に設定しました。`
                    : 'スローモードを解除しました。'
            );

            return;
        }

        // メッセージ固定
        if (action === 'pin') {
            const text = cleanText(value, 500);

            if (!text) {
                return socket.emit('system_message', {
                    text: '固定するメッセージを入力してください。'
                });
            }

            data.pin = text;

            saveData();

            logAction(actor.username, 'pin');

            io.emit('pinned_message', {
                text
            });

            return;
        }

        // 固定解除
        if (action === 'unpin') {
            data.pin = null;

            saveData();

            logAction(actor.username, 'unpin');

            io.emit('pinned_message', {
                text: null
            });

            return;
        }

        // NGワード追加
        if (action === 'ng_add') {
            const word = cleanText(value, 80);

            if (!word) {
                return;
            }

            if (!data.ng.includes(word)) {
                data.ng.push(word);
            }

            saveData();

            logAction(
                actor.username,
                'ng_add',
                word
            );

            sendPermissionData(socket, actor);

            return;
        }

        // NGワード削除
        if (action === 'ng_remove') {
            const word = cleanText(value, 80);

            data.ng = data.ng.filter(
                item => item !== word
            );

            saveData();

            logAction(
                actor.username,
                'ng_remove',
                word
            );

            sendPermissionData(socket, actor);

            return;
        }

        // チャット履歴消去
        if (action === 'clear') {
            data.messages = [];

            saveData();

            logAction(actor.username, 'clear');

            io.emit('clear_messages');
        }
    });

    socket.on('disconnect', () => {
        const user = connectedUsers.get(socket.id);

        connectedUsers.delete(socket.id);

        if (user) {
            broadcastUserList();

            systemMessage(
                `${user.username} が退出しました。`
            );
        }
    });
});

server.listen(PORT, () => {
    console.log(`サーバー起動: port ${PORT}`);

    if (!ADMIN_SECRET) {
        console.warn(
            'ADMIN_SECRET が設定されていません。Ownerログインには秘密鍵が必要です。'
        );
    }
});
