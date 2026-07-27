import { normalizeImageSource } from "./security.js";
import { detectImageFormat, MAX_IMAGE_DIMENSION, MAX_IMAGE_PIXELS } from "./image-metadata.js";

export const CONTEXT_MEDIA_LIBRARY_VERSION = 1;
export const DEFAULT_CONTEXT_MEDIA_MAX_BYTES = 50 * 1024 * 1024;
export const DEFAULT_CONTEXT_MEDIA_MAX_FILES = 20;
export const DEFAULT_CONTEXT_MEDIA_MAX_TOTAL_BYTES = 100 * 1024 * 1024;

export const SUPPORTED_CONTEXT_MEDIA_FORMATS = Object.freeze([
    Object.freeze({ extensions: Object.freeze([".jpg", ".jpeg"]), mimeType: "image/jpeg", type: "image" }),
    Object.freeze({ extensions: Object.freeze([".png"]), mimeType: "image/png", type: "image" }),
    Object.freeze({ extensions: Object.freeze([".gif"]), mimeType: "image/gif", type: "image" }),
    Object.freeze({ extensions: Object.freeze([".webp"]), mimeType: "image/webp", type: "image" }),
    Object.freeze({ extensions: Object.freeze([".mp4"]), mimeType: "video/mp4", type: "video" }),
    Object.freeze({ extensions: Object.freeze([".webm"]), mimeType: "video/webm", type: "video" }),
]);

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_CONTEXT_MEDIA_CONTAINER_ELEMENTS = 8_192;
const MAX_WEBM_HEADER_BYTES = 1024 * 1024;
const MAX_WEBM_CLUSTER_ELEMENTS_TO_INSPECT = 256;

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

function asMediaBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return null;
}

function bytesAscii(bytes, start, length) {
    let result = "";
    for (let index = 0; index < length; index += 1) result += String.fromCharCode(bytes[start + index]);
    return result;
}

function readIsoMediaBoxes(bytes, start, end, state) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const boxes = [];
    let offset = start;
    while (offset < end) {
        state.elements += 1;
        if (state.elements > MAX_CONTEXT_MEDIA_CONTAINER_ELEMENTS || offset + 8 > end) return null;
        let size = view.getUint32(offset);
        const type = bytesAscii(bytes, offset + 4, 4);
        let headerSize = 8;
        if (size === 1) {
            if (offset + 16 > end) return null;
            const largeSize = view.getBigUint64(offset + 8);
            if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) return null;
            size = Number(largeSize);
            headerSize = 16;
        } else if (size === 0) {
            size = end - offset;
        }
        if (size < headerSize || size > end - offset) return null;
        boxes.push({ type, start: offset + headerSize, end: offset + size });
        offset += size;
    }
    return offset === end ? boxes : null;
}

function isMp4Brand(brand) {
    return /^(?:isom|iso[2-9]|mp4[12]|avc1|dash|M4V |MSNV|f4v |cmf[cs])$/.test(brand)
        || /^3g[2p][A-Za-z0-9 ]$/.test(brand);
}

function hasValidFullBoxLength(bytes, box, versionZeroLength, versionOneLength) {
    if (!box || box.end <= box.start) return false;
    const version = bytes[box.start];
    return (version === 0 && box.end - box.start >= versionZeroLength)
        || (version === 1 && box.end - box.start >= versionOneLength);
}

function isStructurallyValidMp4(bytes) {
    if (bytes.length < 32 || bytes.length > DEFAULT_CONTEXT_MEDIA_MAX_BYTES) return false;
    const state = { elements: 0 };
    const boxes = readIsoMediaBoxes(bytes, 0, bytes.length, state);
    if (!boxes) return false;
    const ftyp = boxes.find((box) => box.type === "ftyp");
    const moov = boxes.find((box) => box.type === "moov");
    const hasMediaData = boxes.some((box) => box.type === "mdat" && box.end > box.start);
    const ftypLength = ftyp ? ftyp.end - ftyp.start : 0;
    if (!ftyp || !moov || !hasMediaData || ftypLength < 8 || ftypLength > 1_024 || ftypLength % 4 !== 0) return false;

    const brands = [bytesAscii(bytes, ftyp.start, 4)];
    for (let offset = ftyp.start + 8; offset < ftyp.end; offset += 4) brands.push(bytesAscii(bytes, offset, 4));
    if (!brands.some(isMp4Brand)) return false;

    const moovBoxes = readIsoMediaBoxes(bytes, moov.start, moov.end, state);
    if (!moovBoxes || !hasValidFullBoxLength(bytes, moovBoxes.find((box) => box.type === "mvhd"), 100, 112)) return false;
    for (const track of moovBoxes.filter((box) => box.type === "trak")) {
        const trackBoxes = readIsoMediaBoxes(bytes, track.start, track.end, state);
        if (!trackBoxes || !hasValidFullBoxLength(bytes, trackBoxes.find((box) => box.type === "tkhd"), 84, 96)) continue;
        const media = trackBoxes.find((box) => box.type === "mdia");
        if (!media) continue;
        const mediaBoxes = readIsoMediaBoxes(bytes, media.start, media.end, state);
        const mediaHeader = mediaBoxes?.find((box) => box.type === "mdhd");
        const handler = mediaBoxes?.find((box) => box.type === "hdlr");
        const mediaInfo = mediaBoxes?.find((box) => box.type === "minf");
        if (!mediaBoxes || !hasValidFullBoxLength(bytes, mediaHeader, 24, 36)
            || !handler || handler.end - handler.start < 24
            || bytesAscii(bytes, handler.start + 8, 4) !== "vide" || !mediaInfo) continue;
        const mediaInfoBoxes = readIsoMediaBoxes(bytes, mediaInfo.start, mediaInfo.end, state);
        if (mediaInfoBoxes?.some((box) => box.type === "stbl")) return true;
    }
    return false;
}

function readEbmlVint(bytes, offset, maxLength, stripMarker) {
    if (offset >= bytes.length || bytes[offset] === 0) return null;
    let marker = 0x80;
    let length = 1;
    while (length <= maxLength && !(bytes[offset] & marker)) {
        marker >>>= 1;
        length += 1;
    }
    if (length > maxLength || offset + length > bytes.length) return null;
    let value = BigInt(stripMarker ? bytes[offset] & (marker - 1) : bytes[offset]);
    let unknown = stripMarker && (bytes[offset] & (marker - 1)) === marker - 1;
    for (let index = 1; index < length; index += 1) {
        value = (value << 8n) | BigInt(bytes[offset + index]);
        unknown = unknown && bytes[offset + index] === 0xff;
    }
    if (!unknown && value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return { length, unknown, value: unknown ? null : Number(value) };
}

function readEbmlElement(bytes, offset, limit, state, allowUnknownSize = false) {
    state.elements += 1;
    if (state.elements > MAX_CONTEXT_MEDIA_CONTAINER_ELEMENTS) return null;
    const id = readEbmlVint(bytes, offset, 4, false);
    if (!id) return null;
    const size = readEbmlVint(bytes, offset + id.length, 8, true);
    if (!size || (size.unknown && !allowUnknownSize)) return null;
    const start = offset + id.length + size.length;
    const end = size.unknown ? limit : start + size.value;
    if (start > limit || end > limit || end < start) return null;
    return { id: id.value, start, end, unknownSize: size.unknown };
}

function readEbmlUnsigned(bytes, element) {
    const length = element.end - element.start;
    if (length < 1 || length > 8) return null;
    let value = 0n;
    for (let offset = element.start; offset < element.end; offset += 1) value = (value << 8n) | BigInt(bytes[offset]);
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

function hasValidVideoDimensions(width, height) {
    return Number.isSafeInteger(width) && Number.isSafeInteger(height)
        && width > 0 && height > 0
        && width <= MAX_IMAGE_DIMENSION && height <= MAX_IMAGE_DIMENSION
        && width * height <= MAX_IMAGE_PIXELS;
}

function isValidWebmInfo(bytes, info, state) {
    let offset = info.start;
    let sawKnownField = false;
    while (offset < info.end) {
        const element = readEbmlElement(bytes, offset, info.end, state);
        if (!element) return false;
        if (element.id === 0x2ad7b1) {
            const scale = readEbmlUnsigned(bytes, element);
            if (!scale) return false;
            sawKnownField = true;
        } else if ([0x4489, 0x4d80, 0x5741].includes(element.id) && element.end > element.start) {
            sawKnownField = true;
        }
        offset = element.end;
    }
    return sawKnownField;
}

function isValidWebmVideoTrack(bytes, track, state) {
    let offset = track.start;
    let trackType = null;
    let codec = "";
    let video = null;
    while (offset < track.end) {
        const element = readEbmlElement(bytes, offset, track.end, state);
        if (!element) return false;
        if (element.id === 0x83) trackType = readEbmlUnsigned(bytes, element);
        else if (element.id === 0x86 && element.end - element.start <= 64) codec = bytesAscii(bytes, element.start, element.end - element.start);
        else if (element.id === 0xe0) video = element;
        offset = element.end;
    }
    if (trackType !== 1 || !codec.startsWith("V_") || !video) return false;

    let width = null;
    let height = null;
    offset = video.start;
    while (offset < video.end) {
        const element = readEbmlElement(bytes, offset, video.end, state);
        if (!element) return false;
        if (element.id === 0xb0) width = readEbmlUnsigned(bytes, element);
        else if (element.id === 0xba) height = readEbmlUnsigned(bytes, element);
        offset = element.end;
    }
    return hasValidVideoDimensions(width, height);
}

function hasValidWebmVideoTrack(bytes, tracks, state) {
    let offset = tracks.start;
    while (offset < tracks.end) {
        const element = readEbmlElement(bytes, offset, tracks.end, state);
        if (!element) return false;
        if (element.id === 0xae && isValidWebmVideoTrack(bytes, element, state)) return true;
        offset = element.end;
    }
    return false;
}

function hasWebmBlockGroup(bytes, group, state) {
    let offset = group.start;
    for (let count = 0; offset < group.end && count < 64; count += 1) {
        const element = readEbmlElement(bytes, offset, group.end, state);
        if (!element) return false;
        if (element.id === 0xa1 && element.end - element.start >= 5) return true;
        offset = element.end;
    }
    return false;
}

function isValidWebmCluster(bytes, cluster, state) {
    let offset = cluster.start;
    let sawTimestamp = false;
    let sawBlock = false;
    for (let count = 0; offset < cluster.end && count < MAX_WEBM_CLUSTER_ELEMENTS_TO_INSPECT; count += 1) {
        const element = readEbmlElement(bytes, offset, cluster.end, state);
        if (!element || element.unknownSize) return false;
        if (element.id === 0xe7) sawTimestamp = readEbmlUnsigned(bytes, element) !== null;
        else if (element.id === 0xa3 && element.end - element.start >= 5) sawBlock = true;
        else if (element.id === 0xa0 && hasWebmBlockGroup(bytes, element, state)) sawBlock = true;
        if (sawTimestamp && sawBlock) return true;
        offset = element.end;
    }
    return false;
}

function isStructurallyValidWebm(bytes) {
    if (bytes.length < 24 || bytes.length > DEFAULT_CONTEXT_MEDIA_MAX_BYTES) return false;
    const state = { elements: 0 };
    const header = readEbmlElement(bytes, 0, bytes.length, state);
    if (!header || header.id !== 0x1a45dfa3 || header.end - header.start > MAX_WEBM_HEADER_BYTES) return false;

    let offset = header.start;
    let docType = "";
    while (offset < header.end) {
        const element = readEbmlElement(bytes, offset, header.end, state);
        if (!element) return false;
        if (element.id === 0x4282 && element.end - element.start <= 16) {
            docType = bytesAscii(bytes, element.start, element.end - element.start).toLowerCase();
        }
        offset = element.end;
    }
    if (docType !== "webm") return false;

    offset = header.end;
    let segment = null;
    while (offset < bytes.length) {
        const element = readEbmlElement(bytes, offset, bytes.length, state, true);
        if (!element || (element.unknownSize && element.id !== 0x18538067)) return false;
        if (element.id === 0x18538067) {
            segment = element;
            break;
        }
        if (element.id !== 0xec && element.id !== 0xbf) return false;
        offset = element.end;
    }
    if (!segment || segment.end <= segment.start) return false;

    let sawInfo = false;
    let sawVideoTrack = false;
    let sawCluster = false;
    offset = segment.start;
    while (offset < segment.end) {
        const element = readEbmlElement(bytes, offset, segment.end, state, true);
        if (!element || (element.unknownSize && element.id !== 0x1f43b675)) return false;
        if (element.id === 0x1549a966) sawInfo = isValidWebmInfo(bytes, element, state);
        else if (element.id === 0x1654ae6b) sawVideoTrack = hasValidWebmVideoTrack(bytes, element, state);
        else if (element.id === 0x1f43b675) sawCluster = isValidWebmCluster(bytes, element, state);
        if (sawInfo && sawVideoTrack && sawCluster) return true;
        offset = element.end;
    }
    return false;
}

export function contextMediaBytesMatchFormat(value, format) {
    const bytes = asMediaBytes(value);
    if (!bytes || !bytes.length || bytes.length > DEFAULT_CONTEXT_MEDIA_MAX_BYTES) return false;
    if (format?.type === "image") return detectImageFormat(bytes)?.mime === format.mimeType;
    if (format?.mimeType === "video/mp4") return isStructurallyValidMp4(bytes);
    if (format?.mimeType === "video/webm") return isStructurallyValidWebm(bytes);
    return false;
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

export function validateContextMediaFileSelection(files, options = {}) {
    const maxFiles = options.maxFiles ?? DEFAULT_CONTEXT_MEDIA_MAX_FILES;
    const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_CONTEXT_MEDIA_MAX_TOTAL_BYTES;
    if (!Number.isSafeInteger(maxFiles) || maxFiles < 0) {
        throw new RangeError("maxFiles must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 0) {
        throw new RangeError("maxTotalBytes must be a non-negative safe integer");
    }

    const source = files || [];
    const declaredLength = Number(source.length ?? 0);
    if (Number.isSafeInteger(declaredLength) && declaredLength > maxFiles) {
        return {
            valid: false,
            errors: [`Select no more than ${maxFiles} Context Media files at once`],
            files: [],
            totalBytes: 0,
        };
    }
    const selectedFiles = [];
    const errors = [];
    let totalBytes = 0;
    const selectedSource = typeof source[Symbol.iterator] === "function" ? source : Array.from(source);
    for (const file of selectedSource) {
        if (selectedFiles.length >= maxFiles) {
            errors.push(`Select no more than ${maxFiles} Context Media files at once`);
            break;
        }
        selectedFiles.push(file);
        if (!Number.isSafeInteger(file?.size) || file.size < 0) {
            errors.push(`${text(file?.name) || "Media file"} has an invalid byte size`);
            continue;
        }
        if (file.size > maxTotalBytes - totalBytes) {
            errors.push(`Selected Context Media files exceed the ${maxTotalBytes} byte aggregate limit`);
            break;
        }
        totalBytes += file.size;
    }
    return {
        valid: errors.length === 0,
        errors,
        files: errors.length === 0 ? selectedFiles : [],
        totalBytes,
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
