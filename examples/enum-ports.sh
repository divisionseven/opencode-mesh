#!/usr/bin/env bash
# Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
# SPDX-License-Identifier: MIT
# List peers across sibling servers.
# Usage: MESH_ENUM_PORTS=4097,4098 bash examples/enum-ports.sh
npx opencode-mesh peers --json | python3 -m json.tool
