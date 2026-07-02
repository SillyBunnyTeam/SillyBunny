/**
 * Conversation Mode REST API - Utilities and Validation
 *
 * Shared utility functions for persona scoping, validation, and image fetching.
 */

// Validation constants
export const MAX_AVATAR_LENGTH = 512;
export const MAX_CHARACTER_FIELD_LENGTH = 8 * 1024; // 8KB
export const MAX_ARRAY_LENGTH = 1000;

// Image fetching constants
const IMAGE_FETCH_TIMEOUT_MS = 10000; // 10 seconds
const IMAGE_MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

const PERSONA_CONVERSATION_STORE_PREFIX = 'persona:';

/**
 * Type guard for plain objects
 */
export function isObject(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/**
 * Safe object getter - returns empty object if not a plain object
 */
export function getObject(value) {
    return isObject(value) ? value : {};
}

/**
 * Parse positive integer with fallback
 */
export function parsePositiveInt(value, fallback, min = 1) {
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

/**
 * Clamp value between min and max
 */
export function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

/**
 * Normalize persona ID from request body
 */
export function getConversationPersonaId(personaId = '') {
    return String(personaId || '').trim();
}

/**
 * Extract persona ID from request (supports multiple aliases)
 */
export function getRequestPersonaId(request) {
    return getConversationPersonaId(
        request.body?.personaId
        || request.body?.persona
        || request.body?.personaAvatar
        || request.body?.userAvatar,
    );
}

/**
 * URL-encode a storage key part
 */
export function encodeConversationStoragePart(value) {
    return encodeURIComponent(String(value || '').trim());
}

/**
 * Scope a storage key to a persona namespace
 */
export function scopeConversationStorageKey(storageKey, personaId = '') {
    const key = String(storageKey || '').trim();
    const persona = getConversationPersonaId(personaId);
    if (!key || !persona || key.startsWith(PERSONA_CONVERSATION_STORE_PREFIX)) {
        return key;
    }

    return `${PERSONA_CONVERSATION_STORE_PREFIX}${encodeConversationStoragePart(persona)}:${key}`;
}

/**
 * Validate avatar parameter
 */
export function validateAvatar(avatar) {
    if (!avatar || typeof avatar !== 'string') {
        return { valid: false, error: 'avatar_required' };
    }
    const trimmed = avatar.trim();
    if (!trimmed || trimmed.length > MAX_AVATAR_LENGTH) {
        return { valid: false, error: 'invalid_avatar' };
    }
    return { valid: true, avatar: trimmed };
}

/**
 * Validate generation payload structure
 */
export function validateGenerationPayload(generation) {
    if (!isObject(generation)) {
        return { valid: false, error: 'generation_required' };
    }
    if (!isObject(generation.payload)) {
        return { valid: false, error: 'generation_payload_required' };
    }
    if (!generation.payload.model || typeof generation.payload.model !== 'string') {
        return { valid: false, error: 'generation_model_required' };
    }
    return { valid: true };
}

/**
 * Validate character override fields
 */
export function validateCharacterOverride(character) {
    if (!character) {
        return { valid: true };
    }
    if (!isObject(character)) {
        return { valid: false, error: 'invalid_character' };
    }
    const fields = ['name', 'description', 'personality', 'scenario', 'mes_example', 'first_mes'];
    for (const field of fields) {
        if (character[field] && typeof character[field] === 'string' && character[field].length > MAX_CHARACTER_FIELD_LENGTH) {
            return { valid: false, error: `character_${field}_too_long` };
        }
    }
    return { valid: true };
}

/**
 * Validate Conversation Mode store structure
 */
export function validateStoreStructure(store) {
    if (!isObject(store)) {
        return { valid: false, error: 'invalid_store' };
    }

    // Validate top-level keys
    const allowedKeys = ['version', 'localStorageMigrated', 'settings', 'characters', 'groups', 'reminders'];
    const unknownKeys = Object.keys(store).filter(key => !allowedKeys.includes(key));
    if (unknownKeys.length > 0) {
        return { valid: false, error: 'unknown_store_keys', keys: unknownKeys };
    }

    // Validate array lengths
    if (Array.isArray(store.groups) && store.groups.length > MAX_ARRAY_LENGTH) {
        return { valid: false, error: 'too_many_groups' };
    }
    if (Array.isArray(store.reminders) && store.reminders.length > MAX_ARRAY_LENGTH) {
        return { valid: false, error: 'too_many_reminders' };
    }

    return { valid: true };
}

/**
 * Check if an avatar is a member of a group
 */
export function isAvatarInGroup(avatar, groupId, store) {
    const groups = Array.isArray(store.groups) ? store.groups : [];
    const group = groups.find(g => String(g?.id) === String(groupId));
    if (!group) {
        return false;
    }
    return Array.isArray(group.members) && group.members.includes(avatar) &&
           !(Array.isArray(group.disabled_members) && group.disabled_members.includes(avatar));
}

/**
 * Check if hostname is a private IP (for SSRF protection)
 */
function isPrivateIP(hostname) {
    // Block private IP ranges for SSRF protection
    const privatePatterns = [
        /^127\./,                    // 127.0.0.0/8
        /^10\./,                     // 10.0.0.0/8
        /^172\.(1[6-9]|2\d|3[01])\./, // 172.16.0.0/12
        /^192\.168\./,               // 192.168.0.0/16
        /^169\.254\./,               // 169.254.0.0/16 (link-local)
        /^::1$/,                     // IPv6 loopback
        /^fe80:/,                    // IPv6 link-local
        /^fc00:/,                    // IPv6 ULA
        /^localhost$/i,
    ];

    return privatePatterns.some(pattern => pattern.test(hostname));
}

/**
 * Fetch image URL and convert to base64 with SSRF protection
 */
export async function fetchImageToBase64(imageUrl) {
    if (typeof imageUrl !== 'string' || !imageUrl) {
        return '';
    }

    // Already base64
    if (imageUrl.startsWith('data:')) {
        return imageUrl;
    }

    try {
        const url = new URL(imageUrl);

        // SSRF protection: block private IPs in dev mode unless explicitly allowed
        // In production, always block private IPs
        const isDevelopment = process.env.NODE_ENV !== 'production';
        if (!isDevelopment || !['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
            if (isPrivateIP(url.hostname)) {
                console.warn(`Blocked image fetch to private IP: ${url.hostname}`);
                return imageUrl; // Return original URL, don't crash
            }
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);

        const response = await fetch(imageUrl, {
            method: 'GET',
            signal: controller.signal,
            headers: {
                'User-Agent': 'SillyBunny-Conversation-API/1.0',
            },
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            console.warn(`Failed to fetch image ${imageUrl}: status ${response.status}`);
            return imageUrl;
        }

        const contentLength = response.headers.get('content-length');
        if (contentLength && parseInt(contentLength, 10) > IMAGE_MAX_SIZE_BYTES) {
            console.warn(`Image too large: ${contentLength} bytes (max ${IMAGE_MAX_SIZE_BYTES})`);
            return imageUrl;
        }

        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > IMAGE_MAX_SIZE_BYTES) {
            console.warn(`Image too large: ${buffer.byteLength} bytes (max ${IMAGE_MAX_SIZE_BYTES})`);
            return imageUrl;
        }

        const contentType = response.headers.get('content-type') || 'image/jpeg';
        const base64 = Buffer.from(buffer).toString('base64');
        return `data:${contentType};base64,${base64}`;
    } catch (error) {
        if (error.name === 'AbortError') {
            console.warn(`Image fetch timeout: ${imageUrl}`);
        } else {
            console.warn(`Failed to fetch image ${imageUrl}:`, error.message);
        }
        return imageUrl; // Return original URL on error
    }
}

/**
 * Convert multiple image URLs to base64 with concurrency control
 */
export async function convertImageUrlsToBase64(imageUrls, concurrency = 3) {
    const urls = Array.isArray(imageUrls) ? imageUrls : [];
    if (!urls.length) {
        return [];
    }

    const results = new Array(urls.length).fill('');
    let nextIndex = 0;
    const workerCount = Math.max(1, Math.min(concurrency, urls.length));
    const workers = Array.from({ length: workerCount }, async () => {
        while (nextIndex < urls.length) {
            const index = nextIndex;
            nextIndex += 1;
            results[index] = await fetchImageToBase64(urls[index]);
        }
    });

    await Promise.all(workers);
    return results;
}

/**
 * Extract avatar from request body
 */
export function getRequestAvatar(request) {
    return String(request.body?.avatar || '').trim();
}

/**
 * Extract groupId from request body
 */
export function getRequestGroupId(request) {
    return String(request.body?.groupId || '').trim();
}
