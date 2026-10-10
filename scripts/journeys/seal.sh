#!/usr/bin/env bash
# Seal the journey logs of ONE directory after a real walk (docs/journeys.md):
#   scripts/journeys/seal.sh docs/<family>-journeys/<dir>
# Records each log's rendered-contract digest in <family>/.contract-sha. There
# is deliberately no "all": each directory is sealed by whoever walked it.
# Refuses (writing nothing) when the contracts are not measured on the
# current source, when a log is not a complete passing walk, or when a log or
# its screenshot has not been written since the contract it would seal last
# changed — a log can only be sealed by a walk.
set -u
cd "$(dirname "$0")/../.."
[ $# -eq 1 ] || { echo "usage: $0 docs/<family>-journeys/<dir>   (one directory per seal)" >&2; exit 2; }
[ -d "$1" ] || { echo "no such directory: $1" >&2; exit 2; }
exec node scripts/journeys/journeys.mjs seal "$1"
