/**
 * Lets one tab at a time run the automatic worker. Two open tabs of the same browser share one data folder on the server,
 * so two workers would each send the follow-up of a quiet chat, and each fire a due reminder.
 *
 * Where Web Locks exist, the tab that holds the lock `sb-conversation-worker` leads, and the browser hands the lock to a
 * waiting tab when the leader's tab closes. Web Locks need a secure context, so a SillyBunny that a phone opens over a
 * plain `http` address on the local network has none; there the tabs elect a leader over a `BroadcastChannel`, which has
 * no secure-context rule. Where neither exists no tab can learn of another, so every tab leads, as it did before.
 *
 * Everything that belongs to the page comes in through the parameters, so that tests run several tabs on a fake clock.
 */

const LOCK_NAME = 'sb-conversation-worker';
const CHANNEL_NAME = 'sb-conversation-worker';
/** A leader says that it is alive this often. */
export const HEARTBEAT_MS = 10_000;
/** A follower takes over when it heard nothing from a leader for this long: more than two missed beats. */
export const STALE_AFTER_MS = 25_000;
/** A tab that wants to lead waits this long for a better claim or a leader's answer before it takes the lead. */
export const CLAIM_WAIT_MS = 500;

function createRandomId() {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Visible tabs rank ahead of hidden ones so background timer throttling does not flap leadership; ties keep oldest-tab order. */
function isBetterRank(candidate, other) {
    const candidateVisible = candidate.visible !== false;
    const otherVisible = other.visible !== false;
    if (candidateVisible !== otherVisible) {
        return candidateVisible;
    }
    return candidate.startedAt < other.startedAt || (candidate.startedAt === other.startedAt && candidate.id < other.id);
}

/**
 * @param {object} [page]
 * @param {() => ({ request: Function }|undefined)} [page.getLocks] `navigator.locks`, read at each use.
 * @param {((name: string) => { postMessage: Function, addEventListener: Function, close: Function })|null} [page.createChannel]
 * @param {() => number} [page.now]
 * @param {(callback: () => void, delay: number) => any} [page.setTimer]
 * @param {(timer: any) => void} [page.clearTimer]
 * @param {() => string} [page.createId]
 * @param {() => boolean} [page.isVisible] Whether this tab is foregrounded.
 */
export function createWorkerLock({
    getLocks = () => globalThis.navigator?.locks,
    createChannel = typeof BroadcastChannel === 'function' ? name => new BroadcastChannel(name) : null,
    now = () => Date.now(),
    setTimer = (callback, delay) => setTimeout(callback, delay),
    clearTimer = timer => clearTimeout(timer),
    createId = createRandomId,
    isVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
} = {}) {
    /** @type {'none'|'web-locks'|'election'} */
    let mode = 'none';
    let wanted = false;
    /** @type {{ isLeader: () => boolean, stop: () => void }|null} */
    let engine = null;

    function startWebLocks(locks) {
        const controller = new AbortController();
        const state = { leader: false, release: null };
        locks.request(LOCK_NAME, { mode: 'exclusive', signal: controller.signal }, () => new Promise((resolve) => {
            state.release = resolve;
            state.leader = true;
        })).catch((error) => {
            // A page with an opaque origin has the API and is refused every lock; the election works there.
            if (error?.name === 'SecurityError' && wanted && engine === handle) {
                engine = startElection();
            }
        }).finally(() => {
            state.leader = false;
        });
        const handle = {
            isLeader: () => state.leader,
            stop() {
                controller.abort();
                state.release?.();
                state.leader = false;
            },
        };
        return handle;
    }

    function startElection() {
        let channel;
        try {
            channel = createChannel?.(CHANNEL_NAME);
        } catch {
            channel = null;
        }
        if (!channel) {
            mode = 'none';
            return { isLeader: () => true, stop() {} };
        }

        mode = 'election';
        const self = { id: createId(), startedAt: now() };
        let role = 'follower';
        let lastLifeAt = -Infinity;
        let claimTimer = null;
        let beatTimer = null;
        let watchTimer = null;
        let closed = false;

        const selfRank = () => ({ id: self.id, startedAt: self.startedAt, visible: Boolean(isVisible()) });
        const post = message => channel.postMessage({ ...message, ...selfRank() });

        function becomeLeader() {
            role = 'leader';
            post({ type: 'beat' });
            beatTimer = setTimer(function beat() {
                post({ type: 'beat' });
                beatTimer = setTimer(beat, HEARTBEAT_MS);
            }, HEARTBEAT_MS);
        }

        function stepDown() {
            clearTimer(beatTimer);
            beatTimer = null;
            clearTimer(claimTimer);
            claimTimer = null;
            role = 'follower';
        }

        function claim() {
            claimTimer = null;
            if (closed || role !== 'follower' || now() - lastLifeAt < STALE_AFTER_MS) {
                return;
            }
            role = 'candidate';
            post({ type: 'claim' });
            claimTimer = setTimer(() => {
                claimTimer = null;
                if (!closed && role === 'candidate') {
                    becomeLeader();
                }
            }, CLAIM_WAIT_MS);
        }

        function onMessage({ data }) {
            if (closed || !data || data.id === self.id) {
                return;
            }
            const other = { id: String(data.id), startedAt: Number(data.startedAt), visible: data.visible !== false };
            const currentSelf = selfRank();
            if (data.type === 'who') {
                if (role === 'leader') {
                    post({ type: 'beat' });
                }
            } else if (data.type === 'beat') {
                lastLifeAt = now();
                if (role === 'candidate') {
                    if (other.visible || !currentSelf.visible) {
                        stepDown();
                    }
                } else if (role === 'leader') {
                    if (isBetterRank(other, currentSelf)) {
                        stepDown();
                    } else {
                        // Remind a lower-ranked leader (such as a throttled hidden tab waking late) to step down at once.
                        post({ type: 'beat' });
                    }
                }
            } else if (data.type === 'claim') {
                // A tab that claims will lead unless a better one claims too, so this one need not.
                lastLifeAt = now();
                if (role === 'leader') {
                    if (isBetterRank(other, currentSelf)) {
                        stepDown();
                    } else {
                        post({ type: 'beat' });
                    }
                } else if (role === 'candidate' && isBetterRank(other, currentSelf)) {
                    stepDown();
                }
            } else if (data.type === 'resign') {
                lastLifeAt = -Infinity;
                if (role === 'follower') {
                    clearTimer(claimTimer);
                    claim();
                }
            }
        }

        channel.addEventListener('message', onMessage);
        post({ type: 'who' });
        claimTimer = setTimer(claim, CLAIM_WAIT_MS);
        watchTimer = setTimer(function watch() {
            if (role === 'follower' && claimTimer === null && now() - lastLifeAt >= STALE_AFTER_MS) {
                claim();
            }
            watchTimer = setTimer(watch, HEARTBEAT_MS);
        }, HEARTBEAT_MS);

        return {
            isLeader: () => role === 'leader',
            stop() {
                if (role === 'leader') {
                    post({ type: 'resign' });
                }
                closed = true;
                role = 'follower';
                clearTimer(claimTimer);
                clearTimer(beatTimer);
                clearTimer(watchTimer);
                channel.close();
            },
        };
    }

    function begin() {
        const locks = getLocks();
        if (typeof locks?.request === 'function') {
            mode = 'web-locks';
            engine = startWebLocks(locks);
        } else {
            engine = startElection();
        }
    }

    function end() {
        engine?.stop();
        engine = null;
    }

    return Object.freeze({
        /** Joins the election or asks for the lock. */
        start() {
            if (wanted) {
                return;
            }
            wanted = true;
            begin();
        },
        /** Gives the lead up for good. */
        stop() {
            wanted = false;
            end();
        },
        /** Gives the lead up for as long as the page is hidden for good; `resume()` asks for it again. */
        suspend() {
            end();
        },
        resume() {
            if (wanted && !engine) {
                begin();
            }
        },
        /** @returns {boolean} Whether this tab runs the worker now. */
        isLeader: () => wanted && Boolean(engine?.isLeader()),
        get mode() {
            return mode;
        },
    });
}
