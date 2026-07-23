const GEMINI_SUCCESS_FINISH_REASONS = new Set(["", "STOP"]);

export function getGeminiCandidateFailure(candidate) {
    const finishReason = String(candidate?.finishReason || "").trim().toUpperCase();
    if (GEMINI_SUCCESS_FINISH_REASONS.has(finishReason)) return null;

    const explanation = (candidate?.content?.parts || [])
        .map(part => typeof part?.text === "string" ? part.text.trim() : "")
        .filter(Boolean)
        .join(" ")
        .slice(0, 300);
    const suffix = explanation ? `: ${explanation}` : "";

    return `Gemini did not complete image generation (${finishReason})${suffix}`;
}

export function isEffectivelyBlankPixels(pixels) {
    if (!pixels || pixels.length < 4 || pixels.length % 4 !== 0) return true;

    const pixelCount = pixels.length / 4;
    let visiblePixels = 0;
    let minR = 255;
    let minG = 255;
    let minB = 255;
    let maxR = 0;
    let maxG = 0;
    let maxB = 0;
    let luminanceSum = 0;
    let luminanceSquaredSum = 0;

    for (let i = 0; i < pixels.length; i += 4) {
        const alpha = pixels[i + 3];
        if (alpha <= 8) continue;

        const r = pixels[i];
        const g = pixels[i + 1];
        const b = pixels[i + 2];
        const luminance = (0.2126 * r) + (0.7152 * g) + (0.0722 * b);
        visiblePixels++;
        minR = Math.min(minR, r);
        minG = Math.min(minG, g);
        minB = Math.min(minB, b);
        maxR = Math.max(maxR, r);
        maxG = Math.max(maxG, g);
        maxB = Math.max(maxB, b);
        luminanceSum += luminance;
        luminanceSquaredSum += luminance * luminance;
    }

    if (visiblePixels < Math.max(1, pixelCount * 0.01)) return true;

    const channelRange = Math.max(maxR - minR, maxG - minG, maxB - minB);
    const meanLuminance = luminanceSum / visiblePixels;
    const luminanceVariance = Math.max(0, (luminanceSquaredSum / visiblePixels) - (meanLuminance * meanLuminance));
    return channelRange <= 12
        && luminanceVariance <= 4
        && (meanLuminance <= 8 || meanLuminance >= 247);
}
