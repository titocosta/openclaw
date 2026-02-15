#!/bin/bash
set -e

# Source environment variables
source "$HOME/.zshrc" 2>/dev/null || true

# Ensure pnpm is in PATH
export PNPM_HOME="$HOME/.local/share/pnpm"
export PATH="$PNPM_HOME:$PATH"

# Run gateway
cd "$HOME/openclaw"
exec pnpm openclaw gateway --bind lan
