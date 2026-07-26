const REGISTRY_KEY = Symbol.for('sillybunny.extensionCapabilities');

function getRegistry() {
    let registry = globalThis[REGISTRY_KEY];
    if (!registry?.set) {
        registry = new Map();
        Object.defineProperty(globalThis, REGISTRY_KEY, {
            configurable: true,
            value: registry,
        });
    }
    return registry;
}

export function getExtensionCapability(name) {
    return getRegistry().get(name) ?? null;
}

export function registerExtensionCapability(name, capability) {
    const registry = getRegistry();
    registry.set(name, capability);
    return () => {
        if (registry.get(name) === capability) {
            registry.delete(name);
        }
    };
}
