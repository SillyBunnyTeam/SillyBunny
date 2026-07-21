export const GALLERY_MANIFEST_VERSION = 2;
export const DEFAULT_GALLERY_LIMIT = 50;

const DEFAULT_DB_NAME = 'qig-gallery';
const DEFAULT_STORE_NAME = 'assets';
const DEFAULT_MANIFEST_KEY = 'qig_gallery_manifest_v2';
const DEFAULT_LEGACY_KEY = 'qig_gallery';

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

function sanitizeManifestValue(value, key = '', depth = 0, seen = new WeakSet()) {
  if (/(?:api.?key|key$|token|secret|password|ref.*image|image.*ref|control.*image)/i.test(key)) return undefined;
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

function toManifestEntry(entry, id) {
  return {
    id,
    assetId: id,
    sourceMessageIndex: Number.isInteger(entry?.sourceMessageIndex) ? entry.sourceMessageIndex : null,
    prompt: typeof entry?.prompt === 'string' ? entry.prompt : '',
    negative: typeof entry?.negative === 'string' ? entry.negative : '',
    provider: typeof entry?.provider === 'string' ? entry.provider : '',
    metadataSettings: sanitizeManifestValue(entry?.metadataSettings || {}) || {},
    effectiveRequest: sanitizeManifestValue(entry?.effectiveRequest || {}) || {},
    promptWasLLM: entry?.promptWasLLM === true,
    date: normalizeDate(entry?.date),
  };
}

function parseManifest(storage, key) {
  const raw = storage?.getItem?.(key);
  if (!raw) return { version: GALLERY_MANIFEST_VERSION, revision: 0, legacyMigrated: false, entries: [] };

  try {
    const parsed = JSON.parse(raw);
    if (parsed?.version !== GALLERY_MANIFEST_VERSION || !Array.isArray(parsed.entries)) {
      throw new Error('Unsupported gallery manifest');
    }
    return {
      version: GALLERY_MANIFEST_VERSION,
      revision: Number.isInteger(parsed.revision) ? parsed.revision : 0,
      legacyMigrated: parsed.legacyMigrated === true,
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
    this.manifest = { version: GALLERY_MANIFEST_VERSION, revision: 0, legacyMigrated: false, entries: [] };
    this.objectUrls = new Map();
    this.operationQueue = Promise.resolve();
    this.generation = 0;
    this.dbPromise = null;
  }

  async init(assetFactory) {
    return this.#enqueue(async () => {
      this.manifest = parseManifest(this.storage, this.manifestKey);
      const durableEntries = await this.#loadManifestEntries();
      const legacyEntries = this.manifest.legacyMigrated
        ? []
        : parseLegacyEntries(this.storage, this.legacyKey);

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
          ...migration.map(item => this.#createEphemeralEntry(item.entry, item.asset, true)),
        ]);
        return this.list();
      }

      const insertedIds = [];
      const previousManifest = clone(this.manifest);
      let nextManifest = null;
      try {
        for (const item of migration) {
          await this.#putAsset(item.id, item.asset);
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
          ...migration.map(item => this.#createEphemeralEntry(item.entry, item.asset, true, errorMessage(error, 'Legacy migration failed'))),
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
      const durableItems = prepared.filter(item => item.asset?.blob instanceof Blob);
      const durableRuntimeById = new Map();
      let persistenceError = '';

      try {
        for (const item of durableItems) {
          await this.#putAsset(item.id, item.asset);
          insertedIds.push(item.id);
          if (requestedGeneration !== this.generation) throw new Error('Gallery was cleared while saving');
        }
        for (const item of durableItems) {
          durableRuntimeById.set(item.id, this.#materializeEntry(toManifestEntry(item.entry, item.id), item.asset));
        }

        const nextMetadata = this.#sortAndLimitMetadata([
          ...prepared
            .filter(item => item.asset?.blob instanceof Blob)
            .map(item => toManifestEntry(item.entry, item.id)),
          ...this.manifest.entries,
        ]);
        const nextManifest = {
          ...this.manifest,
          version: GALLERY_MANIFEST_VERSION,
          revision: this.manifest.revision + 1,
          entries: nextMetadata,
        };
        this.#writeManifest(nextManifest);
        this.manifest = nextManifest;
      } catch (error) {
        persistenceError = errorMessage(error, 'Gallery persistence failed');
        this.#revokeObjectUrls(insertedIds);
        await Promise.allSettled(insertedIds.map(id => this.#deleteAsset(id)));
      }

      if (requestedGeneration !== this.generation) return results.filter(Boolean);

      const materialized = [];
      for (const item of prepared) {
        let runtimeEntry;
        if (!persistenceError && item.asset?.blob instanceof Blob) {
          runtimeEntry = durableRuntimeById.get(item.id);
        } else {
          runtimeEntry = this.#createEphemeralEntry(item.entry, item.asset, false, persistenceError);
        }
        results[novelEntries[materialized.length].index] = runtimeEntry;
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
        entries: [],
      };
      this.#writeManifest(nextManifest);
      try {
        await this.#deleteAssets(previousManifest.entries.map(entry => entry.assetId));
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
        return { id, entry: { ...entry, id, legacy: options.legacy === true }, asset: asset || {} };
      } catch (error) {
        return {
          id,
          entry: { ...entry, id, legacy: options.legacy === true },
          asset: { fallbackUrl: entry?.url || '', error: errorMessage(error, 'Image could not be persisted') },
        };
      }
    }));
  }

  async #putAsset(id, asset) {
    const db = await this.#openDatabase();
    const transaction = db.transaction(this.storeName, 'readwrite');
    const done = transactionDone(transaction);
    transaction.objectStore(this.storeName).put({
      id,
      blob: asset.blob,
      thumbnailBlob: asset.thumbnailBlob instanceof Blob ? asset.thumbnailBlob : null,
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

  async #deleteAsset(id) {
    const db = await this.#openDatabase();
    const transaction = db.transaction(this.storeName, 'readwrite');
    const done = transactionDone(transaction);
    transaction.objectStore(this.storeName).delete(id);
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

  async #loadManifestEntries() {
    const loaded = [];
    const missingIds = [];

    for (const metadata of this.manifest.entries) {
      const asset = await this.#getAsset(metadata.assetId);
      if (!asset?.blob) {
        missingIds.push(metadata.assetId);
        continue;
      }
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
    const url = this.createObjectURL(asset.blob);
    const thumbnail = asset.thumbnailBlob ? this.createObjectURL(asset.thumbnailBlob) : url;
    this.objectUrls.set(metadata.id, thumbnail === url ? [url] : [url, thumbnail]);
    return {
      ...clone(metadata),
      url,
      sourceUrl: '',
      thumbnail,
      ephemeral: false,
    };
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

  #writeManifest(manifest, { expectedRevision = this.manifest.revision } = {}) {
    const current = parseManifest(this.storage, this.manifestKey);
    if (current.revision !== expectedRevision) {
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
