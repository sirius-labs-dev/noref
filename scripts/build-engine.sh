#!/bin/sh
# Build the NoRef engine wasm (same rule code as the contract) for the app.
set -e
cd "$(dirname "$0")/.."
cargo build --release --target wasm32-unknown-unknown -p noref-engine-wasm
cp target/wasm32-unknown-unknown/release/noref_engine_wasm.wasm app/web/engine.wasm
echo "app/web/engine.wasm: $(wc -c < app/web/engine.wasm) bytes"
