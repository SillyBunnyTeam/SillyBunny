export function createAccessibleIconButton(documentRef, {
    tagName = "button",
    id = "",
    className = "",
    label,
    title = label,
} = {}) {
    if (!documentRef?.createElement) throw new TypeError("A document is required");
    if (!String(label || "").trim()) throw new TypeError("An accessible label is required");

    const button = documentRef.createElement(tagName);
    if (button.tagName === "BUTTON") {
        button.type = "button";
    } else {
        button.setAttribute("role", "button");
        button.setAttribute("tabindex", "0");
    }
    if (id) button.id = id;
    if (className) button.className = className;
    button.setAttribute("aria-label", String(label));
    button.title = String(title || label);
    return button;
}

export function resolveMainGenerationControlState({
    active = false,
    paletteAvailable = false,
    manageBusyState = false,
    cancelling = false,
    shortcutLabel = "",
} = {}) {
    if (active && !paletteAvailable) {
        return {
            action: "cancel",
            ariaBusy: true,
            disabled: false,
            iconClass: cancelling ? "fa-spinner fa-spin" : "fa-stop",
            label: cancelling ? "Cancelling..." : "Cancel",
            title: cancelling ? "Cancellation requested" : "Cancel active image generation",
        };
    }
    if (active && manageBusyState) {
        return {
            action: "busy",
            ariaBusy: true,
            disabled: true,
            iconClass: "fa-spinner fa-spin",
            label: "Generating...",
            title: "Image generation is active; use the palette button to cancel",
        };
    }
    return {
        action: "generate",
        ariaBusy: false,
        disabled: false,
        iconClass: "fa-wand-magic-sparkles",
        label: "Generate",
        title: `Generate image with current settings${shortcutLabel ? ` (${shortcutLabel})` : ""}`,
    };
}

export function shouldBlockGenerationStart({
    active = false,
    now = 0,
    blockedUntil = 0,
} = {}) {
    const currentTime = Number(now);
    const lockExpiry = Number(blockedUntil);
    return !active
        && Number.isFinite(currentTime)
        && Number.isFinite(lockExpiry)
        && currentTime < lockExpiry;
}
