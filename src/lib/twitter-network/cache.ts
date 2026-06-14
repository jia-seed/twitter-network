/**
 * IndexedDB-backed cache for the /twitter-network page.
 *
 * Stores one record per (sourceHandle, side). A full 19.7k-follower run
 * with scores is ~4-6 MB of JSON, well past the ~5 MB localStorage
 * budget but trivial for IndexedDB (multi-GB on every modern browser).
 *
 * The previous localStorage implementation LRU-evicted older runs to
 * make room for new writes; once a single payload exceeded the per-
 * origin budget it could not be persisted at all, so large follower
 * pulls were lost on reload. IndexedDB removes the cliff.
 *
 * Migration: on first open we copy any leftover `twitter-network:v1:*`
 * localStorage entries into the IndexedDB store, then delete the source
 * keys so the quota is reclaimed.
 */

import type { TwitterNetworkUser } from '@/server/actions/twitter/network'
import type { TwitterScoredUser } from '@/server/actions/twitter/score-types'

const DB_NAME = 'twitter-network'
// Bumped to 2 when adding the `global_scores` store. Future store
// additions should bump again and add a branch in onupgradeneeded.
const DB_VERSION = 2
const STORE = 'runs'
const SCORES_STORE = 'global_scores'
const LS_PREFIX = 'twitter-network:v1'

export type CachedSide = 'followers' | 'following'

export interface CachedRun {
  handle: string
  side: CachedSide
  sourceUser: TwitterNetworkUser | null
  users: TwitterNetworkUser[]
  // Scores stored as an array of tuples so the JSON shape is small and
  // we can rebuild a Map cheaply on read.
  scores: Array<[string, TwitterScoredUser]>
  cursor: string | null
  hasNext: boolean
  criteriaUsed: string | null
  updatedAt: number
}

export interface RunSummary {
  handle: string
  side: CachedSide
  userCount: number
  scoredCount: number
  updatedAt: number
}

function keyFor(handle: string, side: CachedSide): string {
  return `${side}:${handle.toLowerCase()}`
}

let dbPromise: Promise<IDBDatabase> | null = null
let migrated = false

function openDb(): Promise<IDBDatabase> {
  if (typeof window === 'undefined' || typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB unavailable'))
  }
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE)
      }
      if (!db.objectStoreNames.contains(SCORES_STORE)) {
        db.createObjectStore(SCORES_STORE)
      }
    }
    req.onsuccess = () => {
      const db = req.result
      // If another tab later tries to upgrade the schema, IDB fires
      // `versionchange` on every existing connection. Close ours so the
      // upgrading tab isn't blocked indefinitely — and clear the cached
      // promise so the next access re-opens at the new version.
      db.onversionchange = () => {
        db.close()
        dbPromise = null
      }
      resolve(db)
    }
    req.onerror = () => {
      dbPromise = null
      reject(req.error ?? new Error('IndexedDB open failed'))
    }
    req.onblocked = () => {
      // An older connection from another tab is preventing the upgrade.
      // Clear our cached promise so a retry (after the user closes the
      // offending tab) starts fresh.
      dbPromise = null
      reject(
        new Error(
          'IndexedDB upgrade blocked: another tab of this page is holding the cache open. Close it and reload.',
        ),
      )
    }
  })
  return dbPromise
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB tx error'))
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB tx aborted'))
  })
}

/**
 * One-shot migration from the old localStorage cache. Runs on first
 * openDb call per page load; the in-memory `migrated` flag prevents
 * re-running on subsequent calls. Safe to lose mid-migration — we only
 * delete a localStorage key after its IndexedDB put completes.
 */
async function migrateFromLocalStorage(db: IDBDatabase): Promise<void> {
  if (migrated) return
  migrated = true
  try {
    const keys: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (
        k &&
        (k.startsWith(`${LS_PREFIX}:followers:`) ||
          k.startsWith(`${LS_PREFIX}:following:`))
      ) {
        keys.push(k)
      }
    }
    if (keys.length === 0) return
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    for (const k of keys) {
      try {
        const raw = localStorage.getItem(k)
        if (!raw) continue
        const parsed = JSON.parse(raw) as CachedRun
        if (!parsed || !parsed.handle || !parsed.side) continue
        if (!Array.isArray(parsed.users) || !Array.isArray(parsed.scores)) continue
        store.put(parsed, keyFor(parsed.handle, parsed.side))
      } catch {
        // skip malformed entries; the next loop iteration just moves on
      }
    }
    await txDone(tx)
    // Only drop the source keys after the transaction committed.
    for (const k of keys) {
      try {
        localStorage.removeItem(k)
      } catch {
        // ignore
      }
    }
  } catch {
    // Migration is best-effort. If it fails the old localStorage
    // entries stay put and the page just won't see them.
  }
}

async function getDb(): Promise<IDBDatabase> {
  const db = await openDb()
  await migrateFromLocalStorage(db)
  return db
}

export async function saveRun(
  run: CachedRun,
): Promise<{ ok: boolean; error?: string }> {
  if (typeof window === 'undefined') return { ok: false, error: 'no window' }
  if (!run.handle) return { ok: false, error: 'no handle' }
  try {
    const db = await getDb()
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(run, keyFor(run.handle, run.side))
    await txDone(tx)
    return { ok: true }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'IndexedDB write failed',
    }
  }
}

export async function loadRun(
  handle: string,
  side: CachedSide,
): Promise<CachedRun | null> {
  if (typeof window === 'undefined') return null
  if (!handle) return null
  try {
    const db = await getDb()
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(keyFor(handle, side))
    const result = await new Promise<CachedRun | undefined>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result as CachedRun | undefined)
      req.onerror = () => reject(req.error)
    })
    if (!result) return null
    if (!Array.isArray(result.users) || !Array.isArray(result.scores)) {
      return null
    }
    return result
  } catch {
    return null
  }
}

export async function listRuns(): Promise<RunSummary[]> {
  if (typeof window === 'undefined') return []
  try {
    const db = await getDb()
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).getAll()
    const all = await new Promise<CachedRun[]>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result as CachedRun[])
      req.onerror = () => reject(req.error)
    })
    return all
      .filter((r) => r && r.handle && r.side)
      .map((r) => ({
        handle: r.handle,
        side: r.side,
        userCount: Array.isArray(r.users) ? r.users.length : 0,
        scoredCount: Array.isArray(r.scores) ? r.scores.length : 0,
        updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : 0,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  } catch {
    return []
  }
}

export async function removeRun(
  handle: string,
  side: CachedSide,
): Promise<void> {
  if (typeof window === 'undefined') return
  try {
    const db = await getDb()
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(keyFor(handle, side))
    await txDone(tx)
  } catch {
    // ignore
  }
}

/**
 * Global, cross-run score cache. Keyed by (criteria, handle) so the
 * same handle scored under different criteria stays distinct (a
 * "brand-name founders" score isn't reused as a "crypto founders"
 * score). The criteria is hashed because the raw text can be 1k+
 * characters and key length matters for IDB index performance.
 *
 * Storage cost: ~150 bytes per scored row. A user who runs scoring
 * across 50k unique handles still fits comfortably in IDB.
 */

/**
 * SHA-256 of the (trimmed) criteria text, truncated to 16 hex chars (64
 * bits). Stable across browsers + the server. Used as the cache key for
 * both the local IDB scores store and the server-side per-user scores
 * table, so a score written from one tab is found from another or from
 * a different device under the same criteria.
 */
export async function hashCriteria(criteria: string): Promise<string> {
  const enc = new TextEncoder().encode(criteria.trim())
  const buf = await crypto.subtle.digest('SHA-256', enc)
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16)
}

function scoreKey(criteriaHash: string, handle: string): string {
  return `${criteriaHash}::${handle.toLowerCase()}`
}

/**
 * Bulk lookup of cached scores for a list of handles under one
 * criteria. Returns a Map keyed by original handle casing (we match
 * back via the input) so callers can do `cached.get(u.userName)`.
 */
export async function loadCachedScores(
  criteria: string,
  handles: string[],
): Promise<Map<string, TwitterScoredUser>> {
  const out = new Map<string, TwitterScoredUser>()
  if (typeof window === 'undefined' || handles.length === 0) return out
  try {
    const hash = await hashCriteria(criteria)
    const db = await getDb()
    const tx = db.transaction(SCORES_STORE, 'readonly')
    const store = tx.objectStore(SCORES_STORE)
    // One get per handle. IDB batches these efficiently inside a single
    // transaction; cost is ~1ms per 100 handles in practice.
    await Promise.all(
      handles.map(
        (h) =>
          new Promise<void>((resolve) => {
            const req = store.get(scoreKey(hash, h))
            req.onsuccess = () => {
              const v = req.result as TwitterScoredUser | undefined
              if (v) out.set(h, v)
              resolve()
            }
            req.onerror = () => resolve()
          }),
      ),
    )
  } catch {
    // ignore — caller treats as cache miss
  }
  return out
}

/**
 * Persist a batch of freshly-computed scores under the given criteria
 * so subsequent runs (even for different source accounts) skip the
 * Claude call when they encounter the same handle.
 */
export async function saveCachedScores(
  criteria: string,
  scores: Map<string, TwitterScoredUser>,
): Promise<void> {
  if (typeof window === 'undefined' || scores.size === 0) return
  try {
    const hash = await hashCriteria(criteria)
    const db = await getDb()
    const tx = db.transaction(SCORES_STORE, 'readwrite')
    const store = tx.objectStore(SCORES_STORE)
    for (const [handle, score] of scores) {
      store.put(score, scoreKey(hash, handle))
    }
    await txDone(tx)
  } catch {
    // best-effort; in-memory state stays correct either way
  }
}
