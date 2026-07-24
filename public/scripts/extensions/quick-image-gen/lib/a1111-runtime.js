function toNumber(value) {
    if (value == null || (typeof value === "string" && !value.trim())) return NaN;
    return Number(value);
}

export function parseFiniteFloat(value, fallback, min = -Infinity, max = Infinity) {
    const parsed = toNumber(value);
    const finiteValue = Number.isFinite(parsed) ? parsed : toNumber(fallback);
    if (!Number.isFinite(finiteValue)) return fallback;
    return Math.max(min, Math.min(max, finiteValue));
}

export function parseFiniteInt(value, fallback, min = -Infinity, max = Infinity) {
    return Math.trunc(parseFiniteFloat(value, fallback, min, max));
}

export function normalizeA1111BaseUrl(value) {
    return String(value || "").replace(/\/+$/, "");
}

export function buildA1111ADetailerUnit({
    model,
    prompt,
    negativePrompt,
    denoise,
    confidence,
    maskBlur,
    dilateErode,
    inpaintOnlyMasked,
    inpaintPadding,
}) {
    return {
        ad_model: model,
        ad_prompt: prompt || "",
        ad_negative_prompt: negativePrompt || "",
        ad_denoising_strength: parseFiniteFloat(denoise, 0.4, 0, 1),
        ad_confidence: parseFiniteFloat(confidence, 0.3, 0, 1),
        ad_mask_blur: parseFiniteInt(maskBlur, 4, 0, 64),
        ad_dilate_erode: parseFiniteInt(dilateErode, 4, -128, 128),
        ad_inpaint_only_masked: inpaintOnlyMasked ?? true,
        ad_inpaint_only_masked_padding: parseFiniteInt(inpaintPadding, 32, 0, 256),
    };
}
