// Compact, dependency-free MD5 (RFC 1321) over a byte array → lowercase hex.
// Web Crypto has no MD5, so this covers the MD5 row of the Hasher module.
const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15,
  21,
];
const K: number[] = [];
for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;

const rol = (n: number, c: number) => (n << c) | (n >>> (32 - c));
const hx = (n: number) => {
  let s = '';
  for (let i = 0; i < 4; i++) s += (((n >>> (i * 8)) & 0xff).toString(16)).padStart(2, '0');
  return s;
};

export function md5(msg: Uint8Array): string {
  const origLen = msg.length;
  const bitLen = origLen * 8;
  let len = origLen + 1;
  while (len % 64 !== 56) len++;
  const buf = new Uint8Array(len + 8);
  buf.set(msg);
  buf[origLen] = 0x80;
  for (let i = 0; i < 8; i++) buf[len + i] = Math.floor(bitLen / 2 ** (8 * i)) & 0xff;

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let off = 0; off < buf.length; off += 64) {
    const M: number[] = [];
    for (let i = 0; i < 16; i++)
      M[i] = buf[off + i * 4]! | (buf[off + i * 4 + 1]! << 8) | (buf[off + i * 4 + 2]! << 16) | (buf[off + i * 4 + 3]! << 24);
    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number;
      let g: number;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = (F + A + K[i]! + M[g]!) >>> 0;
      A = D;
      D = C;
      C = B;
      B = (B + rol(F, S[i]!)) >>> 0;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }
  return hx(a0) + hx(b0) + hx(c0) + hx(d0);
}
