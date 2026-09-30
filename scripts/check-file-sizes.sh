#!/bin/sh
# Refuses any file over the size limit.
#
# The escrow program's build output went into history once: 6,920 files,
# about 660 MB, 44 of them over 5 MB. Taking it back out needed a force push
# on a public repository. The largest file this repository keeps on purpose
# is an 8 MB GIF, so 10 MB passes everything we mean to keep and would have
# stopped that commit.
#
#   --staged   check what is about to be committed (the pre-commit hook)
#   (no flag)  check every tracked file in the checkout (CI)
#
# A file that genuinely needs to be larger: raise LIMIT_MB for that commit,
# deliberately, rather than bypassing the check.
set -eu
LIMIT_MB="${LIMIT_MB:-10}"
limit=$((LIMIT_MB * 1024 * 1024))
bad=0

if [ "${1:-}" = "--staged" ]; then
  files=$(git diff --cached --name-only --diff-filter=AM)
  size_of() { git cat-file -s ":$1"; }
else
  files=$(git ls-files)
  size_of() { wc -c < "$1" | tr -d ' '; }
fi

# Paths here have no newlines; IFS is set so spaces in names survive.
IFS='
'
for f in $files; do
  [ -f "$f" ] || [ "${1:-}" = "--staged" ] || continue
  s=$(size_of "$f")
  if [ "$s" -gt "$limit" ]; then
    printf 'too large: %s (%s MB, limit %s MB)\n' "$f" "$((s / 1048576))" "$LIMIT_MB" >&2
    bad=1
  fi
done

if [ "$bad" -ne 0 ]; then
  echo "Refusing: build output belongs in .gitignore, not in history." >&2
  exit 1
fi
