'use server'

import Anthropic from '@anthropic-ai/sdk'
import {
  DEFAULT_FOUNDER_CRITERIA,
  TWITTER_SCORE_BATCH_SIZE,
  type ScoreUsersResult,
  type TwitterScoreInput,
  type TwitterScoredUser,
} from './score-types'

/**
 * Score a batch of (up to TWITTER_SCORE_BATCH_SIZE) Twitter profiles
 * against the caller-supplied criteria using Claude Haiku 4.5. Returns
 * one record per profile in input order — caller maps back by handle.
 */
export async function scoreTwitterUsers(
  users: TwitterScoreInput[],
  criteria?: string,
): Promise<ScoreUsersResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { success: false, error: 'ANTHROPIC_API_KEY not configured.' }
  }
  if (users.length === 0) return { success: true, scores: [] }
  if (users.length > TWITTER_SCORE_BATCH_SIZE) {
    return {
      success: false,
      error: `Batch too large; cap is ${TWITTER_SCORE_BATCH_SIZE}.`,
    }
  }

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const profilesJson = JSON.stringify(
    users.map((u) => ({
      handle: u.handle,
      name: u.name,
      bio: (u.description ?? '').slice(0, 400),
      followers: u.followers,
      verified: u.isVerified || u.isBlueVerified,
      legacyVerified: u.isVerified,
    })),
  )

  const criteriaBlock = (criteria ?? '').trim() || DEFAULT_FOUNDER_CRITERIA

  const prompt = `You are scoring Twitter profiles against a user-provided target.

THE USER IS LOOKING FOR (read carefully — your scores must reflect THIS,
not generic notability):

${criteriaBlock}

SCORING:
- Score every profile 0-100 based on how strongly it matches the target.
- 95-100 = textbook match for the bar described. Use sparingly.
- 80-94  = strong match, clearly fits.
- 60-79  = real but partial match.
- 40-59  = adjacent but not the target.
- 20-39  = wrong category but a real career.
- 0-19   = not the target at all.
- High follower count or legacy verification do NOT save a profile that
  is not the target. Fame is not the criterion.

THE "role" FIELD: be specific. Name the company and the person's role at
it. "Co-founder, Hugging Face" beats "AI founder". If the profile is
NOT the target, still say what they are: "Journalist at NYT", "Engineer
at Figma", "Growth coach".

Return ONLY a JSON array, same order as input. Each object:
{"handle":"...","score":N,"role":"...","reason":"one short sentence"}
No prose, no markdown, no code fences. Just the JSON array.

Profiles (JSON):
${profilesJson}`

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    })

    const textBlock = response.content.find((b) => b.type === 'text')
    if (!textBlock || textBlock.type !== 'text') {
      return { success: false, error: 'Claude returned no text content.' }
    }

    let raw = textBlock.text.trim()
    if (raw.startsWith('```')) {
      raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
    }
    const firstBracket = raw.indexOf('[')
    const lastBracket = raw.lastIndexOf(']')
    if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
      raw = raw.slice(firstBracket, lastBracket + 1)
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (parseErr) {
      return {
        success: false,
        error: `Claude returned non-JSON: ${String(parseErr).slice(0, 120)}`,
      }
    }

    if (!Array.isArray(parsed)) {
      return { success: false, error: 'Claude returned a non-array.' }
    }

    const scores: TwitterScoredUser[] = parsed.map((p) => {
      const rec = (p ?? {}) as Record<string, unknown>
      const scoreNum = Number(rec.score ?? 0)
      return {
        handle: String(rec.handle ?? '').replace(/^@/, ''),
        score: Number.isFinite(scoreNum)
          ? Math.max(0, Math.min(100, Math.round(scoreNum)))
          : 0,
        role: String(rec.role ?? ''),
        reason: String(rec.reason ?? ''),
      }
    })

    return { success: true, scores }
  } catch (e) {
    console.error('[scoreTwitterUsers]', e)
    return { success: false, error: e instanceof Error ? e.message : 'Unknown Claude error' }
  }
}
