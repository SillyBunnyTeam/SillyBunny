const RENDER_ORDER = ['interface', 'timeline', 'palsRail'];

const registeredRenderers = new Map();
const pendingRenderers = new Set();
const renderObservers = new Set();

let pendingFrameId = null;
let pendingInterfaceSyncControls = false;
let flushingRenders = false;

function requestRenderFrame(callback) {
    if (typeof requestAnimationFrame === 'function') {
        return requestAnimationFrame(callback);
    }

    return setTimeout(() => callback(Date.now()), 0);
}

function cancelRenderFrame(frameId) {
    if (typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(frameId);
        return;
    }

    clearTimeout(frameId);
}

export function registerConversationRenderer(name, renderer) {
    if (typeof name === 'string' && typeof renderer === 'function') {
        registeredRenderers.set(name, renderer);
    }
}

function requestFlush() {
    if (pendingFrameId !== null || flushingRenders) {
        return;
    }

    pendingFrameId = requestRenderFrame(() => flushConversationRenders());
}

function scheduleRenderer(name) {
    if (pendingRenderers.has('interface') && name !== 'interface') {
        return;
    }

    pendingRenderers.add(name);
    requestFlush();
}

export function scheduleInterfaceRefresh({ syncControls = false } = {}) {
    pendingInterfaceSyncControls = pendingInterfaceSyncControls || Boolean(syncControls);
    pendingRenderers.delete('timeline');
    pendingRenderers.delete('palsRail');
    scheduleRenderer('interface');
}

export function scheduleTimelineRender() {
    scheduleRenderer('timeline');
}

export function schedulePalsRailRender() {
    scheduleRenderer('palsRail');
}

/**
 * Runs `callback` after each render flush until it returns true, so work that needs the rendered
 * workspace (an enabled composer, say) follows the render instead of guessing a delay.
 */
export function afterConversationRender(callback) {
    if (typeof callback !== 'function') {
        return;
    }

    renderObservers.add(callback);
    requestFlush();
}

function runRenderObservers() {
    for (const observer of [...renderObservers]) {
        let done = true;
        try {
            done = observer() === true;
        } catch (error) {
            console.error('Conversation Mode: render observer failed', error);
        }
        if (done) {
            renderObservers.delete(observer);
        }
    }
}

export function flushConversationRenders() {
    if (pendingFrameId !== null) {
        cancelRenderFrame(pendingFrameId);
        pendingFrameId = null;
    }

    if (!pendingRenderers.size) {
        pendingInterfaceSyncControls = false;
        runRenderObservers();
        return;
    }

    const renderBatch = new Set(pendingRenderers);
    const interfaceSyncControls = pendingInterfaceSyncControls;
    pendingRenderers.clear();
    pendingInterfaceSyncControls = false;

    flushingRenders = true;
    try {
        for (const name of RENDER_ORDER) {
            if (!renderBatch.has(name)) {
                continue;
            }

            const renderer = registeredRenderers.get(name);
            if (!renderer) {
                continue;
            }

            if (name === 'interface') {
                renderer({ syncControls: interfaceSyncControls });
            } else {
                renderer();
            }
        }
    } finally {
        flushingRenders = false;
        runRenderObservers();
        if (pendingRenderers.size) {
            requestFlush();
        }
    }
}
