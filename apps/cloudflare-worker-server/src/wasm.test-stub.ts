/**
 * Vitest-only replacement for the raw WebAssembly module import.
 *
 * The Worker bundle keeps the real `../wasm/azookey.wasm` import.  Vite's
 * browser test runner does not implement the ESM Wasm integration proposal,
 * so tests that exercise HTTP routing alias that import to this inert module;
 * WebSocket conversion tests inject a converter explicitly.
 */
const wasmModule = undefined as unknown as WebAssembly.Module;

export default wasmModule;
