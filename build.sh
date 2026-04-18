#!/bin/bash
set -e

echo "Installing pnpm globally..."
npm install -g pnpm

echo "Installing dependencies with pnpm..."
pnpm install

echo "Building types package..."
pnpm --filter=@ai-insights/types build

echo "Building API..."
pnpm --filter=ai-insights-api build

echo "Build complete!"
