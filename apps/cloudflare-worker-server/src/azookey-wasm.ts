// Keep the raw module import in a tiny bridge so Vitest can replace this file
// with an inert test module without asking Vite to parse ESM Wasm directly.
import wasmModule from "../wasm/azookey.wasm";

export default wasmModule;
