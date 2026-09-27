export function isNanoGptPayg(model, settings) {
    const hasProviderLists = Object.hasOwn(settings, 'nanogpt_allowed_providers') || Object.hasOwn(settings, 'nanogpt_ignored_providers');
    return model?.subscription?.included === false || settings.nanogpt_payg_override === true
        || settings.nanogpt_allowed_providers?.length > 0 || settings.nanogpt_ignored_providers?.length > 0
        || (!hasProviderLists && typeof settings.nanogpt_provider === 'string' && settings.nanogpt_provider.trim().length > 0);
}

export function getNanoGptServiceTiers(model, settings) {
    const tiers = model?.supported_service_tiers;
    return isNanoGptPayg(model, settings) && Array.isArray(tiers)
        ? [...new Set(tiers.map(tier => tier === 'fast' ? 'priority' : tier))].filter(tier => ['flex', 'priority'].includes(tier))
        : [];
}

export function updateServiceTierOptions(selector, tiers = []) {
    const select = document.querySelector(selector);
    if (!select) return;
    // Keep saved choices visible and let the user return to Default, even when support disappears.
    const value = select.value;
    for (const option of select.options) {
        option.disabled = Boolean(option.value) && !tiers.includes(option.value);
    }
    select.disabled = tiers.length === 0 && !value;
}
