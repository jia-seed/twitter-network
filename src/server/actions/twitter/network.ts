'use server'

const BASE = 'https://api.twitterapi.io'
const TIMEOUT_MS = 30_000

export interface TwitterNetworkUser {
  id: string
  userName: string
  name: string
  description: string
  followers: number
  following: number
  profilePicture: string | null
  isVerified: boolean
  isBlueVerified: boolean
  location: string | null
  url: string | null
}

export type FetchFollowersResult =
  | {
      success: true
      users: TwitterNetworkUser[]
      hasNextPage: boolean
      nextCursor: string | null
    }
  | { success: false; error: string }

export type FetchUserInfoResult =
  | { success: true; user: TwitterNetworkUser }
  | { success: false; error: string }

/**
 * Accepts:
 *   audgeviolin07
 *   @audgeviolin07
 *   https://x.com/audgeviolin07
 *   https://twitter.com/audgeviolin07
 *   https://twitter.com/audgeviolin07/with_replies
 */
function normalizeHandle(input: string): string {
  let s = (input ?? '').trim()
  s = s.replace(/^https?:\/\/(?:www\.)?(?:twitter|x)\.com\//i, '')
  s = s.replace(/^@/, '')
  s = s.split('/')[0].split('?')[0].split('#')[0]
  return s
}

type RawUser = Record<string, unknown>

function shape(raw: RawUser): TwitterNetworkUser {
  const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0) || 0)
  const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v))
  return {
    id: str(raw.id ?? raw.user_id ?? raw.rest_id),
    userName: str(raw.userName ?? raw.username ?? raw.screen_name),
    name: str(raw.name),
    description: str(raw.description ?? raw.bio),
    followers: num(raw.followers ?? raw.followers_count),
    following: num(raw.following ?? raw.friends_count),
    profilePicture:
      (raw.profilePicture as string | null) ??
      (raw.profile_image_url_https as string | null) ??
      (raw.profile_image_url as string | null) ??
      null,
    isVerified: Boolean(raw.isVerified ?? raw.verified ?? false),
    isBlueVerified: Boolean(raw.isBlueVerified ?? false),
    location: (raw.location as string | null) ?? null,
    url: (raw.url as string | null) ?? null,
  }
}

export async function fetchTwitterUserInfo(
  rawHandle: string,
): Promise<FetchUserInfoResult> {
  const apiKey = process.env.TWITTERAPI_IO_KEY
  if (!apiKey) {
    return { success: false, error: 'TWITTERAPI_IO_KEY not configured on the server.' }
  }
  const handle = normalizeHandle(rawHandle)
  if (!handle) return { success: false, error: 'Could not parse a Twitter handle from that input.' }

  try {
    const url = new URL(`${BASE}/twitter/user/info`)
    url.searchParams.set('userName', handle)
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: { 'X-API-Key': apiKey },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { success: false, error: `twitterapi.io ${res.status}: ${body.slice(0, 200) || res.statusText}` }
    }
    const data = (await res.json()) as { data?: RawUser; user?: RawUser } & RawUser
    const raw = (data.data ?? data.user ?? (data as RawUser)) as RawUser
    if (!raw || (typeof raw === 'object' && Object.keys(raw).length === 0)) {
      return { success: false, error: 'User not found.' }
    }
    return { success: true, user: shape(raw) }
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      return { success: false, error: 'Twitter API request timed out (30s).' }
    }
    console.error('[fetchTwitterUserInfo]', e)
    return { success: false, error: e instanceof Error ? e.message : 'Unknown error' }
  }
}

export type NetworkSide = 'followers' | 'following'

async function fetchTwitterNetwork(
  side: NetworkSide,
  rawHandle: string,
  cursor?: string,
): Promise<FetchFollowersResult> {
  const apiKey = process.env.TWITTERAPI_IO_KEY
  if (!apiKey) {
    return { success: false, error: 'TWITTERAPI_IO_KEY not configured on the server.' }
  }

  const handle = normalizeHandle(rawHandle)
  if (!handle) return { success: false, error: 'Could not parse a Twitter handle from that input.' }

  try {
    const path = side === 'followers' ? '/twitter/user/followers' : '/twitter/user/followings'
    const url = new URL(`${BASE}${path}`)
    url.searchParams.set('userName', handle)
    if (cursor) url.searchParams.set('cursor', cursor)

    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: { 'X-API-Key': apiKey },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })

    if (res.status === 429 || res.status === 403) {
      const retryAfter = res.headers.get('retry-after')
      return {
        success: false,
        error: `Rate limited (${res.status})${retryAfter ? `, retry after ${retryAfter}s` : ''}.`,
      }
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return {
        success: false,
        error: `twitterapi.io ${res.status}: ${body.slice(0, 200) || res.statusText}`,
      }
    }

    const ct = res.headers.get('content-type') ?? ''
    if (!ct.includes('application/json')) {
      return { success: false, error: `twitterapi.io returned non-JSON: ${ct}` }
    }

    const data = (await res.json()) as {
      followers?: RawUser[]
      followings?: RawUser[]
      users?: RawUser[]
      data?: RawUser[]
      has_next_page?: boolean
      next_cursor?: string
    }

    const list: RawUser[] =
      data.followers ?? data.followings ?? data.users ?? data.data ?? []

    // Normalize empty-string cursors to null. Some pagination APIs return
    // "" instead of omitting the field; an empty-but-truthy cursor would
    // either short-circuit caller loops or trigger endless first-page
    // re-requests.
    const rawCursor = typeof data.next_cursor === 'string' ? data.next_cursor : null
    const nextCursor = rawCursor && rawCursor.length > 0 ? rawCursor : null

    return {
      success: true,
      users: list.map(shape).filter((u) => u.userName),
      hasNextPage: Boolean(data.has_next_page) && nextCursor !== null,
      nextCursor,
    }
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      return { success: false, error: 'Twitter API request timed out (30s).' }
    }
    console.error('[fetchTwitterNetwork]', e)
    return { success: false, error: e instanceof Error ? e.message : 'Unknown error' }
  }
}

export async function fetchTwitterFollowers(
  rawHandle: string,
  cursor?: string,
): Promise<FetchFollowersResult> {
  return fetchTwitterNetwork('followers', rawHandle, cursor)
}

export async function fetchTwitterFollowings(
  rawHandle: string,
  cursor?: string,
): Promise<FetchFollowersResult> {
  return fetchTwitterNetwork('following', rawHandle, cursor)
}
