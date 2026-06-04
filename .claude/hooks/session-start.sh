#!/bin/bash
set -euo pipefail

# Install user-level Claude skills vendored in this repo into the user's
# skills base (~/.claude/skills) so they are available in every session.
#
# Idempotent: re-running keeps ~/.claude/skills in sync with the repo copy.

SRC_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}/.claude/skills-vendor"
DEST_DIR="${HOME}/.claude/skills"

mkdir -p "$DEST_DIR"

if [ -d "$SRC_DIR" ]; then
  for skill_path in "$SRC_DIR"/*/; do
    [ -d "$skill_path" ] || continue
    skill_name="$(basename "$skill_path")"
    rm -rf "${DEST_DIR:?}/${skill_name}"
    cp -a "$skill_path" "${DEST_DIR}/${skill_name}"
    echo "Installed skill: ${skill_name} -> ${DEST_DIR}/${skill_name}"
  done
fi
