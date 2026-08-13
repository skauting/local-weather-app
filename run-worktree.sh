#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_ENV_FILE="$ROOT_DIR/.env"
ROOT_NODE_MODULES_DIR="$ROOT_DIR/node_modules"

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

if [[ ! -d "$TARGET_PATH/node_modules" ]]; then
  if [[ -d "$ROOT_NODE_MODULES_DIR" ]]; then
    echo "Linking shared node_modules from $ROOT_NODE_MODULES_DIR"
    ln -s "$ROOT_NODE_MODULES_DIR" "$TARGET_PATH/node_modules"
  else
    echo "Missing node_modules in both $TARGET_PATH and $ROOT_DIR"
    echo "Run: npm install"
    exit 1
  fi
fi

if [[ ! -f "$TARGET_PATH/.env" && -f "$ROOT_ENV_FILE" ]]; then
  echo "Loading shared .env from $ROOT_ENV_FILE"
  set -a
  # Use the main checkout .env when the target worktree does not have its own copy.
  . "$ROOT_ENV_FILE"
  set +a
fi

cd "$TARGET_PATH"

exec npm run dev:worktree
