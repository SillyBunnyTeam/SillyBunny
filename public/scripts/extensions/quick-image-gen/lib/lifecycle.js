export function createLifecycleScope() {
    const cleanups = [];
    let disposed = false;

    const add = (cleanup) => {
        if (typeof cleanup !== "function") return () => {};
        if (disposed) {
            cleanup();
            return () => {};
        }

        let active = true;
        const run = () => {
            if (!active) return;
            active = false;
            const index = cleanups.indexOf(run);
            if (index >= 0) cleanups.splice(index, 1);
            cleanup();
        };
        cleanups.push(run);
        return run;
    };

    const listen = (target, type, handler, options) => {
        if (!target?.addEventListener || !target?.removeEventListener) return () => {};
        target.addEventListener(type, handler, options);
        return add(() => target.removeEventListener(type, handler, options));
    };

    const subscribe = (source, type, handler) => {
        if (!source?.on || !type) return () => {};
        source.on(type, handler);
        return add(() => {
            if (typeof source.off === "function") source.off(type, handler);
            else source.removeListener?.(type, handler);
        });
    };

    const dispose = () => {
        if (disposed) return [];
        disposed = true;
        const errors = [];
        for (const cleanup of cleanups.splice(0).reverse()) {
            try {
                cleanup();
            } catch (error) {
                errors.push(error);
            }
        }
        return errors;
    };

    return {
        add,
        listen,
        subscribe,
        dispose,
        get disposed() {
            return disposed;
        },
    };
}
