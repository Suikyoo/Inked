/**
 * The embedding device, the same on every browser. Stored vectors sync across browsers, so all of them must come from
 * one numeric path: with the q8 model, WebGPU output is far from WASM's (cosine ~0.3 for the same text), and a
 * query embedded on one device then misses every note embedded on the other.
 */
export const EMBED_DEVICE = 'wasm';
