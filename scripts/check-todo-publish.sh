#!/bin/zsh
# Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
# SPDX-License-Identifier: MIT
# Publish gate: zsh pipestatus check, not PIPESTATUS.
set -e; setopt pipefail
if rg -n "TODO\(PUBLISH" src plugin bin package.json README.md CHANGELOG.md skills/opencode-mesh/SKILL.md ARCHITECTURE.md docs examples 2>/dev/null | grep -q .; then
  echo "TODO(PUBLISH) blocks publish" >&2
  rg -n "TODO\(PUBLISH" src plugin bin package.json README.md CHANGELOG.md skills/opencode-mesh/SKILL.md ARCHITECTURE.md docs examples; exit 1
fi
if rg -n "TODO\(PUBLISH\)" src plugin bin 2>/dev/null | grep -q .; then
  echo "require scope TODO(PUBLISH: scope)" >&2
  rg -n "TODO\(PUBLISH\)" src plugin bin; exit 1
fi
echo "TODO(PUBLISH) gate OK"
