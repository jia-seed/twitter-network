// Plain (no "use server") module for constants + types shared between
// score.ts (server action) and the page. Next.js 16 / Turbopack refuses
// non-async exports from a "use server" file, so values like
// TWITTER_SCORE_BATCH_SIZE and the input/output type shapes have to live
// in a sibling module.

// 50 chosen empirically: Claude Haiku 4.5 handles ~10k input tokens
// comfortably (50 profiles × ~150 tokens of context each = ~7.5k) and
// halving the number of API round-trips for a 19k-follower run is the
// single biggest scoring speedup.
export const TWITTER_SCORE_BATCH_SIZE = 50

/**
 * Default "what to look for" criteria used when the caller doesn't pass
 * a custom one. Tuned to surface founders / co-founders, with explicit
 * name-brand examples at the top of the rubric so Claude doesn't
 * inflate fame-but-not-a-founder profiles. The user can override this
 * verbatim from the UI to hunt for different personas (AI founders,
 * crypto founders, specific YC batches, etc.).
 */
export const DEFAULT_FOUNDER_CRITERIA = `Founders / co-founders. The user wants people who started companies — especially name-brand-company founders at the top.

- The TOP TIER (90-100) is reserved for founders / co-founders of name-brand companies that most people in tech recognize: Hugging Face, Stripe, Notion, Vercel, Anthropic, OpenAI, Figma, Linear, Supabase, Replit, Lovable, Cursor, Perplexity, etc. The bio names the company OR the person's name is famous as that founder.
- Strong (80-94): founder of a real funded startup. Bio names the company. Looks YC / a16z / seed+ shaped, even if you've never heard of it.
- Mid (60-79): indie / bootstrapped founder, or ex-founder of something real.
- Adjacent (40-59): NOT a founder but close — founding engineer, early employee, "building <thing>" without an explicit ownership claim. Do not inflate to 60+.
- Wrong category (20-39): senior operator (VP / Director / Head of X) at a place they didn't found.
- Not it (0-19): journalists, government officials, growth coaches, content creators, anonymous accounts, vague bios, motivational-quote bios. NOT what the user wants, even if very famous.

CRITICAL: a New York Times journalist with 500k followers scores LOW (0-19) because they are not a founder. Don't bias up on fame.`

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
