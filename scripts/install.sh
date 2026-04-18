#!/bin/bash
set -e

echo "Installing pnpm globally..."
npm install -g pnpm

echo "Installing dependencies with pnpm..."
pnpm install

echo "Installation complete!"
