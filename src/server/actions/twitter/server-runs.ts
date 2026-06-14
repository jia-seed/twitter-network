'use server'

import type { TwitterNetworkUser } from './network'

export type ServerRunSide = 'followers' | 'following'

export interface ServerRun {
  handle: string
  side: ServerRunSide
  sourceUser: TwitterNetworkUser | null
  users: TwitterNetworkUser[]
  cursor: string | null
  hasNext: boolean
  criteriaUsed: string | null
  updatedAt: number
}

export interface ServerRunSummary {
  handle: string
  side: ServerRunSide
  userCount: number
  updatedAt: number
}

// This standalone build has no DB. Stubs return null / empty / ok so
// the page keeps working — the IDB cache handles per-device runs on
// its own. Wire these to real DB calls if you fork and add Postgres.

export async function loadServerRun(
  _handle: string,
  _side: ServerRunSide,
): Promise<ServerRun | null> {
  return null
}

export async function saveServerRun(_input: {
  handle: string
  side: ServerRunSide
  sourceUser: TwitterNetworkUser | null
  users: TwitterNetworkUser[]
  cursor: string | null
  hasNext: boolean
  criteriaUsed: string | null
}): Promise<{ ok: boolean; error?: string }> {
  return { ok: true }
}

export async function listServerRuns(): Promise<ServerRunSummary[]> {
  return []
}

export async function removeServerRun(
  _handle: string,
  _side: ServerRunSide,
): Promise<void> {
  return
}
