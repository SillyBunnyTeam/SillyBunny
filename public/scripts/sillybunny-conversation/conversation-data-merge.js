/**
 * The rebase of a chat that the server changed while this page held an older copy (a save answered 409 `integrity`).
 *
 * Messages are told apart by their id. A message that only this page wrote is kept and put among the server's
 * messages by its time. A message that both copies have is taken from the server, so an edit made here to a message
 * that the server also changed is lost, and so is a delete made here: both are counted, and the page tells the user.
 */

/**
 * @param {object[]} messages The messages of a chat as they are on the server after a load or a save.
 * @returns {{ ids: Set<string>, json: Map<string, string> }}
 */
export function describeSyncedMessages(messages) {
    return { ids: new Set(messages.map(message => message.id)), json: new Map(messages.map(message => [message.id, JSON.stringify(message)])) };
}

function insertByTime(messages, message) {
    const time = Number(message.created_at) || 0;
    let index = messages.length;
    while (index > 0 && (Number(messages[index - 1].created_at) || 0) > time) {
        index--;
    }
    messages.splice(index, 0, message);
}

function getMemory(header) {
    return header?.chat_metadata?.sb_conversation;
}

/**
 * @param {object} input
 * @param {object[]} input.localMessages The messages that this page holds.
 * @param {object} input.localHeader The header that this page holds.
 * @param {{ ids: Set<string>, json: Map<string, string> }} input.synced What the server had at the last load or save.
 * @param {object[]} input.serverRecords `[header, ...messages]` as the server has them now.
 * @returns {{ messages: object[], header: object, appended: number, lostEdits: number, lostDeletes: number, headerChanged: boolean }} New
 * values; the arguments are not changed.
 */
export function rebaseChat({ localMessages, localHeader, synced, serverRecords }) {
    const [serverHeader, ...serverMessages] = serverRecords;
    const serverById = new Map(serverMessages.map(message => [message.id, message]));
    const localIds = new Set(localMessages.map(message => message.id));

    const messages = [...serverMessages];
    let appended = 0;
    let lostEdits = 0;
    for (const message of localMessages) {
        const onServer = serverById.get(message.id);
        if (!onServer) {
            if (!synced.ids.has(message.id)) {
                insertByTime(messages, message);
                appended++;
            }
            continue;
        }
        const edited = JSON.stringify(message) !== synced.json.get(message.id);
        if (edited && JSON.stringify(onServer) !== JSON.stringify(message)) {
            lostEdits++;
        }
    }
    const lostDeletes = serverMessages.filter(message => synced.ids.has(message.id) && !localIds.has(message.id)).length;

    const header = structuredClone(serverHeader);
    const localMemory = getMemory(localHeader);
    const serverMemory = getMemory(serverHeader);
    let headerChanged = false;
    if (localMemory && (Number(localMemory.memory_updated_at) || 0) > (Number(serverMemory?.memory_updated_at) || 0)) {
        header.chat_metadata = { ...header.chat_metadata, sb_conversation: structuredClone(localMemory) };
        headerChanged = true;
    }
    return { messages, header, appended, lostEdits, lostDeletes, headerChanged };
}
