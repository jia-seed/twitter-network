'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  fetchTwitterFollowers,
  fetchTwitterFollowings,
  fetchTwitterUserInfo,
  type TwitterNetworkUser,
} from '@/server/actions/twitter/network'
import { scoreTwitterUsers } from '@/server/actions/twitter/score'
import {
  DEFAULT_FOUNDER_CRITERIA,
  TWITTER_SCORE_BATCH_SIZE,
  type TwitterScoredUser,
} from '@/server/actions/twitter/score-types'
import {
  hashCriteria,
  listRuns,
  loadCachedScores,
  loadRun,
  removeRun,
  saveCachedScores,
  saveRun,
  type RunSummary,
} from '@/lib/twitter-network/cache'
import {
  loadServerScores,
  saveServerScores,
} from '@/server/actions/twitter/server-scores'
import {
  listServerRuns,
  loadServerRun,
  removeServerRun,
  saveServerRun,
} from '@/server/actions/twitter/server-runs'

function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(ts).toLocaleDateString()
}

function normalizeForCache(input: string): string {
  let s = (input ?? '').trim()
  s = s.replace(/^https?:\/\/(?:www\.)?(?:twitter|x)\.com\//i, '')
  s = s.replace(/^@/, '')
  return s.split('/')[0].split('?')[0].split('#')[0].toLowerCase()
}

import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'

const MAX_AUTOLOAD_PAGES = 200 // ~40k accounts safety cap
// 6 in flight stays comfortably under Anthropic's default Haiku RPM/TPM
// limits while running 50% more work concurrently than the prior 4.
const SCORE_PARALLELISM = 6
// Server-save delta gate. The Postgres jsonb payload is ~5 MB at 19k
// followers; we don't want to push it every second during paging. Save
// whenever the load grows by this many followers or when load finishes
// (hasNext=false), whichever lands first.
const SERVER_SAVE_DELTA_THRESHOLD = 2000
// Followers with no bio at all cannot match any of the founder-shaped
// criteria the page ships with — auto-score them client-side so we
// don't waste Claude calls. For a typical 19k-follower account this
// cuts 30-40% of the scoring queue.
const SHORTCUT_SCORE_FOR_EMPTY_BIO: TwitterScoredUser = {
  handle: '',
  score: 0,
  role: '—',
  reason: 'No bio',
}
function shouldShortcutScore(u: { description: string }): boolean {
  return (u.description ?? '').trim().length === 0
}

// Broad founder-detector. Hits the obvious roles, the chief-X-officer
// long forms, the co-founder spellings, and the founder-adjacent verbs
// that almost always indicate "this person runs/started something"
// (founding eng/PM, building $thing, ex-founder).
const FOUNDER_RE =
  /\b(ceo|coo|cto|cfo|cmo|cpo|cro|founder|co[- ]?founder|cofounder|founding\s+(?:engineer|member|pm|partner)|ex[- ]?founder|chief\s+(?:executive|operating|technology|financial|marketing|product|revenue)\s+officer|entrepreneur|owner|president|building\s+\w+)\b/i

function highlightBio(bio: string): ReactNode {
  if (!bio) return null
  // Use a global, case-insensitive copy so .exec walks the whole string
  // and capture groups are stable for the .split() trick.
  const re = new RegExp(FOUNDER_RE.source, 'gi')
  const parts: Array<{ text: string; match: boolean }> = []
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(bio)) !== null) {
    if (m.index > last) {
      parts.push({ text: bio.slice(last, m.index), match: false })
    }
    parts.push({ text: m[0], match: true })
    last = m.index + m[0].length
    // Guard against zero-length matches (shouldn't happen with \b but
    // defensive against future regex edits).
    if (m[0].length === 0) re.lastIndex++
  }
  if (last < bio.length) parts.push({ text: bio.slice(last), match: false })
  if (parts.length === 0) parts.push({ text: bio, match: false })
  return parts.map((p, i) =>
    p.match ? (
      <mark
        key={i}
        className="text-foreground rounded-sm bg-transparent px-0 font-medium"
      >
        {p.text}
      </mark>
    ) : (
      <span key={i}>{p.text}</span>
    ),
  )
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toString()
}

export default function TwitterNetworkPage() {
  const [handle, setHandle] = useState('')
  const [side, setSide] = useState<'followers' | 'following'>('followers')
  const [filter, setFilter] = useState('')
  // DOM rendering ~20k rows tanks the page (~5-10s tax on every paint
  // + slow filter typing). Cap the rendered slice; user can expand if
  // they want to scroll past the top matches. Sorted-by-score means
  // the visible cap = the most relevant N anyway.
  const [renderCap, setRenderCap] = useState(500)
  const RENDER_CAP_DEFAULT = 500
  const [ceosOnly, setCeosOnly] = useState(false)
  const [verifiedOnly, setVerifiedOnly] = useState(false)
  const [scoredOnly, setScoredOnly] = useState(false)
  const [sortBy, setSortBy] = useState<'followers' | 'score' | 'order'>('order')
  const [users, setUsers] = useState<TwitterNetworkUser[]>([])
  const [sourceUser, setSourceUser] = useState<TwitterNetworkUser | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [hasNext, setHasNext] = useState(false)
  const [loading, setLoading] = useState(false)
  const [autoLoading, setAutoLoading] = useState(false)
  const [scoring, setScoring] = useState(false)
  const [scoredCount, setScoredCount] = useState(0)
  // Running tally of how many of the in-progress run's scores came from
  // the IDB / server cache vs cost a Claude call. Surfaces the cross-
  // device cache value in the scoring status line.
  const [cacheHitCount, setCacheHitCount] = useState(0)
  const [claudeCallCount, setClaudeCallCount] = useState(0)
  const [scores, setScores] = useState<Map<string, TwitterScoredUser>>(new Map())
  const [presetId, setPresetId] = useState<string>('founders')
  const [criteria, setCriteria] = useState<string>(DEFAULT_FOUNDER_CRITERIA)
  const [lastCriteriaUsed, setLastCriteriaUsed] = useState<string | null>(null)
  const [minScore, setMinScore] = useState<number>(0)
  const [error, setError] = useState<string | null>(null)
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [cacheStatus, setCacheStatus] = useState<'idle' | 'saving' | 'saved'>('idle')
  // Set to `true` once IndexedDB has rejected a write hard enough that
  // retrying isn't useful in this session (another tab is holding the
  // older schema open, or the quota is genuinely exhausted). Suppresses
  // the auto-save effect and the error banner; the page keeps working
  // in memory and shows a small "session only" pill.
  const [cacheDisabled, setCacheDisabled] = useState(false)
  const skipRestoreRef = useRef(false)
  const cancelRef = useRef(false)
  const scoringCancelRef = useRef(false)
  // How many followers the server has for the active run. The auto-save
  // effect uses this to decide whether the delta is big enough to
  // justify another ~5 MB server write — we only push when load grows
  // by SERVER_SAVE_DELTA_THRESHOLD or when the page hits a natural
  // "settled" point (load complete, scoring finished). Reset whenever
  // the active run changes so a different (handle, side) gets a fresh
  // baseline.
  const lastServerSavedLenRef = useRef(0)
  const lastServerSavedKeyRef = useRef<string>('')
  // Tracks which (normalized handle, side) the in-memory users/scores
  // belong to. Updated whenever state is freshly loaded or restored.
  // The auto-save effect refuses to write when this doesn't match the
  // current typed handle — otherwise typing a new handle while a prior
  // run is still in memory would persist the OLD run under the NEW
  // handle's key (the original "emily_yu shows 19,670 jia_seed
  // followers" bug).
  const runKeyRef = useRef<string>('')
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  // Ref-mirror of `side` so the one-click pipeline can flip "followers"
  // synchronously before kicking the fetch, even though the corresponding
  // setSide is async and wouldn't reach loadOnce's closure for another
  // render.
  const sideRef = useRef(side)
  sideRef.current = side

  const loadOnce = async (
    cursorArg: string | undefined,
  ): Promise<{ ok: boolean; nextCursor: string | null; hasNext: boolean }> => {
    const fetcher =
      sideRef.current === 'following' ? fetchTwitterFollowings : fetchTwitterFollowers
    const result = await fetcher(handle, cursorArg)
    if (!result.success) {
      setError(result.error)
      return { ok: false, nextCursor: null, hasNext: false }
    }
    setUsers((prev) => {
      // Dedupe by id (twitterapi.io can return overlap on cursor edges).
      const seen = new Set(prev.map((u) => u.id || u.userName))
      const merged = [...prev]
      for (const u of result.users) {
        const key = u.id || u.userName
        if (!seen.has(key)) {
          seen.add(key)
          merged.push(u)
        }
      }
      return merged
    })
    setCursor(result.nextCursor)
    setHasNext(result.hasNextPage)
    return { ok: true, nextCursor: result.nextCursor, hasNext: result.hasNextPage }
  }

  const startFresh = async () => {
    setLoading(true)
    setError(null)
    skipRestoreRef.current = true
    setUsers([])
    setCursor(null)
    setHasNext(false)
    setSourceUser(null)
    setScores(new Map())
    setScoredCount(0)
    setLastCriteriaUsed(null)
    // Source account profile (for the "of N total" line).
    const info = await fetchTwitterUserInfo(handle)
    if (info.success) setSourceUser(info.user)
    await loadOnce(undefined)
    setLoading(false)
    // Re-enable the restore guard after a tick so future handle edits
    // can still trigger restores.
    setTimeout(() => {
      skipRestoreRef.current = false
    }, 0)
  }

  const loadNextPage = async () => {
    setLoading(true)
    setError(null)
    await loadOnce(cursor ?? undefined)
    setLoading(false)
  }

  const loadAll = async () => {
    setAutoLoading(true)
    setError(null)
    cancelRef.current = false
    let pageCount = 0
    let next: string | null = cursor
    let more = hasNext
    while (more && next && pageCount < MAX_AUTOLOAD_PAGES) {
      if (cancelRef.current) break
      const r = await loadOnce(next)
      pageCount++
      if (!r.ok) break
      next = r.nextCursor
      more = r.hasNext
    }
    setAutoLoading(false)
  }

  const cancelAutoLoad = () => {
    cancelRef.current = true
  }

  /**
   * Score every loaded user that hasn't been scored yet. Batches of
   * TWITTER_SCORE_BATCH_SIZE (25), run with SCORE_PARALLELISM (4) in
   * flight so a 19k-user pass finishes in ~3 minutes instead of ~13.
   */
  const scoreAllLoaded = async () => {
    setScoring(true)
    setError(null)
    setLastCriteriaUsed(criteria)
    scoringCancelRef.current = false
    setCacheHitCount(0)
    setClaudeCallCount(0)

    // Snapshot of current scores so we don't re-score people in a refresh.
    const alreadyScored = new Set(scores.keys())
    const todo = users.filter((u) => !alreadyScored.has(u.userName))
    const newScores = new Map(scores)

    // Empty-bio followers can't match any of the founder-shaped criteria
    // the page ships with — skip Claude and auto-score them 0. For a
    // typical 19k-follower run this drops the queue by 30-40% before
    // anything hits the network.
    const claudeCandidates: TwitterNetworkUser[] = []
    for (const u of todo) {
      if (shouldShortcutScore(u)) {
        newScores.set(u.userName, {
          ...SHORTCUT_SCORE_FOR_EMPTY_BIO,
          handle: u.userName,
        })
      } else {
        claudeCandidates.push(u)
      }
    }

    // Apply IDB + server cache hits before sending anything to Claude.
    // Server hits give cross-device durability; IDB gives instant local
    // reads. Run both in parallel and union the results.
    const handlesToCheck = claudeCandidates.map((u) => u.userName)
    const critHashEarly = await hashCriteria(criteria)
    const [idbHitsAll, serverRowsAll] = await Promise.all([
      loadCachedScores(criteria, handlesToCheck),
      loadServerScores(critHashEarly, handlesToCheck),
    ])
    const serverByHandleAll = new Map<string, TwitterScoredUser>()
    for (const row of serverRowsAll) {
      const original = claudeCandidates.find(
        (u) => u.userName.toLowerCase() === row.handle.toLowerCase(),
      )?.userName
      if (original) {
        serverByHandleAll.set(original, {
          handle: original,
          score: row.score,
          role: row.role,
          reason: row.reason,
        })
      }
    }
    const idbBackfillAll = new Map<string, TwitterScoredUser>()
    const claudeTodo = claudeCandidates.filter((u) => {
      const hit = idbHitsAll.get(u.userName) ?? serverByHandleAll.get(u.userName)
      if (hit) {
        newScores.set(u.userName, hit)
        if (!idbHitsAll.has(u.userName) && serverByHandleAll.has(u.userName)) {
          idbBackfillAll.set(u.userName, hit)
        }
        return false
      }
      return true
    })
    if (idbHitsAll.size > 0 || serverByHandleAll.size > 0) {
      setScores(new Map(newScores))
      setScoredCount(newScores.size)
      // Each unique handle resolved from either cache layer counts once.
      const unionHits = new Set<string>([
        ...idbHitsAll.keys(),
        ...serverByHandleAll.keys(),
      ])
      setCacheHitCount(unionHits.size)
    }
    if (idbBackfillAll.size > 0) {
      void saveCachedScores(criteria, idbBackfillAll)
    }

    // Pack remaining (Claude-bound) work into batches.
    const batches: Array<typeof users> = []
    for (let i = 0; i < claudeTodo.length; i += TWITTER_SCORE_BATCH_SIZE) {
      batches.push(claudeTodo.slice(i, i + TWITTER_SCORE_BATCH_SIZE))
    }
    setScoredCount(newScores.size)

    // Worker pool: pop next batch index, run, repeat. Bounded concurrency.
    let nextIdx = 0
    const workers = Array.from(
      { length: Math.min(SCORE_PARALLELISM, batches.length) },
      async (): Promise<void> => {
        while (true) {
          if (scoringCancelRef.current) return
          const i = nextIdx++
          if (i >= batches.length) return
          const batch = batches[i]
          const result = await scoreTwitterUsers(
            batch.map((u) => ({
              handle: u.userName,
              name: u.name,
              description: u.description,
              followers: u.followers,
              isVerified: u.isVerified,
              isBlueVerified: u.isBlueVerified,
            })),
            criteria,
          )
          if (!result.success) {
            // Surface the first hard failure but keep going on others.
            setError((prev) => prev ?? result.error)
            continue
          }
          const justScored = new Map<string, TwitterScoredUser>()
          // Merge scores keyed by handle. Match Claude's returned handle
          // case-insensitively against the input batch in case the model
          // normalised casing.
          for (let j = 0; j < result.scores.length; j++) {
            const s = result.scores[j]
            const sourceHandle = batch[j]?.userName
            const key = (s.handle && batch.find(
              (b) => b.userName.toLowerCase() === s.handle.toLowerCase(),
            )?.userName) ?? sourceHandle
            if (key) {
              newScores.set(key, s)
              justScored.set(key, s)
            }
          }
          setScores(new Map(newScores))
          setScoredCount(newScores.size)
          setClaudeCallCount((n) => n + justScored.size)
          void saveCachedScores(criteria, justScored)
          void (async () => {
            const critHash = await hashCriteria(criteria)
            await saveServerScores(
              critHash,
              Array.from(justScored.values()).map((s) => ({
                handle: s.handle,
                score: s.score,
                role: s.role,
                reason: s.reason,
              })),
            )
          })()
        }
      },
    )
    await Promise.all(workers)
    setScoring(false)
    // After scoring lands, default to best-first — that's the entire
    // point of the run ("show me the best followers"). The user can
    // still toggle back to original order via the sort checkbox.
    if (newScores.size > 0) setSortBy('score')
  }

  const cancelScoring = () => {
    scoringCancelRef.current = true
  }

  /**
   * Snapshot every scored follower as a CSV the user can save to disk.
   * Rows sorted high-score-first so the file opens with the best
   * matches at the top. Bios are flattened to single-line so spreadsheet
   * apps don't break rows on embedded newlines.
   */
  const downloadScoredCsv = () => {
    if (scores.size === 0) return
    const header = [
      'handle',
      'name',
      'score',
      'role',
      'reason',
      'bio',
      'followers',
      'following',
      'location',
      'url',
      'verified',
    ]
    type Row = (string | number)[]
    const dataRows: Row[] = []
    for (const u of users) {
      const s = scores.get(u.userName)
      if (!s) continue
      dataRows.push([
        u.userName,
        u.name,
        s.score,
        s.role,
        s.reason,
        (u.description ?? '').replace(/\s+/g, ' ').trim(),
        u.followers,
        u.following,
        u.location ?? '',
        u.url ?? '',
        u.isVerified || u.isBlueVerified ? 'yes' : 'no',
      ])
    }
    dataRows.sort((a, b) => Number(b[2]) - Number(a[2]))
    const escape = (cell: string | number): string => {
      const s = String(cell ?? '')
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const csv = [header, ...dataRows]
      .map((row) => row.map(escape).join(','))
      .join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    const safeHandle = (handle || 'export')
      .replace(/[^a-z0-9_-]/gi, '_')
      .toLowerCase()
    const stamp = new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .slice(0, 19)
    a.download = `twitter-network-${safeHandle}-${side}-${stamp}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  /**
   * Whole pipeline in one click: switch to "followers" side, pull every
   * page, score every loaded profile with Claude, sort by score descending.
   *
   * Architecturally: one loader + SCORE_PARALLELISM scorers consume the
   * same in-memory queue. Loader appends as pages arrive; scorers pop
   * batches of TWITTER_SCORE_BATCH_SIZE and call Claude. Total wall time
   * = max(load_time, score_time) instead of load_time + score_time.
   *
   * Resume-friendly: starts from whatever is in state (cached run from
   * localStorage, mid-flight users, prior scores). The loader picks up
   * at the cached cursor; the scorers only enqueue users that haven't
   * been scored yet.
   */
  const findBestFollowers = async () => {
    if (!handle.trim()) {
      setError('Paste a Twitter handle first.')
      return
    }
    sideRef.current = 'followers'
    setSide('followers')
    skipRestoreRef.current = true
    cancelRef.current = false
    scoringCancelRef.current = false
    setError(null)
    setLastCriteriaUsed(criteria)
    // Stamp the run key so the auto-save effect knows the in-memory
    // state now belongs to this (handle, side). Without this, a fresh
    // load before any successful save would let stale state leak.
    runKeyRef.current = `${normalizeForCache(handle)}:followers`
    // Reset the run-scoped tally so the progress line starts at zero.
    setCacheHitCount(0)
    setClaudeCallCount(0)

    // Seed in-memory mirrors from whatever the page already has. These
    // are the source of truth for the streaming pipeline; we still
    // flush back into React state for rendering.
    const usersByHandle = new Map<string, TwitterNetworkUser>(
      users.map((u) => [u.userName.toLowerCase(), u]),
    )
    const scoresByHandle = new Map<string, TwitterScoredUser>(scores)
    const queue: TwitterNetworkUser[] = users.filter(
      (u) => !scoresByHandle.has(u.userName),
    )
    let loadingDone = false

    // Make sure we know the source user's true follower count before
    // deciding whether to trust the cached pagination state. Otherwise a
    // stale `hasNext: false` from a previously-canceled run can short-
    // circuit the loader before the second page even fires.
    let liveSourceUser = sourceUser
    if (!liveSourceUser) {
      const info = await fetchTwitterUserInfo(handle)
      if (info.success) {
        liveSourceUser = info.user
        setSourceUser(info.user)
      }
    }

    // Suspicion check: if the source has materially more followers than
    // what's cached AND we have no cursor to continue from, the cached
    // pagination state is wrong (the cache was likely written after a
    // canceled run). Start fresh rather than trust it.
    let stateCursor: string | null = cursor
    const expectedMore =
      liveSourceUser && liveSourceUser.followers - usersByHandle.size > 50
    if (expectedMore && !stateCursor) {
      usersByHandle.clear()
      scoresByHandle.clear()
      queue.length = 0
      stateCursor = null
      setUsers([])
      setScores(new Map())
      setScoredCount(0)
      setCursor(null)
      setHasNext(true)
    }

    // Route the source profile through the same cache → queue path as
    // followers so the user's own score shows up alongside theirs. Runs
    // after the suspicion check so its score isn't wiped along with
    // stale follower data. Empty bio → instant zero shortcut; IDB or
    // server cache hit → applied immediately; otherwise queued at the
    // front so a fresh score lands before the long follower tail.
    if (liveSourceUser && !scoresByHandle.has(liveSourceUser.userName)) {
      const srcHandle = liveSourceUser.userName
      if (shouldShortcutScore(liveSourceUser)) {
        scoresByHandle.set(srcHandle, {
          ...SHORTCUT_SCORE_FOR_EMPTY_BIO,
          handle: srcHandle,
        })
        setScores(new Map(scoresByHandle))
      } else {
        const critHash = await hashCriteria(criteria)
        const [idbHits, serverHits] = await Promise.all([
          loadCachedScores(criteria, [srcHandle]),
          loadServerScores(critHash, [srcHandle]),
        ])
        const idbHit = idbHits.get(srcHandle)
        const serverHit = serverHits.find(
          (r) => r.handle.toLowerCase() === srcHandle.toLowerCase(),
        )
        if (idbHit) {
          scoresByHandle.set(srcHandle, idbHit)
          setScores(new Map(scoresByHandle))
        } else if (serverHit) {
          const hit: TwitterScoredUser = {
            handle: srcHandle,
            score: serverHit.score,
            role: serverHit.role,
            reason: serverHit.reason,
          }
          scoresByHandle.set(srcHandle, hit)
          setScores(new Map(scoresByHandle))
          void saveCachedScores(criteria, new Map([[srcHandle, hit]]))
        } else {
          queue.unshift(liveSourceUser)
        }
      }
    }

    setLoading(true)
    setAutoLoading(true)

    // ---- LOADER: page out the rest of the follower list. ----
    const loaderPromise = (async (): Promise<void> => {
      // If we already have users cached AND no cursor to continue from,
      // the prior run finished — skip loading and let the scorers drain
      // any unscored leftovers.
      if (!stateCursor && usersByHandle.size > 0) {
        loadingDone = true
        setAutoLoading(false)
        setLoading(false)
        return
      }
      let nextCursor: string | undefined = stateCursor ?? undefined
      let pages = 0
      while (pages < MAX_AUTOLOAD_PAGES) {
        if (cancelRef.current) break
        const result = await fetchTwitterFollowers(handle, nextCursor)
        if (!result.success) {
          setError((prev) => prev ?? result.error)
          break
        }
        let added = 0
        const newCandidates: TwitterNetworkUser[] = []
        let shortcutHits = 0
        for (const u of result.users) {
          if (!u.userName) continue
          const key = u.userName.toLowerCase()
          if (usersByHandle.has(key)) continue
          usersByHandle.set(key, u)
          if (!scoresByHandle.has(u.userName)) {
            if (shouldShortcutScore(u)) {
              // Auto-score empty-bio followers without calling Claude.
              scoresByHandle.set(u.userName, {
                ...SHORTCUT_SCORE_FOR_EMPTY_BIO,
                handle: u.userName,
              })
              shortcutHits++
            } else {
              newCandidates.push(u)
            }
          }
          added++
        }
        if (shortcutHits > 0) {
          setScores(new Map(scoresByHandle))
          setScoredCount(scoresByHandle.size)
        }
        // Snapshot for the UI. Cheap to re-create an array from the map
        // every page; rendering is virtualized by browser scrolling.
        setUsers(Array.from(usersByHandle.values()))
        setCursor(result.nextCursor)
        setHasNext(result.hasNextPage)
        pages++
        // Consult both the local (IDB) score cache and the per-user
        // server score table before queueing for Claude. Either hit
        // applies the cached score for free; only genuine misses go to
        // the queue. Server hits give us cross-device durability — a
        // score paid for in one browser shows up in another the next
        // time the same criteria is run.
        if (newCandidates.length > 0) {
          const handlesToCheck = newCandidates.map((u) => u.userName)
          const critHash = await hashCriteria(criteria)
          const [idbHits, serverRows] = await Promise.all([
            loadCachedScores(criteria, handlesToCheck),
            loadServerScores(critHash, handlesToCheck),
          ])
          // Map server rows back to original handle casing (server stores
          // lowercase; rest of the page keys by the original casing).
          const serverByHandle = new Map<string, TwitterScoredUser>()
          for (const row of serverRows) {
            const original = newCandidates.find(
              (u) => u.userName.toLowerCase() === row.handle.toLowerCase(),
            )?.userName
            if (original) {
              serverByHandle.set(original, {
                handle: original,
                score: row.score,
                role: row.role,
                reason: row.reason,
              })
            }
          }
          let hits = 0
          const idbMissesNeedingBackfill = new Map<string, TwitterScoredUser>()
          for (const u of newCandidates) {
            const hit = idbHits.get(u.userName) ?? serverByHandle.get(u.userName)
            if (hit) {
              scoresByHandle.set(u.userName, hit)
              hits++
              // If only the server had it, warm the IDB cache so the
              // next session reads it locally without a round-trip.
              if (!idbHits.has(u.userName) && serverByHandle.has(u.userName)) {
                idbMissesNeedingBackfill.set(u.userName, hit)
              }
            } else {
              queue.push(u)
            }
          }
          if (hits > 0) {
            setScores(new Map(scoresByHandle))
            setScoredCount(scoresByHandle.size)
            setCacheHitCount((n) => n + hits)
          }
          if (idbMissesNeedingBackfill.size > 0) {
            void saveCachedScores(criteria, idbMissesNeedingBackfill)
          }
        }
        // End conditions: no cursor, API said done, or a full page of
        // dupes (defensive — would mean we looped).
        if (!result.nextCursor || !result.hasNextPage) break
        if (added === 0 && pages > 1) break
        nextCursor = result.nextCursor
      }
      loadingDone = true
      setAutoLoading(false)
      setLoading(false)
    })()

    // ---- SCORERS: SCORE_PARALLELISM workers consume `queue`. ----
    setScoring(true)
    setScoredCount(scoresByHandle.size)
    const scorerPromises = Array.from(
      { length: SCORE_PARALLELISM },
      async (): Promise<void> => {
        while (true) {
          if (scoringCancelRef.current) return
          const batch = queue.splice(0, TWITTER_SCORE_BATCH_SIZE)
          if (batch.length === 0) {
            // No work right now. If the loader is done, we're done.
            // Otherwise wait briefly for the next page to arrive.
            if (loadingDone) return
            await new Promise<void>((r) => setTimeout(r, 250))
            continue
          }
          const result = await scoreTwitterUsers(
            batch.map((u) => ({
              handle: u.userName,
              name: u.name,
              description: u.description,
              followers: u.followers,
              isVerified: u.isVerified,
              isBlueVerified: u.isBlueVerified,
            })),
            criteria,
          )
          if (!result.success) {
            setError((prev) => prev ?? result.error)
            continue
          }
          const justScored = new Map<string, TwitterScoredUser>()
          for (let j = 0; j < result.scores.length; j++) {
            const s = result.scores[j]
            const sourceHandle = batch[j]?.userName
            const matched =
              s.handle &&
              batch.find(
                (b) => b.userName.toLowerCase() === s.handle.toLowerCase(),
              )?.userName
            const key = matched ?? sourceHandle
            if (key) {
              scoresByHandle.set(key, s)
              justScored.set(key, s)
            }
          }
          setScores(new Map(scoresByHandle))
          setScoredCount(scoresByHandle.size)
          setClaudeCallCount((n) => n + justScored.size)
          // Persist to BOTH the local IDB cache (instant local reads on
          // reload) and the per-user server table (durable across
          // devices). Fire-and-forget — the in-memory map is already
          // updated, so a failed save doesn't block UI progress.
          void saveCachedScores(criteria, justScored)
          void (async () => {
            const critHash = await hashCriteria(criteria)
            await saveServerScores(
              critHash,
              Array.from(justScored.values()).map((s) => ({
                handle: s.handle,
                score: s.score,
                role: s.role,
                reason: s.reason,
              })),
            )
          })()
        }
      },
    )

    await Promise.all([loaderPromise, ...scorerPromises])
    setScoring(false)
    if (scoresByHandle.size > 0) setSortBy('score')
    setTimeout(() => {
      skipRestoreRef.current = false
    }, 0)
  }

  // Infinite-scroll: when the sentinel scrolls within 600px of the
  // viewport, kick the next page. The effect re-arms whenever loading or
  // hasNext flips, so the next firing waits cleanly for the in-flight
  // request to settle before issuing another. If the user filters
  // hard (e.g. "Founders only" with 3 matches on a 200-row page), the
  // sentinel may already be on-screen — the observer will fire
  // immediately on re-arm and keep pulling pages until either the
  // filtered list grows large enough to push it off-screen, or
  // hasNext becomes false.
  useEffect(() => {
    if (!hasNext || loading || autoLoading) return
    const node = sentinelRef.current
    if (!node) return
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          void loadNextPage()
        }
      },
      { rootMargin: '600px' },
    )
    obs.observe(node)
    return () => obs.disconnect()
    // loadNextPage closes over cursor + setters; gating on hasNext/
    // loading/autoLoading is enough to avoid stale-closure double-fires.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasNext, loading, autoLoading])

  // Wipe in-memory state when the typed handle no longer matches the
  // run it belongs to. Without this, the auto-save effect would persist
  // the prior run's users[] under the freshly-typed handle's cache key.
  useEffect(() => {
    const normalized = normalizeForCache(handle)
    const currentKey = normalized ? `${normalized}:${side}` : ''
    if (!runKeyRef.current) return
    if (runKeyRef.current === currentKey) return
    setUsers([])
    setScores(new Map())
    setSourceUser(null)
    setCursor(null)
    setHasNext(false)
    setScoredCount(0)
    setCacheHitCount(0)
    setClaudeCallCount(0)
    setLastCriteriaUsed(null)
    runKeyRef.current = ''
    lastServerSavedLenRef.current = 0
    lastServerSavedKeyRef.current = ''
  }, [handle, side])

  // Load the recent-runs list on mount. Merge local IDB + per-user
  // server runs so cross-device runs surface as long as the user is
  // signed in. Dedupe on (handle, side); keep the freshest by
  // updatedAt.
  useEffect(() => {
    void (async () => {
      const [local, server] = await Promise.all([
        listRuns(),
        listServerRuns(),
      ])
      const merged = new Map<string, RunSummary>()
      for (const r of local) {
        merged.set(`${r.side}:${r.handle.toLowerCase()}`, r)
      }
      for (const r of server) {
        const key = `${r.side}:${r.handle.toLowerCase()}`
        const existing = merged.get(key)
        if (!existing || r.updatedAt > existing.updatedAt) {
          merged.set(key, {
            handle: r.handle,
            side: r.side,
            userCount: r.userCount,
            // Server doesn't track scoredCount in this table; fall back
            // to whatever IDB had so the row still looks right.
            scoredCount: existing?.scoredCount ?? 0,
            updatedAt: r.updatedAt,
          })
        }
      }
      setRuns(
        Array.from(merged.values()).sort((a, b) => b.updatedAt - a.updatedAt),
      )
    })()
  }, [])

  // Auto-save: 1s after any state change to users / scores / cursor /
  // sourceUser, write the snapshot to IndexedDB keyed by (normalized
  // handle, side). Debounced via setTimeout so a fast sequence of state
  // updates (e.g. infinite-scroll auto-paging) produces at most one
  // persistent write per second.
  useEffect(() => {
    const normalized = normalizeForCache(handle)
    if (!normalized || users.length === 0) return

    // Don't persist if the in-memory state belongs to a different run
    // than the currently typed handle. Prevents the original bug where
    // typing a new handle while a prior run was loaded saved the OLD
    // users[] under the NEW handle's cache key.
    const currentKey = `${normalized}:${side}`
    if (runKeyRef.current && runKeyRef.current !== currentKey) return

    // IDB write (always tried unless cache is disabled). Cheap and
    // fast — runs every settled state change.
    let idbTimeout: ReturnType<typeof setTimeout> | undefined
    if (!cacheDisabled) {
      setCacheStatus('saving')
      idbTimeout = setTimeout(() => {
        void saveRun({
          handle: normalized,
          side,
          sourceUser,
          users,
          scores: Array.from(scores.entries()),
          cursor,
          hasNext,
          criteriaUsed: lastCriteriaUsed,
          updatedAt: Date.now(),
        }).then((result) => {
          if (result.ok) {
            setCacheStatus('saved')
            void listRuns().then(setRuns)
          } else {
            setCacheStatus('idle')
            setCacheDisabled(true)
          }
        })
      }, 1000)
    }

    // Server write — coarser cadence. Only push when the delta is big
    // enough or the load just settled (hasNext=false), so a 19k run
    // emits ~10 saves total instead of ~hundreds.
    const runKey = `${normalized}:${side}`
    if (runKey !== lastServerSavedKeyRef.current) {
      lastServerSavedLenRef.current = 0
      lastServerSavedKeyRef.current = runKey
    }
    const delta = users.length - lastServerSavedLenRef.current
    const loadFinished = !hasNext && users.length > 0
    const shouldServerSave =
      delta >= SERVER_SAVE_DELTA_THRESHOLD || loadFinished
    let serverTimeout: ReturnType<typeof setTimeout> | undefined
    if (shouldServerSave) {
      const snapshot = {
        handle: normalized,
        side,
        sourceUser,
        users,
        cursor,
        hasNext,
        criteriaUsed: lastCriteriaUsed,
      }
      const snapshotLen = users.length
      serverTimeout = setTimeout(() => {
        void saveServerRun(snapshot).then((result) => {
          if (result.ok) {
            lastServerSavedLenRef.current = snapshotLen
          }
        })
      }, 1500)
    }

    return () => {
      if (idbTimeout) clearTimeout(idbTimeout)
      if (serverTimeout) clearTimeout(serverTimeout)
    }
  }, [handle, side, users, scores, cursor, hasNext, sourceUser, lastCriteriaUsed, cacheDisabled])

  // Auto-restore when the typed handle matches a cached run AND the
  // user hasn't already loaded something for that handle. Suppressed
  // right after we've kicked a fresh load so a network result doesn't
  // get clobbered by a restore on the same render.
  useEffect(() => {
    if (skipRestoreRef.current) return
    if (loading || autoLoading || scoring) return
    if (users.length > 0) return
    const normalized = normalizeForCache(handle)
    if (!normalized) return
    let cancelled = false
    void (async () => {
      // Query the local IDB cache and the server in parallel. Prefer
      // whichever is fresher (higher updatedAt) — the server wins
      // cross-device, the IDB wins instantly on the same machine.
      // Scores from the IDB cache (if present) get merged with whatever
      // the server has via the existing score-cache pipeline; the
      // restored users[] determines what's visible.
      const [idb, server] = await Promise.all([
        loadRun(normalized, side),
        loadServerRun(normalized, side),
      ])
      if (cancelled) return
      let chosen:
        | {
            users: TwitterNetworkUser[]
            scores: Array<[string, TwitterScoredUser]>
            sourceUser: TwitterNetworkUser | null
            cursor: string | null
            hasNext: boolean
            criteriaUsed: string | null
          }
        | null = null
      if (idb && server) {
        // Both exist — take the bigger or fresher one.
        const idbSize = idb.users.length
        const serverSize = server.users.length
        if (serverSize > idbSize || server.updatedAt > idb.updatedAt) {
          chosen = {
            users: server.users,
            scores: idb.scores, // server scores live in twitter_network_scores; surface those via the score cache pipeline
            sourceUser: server.sourceUser,
            cursor: server.cursor,
            hasNext: server.hasNext,
            criteriaUsed: server.criteriaUsed,
          }
        } else {
          chosen = idb
        }
      } else if (server) {
        chosen = {
          users: server.users,
          scores: [],
          sourceUser: server.sourceUser,
          cursor: server.cursor,
          hasNext: server.hasNext,
          criteriaUsed: server.criteriaUsed,
        }
      } else if (idb) {
        chosen = idb
      }
      if (!chosen) return
      setUsers(chosen.users)
      setScores(new Map(chosen.scores))
      setSourceUser(chosen.sourceUser)
      setCursor(chosen.cursor)
      setHasNext(chosen.hasNext)
      setLastCriteriaUsed(chosen.criteriaUsed)
      setScoredCount(chosen.scores.length)
      // Anchor the server-save delta tracker so the next save only fires
      // once we've actually grown the list beyond what's already saved.
      lastServerSavedLenRef.current = chosen.users.length
      lastServerSavedKeyRef.current = `${normalized}:${side}`
      runKeyRef.current = `${normalized}:${side}`
      if (chosen.scores.length > 0) setSortBy('score')
    })()
    return () => {
      cancelled = true
    }
  }, [handle, side, loading, autoLoading, scoring, users.length])

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase()
    let out = users
    if (ceosOnly) out = out.filter((u) => FOUNDER_RE.test(u.description))
    if (verifiedOnly) out = out.filter((u) => u.isVerified || u.isBlueVerified)
    if (scoredOnly) out = out.filter((u) => scores.has(u.userName))
    if (minScore > 0) {
      out = out.filter((u) => (scores.get(u.userName)?.score ?? -1) >= minScore)
    }
    if (q) {
      out = out.filter(
        (u) =>
          u.name.toLowerCase().includes(q) ||
          u.userName.toLowerCase().includes(q) ||
          u.description.toLowerCase().includes(q),
      )
    }
    if (sortBy === 'followers') {
      out = [...out].sort((a, b) => b.followers - a.followers)
    } else if (sortBy === 'score') {
      out = [...out].sort((a, b) => {
        const sa = scores.get(a.userName)?.score ?? -1
        const sb = scores.get(b.userName)?.score ?? -1
        return sb - sa
      })
    }
    return out
  }, [users, filter, ceosOnly, verifiedOnly, scoredOnly, minScore, sortBy, scores])

  // Whole-loaded-set breakdown (independent of the filter so you can see
  // how many of each segment exist in the pulled data).
  const stats = useMemo(() => {
    let verified = 0
    let blueVerified = 0
    let founders = 0
    for (const u of users) {
      if (u.isVerified) verified++
      if (u.isBlueVerified) blueVerified++
      if (FOUNDER_RE.test(u.description)) founders++
    }
    return { verified, blueVerified, founders }
  }, [users])

  return (
    <div className="animate-in fade-in relative min-h-screen duration-300">
      {/* Background lifted from the GEO dashboard: a fixed image anchored
          to the bottom of the viewport with a fading gradient overlay,
          so content above it stays legible while the bottom of the page
          carries the same visual signature as the rest of the app. */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-x-0 bottom-[-12vh] z-0 h-[38vh] overflow-hidden"
      >
        <div
          className="absolute -inset-[5%] dark:hidden"
          style={{
            backgroundImage: 'url(/landing/geo-bg.png)',
            backgroundSize: 'cover',
            backgroundPosition: 'center bottom',
            backgroundRepeat: 'no-repeat',
          }}
        />
        <div
          className="absolute -inset-[5%] hidden [filter:saturate(0.25)] dark:block"
          style={{
            backgroundImage: 'url(/landing/main-demo-bg-dark.jpg)',
            backgroundSize: 'cover',
            backgroundPosition: 'center bottom',
            backgroundRepeat: 'no-repeat',
          }}
        />
        <div
          className="absolute inset-0"
          style={{
            backgroundImage:
              'linear-gradient(to bottom, var(--background) 0%, color-mix(in oklch, var(--background) 96%, transparent) 18%, color-mix(in oklch, var(--background) 76%, transparent) 42%, color-mix(in oklch, var(--background) 36%, transparent) 70%, transparent 100%)',
          }}
        />
      </div>

      <div className="relative z-10 mx-auto max-w-5xl space-y-6 p-8">
      <div className="space-y-2 pt-16 text-center">
        <div className="flex flex-wrap items-baseline justify-center gap-x-3 gap-y-1">
          <h1 className="text-foreground text-3xl leading-tight font-light sm:text-4xl">
            Twitter Network
          </h1>
          {cacheDisabled && (
            <span
              className="text-muted-foreground border-border rounded-full border px-2 py-0.5 text-xs font-light"
              title="Another tab of this page is holding the cache open, or storage is full. Session keeps working in memory; close other tabs and reload to re-enable persistence."
            >
              session only
            </span>
          )}
        </div>
        <p className="text-muted-foreground mx-auto max-w-2xl text-base font-light">
          Pull the followers of any Twitter account and see who the best people
          following you are.
        </p>
      </div>

      {runs.length > 0 && (
        <div className="space-y-2 rounded-md border p-3">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground text-xs font-light">
              Recent runs
            </span>
            {cacheDisabled ? (
              <span
                className="text-muted-foreground text-xs font-light"
                title="Another tab of this page is holding the cache open, or storage is full. Session keeps working in memory; close other tabs and reload to re-enable persistence."
              >
                session only
              </span>
            ) : cacheStatus !== 'idle' ? (
              <span className="text-muted-foreground text-xs font-light">
                {cacheStatus === 'saving' ? 'Saving...' : 'Saved'}
              </span>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            {runs.slice(0, 12).map((r) => (
              <div
                key={`${r.side}:${r.handle}`}
                className="border-border bg-background flex items-center gap-2 rounded-full border px-3 py-1 text-xs"
              >
                <button
                  type="button"
                  onClick={() => {
                    setHandle(r.handle)
                    sideRef.current = r.side
                    setSide(r.side)
                    // The handle/side change will trigger the auto-restore
                    // effect on the next render.
                  }}
                  className="hover:underline"
                  title={`${r.userCount.toLocaleString()} loaded · ${r.scoredCount.toLocaleString()} scored · ${relativeTime(r.updatedAt)}`}
                >
                  <span className="text-muted-foreground">
                    {r.side === 'followers' ? "followers of " : "following of "}
                  </span>
                  @{r.handle}
                  <span className="text-muted-foreground ml-1">
                    · {r.userCount.toLocaleString()}
                    {r.scoredCount > 0 ? ` · ${r.scoredCount.toLocaleString()} scored` : ''}
                    · {relativeTime(r.updatedAt)}
                  </span>
                </button>
                <button
                  type="button"
                  aria-label="Forget this run"
                  onClick={() => {
                    void Promise.all([
                      removeRun(r.handle, r.side),
                      removeServerRun(r.handle, r.side),
                    ]).then(async () => {
                      const [local, server] = await Promise.all([
                        listRuns(),
                        listServerRuns(),
                      ])
                      const merged = new Map<string, RunSummary>()
                      for (const x of local) {
                        merged.set(`${x.side}:${x.handle.toLowerCase()}`, x)
                      }
                      for (const x of server) {
                        const k = `${x.side}:${x.handle.toLowerCase()}`
                        const existing = merged.get(k)
                        if (!existing || x.updatedAt > existing.updatedAt) {
                          merged.set(k, {
                            handle: x.handle,
                            side: x.side,
                            userCount: x.userCount,
                            scoredCount: existing?.scoredCount ?? 0,
                            updatedAt: x.updatedAt,
                          })
                        }
                      }
                      setRuns(
                        Array.from(merged.values()).sort(
                          (a, b) => b.updatedAt - a.updatedAt,
                        ),
                      )
                    })
                  }}
                  className="text-muted-foreground hover:text-foreground"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault()
          void findBestFollowers()
        }}
        className="space-y-3"
      >
        <div className="flex gap-2">
          <Input
            placeholder="@audgeviolin07 or https://x.com/audgeviolin07"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            className="flex-1"
            disabled={loading || autoLoading || scoring}
          />
          {!loading && !autoLoading && !scoring ? (
            <Button
              type="submit"
              disabled={!handle.trim() || !criteria.trim()}
            >
              See my best followers
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                cancelRef.current = true
                scoringCancelRef.current = true
              }}
            >
              {scoring
                ? `Cancel · ${scoredCount.toLocaleString()} / ${users.length.toLocaleString()} scored`
                : `Cancel · ${users.length.toLocaleString()} loaded`}
            </Button>
          )}
        </div>
      </form>

      {(sourceUser || users.length > 0) && (
        <div className="flex flex-wrap items-center gap-4 rounded-md border p-4">
          {sourceUser && (
            <div className="flex min-w-0 items-center gap-3">
              {sourceUser.profilePicture && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={sourceUser.profilePicture}
                  alt={sourceUser.userName}
                  className="h-12 w-12 flex-shrink-0 rounded-full object-cover"
                />
              )}
              <div className="min-w-0">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className="text-foreground font-light">
                    {sourceUser.name}
                  </span>
                  <span className="text-muted-foreground text-sm font-light">
                    @{sourceUser.userName}
                  </span>
                  {(() => {
                    const s = scores.get(sourceUser.userName)
                    if (!s) return null
                    return (
                      <span
                        className="border-border text-foreground rounded-full border bg-transparent px-2 py-0.5 text-xs font-light"
                        title={s.reason}
                      >
                        {s.score} · {s.role || 'unrated'}
                      </span>
                    )
                  })()}
                </div>
                <div className="text-muted-foreground mt-0.5 flex flex-wrap gap-x-3 text-xs font-light">
                  <span>
                    <span className="text-foreground">
                      {formatNumber(sourceUser.followers)}
                    </span>{' '}
                    followers
                  </span>
                  <span>{formatNumber(sourceUser.following)} following</span>
                  {sourceUser.location && <span>{sourceUser.location}</span>}
                </div>
              </div>
            </div>
          )}
          {users.length > 0 && (
            <div className="flex min-w-0 flex-col">
              <span className="text-foreground text-xl font-light">
                {users.length.toLocaleString()}
              </span>
              <span className="text-muted-foreground text-xs font-light">
                loaded
                {sourceUser
                  ? ` / ${sourceUser.followers.toLocaleString()} total`
                  : ''}
              </span>
            </div>
          )}
          {users.length > 0 && scores.size > 0 && !scoring && (
            <Button
              type="button"
              variant="outline"
              onClick={downloadScoredCsv}
              title="Saves handle, name, score, role, reason, bio, followers, and location to a CSV file."
            >
              Download CSV ({scores.size.toLocaleString()} scored)
            </Button>
          )}
          {users.length > 0 && (
            <span className="text-muted-foreground ml-auto text-sm font-light">
              {scoring && (cacheHitCount > 0 || claudeCallCount > 0)
                ? `${cacheHitCount.toLocaleString()} cached · ${claudeCallCount.toLocaleString()} scored`
                : !scoring && (cacheHitCount > 0 || claudeCallCount > 0)
                  ? `This run: ${cacheHitCount.toLocaleString()} cached · ${claudeCallCount.toLocaleString()} freshly scored`
                  : `${visible.length} of ${users.length} loaded${hasNext ? ' (more available)' : ''}`}
            </span>
          )}
        </div>
      )}

      {error && (
        <div className="border-border text-foreground rounded-md border p-3 text-sm font-light">
          {error}
        </div>
      )}

      {users.length > 0 && (
        <Input
          placeholder="Filter name / handle / bio"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value)
            setRenderCap(RENDER_CAP_DEFAULT)
          }}
        />
      )}

      {visible.length > 0 && (
        <div className="divide-border bg-background divide-y rounded-md border">
          {visible.slice(0, renderCap).map((u) => (
            <div key={u.id || u.userName} className="flex items-start gap-4 p-4">
              {u.profilePicture ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={u.profilePicture}
                  alt={u.userName}
                  className="h-12 w-12 flex-shrink-0 rounded-full object-cover"
                />
              ) : (
                <div className="bg-muted h-12 w-12 flex-shrink-0 rounded-full" />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <a
                    href={`https://x.com/${u.userName}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-foreground font-light hover:underline"
                  >
                    {u.name || u.userName}
                  </a>
                  <span className="text-muted-foreground text-sm font-light">
                    @{u.userName}
                  </span>
                  {(u.isVerified || u.isBlueVerified) && (
                    <span className="text-muted-foreground text-xs font-light">
                      verified
                    </span>
                  )}
                  {(() => {
                    const s = scores.get(u.userName)
                    if (!s) return null
                    return (
                      <span
                        className="border-border text-foreground ml-1 rounded-full border bg-transparent px-2 py-0.5 text-xs font-light"
                        title={s.reason}
                      >
                        {s.score} · {s.role || 'unrated'}
                      </span>
                    )
                  })()}
                </div>
                {u.description && (
                  <p className="text-muted-foreground mt-1 text-sm whitespace-pre-wrap">
                    {highlightBio(u.description)}
                  </p>
                )}
                <div className="text-muted-foreground mt-2 flex flex-wrap gap-x-3 text-xs">
                  <span>{formatNumber(u.followers)} followers</span>
                  <span>{formatNumber(u.following)} following</span>
                  {u.location && <span>{u.location}</span>}
                  {u.url && (
                    <a
                      href={u.url}
                      target="_blank"
                      rel="noreferrer"
                      className="hover:underline"
                    >
                      {u.url.replace(/^https?:\/\/(?:www\.)?/, '')}
                    </a>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {visible.length > renderCap && (
        <div className="flex items-center justify-center gap-3 py-2">
          <span className="text-muted-foreground text-xs font-light">
            Showing top {renderCap.toLocaleString()} of {visible.length.toLocaleString()}
          </span>
          <Button
            type="button"
            variant="outline"
            onClick={() => setRenderCap((n) => n + 500)}
          >
            Show 500 more
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => setRenderCap(visible.length)}
          >
            Show all
          </Button>
        </div>
      )}

      {/* Sentinel for infinite scroll. Sits just above the action row so
          the IntersectionObserver fires as the user nears the bottom. */}
      {users.length > 0 && (
        <div
          ref={sentinelRef}
          aria-hidden="true"
          className="h-px w-full"
        />
      )}

      {hasNext && users.length > 0 && (loading || autoLoading) && (
        <div className="text-muted-foreground text-center text-sm">
          Loading more...
        </div>
      )}

      {hasNext && users.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => void loadNextPage()}
            disabled={loading || autoLoading}
          >
            {loading && !autoLoading ? 'Loading...' : 'Load next page'}
          </Button>
          {!autoLoading ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => void loadAll()}
              disabled={loading}
            >
              Load all remaining
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              onClick={cancelAutoLoad}
            >
              Cancel ({users.length.toLocaleString()} loaded...)
            </Button>
          )}
          {sourceUser && (
            <span className="text-muted-foreground self-center text-xs">
              ~{Math.max(0, sourceUser.followers - users.length).toLocaleString()}{' '}
              more to fetch
            </span>
          )}
        </div>
      )}
      </div>
    </div>
  )
}
