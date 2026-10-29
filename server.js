case 'rank': {
    // Owner以外のランクを変更できる
    const allowedRoles = new Set([
        'Admin',
        'Moderator',
        'Member',
        'Regular'
    ]);

    if (!target) {
        notify(socket, '対象ユーザー名を入力してください');
        break;
    }

    if (typeof value !== 'string' || !allowedRoles.has(value)) {
        notify(socket, '選択したランクは無効です');
        break;
    }

    let targetEntry = null;

    for (const [id, targetUser] of users.entries()) {
        if (
            targetUser.username.toLowerCase() ===
            target.toLowerCase()
        ) {
            targetEntry = { id, user: targetUser };
            break;
        }
    }

    if (!targetEntry) {
        notify(socket, '対象ユーザーが見つかりません');
        break;
    }

    if (targetEntry.user.role === 'Owner') {
        notify(socket, 'Ownerのランクは変更できません');
        break;
    }

    const oldRole = targetEntry.user.role;

    targetEntry.user.role = value;

    // 本人の画面に変更後のランクを通知
    io.to(targetEntry.id).emit('role_updated', {
        username: targetEntry.user.username,
        role: value
    });

    // 全員のユーザー一覧を更新
    io.emit('user_list', getUserList());

    // 管理ログに記録
    logAction(
        user.username,
        'RANK',
        `${targetEntry.user.username}: ${oldRole} -> ${value}`
    );

    notify(
        socket,
        `${targetEntry.user.username} のランクを ${value} に変更しました`
    );

    io.emit(
        'system_message',
        `${targetEntry.user.username} のランクが ${value} に変更されました`
    );

    break;
}
