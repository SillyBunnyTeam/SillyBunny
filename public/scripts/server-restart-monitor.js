function getTrimmedVersionValue(version, key) {
    return String(version?.[key] ?? '').trim();
}

export function hasServerReturnedAfterRestart(version, {
    expectedRevision = '',
    previousServerBootId = '',
    sawOffline = false,
} = {}) {
    const revision = getTrimmedVersionValue(version, 'gitRevision');
    const serverBootId = getTrimmedVersionValue(version, 'serverBootId');
    const previousBootId = String(previousServerBootId ?? '').trim();

    if (expectedRevision && revision === expectedRevision) {
        return true;
    }

    if (previousBootId && serverBootId && serverBootId !== previousBootId) {
        return true;
    }

    return Boolean(sawOffline);
}
