/**
 * Loads a panel once on demand. Indexing can prepare it without activating polling
 * or requests, and closing it while loading prevents a late activation.
 * @param {() => Promise<{onActivate?: Function, onDeactivate?: Function}>} load
 * @returns {{ensureReady: Function, activate: Function, deactivate: Function}}
 */
export function createDeferredPanel(load) {
    let pending;
    let panel;
    let active = false;
    let activated = false;

    const ensureReady = () => {
        if (panel) return Promise.resolve(panel);
        pending ??= Promise.resolve().then(load).then(result => {
            panel = result;
            return result;
        }).catch(error => {
            pending = undefined;
            throw error;
        });
        return pending;
    };

    return {
        ensureReady,
        async activate() {
            active = true;
            const result = await ensureReady();
            if (active && !activated) {
                activated = true;
                try {
                    result.onActivate?.();
                } catch (error) {
                    activated = false;
                    throw error;
                }
            }
        },
        deactivate() {
            active = false;
            if (activated) panel.onDeactivate?.();
            activated = false;
        },
    };
}
