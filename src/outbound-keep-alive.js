/**
 * How long a pooled outbound socket may sit idle before this process closes it.
 * Node.js and Apache servers close an idle connection after 5 s by default. The client has to give up first, because
 * a request that reuses a socket just after the peer closed it fails with ECONNRESET, and a chat completion is not retried.
 */
export const KEEP_ALIVE_IDLE_TIMEOUT_MS = 4000;

/**
 * Builds the options of an outbound HTTP or HTTPS agent that keeps sockets alive only when the user asked for it.
 * @param {boolean} enableKeepAlive The `enableKeepAlive` setting, from the command line or `config.yaml`.
 * @param {number} [idleTimeoutMs] Idle time after which a free socket is closed by this process.
 * @returns {{ keepAlive: boolean, timeout: number }} Agent options.
 */
export function getKeepAliveAgentOptions(enableKeepAlive, idleTimeoutMs = KEEP_ALIVE_IDLE_TIMEOUT_MS) {
    return { keepAlive: Boolean(enableKeepAlive), timeout: idleTimeoutMs };
}
