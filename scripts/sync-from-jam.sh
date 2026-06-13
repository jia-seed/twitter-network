#!/usr/bin/env bash
# Copy twitter-network sources from the upstream `jam` repo into this
# standalone repo. Run before each push if upstream has changed.
#
# Usage:
#   JAM_REPO=../jam ./scripts/sync-from-jam.sh
#   JAM_REPO=/abs/path/to/jam ./scripts/sync-from-jam.sh
#
# Defaults to ../jam relative to this script's parent directory.

set -euo pipefail

JAM_REPO="${JAM_REPO:-$(cd "$(dirname "$0")/.." && pwd)/../jam}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"

if [ ! -d "$JAM_REPO" ]; then
  echo "error: JAM_REPO=$JAM_REPO does not exist" >&2
  exit 1
fi

echo "syncing from $JAM_REPO -> $HERE"

# Direct file-by-file copy. Any change to the structure of the upstream
# slice (new file, renamed dir) requires editing this list.
cp "$JAM_REPO/src/lib/twitter-network/cache.ts" \
   "$HERE/src/lib/twitter-network/cache.ts"

cp "$JAM_REPO/src/server/actions/twitter/network.ts" \
   "$HERE/src/server/actions/twitter/network.ts"

cp "$JAM_REPO/src/server/actions/twitter/score-types.ts" \
   "$HERE/src/server/actions/twitter/score-types.ts"

# These two need find/replace because upstream uses internal helpers
# that don't exist in this repo. Keep edits minimal; if the upstream
# diverges further, just port by hand.
#
#   1. score.ts: getAnthropicClient() -> new Anthropic(...)
#   2. score.ts: captureActionError(...) -> console.error(...)
#   3. network.ts: captureActionError(...) -> console.error(...)
sed -e "s|import { getAnthropicClient } from '@/lib/ai/client'|import Anthropic from '@anthropic-ai/sdk'|" \
    -e "s|import { captureActionError } from '@/lib/sentry'||" \
    -e "s|const anthropic = getAnthropicClient()|const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })|" \
    -e "/captureActionError(/,/})/d" \
    "$JAM_REPO/src/server/actions/twitter/score.ts" \
  > "$HERE/src/server/actions/twitter/score.ts"

sed -e "s|import { captureActionError } from '@/lib/sentry'||" \
    -e "/captureActionError(/,/})/d" \
    "$JAM_REPO/src/server/actions/twitter/network.ts" \
  > "$HERE/src/server/actions/twitter/network.ts"

# Page lives at /twitter-network in jam, at / in this repo.
cp "$JAM_REPO/src/app/twitter-network/page.tsx" \
   "$HERE/src/app/page.tsx"

echo "done. review with: git diff"
