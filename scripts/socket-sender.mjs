// ─── ACE: Engine — WHO SENT A SOCKET MESSAGE, AS THE SERVER SAYS ────────────
//
// His rule, 2026-10-11: "A socket cannot prove who is asking."
//
// PROVEN from Foundry 13.351's own server (dist/server/sockets.mjs,
// handleCustomSocket): a module socket message is relayed as
//
//     socket.broadcast.emit(event, data, this.user.id)
//
// so every listener is called as (data, senderId), and senderId is the user
// the SERVER authenticated on that connection. Anything inside `data` was
// written by the sender. Every Engine check used to read `data.userId`, which
// let a player name a GM, or name nobody and skip the test altogether.
//
// Every Engine listener now starts with stampSender: the payload's own
// `userId` and `senderId` are thrown away and replaced by the server's. The
// existing checks, all of which already meant "the sender", then read the
// truth without each one being rewritten.

/**
 * The payload with its sender overwritten by the one the server stamped.
 * @param {object} raw          the payload as it arrived
 * @param {string|undefined} senderId  the second argument Foundry passes every listener
 */
export function stampSender(raw, senderId) {
    const data = (raw && typeof raw === "object") ? { ...raw } : {};
    data.userId = senderId ?? null;
    data.senderId = senderId ?? null;
    return data;
}

/** The sender as a User, or null when the server stamped nobody. */
export function senderUser(data) {
    const id = data?.senderId ?? null;
    return id ? (game.users?.get?.(id) ?? null) : null;
}

/** True only when the server says a GM sent this. */
export function sentByGM(data) {
    return !!senderUser(data)?.isGM;
}
