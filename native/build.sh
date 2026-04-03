#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
echo "Building fantastical-helper..."
swiftc -O -o "$SCRIPT_DIR/../dist/native/fantastical-helper" "$SCRIPT_DIR/fantastical-helper.swift" \
  -framework EventKit -framework CoreGraphics
echo "Built: dist/native/fantastical-helper"
