import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { getConfigValue } from './util.js';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;
// SillyBunny: OpenSSL's default 32 MiB scrypt memory cap rejects N=32768, r=8, p=1 on Node 24+ and Bun 1.4+ without an explicit maxmem.
const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const MAGIC_HEADER = Buffer.from('STENC01');
const SECRET_KEY_FILE = '.secret_key';

/**
 * Derives an AES-256 key from a passphrase using scrypt.
 * @param {string} passphrase
 * @param {Buffer} salt
 * @returns {Buffer}
 */
function deriveKey(passphrase, salt) {
    return crypto.scryptSync(passphrase.normalize('NFC'), salt, KEY_LENGTH, SCRYPT_OPTIONS);
}

/**
 * Encrypts plaintext with AES-256-GCM using a scrypt-derived key.
 * Output format: MAGIC_HEADER | salt | iv | authTag | ciphertext
 * @param {string} plaintext
 * @param {string} passphrase
 * @returns {Buffer}
 */
export function encrypt(plaintext, passphrase) {
    const salt = crypto.randomBytes(SALT_LENGTH);
    const key = deriveKey(passphrase, salt);
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([MAGIC_HEADER, salt, iv, authTag, encrypted]);
}

/**
 * Decrypts a buffer produced by encrypt().
 * @param {Buffer} buffer
 * @param {string} passphrase
 * @returns {string}
 */
export function decrypt(buffer, passphrase) {
    if (!isEncrypted(buffer)) {
        throw new Error('Data is not encrypted or uses an unsupported format');
    }
    let offset = MAGIC_HEADER.length;
    const salt = buffer.subarray(offset, offset + SALT_LENGTH); offset += SALT_LENGTH;
    const iv = buffer.subarray(offset, offset + IV_LENGTH); offset += IV_LENGTH;
    const authTag = buffer.subarray(offset, offset + AUTH_TAG_LENGTH); offset += AUTH_TAG_LENGTH;
    const encrypted = buffer.subarray(offset);
    const key = deriveKey(passphrase, salt);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

/**
 * Checks if a buffer is encrypted (starts with the magic header).
 * @param {Buffer} buffer
 * @returns {boolean}
 */
export function isEncrypted(buffer) {
    return Buffer.isBuffer(buffer)
        && buffer.length > MAGIC_HEADER.length + SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH
        && buffer.subarray(0, MAGIC_HEADER.length).equals(MAGIC_HEADER);
}

/**
 * Resolves the encryption passphrase from config or auto-generated key file.
 * @param {string} dataRoot Path to the data root directory
 * @returns {string|null} Passphrase or null if encryption is not configured
 */
export function getEncryptionPassphrase(dataRoot) {
    const enabled = getConfigValue('encryptSecrets.enabled', false, 'boolean');
    if (!enabled) {
        return null;
    }

    const configPassphrase = getConfigValue('encryptSecrets.passphrase', '', 'string');
    if (configPassphrase) {
        return configPassphrase;
    }

    // Auto-generate and store a key file
    const keyFilePath = path.join(dataRoot, SECRET_KEY_FILE);
    if (fs.existsSync(keyFilePath)) {
        return fs.readFileSync(keyFilePath, 'utf-8').trim();
    }

    const generatedKey = crypto.randomBytes(64).toString('base64url');
    fs.writeFileSync(keyFilePath, generatedKey, { mode: 0o600 });
    console.info(`Generated encryption key file at ${keyFilePath}`);
    return generatedKey;
}
