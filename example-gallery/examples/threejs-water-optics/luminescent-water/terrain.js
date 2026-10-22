import * as THREE from 'three/webgpu';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
const TW = 10.24, TL = 10.24;            // terrain tile width (x) and period (z)
const MRES = 1024;                       // macro terrain texels per side (1 cm)
const MT = TW / MRES;
const NX = 512, NZ = 1024, N = NX * NZ;  // shallow-water grid (1 cm cells)
const DX = 0.01;
const SW = NX * DX, SL = NZ * DX;        // 5.12 x 10.24
const SX0 = (TW - SW) / 2;               // sim x origin
const G = 9.81;
const MICRO_TILE = 1.6;                  // metres covered by one 4K texture tile
const MICRO_AMP = 0.055;                 // displacement amplitude (m)
const WATER_LEVEL = 0.0;
const H_EPS = 0.0006;
const VMAX = 4.0;
const DET_FREQ = 1.0 / 0.45;             // advected detail texture: tiles per metre
const LX = 128, LZ = 256;                // low-res luminance field for area lighting
const CAUS_X = 512, CAUS_Z = 1024;       // caustic mesh resolution (= sim resolution)
const CAUS_RT_X = 1024, CAUS_RT_Z = 2048;
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function makeNoise(rng) {
  const perm = new Uint16Array(1024); const p = [...Array(512).keys()];
  for (let i = 511; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  for (let i = 0; i < 1024; i++) perm[i] = p[i & 511];
  const gx = new Float32Array(512), gy = new Float32Array(512);
  for (let i = 0; i < 512; i++) { const a = rng() * Math.PI * 2; gx[i] = Math.cos(a); gy[i] = Math.sin(a); }
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  // periodic with integer period (px, py) in lattice units
  return (x, y, px, py) => {
    const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
    const x0 = ((xi % px) + px) % px, y0 = ((yi % py) + py) % py, x1 = (x0 + 1) % px, y1 = (y0 + 1) % py;
    const h = (a, b) => perm[perm[a & 511] + (b & 511)];
    const g = (hh, dx, dy) => gx[hh] * dx + gy[hh] * dy;
    const n00 = g(h(x0, y0), fx, fy), n10 = g(h(x1, y0), fx - 1, fy), n01 = g(h(x0, y1), fx, fy - 1), n11 = g(h(x1, y1), fx - 1, fy - 1);
    const u = fade(fx), v = fade(fy);
    return 1.4142 * ((n00 * (1 - u) + n10 * u) * (1 - v) + (n01 * (1 - u) + n11 * u) * v);
  };
}
const smooth = (a, b, x) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };
const PI2 = Math.PI * 2;
const cxf = (z) => TW / 2 + 0.55 * Math.sin(PI2 * z / TL) + 0.22 * Math.sin(2 * PI2 * z / TL + 1.0) + 0.1 * Math.sin(3 * PI2 * z / TL + 2.2);   // channel centreline
const hwf = (z) => 0.85 + 0.2 * Math.sin(3 * PI2 * z / TL + 0.5) + 0.12 * Math.sin(5 * PI2 * z / TL + 2.0);                                 // channel half-width
export function generateTerrain() {
  const rng = mulberry32(1337);
  const nA = makeNoise(rng), nB = makeNoise(rng), nC = makeNoise(rng);
  const fbm = (n, x, z, f, oct, gain = 0.5) => { let s = 0, a = 1, w = 0; for (let o = 0; o < oct; o++) { s += a * n(x / TW * f, z / TL * f, f, f); w += a; a *= gain; f *= 2; } return s / w; };
  const boulders = [];
  for (let k = 0; k < 64; k++) {
    const z0 = rng() * TL, side = rng() < 0.5 ? -1 : 1, ad = 0.95 + rng() * rng() * 2.6;
    const r = 0.3 + rng() * 0.75;
    // centre sits outside the bank by ~its radius so it only encroaches on the channel edge
    boulders.push({ x0: cxf(z0) + side * (ad * hwf(z0) + r * (0.55 + rng() * 0.3)), z0, rx: r * (0.75 + rng() * 0.5), rz: r * (0.8 + rng() * 0.7), top: 0.12 + rng() * 0.55 + (ad - 1) * 0.35, base: -0.3, rot: rng() * Math.PI, sd: rng() * 64 });
  }
  for (let k = 0; k < 18; k++) {
    const z0 = rng() * TL, d = (rng() * 2 - 1) * 0.78, r = 0.07 + rng() * 0.2;
    boulders.push({ x0: cxf(z0) + d * hwf(z0), z0, rx: r * (0.8 + rng() * 0.6), rz: r * (0.8 + rng() * 0.8), top: -0.12 + rng() * 0.26, base: -0.32, rot: rng() * Math.PI, sd: rng() * 64, inStream: true });
  }
  const H = new Float32Array(MRES * MRES), R = new Float32Array(MRES * MRES);
  for (let j = 0; j < MRES; j++) {
    const z = (j + 0.5) * MT, cx = cxf(z), hw = hwf(z);
    for (let i = 0; i < MRES; i++) {
      const x = (i + 0.5) * MT, d = (x - cx) / hw, ad = Math.abs(d);
      const depth = -0.2 - 0.07 * Math.sin(4 * PI2 * z / TL + 0.3) + 0.05 * fbm(nA, x, z, 6, 3);
      let h = depth * (1 - smooth(0.45, 1.05, ad));
      h += smooth(0.85, 1.8, ad) * (0.28 + 0.3 * (fbm(nB, x, z, 4, 3) * 0.5 + 0.5)) + Math.max(0, ad - 1.8) * 0.22;
      h += 0.012 * fbm(nC, x, z, 48, 3);
      const base = h; let rock = smooth(0.25, 0.6, base);
      for (const b of boulders) {
        let dz = z - b.z0; dz -= TL * Math.round(dz / TL);
        const dx = x - b.x0; if (Math.abs(dx) > b.rx * 1.6 || Math.abs(dz) > b.rz * 1.6) continue;
        const c = Math.cos(b.rot), s = Math.sin(b.rot);
        const lx = (c * dx + s * dz) / b.rx, lz = (-s * dx + c * dz) / b.rz;
        let q = 1 - lx * lx - lz * lz;
        q += 0.28 * nA(x * 2.3 + b.sd, z * 2.3, 4096, 4096) + 0.1 * nB(x * 6 + b.sd, z * 6, 4096, 4096);
        if (q <= 0) continue;
        const ry = b.top - b.base;
        let hb = b.base + ry * Math.pow(Math.min(q, 1), 0.38);
        hb += ry * (0.05 * nC(x * 9 + b.sd, z * 9, 4096, 4096) + 0.025 * nA(x * 23 + b.sd, z * 23, 4096, 4096)) - ry * 0.035 * Math.abs(nB(x * 14 + b.sd, z * 14, 4096, 4096));
        const k = 0.03, m = Math.max(k - Math.abs(hb - h), 0) / k;
        const hn = Math.max(h, hb) + m * m * k * 0.25;
        if (hb > base + 0.004) rock = Math.max(rock, smooth(0.004, 0.03, hb - base));
        h = hn;
      }
      H[j * MRES + i] = h; R[j * MRES + i] = rock;
    }
  }
  const data = new Float32Array(MRES * MRES * 4);
  for (let j = 0; j < MRES; j++) for (let i = 0; i < MRES; i++) {
    const ip = Math.min(i + 1, MRES - 1), im = Math.max(i - 1, 0), jp = (j + 1) % MRES, jm = (j - 1 + MRES) % MRES;
    const k = j * MRES + i, dhx = (H[j * MRES + ip] - H[j * MRES + im]) / ((ip - im) * MT), dhz = (H[jp * MRES + i] - H[jm * MRES + i]) / (2 * MT);
    const slope = Math.hypot(dhx, dhz);
    data[k * 4] = H[k]; data[k * 4 + 1] = dhx; data[k * 4 + 2] = dhz;
    data[k * 4 + 3] = Math.max(R[k], smooth(0.9, 1.6, slope) * smooth(-0.05, 0.1, H[k]));
  }
  // half float is plenty (<=0.5 mm at 1 m) and gives hardware bilinear: one fetch per ray-march step
  const half = new Uint16Array(data.length), toH = THREE.DataUtils.toHalfFloat;
  for (let k = 0; k < data.length; k++) half[k] = toH(data[k]);
  const t = new THREE.DataTexture(half, MRES, MRES, THREE.RGBAFormat, THREE.HalfFloatType);
  t.minFilter = t.magFilter = THREE.LinearFilter; t.generateMipmaps = false;
  t.wrapS = THREE.ClampToEdgeWrapping; t.wrapT = THREE.RepeatWrapping; t.needsUpdate = true;
  return { tex: t, H, boulders };
}
async function loadBitmap(url) { const r = await fetch(url); if (!r.ok) throw new Error(url); return createImageBitmap(await r.blob()); }
function bitmapTexture(bmp, srgb) {
  const t = new THREE.Texture(bmp); t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.flipY = false; t.needsUpdate = true; return t;
}
// displacement / roughness / AO packed into one RGBA texture (one fetch per lookup)
async function packTexture(urls) {
  const bmps = await Promise.all(urls.map(loadBitmap));
  const W = bmps[0].width, Hh = bmps[0].height, cv = new OffscreenCanvas(W, Hh), ctx = cv.getContext('2d', { willReadFrequently: true });
  const chans = bmps.map((b) => { ctx.clearRect(0, 0, W, Hh); ctx.drawImage(b, 0, 0); return ctx.getImageData(0, 0, W, Hh).data; });
  const out = new Uint8Array(W * Hh * 4); let sum = 0;
  for (let k = 0, n = W * Hh; k < n; k++) { out[k * 4] = chans[0][k * 4]; out[k * 4 + 1] = chans[1][k * 4]; out[k * 4 + 2] = chans[2][k * 4]; out[k * 4 + 3] = 255; sum += chans[0][k * 4]; }
  const t = new THREE.DataTexture(out, W, Hh, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = true; t.needsUpdate = true;
  return { tex: t, mean: sum / (W * Hh) / 255 };
}

export async function loadWaterStage(resolveAsset) {
const [colorBmp, normalBmp, pack, env] = await Promise.all([
  loadBitmap(resolveAsset('assets/rock-basecolor.jpg')), loadBitmap(resolveAsset('assets/rock-normal.jpg')),
  packTexture([resolveAsset('assets/rock-displacement.jpg'), resolveAsset('assets/rock-roughness.jpg'), resolveAsset('assets/rock-ao.jpg')]),
  new EXRLoader().loadAsync(resolveAsset('assets/bg.hdri')),   // OpenEXR data; the loader parses by content, not extension
]);
const colorTex = bitmapTexture(colorBmp, true), normalTex = bitmapTexture(normalBmp, false), packTex = pack.tex;
env.mapping = THREE.EquirectangularReflectionMapping;
// the HDRI is supporting light only: tame its sodium lamps / light-pollution band and cool it to moonlight
{
  const d = env.image.data, fromH = THREE.DataUtils.fromHalfFloat, toH = THREE.DataUtils.toHalfFloat, half = d instanceof Uint16Array;
  for (let k = 0; k < d.length; k += 4) {
    let r = half ? fromH(d[k]) : d[k], g = half ? fromH(d[k + 1]) : d[k + 1], b = half ? fromH(d[k + 2]) : d[k + 2];
    const l = Math.min(0.3 * r + 0.55 * g + 0.15 * b, 0.8), s = 0.2;
    r = (l + (Math.min(r, 0.8) - l) * s) * 0.62; g = (l + (Math.min(g, 0.8) - l) * s) * 0.8; b = (l + (Math.min(b, 0.8) - l) * s) * 1.0;
    if (half) { d[k] = toH(r); d[k + 1] = toH(g); d[k + 2] = toH(b); } else { d[k] = r; d[k + 1] = g; d[k + 2] = b; }
  }
  env.needsUpdate = true;
}

return { terrain: generateTerrain(), colorTex, normalTex, packTex, packMean: pack.mean, env };
}
