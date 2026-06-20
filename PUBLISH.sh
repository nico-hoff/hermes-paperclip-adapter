#!/bin/bash
# Run this once to publish hermes-paperclip-adapter-pow to npm
set -e
cd "$(dirname "$0")"
echo "Logging in to npm..."
npm login
echo "Publishing hermes-paperclip-adapter-pow@1.1.0..."
npm publish --access public
echo "Done! Package available at: https://www.npmjs.com/package/hermes-paperclip-adapter-pow"
