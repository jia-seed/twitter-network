#!/usr/bin/env bash
# Copy twitter-network sources from the upstream `jam` repo into this
# standalone repo. Run before each push if upstream has changed.
#
# Usage:
#   JAM_REPO=../jam ./scripts/sync-from-jam.sh
#   JAM_REPO=/abs/path/to/jam ./scripts/sync-from-jam.sh
#
# Defaults to ../jam relative to this repo's parent directory.

set -euo pipefail

JAM_REPO="${JAM_REPO:-$(cd "$(dirname "$0")/.." && pwd)/../jam}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"

if [ ! -d "$JAM_REPO" ]; then
  echo "error: JAM_REPO=$JAM_REPO does not exist" >&2
  exit 1
fi

echo "syncing from $JAM_REPO -> $HERE"

# Plain copies — these files have no Jam-internal dependencies.
cp "$JAM_REPO/src/lib/twitter-network/cache.ts" \
   "$HERE/src/lib/twitter-network/cache.ts"

cp "$JAM_REPO/src/server/actions/twitter/score-types.ts" \
   "$HERE/src/server/actions/twitter/score-types.ts"

cp "$JAM_REPO/src/app/twitter-network/page.tsx" \
   "$HERE/src/app/page.tsx"

# score.ts needs two replacements:
#   - import { getAnthropicClient } -> import Anthropic from '@anthropic-ai/sdk'
#   - drop the @/lib/sentry import + every captureActionError(...) call
# Done with python (regex with proper multi-line handling — sed multi-line
# replace was eating downstream blocks).
python3 - "$JAM_REPO/src/server/actions/twitter/score.ts" \
            "$HERE/src/server/actions/twitter/score.ts" <<'PY'
import re, sys
src, dst = sys.argv[1], sys.argv[2]
text = open(src).read()
text = text.replace(
    "import { getAnthropicClient } from '@/lib/ai/client'",
    "import Anthropic from '@anthropic-ai/sdk'",
)
text = re.sub(r"^import \{ captureActionError \} from '@/lib/sentry'\s*\n", '', text, flags=re.M)
text = text.replace(
    "const anthropic = getAnthropicClient()",
    "const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })",
)
text = re.sub(r"^\s*captureActionError\([^)]*\)\s*\n", '', text, flags=re.M)
text = re.sub(r"^\s*captureActionError\(\s*\n(?:[^\n]*\n)*?\s*\}\)\s*\n", '', text, flags=re.M)
open(dst, 'w').write(text)
PY

# network.ts: just drop the @/lib/sentry import + captureActionError calls.
python3 - "$JAM_REPO/src/server/actions/twitter/network.ts" \
            "$HERE/src/server/actions/twitter/network.ts" <<'PY'
import re, sys
src, dst = sys.argv[1], sys.argv[2]
text = open(src).read()
text = re.sub(r"^import \{ captureActionError \} from '@/lib/sentry'\s*\n", '', text, flags=re.M)
text = re.sub(r"^\s*captureActionError\([^)]*\)\s*\n", '', text, flags=re.M)
text = re.sub(r"^\s*captureActionError\(\s*\n(?:[^\n]*\n)*?\s*\}\)\s*\n", '', text, flags=re.M)
open(dst, 'w').write(text)
PY

# DO NOT copy server-runs.ts / server-scores.ts — those are intentional
# stubs in this repo (no DB). The page imports them but only no-ops run.

echo "done. review with: git diff"
