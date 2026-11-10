/**
 * keccak256 (the Ethereum hash, NOT the later NIST SHA3-256 padding), dependency-free.
 * Used by the Role Registry page to recompute and check, in the administrator's own browser,
 * what a transaction will do before the wallet signs it (Problem 26, review issue 4).
 * keccak256(bytes: Uint8Array) -> "0x" + 64 hex characters.   keccak256Text(string) for UTF-8 text.
 */
(function initKeccak(global) {
  const MASK = (1n << 64n) - 1n;
  const RC = [
    0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
    0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
    0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
    0x000000000000800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
  ];
  // rotation offsets r[x][y], lane index x + 5y
  const R = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]];
  const rotl = (v, n) => (n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & MASK);

  function keccakF(A) {
    for (let round = 0; round < 24; round += 1) {
      const C = [0, 1, 2, 3, 4].map((x) => A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20]);
      const D = [0, 1, 2, 3, 4].map((x) => C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1));
      for (let i = 0; i < 25; i += 1) A[i] ^= D[i % 5];
      const B = new Array(25);
      for (let x = 0; x < 5; x += 1) for (let y = 0; y < 5; y += 1) B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(A[x + 5 * y], R[x][y]);
      for (let x = 0; x < 5; x += 1) for (let y = 0; y < 5; y += 1) A[x + 5 * y] = B[x + 5 * y] ^ ((~B[((x + 1) % 5) + 5 * y] & MASK) & B[((x + 2) % 5) + 5 * y]);
      A[0] ^= RC[round];
    }
  }

  function keccak256(bytes) {
    const rate = 136;
    const padded = new Uint8Array(Math.ceil((bytes.length + 1) / rate) * rate);
    padded.set(bytes);
    padded[bytes.length] ^= 0x01; // Keccak padding (SHA3 would use 0x06)
    padded[padded.length - 1] ^= 0x80;
    const A = new Array(25).fill(0n);
    for (let off = 0; off < padded.length; off += rate) {
      for (let i = 0; i < rate / 8; i += 1) {
        let lane = 0n;
        for (let b = 7; b >= 0; b -= 1) lane = (lane << 8n) | BigInt(padded[off + i * 8 + b]);
        A[i] ^= lane;
      }
      keccakF(A);
    }
    let hex = '';
    for (let i = 0; i < 4; i += 1) for (let b = 0; b < 8; b += 1) hex += Number((A[i] >> BigInt(8 * b)) & 0xffn).toString(16).padStart(2, '0');
    return `0x${hex}`;
  }

  const keccak256Text = (text) => keccak256(new TextEncoder().encode(text));
  const api = { keccak256, keccak256Text };
  global.Keccak = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof window !== 'undefined' ? window : globalThis));
