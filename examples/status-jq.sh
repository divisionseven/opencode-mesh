#!/bin/zsh
# Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
# SPDX-License-Identifier: MIT
# Pull one field out of status --json.
# Usage: zsh examples/status-jq.sh [field]
# Example: zsh examples/status-jq.sh port
FIELD="${1:-plugin}"
npx opencode-mesh status --json | python3 -c "import json,sys; print(json.load(sys.stdin)['$FIELD'])"
