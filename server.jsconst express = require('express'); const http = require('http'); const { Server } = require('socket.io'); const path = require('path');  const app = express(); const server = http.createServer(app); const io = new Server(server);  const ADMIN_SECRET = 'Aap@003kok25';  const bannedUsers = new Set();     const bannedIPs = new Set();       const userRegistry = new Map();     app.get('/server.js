const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const ADMIN_SECRET = 'Aap@003kok25';

const bannedUsers = new Set();    
const bannedIPs = new Set();      
const userRegistry = new Map();   

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

io.on('connection', (socket) => {
    const clientIp = socket.handshake.address;

    if (bannedIPs.has(clientIp)) {
        socket.emit('auth_error', 'あなたのIPアドレスはBANされています。');
        socket.disconnect(true);
        return;
    }

    socket.on('join', ({ username, adminCode }) => {
        if (!username || username.trim() === '') {
            return socket.emit('auth_error', '有効なユーザー名を入力してください。');
        }
        if (bannedUsers.has(username)) {
            return socket.emit('auth_error', 'このユーザー名はBANされています。');
        }

        const isAdmin = (adminCode === ADMIN_SECRET);
        userRegistry.set(socket.id, { username, ip: clientIp, isAdmin });
        socket.emit('login_success', { username, isAdmin });
        io.emit('system_message', `${username} が参加しました。${isAdmin ? '（管理者）' : ''}`);
    });

    socket.on('chat_message', (msg) => {
        const user = userRegistry.get(socket.id);
        if (!user) return;

        io.emit('chat_message', {
            username: user.username,
            msg: msg,
            isAdmin: user.isAdmin,
            time: new Date().toLocaleTimeString()
        });
    });

    socket.on('typing', () => {
        const user = userRegistry.get(socket.id);
        if (user) socket.broadcast.emit('user_typing', user.username);
    });

    socket.on('stop_typing', () => {
        const user = userRegistry.get(socket.id);
        if (user) socket.broadcast.emit('user_stop_typing', user.username);
    });

    socket.on('admin_command', ({ command, target }) => {
        const user = userRegistry.get(socket.id);
        if (!user || !user.isAdmin) {
            return socket.emit('system_message', 'エラー: 管理者権限がありません。');
        }

        const targetTrimmed = target ? target.trim() : '';

        switch (command) {
            case 'kick':
                const kickSocketId = findSocketIdByUsername(targetTrimmed);
                if (kickSocketId) {
                    io.to(kickSocketId).emit('auth_error', '管理者によってキックされました。');
                    io.sockets.sockets.get(kickSocketId).disconnect(true);
                    io.emit('system_message', `${targetTrimmed} がキックされました。`);
                } else {
                    socket.emit('system_message', `ユーザー ${targetTrimmed} が見つかりません。`);
                }
                break;

            case 'ban':
                bannedUsers.add(targetTrimmed);
                io.emit('system_message', `${targetTrimmed} がユーザー名BANされました。`);
                const banSocketId = findSocketIdByUsername(targetTrimmed);
                if (banSocketId) {
                    io.to(banSocketId).emit('auth_error', 'アカウントがBANされました。');
                    io.sockets.sockets.get(banSocketId).disconnect(true);
                }
                break;

            case 'unban':
                if (bannedUsers.delete(targetTrimmed)) {
                    io.emit('system_message', `${targetTrimmed} のユーザー名BANが解除されました。`);
                } else {
                    socket.emit('system_message', `${targetTrimmed} はBANされていません。`);
                }
                break;

            case 'ipban':
                const ipTargetSocketId = findSocketIdByUsername(targetTrimmed);
                if (ipTargetSocketId) {
                    const targetIp = userRegistry.get(ipTargetSocketId).ip;
                    bannedIPs.add(targetIp);
                    io.emit('system_message', `${targetTrimmed} (IP: ${targetIp}) がIP BANされました。`);
                    io.to(ipTargetSocketId).emit('auth_error', 'あなたのIPはBANされました。');
                    io.sockets.sockets.get(ipTargetSocketId).disconnect(true);
                } else {
                    bannedIPs.add(targetTrimmed);
                    io.emit('system_message', `IP: ${targetTrimmed} がIP BANされました。`);
                }
                break;

            case 'unbanip':
                if (bannedIPs.delete(targetTrimmed)) {
                    io.emit('system_message', `IP: ${targetTrimmed} のIP BANが解除されました。`);
                } else {
                    socket.emit('system_message', `IP: ${targetTrimmed} はBANされていません。`);
                }
                break;

            case 'iplist':
                let listMsg = '【オンラインIPリスト】\n';
                userRegistry.forEach((val) => {
                    listMsg += `- ${val.username}: ${val.ip} ${val.isAdmin ? '[管理者]' : ''}\n`;
                });
                listMsg += '【IP BAN中リスト】\n';
                bannedIPs.forEach(ip => listMsg += `- ${ip}\n`);
                socket.emit('system_message', listMsg);
                break;

            default:
                socket.emit('system_message', '不明なコマンドです。');
        }
    });

    socket.on('disconnect', () => {
        const user = userRegistry.get(socket.id);
        if (user) {
            io.emit('system_message', `${user.username} が退室しました。`);
            userRegistry.delete(socket.id);
        }
    });
});

function findSocketIdByUsername(username) {
    for (let [id, user] of userRegistry.entries()) {
        if (user.username === username) return id;
    }
    return null;
}

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
