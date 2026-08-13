#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mapfile -t WORKTREE_LINES < <(git -C "$ROOT_DIR" worktree list | grep -v "^$ROOT_DIR ")

if [[ ${#WORKTREE_LINES[@]} -eq 0 ]]; then
  echo "No extra worktrees found for $ROOT_DIR"
  exit 1
fi

resolve_target() {
  local query="$1"
  local line path
  for line in "${WORKTREE_LINES[@]}"; do
    path="${line%% *}"
    if [[ "$path" == *"$query"* ]]; then
      printf '%s\n' "$path"
      return 0
    fi
  done
  return 1
}

if [[ $# -ge 1 ]]; then
  TARGET_PATH="$(resolve_target "$1" || true)"
  if [[ -z "${TARGET_PATH:-}" ]]; then
    echo "Worktree matching '$1' was not found."
    printf '%s\n' "${WORKTREE_LINES[@]}"
    exit 1
  fi
elif [[ ${#WORKTREE_LINES[@]} -eq 1 ]]; then
  TARGET_PATH="${WORKTREE_LINES[0]%% *}"
else
  echo "Choose worktree to run on port 3001:"
  for i in "${!WORKTREE_LINES[@]}"; do
    printf '  %d) %s\n' "$((i + 1))" "${WORKTREE_LINES[$i]}"
  done
  read -r -p "Selection: " selection
  if [[ ! "$selection" =~ ^[0-9]+$ ]] || (( selection < 1 || selection > ${#WORKTREE_LINES[@]} )); then
    echo "Invalid selection."
    exit 1
  fi
  TARGET_PATH="${WORKTREE_LINES[$((selection - 1))]%% *}"
fi

cd "$TARGET_PATH"

if [[ ! -d node_modules ]]; then
  echo "Missing node_modules in $TARGET_PATH"
  echo "Run: npm install"
  exit 1
fi

exec npm run dev:worktree
