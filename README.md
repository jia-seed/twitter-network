# twitter-network

A single-page tool for pulling a Twitter account's followers / following via
[twitterapi.io](https://twitterapi.io) and ranking each profile against a
custom criteria with Claude Haiku.

Paste a handle, click "Find brand-name founders" (or any preset / custom
criteria), and the tool pages out the entire follower list and stream-scores
every profile in parallel. Results are cached in IndexedDB so reopening the
page restores the run, and scores are reused across runs under the same
criteria.

## Stack

- Next.js 16 (App Router) + React 19 + TypeScript
- Tailwind v4
- Anthropic SDK (Claude Haiku 4.5)
- IndexedDB for client-side persistence

## Setup

```bash
npm install
cp .env.example .env.local
# fill in TWITTERAPI_IO_KEY + ANTHROPIC_API_KEY
npm run dev
```

Visit http://localhost:3000.

## Cost

For a 19k-follower account: ~5 minutes wall time, ~$0.75 in Claude
calls (Haiku at 25-profile batches, 4 in flight). Subsequent runs across
overlapping followers reuse cached scores for free.

## Sync from upstream

This repo started as a slice of a larger app. `scripts/sync-from-jam.sh`
copies updates from the upstream `jam` repo into here. Run before each
push if the upstream has changed:

```bash
JAM_REPO=../jam npm run sync
```

## License

MIT
