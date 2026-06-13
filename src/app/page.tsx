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
  listRuns,
  loadCachedScores,
  loadRun,
  removeRun,
  saveCachedScores,
  saveRun,
  type RunSummary,
} from '@/lib/twitter-network/cache'

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

const PRESETS: Array<{ id: string; label: string; text: string }> = [
  {
    id: 'founders',
    label: 'Founders',
    text: DEFAULT_FOUNDER_CRITERIA,
  },
  {
    id: 'brand-name',
    label: 'Brand-name founders only',
    text: `Founders / co-founders of name-brand companies that almost anyone in tech would recognize by company name on the spot.

- 95-100: Founder / co-founder of Hugging Face, Stripe, Notion, Vercel, Anthropic, OpenAI, Figma, Linear, Supabase, Replit, Cursor, Perplexity, Lovable, Cloudflare, Airtable, Discord, or a peer of these. Bio explicitly names a household-tech company OR the person's name is famous as that founder.
- 80-94: Founder / co-founder of a clearly funded, named-in-bio company that is "kind of well known" but not a household name (Series A+ generally). Bio names the company.
- 40-79: Founder of a real but lesser-known startup. Bio names a company you've never heard of.
- 0-39: Not a founder of a recognizable / fundable company. EVEN IF very famous, very verified, or with millions of followers. Hard-cap to under 40.

This is the strictest preset. Err on the side of LOW scores — only obvious name-brand-company founders should clear 90.`,
  },
  {
    id: 'ai-dev',
    label: 'AI / dev-tool founders',
    text: `Founders / co-founders of AI, developer-tool, or infrastructure companies. Things like LLMs, AI products, dev tools, databases, hosting, APIs, IDEs, agents, vector stores, eval platforms.

- 90-100: Founder of a known AI or dev-infra company (Anthropic, OpenAI, Hugging Face, LangChain, Vercel, Supabase, Replit, Cursor, Lovable, Composio, Linear, Inngest, Modal, Pinecone, Cohere, Mistral, etc.).
- 70-89: Founder of a real funded AI / dev startup, bio names the company, looks YC-shaped.
- 50-69: Indie AI / dev founder.
- 0-49: Not an AI / dev / infra founder.

Strongly downweight: AI-influencer types ("AI thought leader", "AI strategist", growth-coach-shaped bios that mention AI but don't name a product) — those are not founders of AI products.`,
  },
  {
    id: 'crypto',
    label: 'Crypto founders',
    text: `Founders / co-founders of crypto / web3 / DeFi / NFT companies, protocols, or DAOs.

- 90-100: Founder of a known crypto company / protocol (a16z crypto portfolio, top-50-by-TVL DeFi protocols, well-known L1s/L2s, well-known NFT brands).
- 70-89: Founder of a real funded crypto startup, bio names the product/protocol.
- 50-69: Indie crypto founder / project lead.
- 0-49: Not a crypto founder. Influencers, traders, "crypto coaches" hard-cap under 40 even if very famous.`,
  },
  {
    id: 'custom',
    label: 'Custom (edit below)',
    text: '',
  },
]
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'

const MAX_AUTOLOAD_PAGES = 200 // ~40k accounts safety cap
const SCORE_PARALLELISM = 4    // 4 Claude requests in flight at once

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
  const [scores, setScores] = useState<Map<string, TwitterScoredUser>>(new Map())
  const [presetId, setPresetId] = useState<string>('founders')
  const [criteria, setCriteria] = useState<string>(DEFAULT_FOUNDER_CRITERIA)
  const [lastCriteriaUsed, setLastCriteriaUsed] = useState<string | null>(null)
  const [minScore, setMinScore] = useState<number>(0)
  const [error, setError] = useState<string | null>(null)
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [cacheStatus, setCacheStatus] = useState<'idle' | 'saving' | 'saved'>('idle')
  const skipRestoreRef = useRef(false)
  const cancelRef = useRef(false)
  const scoringCancelRef = useRef(false)
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

    // Snapshot of current scores so we don't re-score people in a refresh.
    const alreadyScored = new Set(scores.keys())
    const todo = users.filter((u) => !alreadyScored.has(u.userName))
    const newScores = new Map(scores)

    // Apply any globally-cached scores up front so Claude only sees the
    // genuine misses. Hugely cheaper on a second run of the same
    // criteria across overlapping follower sets.
    const cachedHits = await loadCachedScores(
      criteria,
      todo.map((u) => u.userName),
    )
    const claudeTodo = todo.filter((u) => {
      const hit = cachedHits.get(u.userName)
      if (hit) {
        newScores.set(u.userName, hit)
        return false
      }
      return true
    })
    if (cachedHits.size > 0) {
      setScores(new Map(newScores))
      setScoredCount(newScores.size)
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
          void saveCachedScores(criteria, justScored)
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
        for (const u of result.users) {
          if (!u.userName) continue
          const key = u.userName.toLowerCase()
          if (usersByHandle.has(key)) continue
          usersByHandle.set(key, u)
          if (!scoresByHandle.has(u.userName)) newCandidates.push(u)
          added++
        }
        // Snapshot for the UI. Cheap to re-create an array from the map
        // every page; rendering is virtualized by browser scrolling.
        setUsers(Array.from(usersByHandle.values()))
        setCursor(result.nextCursor)
        setHasNext(result.hasNextPage)
        pages++
        // Consult the global score cache before queueing for Claude.
        // Any handle scored in a previous run under the same criteria is
        // applied here for free, skipping the queue entirely.
        if (newCandidates.length > 0) {
          const cachedHits = await loadCachedScores(
            criteria,
            newCandidates.map((u) => u.userName),
          )
          let hits = 0
          for (const u of newCandidates) {
            const hit = cachedHits.get(u.userName)
            if (hit) {
              scoresByHandle.set(u.userName, hit)
              hits++
            } else {
              queue.push(u)
            }
          }
          if (hits > 0) {
            setScores(new Map(scoresByHandle))
            setScoredCount(scoresByHandle.size)
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
          // Persist to the global score cache so subsequent runs (even
          // for different source accounts) reuse this score under the
          // same criteria.
          void saveCachedScores(criteria, justScored)
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

  // Load the list of cached runs once on mount so the "Recent runs"
  // panel can populate.
  useEffect(() => {
    void listRuns().then(setRuns)
  }, [])

  // Auto-save: 1s after any state change to users / scores / cursor /
  // sourceUser, write the snapshot to IndexedDB keyed by (normalized
  // handle, side). Debounced via setTimeout so a fast sequence of state
  // updates (e.g. infinite-scroll auto-paging) produces at most one
  // persistent write per second.
  useEffect(() => {
    const normalized = normalizeForCache(handle)
    if (!normalized || users.length === 0) return
    setCacheStatus('saving')
    const t = setTimeout(() => {
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
          if (result.error) {
            const isBlocked = result.error.toLowerCase().includes('blocked')
            setError(
              isBlocked
                ? 'Another tab of /twitter-network is holding the cache open at an older schema. Close it and reload this tab to unblock.'
                : `Couldn't cache this run: ${result.error}. Current session keeps working in memory.`,
            )
          }
        }
      })
    }, 1000)
    return () => clearTimeout(t)
  }, [handle, side, users, scores, cursor, hasNext, sourceUser, lastCriteriaUsed])

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
    void loadRun(normalized, side).then((cached) => {
      if (cancelled || !cached) return
      setUsers(cached.users)
      setScores(new Map(cached.scores))
      setSourceUser(cached.sourceUser)
      setCursor(cached.cursor)
      setHasNext(cached.hasNext)
      setLastCriteriaUsed(cached.criteriaUsed)
      setScoredCount(cached.scores.length)
      // If the cached run already has scores, default to showing the best
      // first — that's the natural "show me the best followers" view the
      // user expects when they reopen a scored run. They can still flip
      // back to original order via the sort checkbox.
      if (cached.scores.length > 0) setSortBy('score')
    })
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
    <div className="mx-auto max-w-5xl space-y-6 p-8">
      <div className="space-y-2">
        <h1 className="text-foreground text-3xl leading-tight font-light sm:text-4xl">
          Twitter network
        </h1>
        <p className="text-muted-foreground max-w-2xl text-base font-light">
          Pull the followers of any Twitter account via twitterapi.io. Filter the
          list locally for founders / CEOs.
        </p>
      </div>

      {runs.length > 0 && (
        <div className="space-y-2 rounded-md border bg-muted/40 p-3">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground text-xs font-light">
              Recent runs
            </span>
            {cacheStatus !== 'idle' && (
              <span className="text-muted-foreground text-xs">
                {cacheStatus === 'saving' ? 'Saving...' : 'Saved'}
              </span>
            )}
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
                    void removeRun(r.handle, r.side).then(() =>
                      listRuns().then(setRuns),
                    )
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
          void startFresh()
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
          <Button
            type="submit"
            disabled={loading || autoLoading || scoring || !handle.trim()}
          >
            {loading && users.length === 0
              ? 'Loading...'
              : `Load ${side === 'following' ? 'following' : 'followers'}`}
          </Button>
        </div>
        <div className="flex gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="side"
              value="followers"
              checked={side === 'followers'}
              onChange={() => setSide('followers')}
              disabled={loading || autoLoading || scoring}
            />
            Their followers
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="side"
              value="following"
              checked={side === 'following'}
              onChange={() => setSide('following')}
              disabled={loading || autoLoading || scoring}
            />
            Who they follow
          </label>
        </div>
      </form>

      <div className="space-y-3 rounded-md border border-dashed p-4">
        <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-foreground text-base font-light">
              Find {presetId === 'brand-name'
                ? 'brand-name founders'
                : presetId === 'ai-dev'
                  ? 'AI / dev-tool founders'
                  : presetId === 'crypto'
                    ? 'crypto founders'
                    : presetId === 'custom'
                      ? 'matches'
                      : 'founders'}{' '}
              following you
            </p>
            <p className="text-muted-foreground mt-1 text-xs font-light">
              One click: pulls every follower, scores each one against
              the criteria below with Claude, sorts by score. ~5 min and
              ~$0.75 for a 19k-follower account.
            </p>
          </div>
          {!loading && !autoLoading && !scoring ? (
            <Button
              type="button"
              onClick={() => void findBestFollowers()}
              disabled={!handle.trim() || !criteria.trim()}
              className="w-full sm:w-auto"
            >
              Find {presetId === 'custom' ? 'matches' : presetId === 'founders' ? 'founders' : presetId === 'brand-name' ? 'brand names' : presetId.split('-')[0]}
            </Button>
          ) : (
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                cancelRef.current = true
                scoringCancelRef.current = true
              }}
              className="w-full sm:w-auto"
            >
              {scoring
                ? `Cancel scoring (${scoredCount.toLocaleString()} / ${users.length.toLocaleString()})`
                : autoLoading
                  ? `Cancel pulling (${users.length.toLocaleString()} loaded)`
                  : 'Cancel'}
            </Button>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => {
                setPresetId(p.id)
                if (p.id !== 'custom') setCriteria(p.text)
              }}
              disabled={loading || autoLoading || scoring}
              className={`rounded-full border px-3 py-1 text-xs transition ${
                presetId === p.id
                  ? 'border-foreground bg-foreground text-background'
                  : 'border-border bg-background hover:bg-accent'
              } disabled:opacity-50`}
            >
              {p.label}
            </button>
          ))}
        </div>

        <details className="text-sm" open={presetId === 'custom'}>
          <summary className="text-muted-foreground cursor-pointer text-xs select-none">
            What to look for (Claude reads this verbatim) — {criteria.length}{' '}
            chars
          </summary>
          <textarea
            value={criteria}
            onChange={(e) => {
              setCriteria(e.target.value)
              setPresetId('custom')
            }}
            disabled={loading || autoLoading || scoring}
            rows={8}
            className="border-border bg-background mt-2 w-full rounded-md border p-3 font-mono text-xs"
            placeholder="Describe who you're hunting for. E.g. 'Founders of YC-backed AI companies, especially the AI-research labs everyone's heard of.'"
          />
        </details>
      </div>

      {sourceUser && (
        <div className="bg-muted/40 flex items-start gap-4 rounded-md border p-4">
          {sourceUser.profilePicture && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={sourceUser.profilePicture}
              alt={sourceUser.userName}
              className="h-12 w-12 flex-shrink-0 rounded-full object-cover"
            />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="text-foreground font-light">{sourceUser.name}</span>
              <span className="text-muted-foreground text-sm font-light">
                @{sourceUser.userName}
              </span>
            </div>
            <div className="text-muted-foreground mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs font-light">
              <span>
                <span className="text-foreground">
                  {formatNumber(sourceUser.followers)}
                </span>{' '}
                followers on Twitter
              </span>
              <span>
                {formatNumber(sourceUser.following)} following
              </span>
              {sourceUser.location && <span>{sourceUser.location}</span>}
            </div>
          </div>
        </div>
      )}

      {users.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {!scoring ? (
            <Button
              type="button"
              variant="secondary"
              onClick={() => void scoreAllLoaded()}
              disabled={loading || autoLoading}
            >
              {scores.size > 0
                ? `Score ${(users.length - scores.size).toLocaleString()} unscored with Claude`
                : `Score ${users.length.toLocaleString()} loaded with Claude`}
            </Button>
          ) : (
            <Button
              type="button"
              variant="secondary"
              onClick={cancelScoring}
            >
              Cancel scoring ({scoredCount.toLocaleString()} / {users.length.toLocaleString()})
            </Button>
          )}
          {scoring && (
            <span className="text-muted-foreground text-xs">
              Claude Haiku, batches of {TWITTER_SCORE_BATCH_SIZE},{' '}
              {SCORE_PARALLELISM} in flight
            </span>
          )}
        </div>
      )}

      {users.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-md border p-3">
            <div className="text-foreground text-2xl font-light">
              {users.length.toLocaleString()}
            </div>
            <div className="text-muted-foreground text-xs font-light">
              loaded
              {sourceUser
                ? ` / ${sourceUser.followers.toLocaleString()} total`
                : ''}
            </div>
          </div>
          <div className="rounded-md border p-3">
            <div className="text-foreground text-2xl font-light">
              {(stats.verified + stats.blueVerified).toLocaleString()}
            </div>
            <div className="text-muted-foreground text-xs font-light">
              verified (legacy + blue)
            </div>
          </div>
          <div className="rounded-md border p-3">
            <div className="text-foreground text-2xl font-light">{stats.verified}</div>
            <div className="text-muted-foreground text-xs font-light">legacy verified</div>
          </div>
          <div className="rounded-md border p-3">
            <div className="text-foreground text-2xl font-light">
              {stats.founders.toLocaleString()}
            </div>
            <div className="text-muted-foreground text-xs font-light">
              founder-language bios
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="border-border bg-muted/40 text-foreground rounded-md border p-3 text-sm font-light">
          {error}
        </div>
      )}

      {users.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <Input
            placeholder="Filter name / handle / bio"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="max-w-xs"
          />
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={ceosOnly}
              onCheckedChange={(v) => setCeosOnly(Boolean(v))}
            />
            Founders / CEOs only
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={verifiedOnly}
              onCheckedChange={(v) => setVerifiedOnly(Boolean(v))}
            />
            Verified only
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={sortBy === 'followers'}
              onCheckedChange={(v) =>
                setSortBy(Boolean(v) ? 'followers' : 'order')
              }
            />
            Sort by follower count
          </label>
          {scores.size > 0 && (
            <>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={scoredOnly}
                  onCheckedChange={(v) => setScoredOnly(Boolean(v))}
                />
                Scored only
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={sortBy === 'score'}
                  onCheckedChange={(v) =>
                    setSortBy(Boolean(v) ? 'score' : 'order')
                  }
                />
                Sort by Claude score
              </label>
              <label className="flex items-center gap-2 text-sm">
                <span>Min score</span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={minScore}
                  onChange={(e) =>
                    setMinScore(
                      Math.max(0, Math.min(100, Number(e.target.value) || 0)),
                    )
                  }
                  className="border-border bg-background w-16 rounded-md border px-2 py-1 text-sm"
                />
                {[90, 80, 70].map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setMinScore(n)}
                    className="text-muted-foreground hover:text-foreground text-xs underline"
                  >
                    {n}+
                  </button>
                ))}
              </label>
            </>
          )}
          <span className="text-muted-foreground ml-auto text-sm">
            {visible.length} of {users.length} loaded
            {hasNext ? ' (more available)' : ''}
          </span>
        </div>
      )}

      {visible.length > 0 && (
        <div className="divide-border bg-background divide-y rounded-md border">
          {visible.map((u) => (
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
            variant="secondary"
            onClick={() => void loadNextPage()}
            disabled={loading || autoLoading}
          >
            {loading && !autoLoading ? 'Loading...' : 'Load next page'}
          </Button>
          {!autoLoading ? (
            <Button
              type="button"
              variant="secondary"
              onClick={() => void loadAll()}
              disabled={loading}
            >
              Load all remaining
            </Button>
          ) : (
            <Button
              type="button"
              variant="secondary"
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
  )
}
