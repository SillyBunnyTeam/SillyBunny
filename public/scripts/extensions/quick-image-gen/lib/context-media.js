import { normalizeImageSource } from "./security.js";

export const CONTEXT_MEDIA_LIBRARY_VERSION = 1;
export const DEFAULT_CONTEXT_MEDIA_MAX_BYTES = 50 * 1024 * 1024;

export const SUPPORTED_CONTEXT_MEDIA_FORMATS = Object.freeze([
    Object.freeze({ extensions: Object.freeze([".jpg", ".jpeg"]), mimeType: "image/jpeg", type: "image" }),
    Object.freeze({ extensions: Object.freeze([".png"]), mimeType: "image/png", type: "image" }),
    Object.freeze({ extensions: Object.freeze([".gif"]), mimeType: "image/gif", type: "image" }),
    Object.freeze({ extensions: Object.freeze([".webp"]), mimeType: "image/webp", type: "image" }),
    Object.freeze({ extensions: Object.freeze([".mp4"]), mimeType: "video/mp4", type: "video" }),
    Object.freeze({ extensions: Object.freeze([".webm"]), mimeType: "video/webm", type: "video" }),
]);

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function text(value) {
    return typeof value === "string" ? value.trim() : "";
}

function labelFor(value, fallback) {
    return text(value?.label) || text(value?.name) || fallback;
}

function hashString(value) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
}

function slug(value, fallback) {
    const result = value.toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40);
    return result || fallback;
}

function createStableId(kind, scope, value) {
    const identity = text(value?.path) || labelFor(value, kind);
    return `${kind}-${slug(identity, kind)}-${hashString(`${scope}\0${identity}`)}`;
}

function claimId(kind, scope, value, usedIds) {
    const suppliedId = text(value?.id);
    const baseId = SAFE_ID.test(suppliedId) ? suppliedId : createStableId(kind, scope, value);
    let id = baseId;
    let suffix = 2;
    while (usedIds.has(id)) {
        id = `${baseId}-${suffix}`;
        suffix += 1;
    }
    usedIds.add(id);
    return id;
}

function normalizeMediaPath(value) {
    return text(value).replaceAll("\\", "/");
}

function normalizeMedia(media, scope, usedIds) {
    const source = text(media?.source).toLowerCase() === "remote" ? "remote" : "server";
    const remote = source === "remote" ? validateContextMediaRemoteUrl(media?.path) : null;
    if (remote && !remote.valid) return null;
    const path = remote?.url || normalizeMediaPath(media?.path);
    const mimeType = remote?.format.mimeType || text(media?.mimeType).toLowerCase();
    const knownFormat = SUPPORTED_CONTEXT_MEDIA_FORMATS.find((format) => format.mimeType === mimeType);
    const id = claimId("media", scope, { ...media, path }, usedIds);
    return {
        id,
        label: labelFor(media, path.split("/").pop() || "Media"),
        path,
        source,
        mimeType,
        type: remote?.format.type || text(media?.type).toLowerCase() || knownFormat?.type || "",
        size: Number.isSafeInteger(media?.size) && media.size >= 0 ? media.size : null,
        verifiedAt: source === "remote" ? text(media?.verifiedAt) : "",
    };
}

function normalizeSubfolder(subfolder, scope, usedIds) {
    const id = claimId("subfolder", scope, subfolder, usedIds);
    const media = Array.isArray(subfolder?.media) ? subfolder.media : [];
    return {
        id,
        label: labelFor(subfolder, "Subfolder"),
        description: text(subfolder?.description),
        media: media.filter((item) => item && typeof item === "object")
            .map((item) => normalizeMedia(item, `${scope}/${id}`, usedIds))
            .filter(Boolean),
    };
}

function normalizeFolder(folder, scope, usedIds) {
    const id = claimId("folder", scope, folder, usedIds);
    const subfolders = Array.isArray(folder?.subfolders) ? folder.subfolders : [];
    const media = Array.isArray(folder?.media) ? folder.media : [];
    return {
        id,
        label: labelFor(folder, "Folder"),
        description: text(folder?.description),
        media: media.filter((item) => item && typeof item === "object")
            .map((item) => normalizeMedia(item, `${scope}/${id}`, usedIds))
            .filter(Boolean),
        subfolders: subfolders.filter((item) => item && typeof item === "object")
            .map((item) => normalizeSubfolder(item, `${scope}/${id}`, usedIds)),
    };
}

function normalizeProfile(profile, usedIds) {
    const id = claimId("profile", "context-media", profile, usedIds);
    const folders = Array.isArray(profile?.folders) ? profile.folders : [];
    return {
        id,
        label: labelFor(profile, "Profile"),
        description: text(profile?.description),
        folders: folders.filter((item) => item && typeof item === "object")
            .map((item) => normalizeFolder(item, id, usedIds)),
    };
}

export function normalizeContextMediaLibrary(library = {}) {
    if (!library || typeof library !== "object" || Array.isArray(library)) {
        throw new TypeError("Context Media library must be an object");
    }
    if (library.version !== undefined && library.version !== CONTEXT_MEDIA_LIBRARY_VERSION) {
        throw new Error(`Unsupported Context Media library version: ${library.version}`);
    }

    const usedIds = new Set();
    const profiles = Array.isArray(library.profiles) ? library.profiles : [];
    const normalizedProfiles = profiles.filter((item) => item && typeof item === "object")
        .map((item) => normalizeProfile(item, usedIds));
    const profileIds = new Set(normalizedProfiles.map((profile) => profile.id));
    const chatMap = {};
    if (library.chatMap && typeof library.chatMap === "object" && !Array.isArray(library.chatMap)) {
        for (const [chatId, profileId] of Object.entries(library.chatMap)) {
            const key = text(chatId);
            const value = text(profileId);
            if (key && profileIds.has(value)) chatMap[key] = value;
        }
    }
    return {
        version: CONTEXT_MEDIA_LIBRARY_VERSION,
        profiles: normalizedProfiles,
        chatMap,
    };
}

export function buildContextMediaCandidates(library, options = {}) {
    const normalized = normalizeContextMediaLibrary(library);
    const profileIds = options.profileIds == null
        ? null
        : new Set(Array.isArray(options.profileIds) ? options.profileIds : [options.profileIds]);
    const candidates = [];

    for (const profile of normalized.profiles) {
        if (profileIds && !profileIds.has(profile.id)) continue;
        for (const folder of profile.folders) {
            if (options.includeEmpty || folder.media.length > 0) {
                candidates.push({
                    number: candidates.length + 1,
                    id: folder.id,
                    label: [profile.label, folder.label].join(" / "),
                    description: folder.description,
                    profileId: profile.id,
                    folderId: folder.id,
                    subfolderId: null,
                    media: folder.media.map((item) => ({ ...item })),
                });
            }
            for (const subfolder of folder.subfolders) {
                if (!options.includeEmpty && subfolder.media.length === 0) continue;
                candidates.push({
                    number: candidates.length + 1,
                    id: subfolder.id,
                    label: [profile.label, folder.label, subfolder.label].join(" / "),
                    description: subfolder.description,
                    profileId: profile.id,
                    folderId: folder.id,
                    subfolderId: subfolder.id,
                    media: subfolder.media.map((item) => ({ ...item })),
                });
            }
        }
    }
    return candidates;
}

function unwrapClassifierJson(response) {
    if (typeof response !== "string" || !response.trim()) {
        throw new TypeError("Classifier response must be a non-empty string");
    }
    const trimmed = response.trim();
    if (!trimmed.startsWith("```")) return trimmed;
    const match = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(trimmed);
    if (!match) throw new Error("Classifier response contains an invalid JSON fence");
    return match[1].trim();
}

export function parseContextMediaClassifierResponse(response, candidates) {
    let parsed;
    try {
        parsed = JSON.parse(unwrapClassifierJson(response));
    } catch (error) {
        if (error instanceof TypeError) throw error;
        throw new Error(`Invalid classifier response: ${error.message}`);
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Classifier response must be an object");
    }
    if (Object.keys(parsed).length !== 2 || !Array.isArray(parsed.candidates)) {
        throw new Error('Classifier response must contain only "candidates" and "confidence"');
    }

    if (typeof parsed.confidence !== "number" || !Number.isFinite(parsed.confidence) || parsed.confidence < 0 || parsed.confidence > 100) {
        throw new Error("Classifier confidence must be a finite number from 0 to 100");
    }

    const knownNumbers = new Set((Array.isArray(candidates) ? candidates : []).map((candidate) => candidate?.number));
    const selected = parsed.candidates;
    if (selected.some((number) => !Number.isInteger(number))) {
        throw new Error("Classifier candidate numbers must be integers");
    }
    if (new Set(selected).size !== selected.length) {
        throw new Error("Classifier candidate numbers must be unique");
    }
    const unknown = selected.find((number) => !knownNumbers.has(number));
    if (unknown !== undefined) throw new Error(`Unknown classifier candidate: ${unknown}`);
    return {
        candidateNumbers: selected.slice(),
        confidence: parsed.confidence,
    };
}

export function selectContextMedia(candidates, selectedNumbers, options = {}) {
    const candidateList = Array.isArray(candidates) ? candidates : [];
    const selected = Array.isArray(selectedNumbers) ? selectedNumbers : [];
    const byNumber = new Map(candidateList.map((candidate) => [candidate?.number, candidate]));
    const unknown = selected.find((number) => !byNumber.has(number));
    if (unknown !== undefined) throw new Error(`Unknown classifier candidate: ${unknown}`);

    const mediaById = new Map();
    for (const number of selected) {
        for (const media of byNumber.get(number)?.media || []) {
            if (media?.id && !mediaById.has(media.id)) mediaById.set(media.id, media);
        }
    }

    let media = [...mediaById.values()];
    if (media.length > 1 && options.previousMediaId) {
        media = media.filter((item) => item.id !== options.previousMediaId);
    }
    if (media.length === 0) return null;

    const random = options.random || Math.random;
    const value = random();
    if (!Number.isFinite(value) || value < 0 || value >= 1) {
        throw new RangeError("Random source must return a number from 0 up to, but not including, 1");
    }
    return { ...media[Math.floor(value * media.length)] };
}

function extensionFor(value) {
    const path = text(value).split(/[?#]/, 1)[0];
    const fileName = path.split(/[\\/]/).pop() || "";
    const dot = fileName.lastIndexOf(".");
    return dot >= 0 ? fileName.slice(dot).toLowerCase() : "";
}

function isObviouslyNonPublicHostname(hostname) {
    const host = text(hostname).toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    if (!host) return true;
    if (/\.(?:home|internal|intranet|lan|local|localdomain)$/i.test(host)) return true;
    return !host.includes(".") && !host.includes(":") && !/^\d+$/.test(host);
}

export function validateContextMediaRemoteUrl(value) {
    const source = text(value);
    const errors = [];
    let parsed = null;
    try {
        parsed = new URL(source);
    } catch {
        errors.push("Media URL must be an absolute HTTPS URL");
    }
    if (parsed?.protocol !== "https:") errors.push("Media URL must use HTTPS");
    if (parsed && (parsed.username || parsed.password)) errors.push("Media URL must not contain embedded credentials");
    if (parsed?.search || parsed?.hash) errors.push("Media URL must not contain query parameters or fragments");

    const normalized = parsed?.protocol === "https:"
        ? normalizeImageSource(source, { allowHttp: false, allowRelative: false, blockPrivateHosts: true })
        : null;
    if (parsed?.protocol === "https:" && (!normalized || isObviouslyNonPublicHostname(parsed.hostname))) {
        errors.push("Media URL host is private, local, or invalid");
    }
    const extension = parsed ? extensionFor(parsed.pathname) : "";
    const format = SUPPORTED_CONTEXT_MEDIA_FORMATS.find((item) => item.extensions.includes(extension));
    if (!format) errors.push(`Unsupported media URL extension: ${extension || "(none)"}`);

    return {
        valid: errors.length === 0,
        errors,
        url: errors.length === 0 ? normalized : null,
        format: errors.length === 0 ? {
            extension,
            mimeType: format.mimeType,
            type: format.type,
        } : null,
    };
}

export function validateContextMediaFile(file, options = {}) {
    const maxBytes = options.maxBytes ?? DEFAULT_CONTEXT_MEDIA_MAX_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
        throw new RangeError("maxBytes must be a non-negative safe integer");
    }

    const extension = extensionFor(file?.name || file?.path);
    const suppliedType = text(file?.type).toLowerCase();
    const mimeType = text(file?.mimeType || (suppliedType.includes("/") ? suppliedType : "")).toLowerCase();
    const declaredType = text(file?.mediaType || (!suppliedType.includes("/") ? suppliedType : "")).toLowerCase();
    const extensionFormat = SUPPORTED_CONTEXT_MEDIA_FORMATS.find((format) => format.extensions.includes(extension));
    const mimeFormat = SUPPORTED_CONTEXT_MEDIA_FORMATS.find((format) => format.mimeType === mimeType);
    const errors = [];

    if (!extensionFormat) errors.push(`Unsupported media extension: ${extension || "(none)"}`);
    if (!mimeFormat) errors.push(`Unsupported media MIME type: ${mimeType || "(none)"}`);
    if (extensionFormat && mimeFormat && extensionFormat !== mimeFormat) {
        errors.push(`Media extension ${extension} does not match MIME type ${mimeType}`);
    }
    const expectedType = extensionFormat?.type || mimeFormat?.type;
    if (declaredType && declaredType !== expectedType) {
        errors.push(`Media type ${declaredType} does not match ${expectedType || "the file format"}`);
    }
    if (!Number.isSafeInteger(file?.size) || file.size < 0) {
        errors.push("Media size must be a non-negative safe integer");
    } else if (file.size > maxBytes) {
        errors.push(`Media exceeds the ${maxBytes} byte limit`);
    }

    return {
        valid: errors.length === 0,
        errors,
        format: errors.length === 0 ? {
            extension,
            mimeType: mimeFormat.mimeType,
            type: mimeFormat.type,
        } : null,
    };
}

function allMedia(library) {
    return normalizeContextMediaLibrary(library).profiles.flatMap((profile) =>
        profile.folders.flatMap((folder) =>
            folder.media.concat(folder.subfolders.flatMap((subfolder) => subfolder.media))
        )
    );
}

export function countContextMediaPathReferences(library) {
    const references = new Map();
    for (const media of allMedia(library)) {
        if (!media.path) continue;
        references.set(media.path, (references.get(media.path) || 0) + 1);
    }
    return references;
}

export function canDeleteContextMediaPath(library, path, removingMediaIds) {
    const normalizedPath = normalizeMediaPath(path);
    if (!normalizedPath) return false;
    const removedIds = new Set(Array.isArray(removingMediaIds) ? removingMediaIds : [removingMediaIds]);
    let references = 0;
    let removedReferences = 0;

    for (const media of allMedia(library)) {
        if (media.path !== normalizedPath) continue;
        references += 1;
        if (removedIds.has(media.id)) removedReferences += 1;
    }
    return references > 0 && removedReferences > 0 && references === removedReferences;
}
