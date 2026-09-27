const GEMINI_SUCCESS_FINISH_REASONS = new Set(["", "STOP"]);

function encodePathSegment(value) {
    return encodeURIComponent(value).replace(/[!'()*]/g, char =>
        `%${char.charCodeAt(0).toString(16).toUpperCase()}`
    );
}

export function normalizeSavedImagePath(value) {
    if (typeof value !== "string") return null;
    const source = value.trim();
    if (!source.startsWith("/user/images/") || source.startsWith("//")) return null;
    if (/[\u0000-\u001f\u007f\\]/.test(source)) return null;

    const segments = source.split("/");
    const encoded = [];
    for (let index = 0; index < segments.length; index++) {
        const segment = segments[index];
        if (index === 0) {
            encoded.push("");
            continue;
        }
        if (!segment) return null;

        let decoded = segment;
        try {
            decoded = decodeURIComponent(segment);
        } catch {
            // A literal percent from the server path is encoded below.
        }
        if (decoded === "." || decoded === ".." || /[\u0000-\u001f\u007f/\\]/.test(decoded)) return null;
        encoded.push(encodePathSegment(decoded));
    }
    return encoded.join("/");
}

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

    for (let i = 0; i < pixels.length; i += 4) {
        const alpha = pixels[i + 3];
        if (alpha <= 8) continue;
        visiblePixels++;
    }

    // Only transparent placeholders are rejected here. Opaque uniform images are
    // legitimate results (solid-color prompts, minimalist art) and must not be
    // discarded by a global content heuristic.
    return visiblePixels < Math.max(1, pixelCount * 0.01);
}
