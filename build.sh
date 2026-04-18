#!/bin/bash
set -e

echo "=========================================="
echo "Installing pnpm globally..."
echo "=========================================="
npm install -g pnpm || true

echo ""
echo "=========================================="
echo "Pnpm version:"
pnpm --version

echo ""
echo "=========================================="
echo "Installing dependencies..."
echo "=========================================="
pnpm install

echo ""
echo "=========================================="
echo "Building types package..."
echo "=========================================="
pnpm --filter=@ai-insights/types build

echo ""
echo "=========================================="
echo "Building API package..."
echo "=========================================="
pnpm --filter=ai-insights-api build

echo ""
echo "=========================================="
echo "✓ Build successful!"
echo "=========================================="
