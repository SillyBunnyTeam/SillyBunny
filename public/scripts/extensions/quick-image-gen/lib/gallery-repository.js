import { MAX_PNG_FILE_BYTES, validateImageData } from './image-metadata.js';
import { sanitizeEffectiveRequest } from './provider-contract.js';
import { sanitizeReproducibleModel } from './security.js';

export const GALLERY_MANIFEST_VERSION = 2;
export const DEFAULT_GALLERY_LIMIT = 50;

const DEFAULT_DB_NAME = 'qig-gallery';
const DEFAULT_STORE_NAME = 'assets';
const DEFAULT_MANIFEST_KEY = 'qig_gallery_manifest_v2';
const DEFAULT_LEGACY_KEY = 'qig_gallery';
const MAX_SOURCE_ID_LENGTH = 512;
const MAX_PENDING_ASSET_IDS = 500;
const GALLERY_METADATA_FIELDS = Object.freeze([
  'steps', 'sampler', 'scheduler', 'cfgScale', 'seed', 'width', 'height',
  'provider', 'model', 'backend', 'serverSaveStatus',
]);

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
  });
}

function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function createFallbackId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `gallery-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function normalizeDate(value) {
  const date = Number(value);
  return Number.isFinite(date) && date >= 0 ? date : Date.now();
}

function emptyManifest() {
  return {
    version: GALLERY_MANIFEST_VERSION,
    revision: 0,
    legacyMigrated: false,
    cleared: false,
    pendingAssetIds: [],
    entries: [],
  };
}

function boundedIdentity(value) {
  return typeof value === 'string' ? value.slice(0, MAX_SOURCE_ID_LENGTH) : '';
}

function sanitizeManifestValue(value, key = '', depth = 0, seen = new WeakSet()) {
  if (key.startsWith('_') || /(?:api.?key|key$|token|secret|password|credential|authorization|ref.*image|image.*ref|control.*image|workflow|allowlegacyinterrupt|requesttemplate)/i.test(key)) return undefined;
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    if (/^(?:data:image\/|blob:)/i.test(value)) return undefined;
    return value.length <= 16_384 ? value : value.slice(0, 16_384);
  }
  if (typeof value !== 'object' || depth >= 8 || seen.has(value)) return undefined;
  seen.add(value);

  if (Array.isArray(value)) {
    return value.slice(0, 100).map(item => sanitizeManifestValue(item, key, depth + 1, seen)).filter(item => item !== undefined);
  }

  const result = {};
  for (const [childKey, childValue] of Object.entries(value).slice(0, 200)) {
    if (['__proto__', 'prototype', 'constructor'].includes(childKey)) continue;
    const sanitized = sanitizeManifestValue(childValue, childKey, depth + 1, seen);
    if (sanitized !== undefined) result[childKey] = sanitized;
  }
  return result;
}

function sanitizeMetadataSettings(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const result = {};
  for (const key of GALLERY_METADATA_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const sanitized = key === 'model'
      ? sanitizeReproducibleModel(source[key], source.provider)
      : sanitizeManifestValue(source[key], key);
    if (sanitized !== undefined && (typeof sanitized !== 'object' || sanitized === null)) result[key] = sanitized;
  }
  return result;
}

function toManifestEntry(entry, id) {
  const sourceChatId = boundedIdentity(entry?.sourceChatId);
  const sourceMessageId = boundedIdentity(entry?.sourceMessageId);
  const sourceMessageSignature = boundedIdentity(entry?.sourceMessageSignature);
  const hasSafeSourceIdentity = !!(sourceMessageId.trim() || sourceMessageSignature.trim());
  return {
    id,
    assetId: id,
    sourceChatId,
    sourceMessageIndex: hasSafeSourceIdentity && Number.isSafeInteger(entry?.sourceMessageIndex)
      && entry.sourceMessageIndex >= 0 && entry.sourceMessageIndex <= 1_000_000
      ? entry.sourceMessageIndex
      : null,
    sourceMessageId,
    sourceMessageSignature,
    prompt: typeof entry?.prompt === 'string' ? entry.prompt : '',
    negative: typeof entry?.negative === 'string' ? entry.negative : '',
    provider: typeof entry?.provider === 'string' ? entry.provider : '',
    metadataSettings: sanitizeMetadataSettings(entry?.metadataSettings),
    effectiveRequest: sanitizeEffectiveRequest(entry?.effectiveRequest),
    promptWasLLM: entry?.promptWasLLM === true,
    date: normalizeDate(entry?.date),
  };
}

async function clearAssetStore(indexedDB, dbName, storeName) {
  if (!indexedDB?.open) throw new Error('IndexedDB is unavailable');
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName)) {
        request.result.createObjectStore(storeName, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open gallery database'));
    request.onblocked = () => reject(new Error('Gallery database upgrade was blocked'));
  });
  try {
    const transaction = db.transaction(storeName, 'readwrite');
    const done = transactionDone(transaction);
    transaction.objectStore(storeName).clear();
    await done;
  } finally {
    db.close();
  }
}

export async function clearGalleryRepositoryStorage(options = {}) {
  const storage = options.storage || globalThis.localStorage;
  const indexedDB = options.indexedDB || globalThis.indexedDB;
  const dbName = options.dbName || DEFAULT_DB_NAME;
  const storeName = options.storeName || DEFAULT_STORE_NAME;
  const manifestKey = options.manifestKey || DEFAULT_MANIFEST_KEY;
  const legacyKey = options.legacyKey || DEFAULT_LEGACY_KEY;
  let manifest;
  try {
    manifest = parseManifest(storage, manifestKey);
  } catch {
    manifest = emptyManifest();
  }
  const clearMarker = {
    version: GALLERY_MANIFEST_VERSION,
    revision: manifest.revision + 1,
    legacyMigrated: true,
    cleared: true,
    pendingAssetIds: [],
    entries: [],
  };
  storage.setItem(manifestKey, JSON.stringify(clearMarker));
  try {
    storage.removeItem(legacyKey);
  } catch {
    // The durable clear marker prevents legacy data from being restored.
  }
  try {
    await clearAssetStore(indexedDB, dbName, storeName);
    return { assetsCleared: true, marker: clearMarker, error: null };
  } catch (error) {
    // Keep the marker so initialization can finish the interrupted clear later.
    return { assetsCleared: false, marker: clearMarker, error };
  }
}

function parseManifest(storage, key) {
  const raw = storage?.getItem?.(key);
  if (!raw) return emptyManifest();

  try {
    const parsed = JSON.parse(raw);
    if (parsed?.version !== GALLERY_MANIFEST_VERSION || !Array.isArray(parsed.entries)) {
      throw new Error('Unsupported gallery manifest');
    }
    return {
      version: GALLERY_MANIFEST_VERSION,
      revision: Number.isInteger(parsed.revision) ? parsed.revision : 0,
      legacyMigrated: parsed.legacyMigrated === true,
      cleared: parsed.cleared === true,
      pendingAssetIds: Array.isArray(parsed.pendingAssetIds)
        ? [...new Set(parsed.pendingAssetIds.filter(id => typeof id === 'string' && id).slice(0, MAX_PENDING_ASSET_IDS))]
        : [],
      entries: parsed.entries.filter(entry => entry && typeof entry === 'object' && typeof entry.assetId === 'string'),
    };
  } catch (error) {
    throw new Error(`Invalid gallery manifest: ${error.message}`);
  }
}

function parseLegacyEntries(storage, key) {
  const raw = storage?.getItem?.(key);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(entry => entry && typeof entry === 'object') : [];
  } catch {
    return [];
  }
}

function errorMessage(error, fallback) {
  return error instanceof Error && error.message ? error.message : fallback;
}

export class GalleryRepository {
  constructor(options = {}) {
    this.indexedDB = options.indexedDB || globalThis.indexedDB;
    this.storage = options.storage || globalThis.localStorage;
    this.dbName = options.dbName || DEFAULT_DB_NAME;
    this.storeName = options.storeName || DEFAULT_STORE_NAME;
    this.manifestKey = options.manifestKey || DEFAULT_MANIFEST_KEY;
    this.legacyKey = options.legacyKey || DEFAULT_LEGACY_KEY;
    this.maxEntries = options.maxEntries || DEFAULT_GALLERY_LIMIT;
    this.createId = options.createId || createFallbackId;
    this.createObjectURL = options.createObjectURL || (blob => URL.createObjectURL(blob));
    this.revokeObjectURL = options.revokeObjectURL || (url => URL.revokeObjectURL(url));
    this.lockManager = options.lockManager ?? globalThis.navigator?.locks ?? null;
    this.lockName = options.lockName || `qig-gallery:${this.dbName}:${this.manifestKey}`;
    this.entries = [];
    this.manifest = emptyManifest();
    this.objectUrls = new Map();
    this.operationQueue = Promise.resolve();
    this.generation = 0;
    this.dbPromise = null;
  }

  async init(assetFactory) {
    return this.#enqueue(async () => {
      let manifestWasInvalid = false;
      try {
        this.manifest = parseManifest(this.storage, this.manifestKey);
      } catch {
        manifestWasInvalid = true;
        this.manifest = emptyManifest();
      }

      const legacyEntries = this.manifest.legacyMigrated
        ? []
        : parseLegacyEntries(this.storage, this.legacyKey);
      await this.#reconcileAssets({
        replaceInvalidManifest: manifestWasInvalid,
        hasLegacySource: legacyEntries.length > 0,
      });
      const durableEntries = await this.#loadManifestEntries();

      if (!legacyEntries.length) {
        this.entries = durableEntries;
        return this.list();
      }

      const migration = await this.#prepareEntries(legacyEntries, assetFactory, { legacy: true });
      const canMigrate = migration.length === legacyEntries.length
        && migration.every(item => item.asset?.blob instanceof Blob);

      if (!canMigrate) {
        this.entries = this.#sortAndLimit([
          ...durableEntries,
          ...migration.filter(item => !item.asset?.invalid).map(item => this.#createEphemeralEntry(item.entry, item.asset, true)),
        ]);
        return this.list();
      }

      const insertedIds = [];
      const previousManifest = clone(this.manifest);
      let nextManifest = null;
      try {
        for (const item of migration) {
          const metadata = { ...toManifestEntry(item.entry, item.id), legacy: true };
          await this.#putAsset(item.id, item.asset, metadata);
          insertedIds.push(item.id);
        }

        const mergedMetadata = this.#sortAndLimitMetadata([
          ...this.manifest.entries,
          ...migration.map(item => toManifestEntry(item.entry, item.id)),
        ]);
        nextManifest = {
          version: GALLERY_MANIFEST_VERSION,
          revision: this.manifest.revision + 1,
          legacyMigrated: true,
          cleared: false,
          pendingAssetIds: [],
          entries: mergedMetadata,
        };
        const migratedEntries = migration.map(item => this.#materializeEntry(
          toManifestEntry(item.entry, item.id),
          item.asset,
        ));
        this.#writeManifest(nextManifest);
        this.manifest = nextManifest;
        this.entries = this.#sortAndLimit([...durableEntries, ...migratedEntries]);
        try {
          this.storage.removeItem(this.legacyKey);
        } catch {
          // The manifest records migration completion, so legacy data will not be read twice.
        }
        return this.list();
      } catch (error) {
        this.#revokeObjectUrls(insertedIds);
        let restoredManifest = false;
        if (nextManifest && this.manifest === nextManifest) {
          try {
            const rollbackManifest = { ...previousManifest, revision: nextManifest.revision + 1 };
            this.#writeManifest(rollbackManifest, { expectedRevision: nextManifest.revision });
            this.manifest = rollbackManifest;
            restoredManifest = true;
          } catch {
            // Keep the committed manifest and assets intact if rollback cannot be published.
          }
        }
        if (!nextManifest || restoredManifest) {
          await Promise.allSettled(insertedIds.map(id => this.#deleteAsset(id)));
        }
        this.entries = this.#sortAndLimit([
          ...durableEntries,
          ...migration
            .filter(item => !item.asset?.invalid)
            .map(item => this.#createEphemeralEntry(item.entry, item.asset, true, errorMessage(error, 'Legacy migration failed'))),
        ]);
        return this.list();
      }
    });
  }

  add(entry, assetFactory) {
    return this.addMany([entry], assetFactory).then(entries => entries[0] || null);
  }

  addMany(entries, assetFactory) {
    const requestedGeneration = this.generation;
    const requestedEntries = Array.isArray(entries) ? entries : [];

    return this.#enqueue(async () => {
      const existingById = new Map(this.entries.map(entry => [entry.id, entry]));
      const results = new Array(requestedEntries.length);
      const novelEntries = [];

      requestedEntries.forEach((entry, index) => {
        if (entry?.id && existingById.has(entry.id)) {
          results[index] = existingById.get(entry.id);
        } else {
          novelEntries.push({ entry, index });
        }
      });

      if (!novelEntries.length) return results;

      const prepared = await this.#prepareEntries(
        novelEntries.map(item => item.entry),
        assetFactory,
      );
      if (requestedGeneration !== this.generation) return results.filter(Boolean);

      const insertedIds = [];
      const durableItems = prepared.filter(item => !item.asset?.invalid && item.asset?.blob instanceof Blob);
      const durableRuntimeById = new Map();
      let persistenceError = '';
      let pendingManifestPublished = false;

      try {
        const pendingManifest = {
          ...this.manifest,
          version: GALLERY_MANIFEST_VERSION,
          revision: this.manifest.revision + 1,
          pendingAssetIds: [...new Set([
            ...(this.manifest.pendingAssetIds || []),
            ...durableItems.map(item => item.id),
          ])].slice(-MAX_PENDING_ASSET_IDS),
        };
        this.#writeManifest(pendingManifest);
        this.manifest = pendingManifest;
        pendingManifestPublished = true;

        for (const item of durableItems) {
          const metadata = { ...toManifestEntry(item.entry, item.id), legacy: false, pending: true };
          await this.#putAsset(item.id, item.asset, metadata);
          insertedIds.push(item.id);
          if (requestedGeneration !== this.generation) throw new Error('Gallery was cleared while saving');
        }
        for (const item of durableItems) {
          durableRuntimeById.set(item.id, this.#materializeEntry(toManifestEntry(item.entry, item.id), item.asset));
        }

        const nextMetadata = this.#sortAndLimitMetadata([
          ...prepared
            .filter(item => !item.asset?.invalid && item.asset?.blob instanceof Blob)
            .map(item => toManifestEntry(item.entry, item.id)),
          ...this.manifest.entries,
        ]);
        const nextManifest = {
          ...this.manifest,
          version: GALLERY_MANIFEST_VERSION,
          revision: this.manifest.revision + 1,
          cleared: false,
          pendingAssetIds: (this.manifest.pendingAssetIds || []).filter(id => !durableRuntimeById.has(id)),
          entries: nextMetadata,
        };
        this.#writeManifest(nextManifest);
        this.manifest = nextManifest;
      } catch (error) {
        persistenceError = errorMessage(error, 'Gallery persistence failed');
        this.#revokeObjectUrls(insertedIds);
        if (pendingManifestPublished) {
          try {
            const rollbackManifest = {
              ...this.manifest,
              revision: this.manifest.revision + 1,
              pendingAssetIds: (this.manifest.pendingAssetIds || []).filter(id => !durableItems.some(item => item.id === id)),
            };
            this.#writeManifest(rollbackManifest);
            this.manifest = rollbackManifest;
          } catch {
            // A surviving pending marker lets startup resolve any interrupted IDB writes.
          }
        }
        await Promise.allSettled(insertedIds.map(id => this.#deleteAsset(id)));
      }

      if (requestedGeneration !== this.generation) return results.filter(Boolean);

      const materialized = [];
      for (let preparedIndex = 0; preparedIndex < prepared.length; preparedIndex++) {
        const item = prepared[preparedIndex];
        if (item.asset?.invalid) {
          results[novelEntries[preparedIndex].index] = null;
          continue;
        }
        let runtimeEntry;
        if (!persistenceError && item.asset?.blob instanceof Blob) {
          runtimeEntry = durableRuntimeById.get(item.id);
        } else {
          runtimeEntry = this.#createEphemeralEntry(item.entry, item.asset, false, persistenceError);
        }
        results[novelEntries[preparedIndex].index] = runtimeEntry;
        materialized.push(runtimeEntry);
      }

      this.entries = this.#sortAndLimit([...materialized, ...this.entries]);
      await this.#removeTrimmedAssets();
      return results;
    });
  }

  clear() {
    this.generation += 1;
    return this.#enqueue(async () => {
      const previousManifest = clone(this.manifest);
      const nextManifest = {
        version: GALLERY_MANIFEST_VERSION,
        revision: this.manifest.revision + 1,
        legacyMigrated: true,
        cleared: true,
        pendingAssetIds: [],
        entries: [],
      };
      this.#writeManifest(nextManifest);
      try {
        await this.#deleteAllAssets();
      } catch (error) {
        const rollbackManifest = { ...previousManifest, revision: nextManifest.revision + 1 };
        try {
          this.#writeManifest(rollbackManifest, { expectedRevision: nextManifest.revision });
          this.manifest = rollbackManifest;
          throw error;
        } catch (rollbackError) {
          if (rollbackError === error) throw error;
          this.manifest = nextManifest;
          this.#revokeAllObjectUrls();
          this.entries = [];
          throw new AggregateError([error, rollbackError], 'Gallery clear failed and could not be rolled back');
        }
      }
      this.#revokeAllObjectUrls();
      this.entries = [];
      this.manifest = nextManifest;
      try {
        this.storage.removeItem(this.legacyKey);
      } catch {
        // The v2 manifest is authoritative after a successful clear.
      }
    });
  }

  list() {
    return this.entries.slice();
  }

  async close() {
    await this.operationQueue.catch(() => {});
    this.#revokeAllObjectUrls();
    const db = await this.dbPromise?.catch(() => null);
    db?.close?.();
  }

  #enqueue(operation) {
    const run = () => this.lockManager?.request
      ? this.lockManager.request(this.lockName, { mode: 'exclusive' }, operation)
      : operation();
    const result = this.operationQueue.then(run, run);
    this.operationQueue = result.catch(() => {});
    return result;
  }

  async #openDatabase() {
    if (!this.indexedDB?.open) throw new Error('IndexedDB is unavailable');
    if (this.dbPromise) return this.dbPromise;

    this.dbPromise = new Promise((resolve, reject) => {
      const request = this.indexedDB.open(this.dbName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open gallery database'));
      request.onblocked = () => reject(new Error('Gallery database upgrade was blocked'));
    });
    return this.dbPromise;
  }

  async #prepareEntries(entries, assetFactory, options = {}) {
    const usedIds = new Set([
      ...this.manifest.entries.map(entry => entry.id),
      ...this.entries.map(entry => entry.id),
    ]);

    return Promise.all(entries.map(async entry => {
      let id = typeof entry?.id === 'string' && entry.id ? entry.id : this.createId();
      while (usedIds.has(id)) id = this.createId();
      usedIds.add(id);

      try {
        const asset = await assetFactory(entry);
        if (asset?.blob instanceof Blob) {
          if (asset.blob.size > MAX_PNG_FILE_BYTES) {
            const error = new Error('Image bytes exceed the 25 MB limit');
            error.code = 'INVALID_GALLERY_IMAGE';
            throw error;
          }
          const format = await validateImageData(await asset.blob.arrayBuffer());
          if (!format) {
            const error = new Error('Image bytes are not a supported valid image');
            error.code = 'INVALID_GALLERY_IMAGE';
            throw error;
          }
        }
        let thumbnailBlob = asset?.thumbnailBlob;
        if (thumbnailBlob instanceof Blob) {
          try {
            if (thumbnailBlob.size <= 0 || thumbnailBlob.size > MAX_PNG_FILE_BYTES
              || !await validateImageData(await thumbnailBlob.arrayBuffer())) thumbnailBlob = null;
          } catch {
            thumbnailBlob = null;
          }
        } else if (thumbnailBlob != null) {
          thumbnailBlob = null;
        }
        return {
          id,
          entry: { ...entry, id, legacy: options.legacy === true },
          asset: { ...(asset || {}), thumbnailBlob },
        };
      } catch (error) {
        return {
          id,
          entry: { ...entry, id, legacy: options.legacy === true },
          asset: {
            fallbackUrl: entry?.url || '',
            error: errorMessage(error, 'Image could not be persisted'),
            invalid: error?.code === 'INVALID_GALLERY_IMAGE',
          },
        };
      }
    }));
  }

  async #putAsset(id, asset, metadata = null) {
    const db = await this.#openDatabase();
    const transaction = db.transaction(this.storeName, 'readwrite');
    const done = transactionDone(transaction);
    transaction.objectStore(this.storeName).put({
      id,
      blob: asset.blob,
      thumbnailBlob: asset.thumbnailBlob instanceof Blob ? asset.thumbnailBlob : null,
      metadata: metadata && typeof metadata === 'object' ? clone(metadata) : null,
    });
    await done;
  }

  async #getAsset(id) {
    const db = await this.#openDatabase();
    const transaction = db.transaction(this.storeName, 'readonly');
    const done = transactionDone(transaction);
    const value = await requestResult(transaction.objectStore(this.storeName).get(id));
    await done;
    return value || null;
  }

  async #getAllAssets() {
    const db = await this.#openDatabase();
    const transaction = db.transaction(this.storeName, 'readonly');
    const done = transactionDone(transaction);
    const store = transaction.objectStore(this.storeName);
    let values;
    if (typeof store.getAll === 'function') {
      values = await requestResult(store.getAll());
    } else {
      values = await new Promise((resolve, reject) => {
        const result = [];
        const request = store.openCursor();
        request.onerror = () => reject(request.error || new Error('Could not enumerate gallery assets'));
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            resolve(result);
            return;
          }
          result.push(cursor.value);
          cursor.continue();
        };
      });
    }
    await done;
    return Array.isArray(values) ? values : [];
  }

  async #deleteAsset(id) {
    const db = await this.#openDatabase();
    const transaction = db.transaction(this.storeName, 'readwrite');
    const done = transactionDone(transaction);
    transaction.objectStore(this.storeName).delete(id);
    await done;
  }

  async #deleteAllAssets() {
    const db = await this.#openDatabase();
    const transaction = db.transaction(this.storeName, 'readwrite');
    const done = transactionDone(transaction);
    transaction.objectStore(this.storeName).clear();
    await done;
  }

  async #deleteAssets(ids) {
    const uniqueIds = [...new Set(ids.filter(Boolean))];
    if (!uniqueIds.length) return;
    const db = await this.#openDatabase();
    const transaction = db.transaction(this.storeName, 'readwrite');
    const done = transactionDone(transaction);
    const store = transaction.objectStore(this.storeName);
    uniqueIds.forEach(id => store.delete(id));
    await done;
  }

  async #isValidBlob(blob) {
    if (!(blob instanceof Blob) || blob.size <= 0 || blob.size > MAX_PNG_FILE_BYTES) return false;
    try {
      return !!await validateImageData(await blob.arrayBuffer());
    } catch {
      return false;
    }
  }

  async #sanitizeStoredAsset(asset) {
    if (!asset || typeof asset.id !== 'string' || !await this.#isValidBlob(asset.blob)) return null;
    if (asset.thumbnailBlob == null) return asset;
    if (await this.#isValidBlob(asset.thumbnailBlob)) return asset;
    return { ...asset, thumbnailBlob: null };
  }

  async #reconcileAssets({ replaceInvalidManifest = false, hasLegacySource = false } = {}) {
    const assets = await this.#getAllAssets();
    const validAssets = [];
    const corruptIds = [];
    for (const asset of assets) {
      const sanitized = await this.#sanitizeStoredAsset(asset);
      if (sanitized) {
        validAssets.push(sanitized);
        if (sanitized !== asset) await this.#putAsset(asset.id, sanitized, asset.metadata).catch(() => {});
      }
      else if (typeof asset?.id === 'string') corruptIds.push(asset.id);
    }
    await this.#deleteAssets(corruptIds).catch(() => {});
    const assetsById = new Map(
      validAssets.map(asset => [asset.id, asset]),
    );
    const metadata = [];
    const referencedIds = new Set();
    const pendingIds = new Set(this.manifest.pendingAssetIds || []);

    for (const entry of this.manifest.entries) {
      const assetId = typeof entry?.assetId === 'string' ? entry.assetId : '';
      if (!assetId || !assetsById.get(assetId)?.blob) continue;
      referencedIds.add(assetId);
      metadata.push(toManifestEntry(entry, assetId));
    }

    for (const asset of validAssets) {
      if (!asset || typeof asset.id !== 'string' || referencedIds.has(asset.id) || !asset.blob) continue;
      if (this.manifest.cleared === true) continue;
      if (!replaceInvalidManifest && !pendingIds.has(asset.id)) continue;
      if (hasLegacySource && this.manifest.legacyMigrated !== true && asset.metadata?.legacy === true) {
        continue;
      }
      const stored = asset.metadata && typeof asset.metadata === 'object' ? asset.metadata : {};
      metadata.push(toManifestEntry({
        ...stored,
        prompt: typeof stored.prompt === 'string' ? stored.prompt : 'Recovered gallery image',
        date: Number.isFinite(Number(stored.date)) ? Number(stored.date) : 0,
      }, asset.id));
      referencedIds.add(asset.id);
    }

    const nextEntries = this.#sortAndLimitMetadata(metadata);
    const retainedIds = new Set(nextEntries.map(entry => entry.assetId));
    const changed = replaceInvalidManifest
      || (this.manifest.pendingAssetIds || []).length > 0
      || JSON.stringify(nextEntries) !== JSON.stringify(this.manifest.entries);
    if (changed) {
      const nextManifest = {
        ...this.manifest,
        version: GALLERY_MANIFEST_VERSION,
        revision: this.manifest.revision + 1,
        pendingAssetIds: [],
        entries: nextEntries,
      };
      this.#writeManifest(nextManifest, { replaceInvalid: replaceInvalidManifest });
      this.manifest = nextManifest;
    }

    const staleIds = validAssets
      .map(asset => asset?.id)
      .filter(id => typeof id === 'string' && !retainedIds.has(id));
    await this.#deleteAssets(staleIds).catch(() => {});

    for (const entry of this.manifest.entries) {
      const asset = assetsById.get(entry.assetId);
      if (!asset?.blob) continue;
      const desiredMetadata = {
        ...toManifestEntry(entry, entry.assetId),
        legacy: asset.metadata?.legacy === true,
        pending: false,
      };
      if (JSON.stringify(asset.metadata || null) === JSON.stringify(desiredMetadata)) continue;
      await this.#putAsset(entry.assetId, asset, desiredMetadata).catch(() => {});
    }
  }

  async #loadManifestEntries() {
    const loaded = [];
    const missingIds = [];

    for (const metadata of this.manifest.entries) {
      const storedAsset = await this.#getAsset(metadata.assetId);
      const asset = await this.#sanitizeStoredAsset(storedAsset);
      if (!asset) {
        missingIds.push(metadata.assetId);
        await this.#deleteAsset(metadata.assetId).catch(() => {});
        continue;
      }
      if (asset !== storedAsset) await this.#putAsset(metadata.assetId, asset, storedAsset.metadata).catch(() => {});
      loaded.push(this.#materializeEntry(metadata, asset));
    }

    if (missingIds.length) {
      const missing = new Set(missingIds);
      const nextManifest = {
        ...this.manifest,
        revision: this.manifest.revision + 1,
        entries: this.manifest.entries.filter(entry => !missing.has(entry.assetId)),
      };
      this.#writeManifest(nextManifest);
      this.manifest = nextManifest;
    }

    return this.#sortAndLimit(loaded);
  }

  #materializeEntry(metadata, asset) {
    const createdUrls = [];
    try {
      const url = this.createObjectURL(asset.blob);
      createdUrls.push(url);
      const thumbnail = asset.thumbnailBlob ? this.createObjectURL(asset.thumbnailBlob) : url;
      if (thumbnail !== url) createdUrls.push(thumbnail);
      this.#revokeObjectUrls([metadata.id]);
      this.objectUrls.set(metadata.id, createdUrls);
      return {
        ...clone(metadata),
        url,
        sourceUrl: '',
        thumbnail,
        ephemeral: false,
      };
    } catch (error) {
      for (const url of new Set(createdUrls)) {
        try {
          this.revokeObjectURL(url);
        } catch {
          // Best-effort cleanup must not hide the materialization error.
        }
      }
      throw error;
    }
  }

  #createEphemeralEntry(entry, asset = {}, legacy = false, persistenceError = '') {
    return {
      ...clone(entry || {}),
      id: entry?.id || this.createId(),
      url: asset.fallbackUrl || entry?.url || '',
      sourceUrl: '',
      thumbnail: asset.fallbackThumbnail || entry?.thumbnail || null,
      date: normalizeDate(entry?.date),
      ephemeral: true,
      legacy,
      persistenceError: persistenceError || asset.error || 'Image bytes could not be stored',
    };
  }

  #sortAndLimit(entries) {
    const seen = new Set();
    return entries
      .filter(entry => entry?.id && !seen.has(entry.id) && seen.add(entry.id))
      .sort((a, b) => normalizeDate(b.date) - normalizeDate(a.date))
      .slice(0, this.maxEntries);
  }

  #sortAndLimitMetadata(entries) {
    const seen = new Set();
    return entries
      .filter(entry => entry?.id && !seen.has(entry.id) && seen.add(entry.id))
      .sort((a, b) => normalizeDate(b.date) - normalizeDate(a.date))
      .slice(0, this.maxEntries);
  }

  async #removeTrimmedAssets() {
    const retainedIds = new Set(this.manifest.entries.map(entry => entry.assetId));
    const runtimeIds = new Set(this.entries.map(entry => entry.id));
    for (const [id, urls] of this.objectUrls) {
      if (runtimeIds.has(id)) continue;
      urls.forEach(url => this.revokeObjectURL(url));
      this.objectUrls.delete(id);
      if (!retainedIds.has(id)) await this.#deleteAsset(id).catch(() => {});
    }
  }

  #writeManifest(manifest, { expectedRevision = this.manifest.revision, replaceInvalid = false } = {}) {
    let current = null;
    try {
      current = parseManifest(this.storage, this.manifestKey);
    } catch (error) {
      if (!replaceInvalid) throw error;
    }
    if (current && current.revision !== expectedRevision) {
      throw new Error('Gallery changed in another tab; reload before saving again');
    }
    this.storage.setItem(this.manifestKey, JSON.stringify(manifest));
  }

  #revokeObjectUrls(ids) {
    for (const id of ids) {
      const urls = this.objectUrls.get(id) || [];
      urls.forEach(url => this.revokeObjectURL(url));
      this.objectUrls.delete(id);
    }
  }

  #revokeAllObjectUrls() {
    for (const urls of this.objectUrls.values()) {
      urls.forEach(url => this.revokeObjectURL(url));
    }
    this.objectUrls.clear();
  }
}
