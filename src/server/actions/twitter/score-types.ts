/**
 * Module separate from `score.ts` because `'use server'` files in Next.js
 * 16 / Turbopack cannot export non-async values.
 */

export const TWITTER_SCORE_BATCH_SIZE = 25

export interface TwitterScoreInput {
  handle: string
  name: string
  description: string
  followers: number
  isVerified: boolean
  isBlueVerified: boolean
}

export interface TwitterScoredUser {
  handle: string
  score: number
  role: string
  reason: string
}

export type ScoreUsersResult =
  | { success: true; scores: TwitterScoredUser[] }
  | { success: false; error: string }

export const DEFAULT_FOUNDER_CRITERIA = `Founders / co-founders / CEOs of real, recognizable companies — products you'd find on Product Hunt, YC, or Forbes 30 Under 30.

- 90-100: Founder of a clearly recognizable, well-funded company (named in bio).
- 70-89: Founder of a real, funded startup (named in bio).
- 50-69: Indie founder / solo builder / consultant.
- 0-49: Not a founder.

Strongly downweight: VCs / investors / journalists / "growth coaches" / "AI influencers" unless they are also founders. Fame alone is not the criterion.`
