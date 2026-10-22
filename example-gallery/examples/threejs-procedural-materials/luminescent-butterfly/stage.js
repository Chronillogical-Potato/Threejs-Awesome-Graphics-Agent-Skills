import * as THREE from 'three/webgpu';
import { taperTube } from '/skills/threejs-procedural-materials/examples/luminescent-butterfly/luminescent-butterfly.js';
import {
  Fn, uniform, uv, vec2, vec3, vec4, float, color, texture, time, mix, smoothstep, step, sin, cos, fract, floor,
  dot, length, normalize, max, min, pow, abs, sqrt, exp, saturate, attribute, positionLocal, positionWorld,
  normalWorld, cameraPosition, normalMap, pass, renderOutput, mx_noise_float, mx_fractal_noise_float, screenUV,
  instancedBufferAttribute, viewportSize, positionView, cameraViewMatrix, normalView, BRDF_Lambert,
  perspectiveDepthToViewZ, convertToTexture, Loop, select, clamp, fwidth, atan, mrt, output, instanceIndex, varying, luminance,
  dFdx, dFdy, D_GGX, positionViewDirection, tangentView, bitangentView, log2, If, cross,
  reflect, cameraWorldMatrix, pmremTexture, atan as atanTSL, builtinAOContext, directionToColor, colorToDirection, sample,
  cameraProjectionMatrix, mod, frontFacing
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
const rng = (seed) => { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const D2R = Math.PI / 180;
const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

export function createButterflyStage({ renderer, scene, camera, resolveAsset, defaults }) {
const P = {
  ...defaults,
  key: { color: 0xa9c0ff, intensity: 2600, pos: [-36, 38, 8] },
  rim: { color: 0x3f63ff, intensity: 1400, pos: [30, 14, -30] },
};
const params = new URLSearchParams(location.search);
let cameraBounds;
const key = new THREE.SpotLight(P.key.color, P.key.intensity, 0, 0.42, 0.85, 2);
key.position.set(...P.key.pos);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.bias = -0.0004;
key.shadow.normalBias = 0.03;
key.shadow.camera.near = 20; key.shadow.camera.far = 110;
key.shadow.radius = 3;
scene.add(key, key.target);
key.target.position.set(-1, 0, 0);

const rim = new THREE.SpotLight(P.rim.color, P.rim.intensity, 0, 0.5, 0.9, 2);
rim.position.set(...P.rim.pos);
rim.castShadow = true; // every light is occluded by the petals, butterfly and stem
rim.shadow.mapSize.set(1024, 1024);
rim.shadow.bias = -0.0004; rim.shadow.normalBias = 0.03;
rim.shadow.camera.near = 20;
scene.add(rim, rim.target);
rim.target.position.set(0, 1, 0);

/* ============================================================ rose geometry */
function widthProfile(v, point = 0) {
  let w = 0.15 + 0.85 * Math.pow(Math.sin(Math.min(v / 0.64, 1) * Math.PI * 0.5), 0.8);
  if (v > 0.58) {
    const k = (v - 0.58) / 0.42;
    const round = Math.sqrt(Math.max(0, 1 - k * k * 0.97));
    const pointed = Math.pow(Math.max(0, 1 - k), 0.75) * (1 - 0.25 * k);
    w *= lerp(round, pointed, point);
  }
  return w;
}

function buildRose({ seed, N = 38, segU = 40, segV = 46, S = 1 }) {
  const rand = rng(seed);
  const nv = (segU + 1) * (segV + 1);
  const total = N * nv;
  const pos = new Float32Array(total * 3), uvs = new Float32Array(total * 2);
  const pco = new Float32Array(total * 2), inf = new Float32Array(total * 3), tan = new Float32Array(total * 4);
  const index = [];
  const petals = [];
  const tmp = [0, 0, 0];
  // Non-intersection envelope. Petals are placed inner -> outer; every petal is pushed outside all
  // petals already placed, measured along rays from a point low in the cup (the petals are close to
  // star-shaped from there). env[] holds the outermost occupied distance per (azimuth, elevation) bin.
  const NPH = 288, NTH = 144, env = new Float32Array(NPH * NTH);
  const C0 = 0, C1 = 0.15 * S, C2 = 0, GAP = 0.03 * S;
  const binOf = (x, y, z) => {
    const dx = x - C0, dy = y - C1, dz = z - C2, rho = Math.hypot(dx, dy, dz) || 1e-6;
    const ip = ((Math.floor((Math.atan2(dz, dx) + Math.PI) / (2 * Math.PI) * NPH) % NPH) + NPH) % NPH;
    const it = Math.min(NTH - 1, Math.max(0, Math.floor((Math.asin(dy / rho) + Math.PI / 2) / Math.PI * NTH)));
    return [rho, ip, it, dx / rho, dy / rho, dz / rho];
  };
  const envAround = (ip, it) => {
    let m = 0;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      const tt = it + b; if (tt < 0 || tt >= NTH) continue;
      m = Math.max(m, env[tt * NPH + (ip + a + NPH) % NPH]);
    }
    return m;
  };

  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const j = () => rand() * 2 - 1;
    const p = {
      t,
      phi: i * 2.39996323 + j() * 0.14,
      L: lerp(1.55, 6.9, Math.pow(t, 0.95)) * (1 + j() * 0.06) * S,
      W: lerp(0.85, 3.6, Math.pow(t, 0.85)) * (1 + j() * 0.07) * S,
      r0: lerp(0.14, 1.1, t) * S,
      y0: lerp(0.55, -0.25, t) * S,
      thB: (lerp(2, 34, Math.pow(t, 2.2)) + j() * 2.5) * D2R,
      thT: (-8 + 104 * Math.pow(t, 1.8) + j() * 5) * D2R,
      reflex: lerp(0, 40, sstep(0.3, 0.95, t)) * D2R,
      cup: lerp(0.03, 0.26, t),
      curl: lerp(0.1, 1.0, sstep(0.08, 0.55, t)),
      point: lerp(0.0, 0.55, sstep(0.55, 0.92, t)),
      flat: sstep(0.4, 1, t) * 0.7,
      ruff: 0.035 + 0.09 * t,
      rs: rand() * 100,
      segU, segV, base: i * nv,
    };
    // integrate the mid-rib profile in the (radius, height) plane
    const NS = 160, prof = [];
    let r = p.r0, y = p.y0;
    for (let s = 0; s <= NS; s++) {
      const v = s / NS;
      const th = p.thB + (p.thT - p.thB) * Math.pow(v, 1.5) + p.reflex * Math.pow(sstep(0.5, 1, v), 2);
      prof.push([r, y, th]);
      r = Math.max(r + Math.sin(th) * p.L / NS, 0.12 * S);
      y += Math.cos(th) * p.L / NS;
    }
    const sampleProf = (v) => {
      const f = v * NS, a = Math.min(Math.floor(f), NS - 1), k = f - a;
      const p0 = prof[a], p1 = prof[a + 1];
      return [lerp(p0[0], p1[0], k), lerp(p0[1], p1[1], k), lerp(p0[2], p1[2], k)];
    };
    const cphi = Math.cos(p.phi), sphi = Math.sin(p.phi);
    const surf = (u, v, out) => {
      const [rc, yc, th] = sampleProf(v);
      const hw = p.W * widthProfile(v, p.point) * (1 + 0.05 * Math.sin(v * 7 + p.rs));
      const au = Math.abs(u);
      const roll = Math.pow(sstep(0.4, 1, au), 2) * sstep(0.15, 0.8, v);
      const lat = u * hw * (1 - 0.26 * roll * p.curl);
      const n = p.cup * p.W * u * u * sstep(0, 0.45, v)
        - p.curl * p.W * 0.5 * roll
        + p.ruff * S * Math.sin(u * 4.5 + p.rs + v * 5) * au * v
        - 0.18 * p.curl * p.W * Math.pow(sstep(0.86, 1, v), 2);
      const rad = rc - n * Math.cos(th);
      const yy = yc + n * Math.sin(th);
      const ang = Math.max(-2.75, Math.min(2.75, lat / Math.max(rad, 0.16 * S)));
      const ax = rad * Math.cos(p.phi + ang), az = rad * Math.sin(p.phi + ang);
      const fx = rad * cphi - lat * sphi, fz = rad * sphi + lat * cphi;
      out[0] = lerp(ax, fx, p.flat); out[1] = yy; out[2] = lerp(az, fz, p.flat);
    };
    p.surf = surf;
    for (let jv = 0; jv <= segV; jv++) {
      const v = jv / segV;
      for (let iu = 0; iu <= segU; iu++) {
        const u = iu / segU * 2 - 1;
        const k = p.base + jv * (segU + 1) + iu;
        surf(u, v, tmp);
        pos[k * 3] = tmp[0]; pos[k * 3 + 1] = tmp[1]; pos[k * 3 + 2] = tmp[2];
        uvs[k * 2] = iu / segU; uvs[k * 2 + 1] = v;
        inf[k * 3] = t; inf[k * 3 + 1] = (p.rs % 1); inf[k * 3 + 2] = p.L;
      }
    }
    // push outside the envelope (the hidden base may tuck in), smoothing the push so no kinks appear
    if (!params.has('rawpetals')) {
      const need = new Float32Array(nv), disp = new Float32Array(nv), nb = new Float32Array(nv), info = [];
      for (let q = 0; q < nv; q++) {
        const k = p.base + q, v = Math.floor(q / (segU + 1)) / segV;
        const b = binOf(pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]);
        info.push(b);
        need[q] = Math.max(0, envAround(b[1], b[2]) + GAP - b[0]) * sstep(0.04, 0.22, v);
        disp[q] = need[q];
      }
      for (let it = 0; it < 10; it++) {
        for (let jv = 0; jv <= segV; jv++) for (let iu = 0; iu <= segU; iu++) {
          const q = jv * (segU + 1) + iu;
          let sum = disp[q], n = 1;
          if (iu > 0) { sum += disp[q - 1]; n++; } if (iu < segU) { sum += disp[q + 1]; n++; }
          if (jv > 0) { sum += disp[q - segU - 1]; n++; } if (jv < segV) { sum += disp[q + segU + 1]; n++; }
          nb[q] = sum / n;
        }
        for (let q = 0; q < nv; q++) disp[q] = Math.max(need[q], nb[q]);
      }
      for (let q = 0; q < nv; q++) {
        if (disp[q] <= 0) continue;
        const k = p.base + q, [rho, , , ux, uy, uz] = info[q];
        pos[k * 3] = C0 + ux * (rho + disp[q]); pos[k * 3 + 1] = C1 + uy * (rho + disp[q]); pos[k * 3 + 2] = C2 + uz * (rho + disp[q]);
      }
      // record this petal in the envelope (sub-sampled per quad so thin bins are not skipped)
      const P = (q) => [pos[(p.base + q) * 3], pos[(p.base + q) * 3 + 1], pos[(p.base + q) * 3 + 2]];
      for (let jv = 0; jv < segV; jv++) for (let iu = 0; iu < segU; iu++) {
        const q = jv * (segU + 1) + iu, A = P(q), B = P(q + 1), Cq = P(q + segU + 1), D = P(q + segU + 2);
        for (let a = 0; a <= 3; a++) for (let b = 0; b <= 3; b++) {
          const fu = a / 3, fv = b / 3, w = [(1 - fu) * (1 - fv), fu * (1 - fv), (1 - fu) * fv, fu * fv];
          const x = A[0] * w[0] + B[0] * w[1] + Cq[0] * w[2] + D[0] * w[3];
          const y = A[1] * w[0] + B[1] * w[1] + Cq[1] * w[2] + D[1] * w[3];
          const z = A[2] * w[0] + B[2] * w[1] + Cq[2] * w[2] + D[2] * w[3];
          const [rho, ip, it2] = binOf(x, y, z);
          const e = it2 * NPH + ip; if (rho > env[e]) env[e] = rho;
        }
      }
    }
    // tangents along u from the final grid
    for (let jv = 0; jv <= segV; jv++) for (let iu = 0; iu <= segU; iu++) {
      const k = p.base + jv * (segU + 1) + iu, a = p.base + jv * (segU + 1) + Math.max(0, iu - 1), b = p.base + jv * (segU + 1) + Math.min(segU, iu + 1);
      const tx = pos[b * 3] - pos[a * 3], ty = pos[b * 3 + 1] - pos[a * 3 + 1], tz = pos[b * 3 + 2] - pos[a * 3 + 2], tl = Math.hypot(tx, ty, tz) || 1;
      tan[k * 4] = tx / tl; tan[k * 4 + 1] = ty / tl; tan[k * 4 + 2] = tz / tl; tan[k * 4 + 3] = 1;
    }
    // surface-distance coordinates (cm): arc length along the rib from the base, and across each row
    // from the midrib, so procedural detail keeps its proportions where the petal cups and rolls
    const P3 = (jv, iu) => { const k = (p.base + jv * (segU + 1) + iu) * 3; return [pos[k], pos[k + 1], pos[k + 2]]; };
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    const mid = segU / 2;
    for (let iu = 0; iu <= segU; iu++) {
      let acc = 0;
      for (let jv = 0; jv <= segV; jv++) {
        if (jv > 0) acc += dist(P3(jv, iu), P3(jv - 1, iu));
        pco[(p.base + jv * (segU + 1) + iu) * 2 + 1] = acc;
      }
    }
    for (let jv = 0; jv <= segV; jv++) {
      let acc = 0; pco[(p.base + jv * (segU + 1) + mid) * 2] = 0;
      for (let iu = mid + 1; iu <= segU; iu++) { acc += dist(P3(jv, iu), P3(jv, iu - 1)); pco[(p.base + jv * (segU + 1) + iu) * 2] = acc; }
      acc = 0;
      for (let iu = mid - 1; iu >= 0; iu--) { acc += dist(P3(jv, iu), P3(jv, iu + 1)); pco[(p.base + jv * (segU + 1) + iu) * 2] = -acc; }
    }
    for (let jv = 0; jv < segV; jv++) for (let iu = 0; iu < segU; iu++) {
      const a = p.base + jv * (segU + 1) + iu, b = a + 1, c = a + segU + 1, d = c + 1;
      index.push(a, b, c, b, d, c);
    }
    petals.push(p);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.setAttribute('pcoord', new THREE.BufferAttribute(pco, 2));
  g.setAttribute('pinfo', new THREE.BufferAttribute(inf, 3));
  g.setAttribute('tangent', new THREE.BufferAttribute(tan, 4));
  g.setIndex(index);
  g.computeVertexNormals();
  return { geometry: g, petals };
}

// bilinear lookup of a vertex attribute on a petal grid
function petalSample(rose, p, u, v) {
  const P_ = rose.geometry.attributes.position.array, N_ = rose.geometry.attributes.normal.array;
  const fu = (u * 0.5 + 0.5) * p.segU, fv = v * p.segV;
  const iu = Math.min(Math.floor(fu), p.segU - 1), iv = Math.min(Math.floor(fv), p.segV - 1);
  const ku = fu - iu, kv = fv - iv;
  const id = (jv, ju) => p.base + jv * (p.segU + 1) + ju;
  const ids = [id(iv, iu), id(iv, iu + 1), id(iv + 1, iu), id(iv + 1, iu + 1)];
  const w = [(1 - ku) * (1 - kv), ku * (1 - kv), (1 - ku) * kv, ku * kv];
  const pos = V3(), nor = V3();
  ids.forEach((k, n) => {
    pos.x += P_[k * 3] * w[n]; pos.y += P_[k * 3 + 1] * w[n]; pos.z += P_[k * 3 + 2] * w[n];
    nor.x += N_[k * 3] * w[n]; nor.y += N_[k * 3 + 1] * w[n]; nor.z += N_[k * 3 + 2] * w[n];
  });
  return { pos, nor: nor.normalize() };
}

/* ============================================================ rose material */
// Thin petals transmit part of the light that reaches their far face. Done per light inside the
// lighting model, so it carries that light's falloff and shadowing like any other direct term.
class ThinPetalLightingModel extends THREE.PhysicalLightingModel {
  constructor(transmittance, clearcoat, sheen) { super(clearcoat, sheen); this.transmittance = transmittance; }
  direct(params, builder) {
    super.direct(params, builder);
    const back = normalView.dot(params.lightDirection).negate().clamp();
    params.reflectedLight.directDiffuse.addAssign(back.mul(params.lightColor).mul(BRDF_Lambert({ diffuseColor: this.transmittance })));
  }
}
function makeRoseMaterial() {
  const m = new THREE.MeshPhysicalNodeMaterial({ side: THREE.DoubleSide });
  const pc = attribute('pcoord', 'vec2');   // surface distance in cm (lateral, along the rib)
  const pinfo = attribute('pinfo', 'vec3');
  const tP = pinfo.x;
  const seed = pinfo.y.mul(57.0);
  const vv = uv().y;
  const uu = uv().x;
  const au = abs(uu.mul(2).sub(1));

  // venation: fine veins fanning out from the claw, gently meandering, fading toward the rim
  const meander = mx_noise_float(vec3(pc.mul(vec2(1.2, 0.6)), seed)).mul(0.9);
  const veinPhase = uu.mul(46.0).add(meander);
  const veinLine = pow(abs(sin(veinPhase.mul(Math.PI))).oneMinus(), 6.0).mul(smoothstep(0.98, 0.45, vv));
  const minorLine = pow(abs(sin(veinPhase.mul(Math.PI * 3.0))).oneMinus(), 10.0).mul(0.4).mul(smoothstep(0.9, 0.3, vv));
  const veins = veinLine.add(minorLine);
  // papillae (the velvety epidermal cells) and broad mottling, on undistorted surface coordinates
  const papillae = mx_noise_float(vec3(pc.mul(55.0), seed.add(2.0)));
  const mottle = mx_fractal_noise_float(vec3(pc.mul(0.9), seed.mul(0.3)), 3, 2.0, 0.5, 1.0);

  // height for the shading normal: veins sit in shallow grooves, papillae give a fine tooth
  const hE = 0.01;
  const heightAt = (q, vp) => pow(abs(sin(vp.mul(Math.PI))).oneMinus(), 6.0).mul(-0.6).add(mx_noise_float(vec3(q.mul(55.0), seed.add(2.0))).mul(0.12));
  const duu = hE / 3.0;
  const h0 = heightAt(pc, veinPhase);
  const hx = heightAt(pc.add(vec2(hE, 0)), veinPhase.add(duu * 46.0 / 1.0 * 0.15));
  const hy = heightAt(pc.add(vec2(0, hE)), veinPhase);
  const bump = normalize(vec3(h0.sub(hx).div(hE).mul(0.012), h0.sub(hy).div(hE).mul(0.012), 1.0));

  const edge = max(smoothstep(0.62, 1.0, au), smoothstep(0.82, 1.0, vv));
  let base = mix(color('#020a2c'), color('#1229a8'), smoothstep(0.0, 0.5, vv));
  base = mix(base, color('#2440d0'), edge.mul(0.45));
  base = mix(base, color('#5640f0'), pow(tP.oneMinus(), 1.6).mul(0.85));
  base = base.mul(mottle.mul(0.12).add(papillae.mul(0.05)).add(0.95));
  base = mix(base, base.mul(1.35).add(color('#2a2a9a').mul(0.08)), veins.mul(0.55));

  m.colorNode = base;
  m.normalNode = normalMap(bump.mul(0.5).add(0.5));
  m.roughnessNode = float(0.66);
  m.metalnessNode = float(0.0);
  m.specularIntensityNode = float(0.32);
  // velvet: strong grazing sheen from the papillae instead of a hard specular coat
  m.sheenNode = color('#8da4ff').mul(0.75);
  m.sheenRoughnessNode = float(0.5);

  // diffuse transmittance: a petal is several cell layers thick, so it passes a fraction of what it
  // reflects (more at the thin margins, less through the veins), filtered by its pigment
  const transmittance = base.mul(mix(0.15, 0.35, edge)).mul(veins.mul(-0.25).add(1.0));
  m.setupLightingModel = () => new ThinPetalLightingModel(transmittance, false, true);
  return m;
}
const roseMat = makeRoseMaterial();

/* ============================================================ hero rose */
const roseGroup = new THREE.Group();
roseGroup.rotation.set(0.07, 0.0, 0.05); // blooms upward, a slight natural lean
roseGroup.scale.setScalar(1.15);
scene.add(roseGroup);

const rose = buildRose({ seed: P.seed, N: 40, segU: 44, segV: 52 });
const roseMesh = new THREE.Mesh(rose.geometry, roseMat);
roseMesh.castShadow = true; roseMesh.receiveShadow = true;
roseGroup.add(roseMesh);

/* -------- receptacle (hip), sepals, flower stalk, stem, prickles and compound leaves */
// Botanical cards (leaflets, sepals, stipules) are real geometry shaped by folding, arching and
// curling, with outline, colour and a vein relief map drawn procedurally per organ.
function cardTextures(W, H, drawMask, drawColor, drawHeight, heightField) {
  const mk = (fill) => { const c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d', { willReadFrequently: true }); x.fillStyle = fill; x.fillRect(0, 0, W, H); x.lineCap = 'round'; x.lineJoin = 'round'; return [c, x]; };
  const [mc, mx] = mk('#000'); drawMask(mx);
  const [cc, cx] = mk('#000'); drawColor(cx);
  const [hc, hx] = mk('rgb(128,128,128)'); drawHeight(hx);
  const md = mx.getImageData(0, 0, W, H).data, cd = cx.getImageData(0, 0, W, H).data, hd = hx.getImageData(0, 0, W, H).data;
  const col = new Uint8Array(W * H * 4), nrm = new Uint8Array(W * H * 4);
  const hf = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) hf[y * W + x] = hd[(y * W + x) * 4] / 255 + (heightField ? heightField(x, y) : 0);
  const hAt = (x, y) => hf[Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i4 = (y * W + x) * 4;
    col[i4] = cd[i4]; col[i4 + 1] = cd[i4 + 1]; col[i4 + 2] = cd[i4 + 2]; col[i4 + 3] = md[i4];
    const gx = (hAt(x + 1, y) - hAt(x - 1, y)) * 3.0, gy = (hAt(x, y + 1) - hAt(x, y - 1)) * 3.0, l = Math.hypot(gx, gy, 1);
    nrm[i4] = (-gx / l * 0.5 + 0.5) * 255; nrm[i4 + 1] = (-gy / l * 0.5 + 0.5) * 255; nrm[i4 + 2] = (1 / l * 0.5 + 0.5) * 255; nrm[i4 + 3] = 255;
  }
  const tex = (data, srgb) => { const t = new THREE.DataTexture(data, W, H, THREE.RGBAFormat); t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.anisotropy = 8; t.needsUpdate = true; return t; };
  return { color: tex(col, true), normal: tex(nrm, false) };
}
// outline of a leaflet / sepal in card space: t along (0 base .. 1 tip), returns half-width (0..1)
const leafletHalfWidth = (t, teeth) => {
  let w = Math.pow(Math.sin(Math.PI * Math.min(1, Math.pow(t, 0.8))), 0.85) * (1 - 0.18 * t);
  if (t > 0.1 && t < 0.97) { const f = (t * teeth) % 1; w *= 1 - 0.07 * Math.pow(1 - f, 2.2) * sstep(0.1, 0.25, t); } // serration, teeth point to the tip
  return w;
};
// cellular (Worley F2-F1) field in pixels: the areoles between the finest veins
const areoles = (cell, seed) => (x, y) => {
  const cx = Math.floor(x / cell), cy = Math.floor(y / cell); let f1 = 1e9, f2 = 1e9;
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const gx = cx + i, gy = cy + j, h = Math.sin(gx * 127.1 + gy * 311.7 + seed) * 43758.5453, h2 = Math.sin(gx * 269.5 + gy * 183.3 + seed) * 43758.5453;
    const px = (gx + h - Math.floor(h)) * cell, py = (gy + h2 - Math.floor(h2)) * cell, d = Math.hypot(x - px, y - py);
    if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
  }
  return (f2 - f1) / cell;
};
// Leaflet maps. The upper face is dark and glossy with impressed veins, so each areole between the
// veinlets bulges slightly (a finely bullate blade); variant 1 is an older leaflet carrying a few
// black-spot lesions and a chewed margin.
const makeLeaflet = (variant) => {
  const W = 512, H = 1024, teeth = 24, r = rng(404 + variant * 31);
  const X = (u) => W / 2 + u * W * 0.47, Y = (t) => t * H;
  const outline = (ctx) => { ctx.beginPath(); for (let i = 0; i <= 200; i++) { const t = i / 200; ctx.lineTo(X(-leafletHalfWidth(t, teeth)), Y(t)); } for (let i = 200; i >= 0; i--) { const t = i / 200; ctx.lineTo(X(leafletHalfWidth(t, teeth)), Y(t)); } ctx.closePath(); };
  // pinnate, looping (brochidodromous) secondaries: leave the midrib at ~45 degrees, arch toward the tip
  // and join the next vein inside the margin
  const veins = [];
  for (let k = 0; k < 9; k++) {
    const t0 = 0.07 + k * 0.095;
    for (const s of [-1, 1]) {
      const pts = [];
      for (let i = 0; i <= 18; i++) { const f = i / 18; const t = t0 + f * 0.17 + f * f * 0.09; const u = s * leafletHalfWidth(Math.min(t, 0.99), 1e9) * 0.86 * Math.pow(f, 0.75); pts.push([u, Math.min(t, 0.985)]); }
      veins.push(pts);
    }
  }
  const stroke = (ctx, pts, w0, w1) => { for (let i = 1; i < pts.length; i++) { ctx.lineWidth = lerp(w0, w1, i / pts.length); ctx.beginPath(); ctx.moveTo(X(pts[i - 1][0]), Y(pts[i - 1][1])); ctx.lineTo(X(pts[i][0]), Y(pts[i][1])); ctx.stroke(); } };
  const midrib = Array.from({ length: 30 }, (_, i) => [0, i / 29 * 0.975]);
  const lesions = variant ? Array.from({ length: 3 }, () => [lerp(-0.5, 0.5, r()), lerp(0.25, 0.8, r()), lerp(14, 30, r())]) : [];
  const bite = variant ? [lerp(0.45, 0.65, r()), r() < 0.5 ? -1 : 1] : null;
  const cell = areoles(13, variant * 7.3);
  return cardTextures(W, H,
    (m) => {
      m.fillStyle = '#fff'; outline(m); m.fill();
      if (bite) { m.fillStyle = '#000'; const [t, s] = bite; for (let i = 0; i < 3; i++) { m.beginPath(); m.arc(X(s * (leafletHalfWidth(t, 1e9) + 0.02)), Y(t + (i - 1) * 0.035), 34 - i * 6, 0, 6.283); m.fill(); } }
    },
    (c) => {
      c.fillStyle = variant ? '#1e3a1b' : '#173619'; c.fillRect(0, 0, W, H);
      for (let n = 0; n < 2200; n++) { c.fillStyle = `rgba(${r() < 0.5 ? '38,74,32' : '14,34,16'},${lerp(0.05, 0.16, r())})`; c.beginPath(); c.arc(r() * W, r() * H, lerp(2, 16, r()), 0, 6.283); c.fill(); }
      c.save(); outline(c); c.lineWidth = 5; c.strokeStyle = 'rgba(95,38,34,0.3)'; c.stroke(); c.restore(); // anthocyanin at the teeth
      c.strokeStyle = 'rgba(120,150,78,0.42)'; stroke(c, midrib, 7, 2);
      c.strokeStyle = 'rgba(105,135,72,0.22)'; veins.forEach((v) => stroke(c, v, 2.4, 1.0));
      lesions.forEach(([u, t, R]) => { // black spot: dark feathered lesion inside a yellowing halo
        const x = X(u * leafletHalfWidth(t, 1e9)), y = Y(t);
        let g = c.createRadialGradient(x, y, R * 0.6, x, y, R * 2.4); g.addColorStop(0, 'rgba(120,120,40,0.45)'); g.addColorStop(1, 'rgba(120,120,40,0)'); c.fillStyle = g; c.beginPath(); c.arc(x, y, R * 2.4, 0, 6.283); c.fill();
        c.strokeStyle = 'rgba(12,10,8,0.8)'; c.lineWidth = 1.5;
        for (let k = 0; k < 40; k++) { const a = r() * 6.283, l = R * lerp(0.4, 1.1, r()); c.beginPath(); c.moveTo(x, y); c.quadraticCurveTo(x + Math.cos(a + 0.3) * l * 0.5, y + Math.sin(a + 0.3) * l * 0.5, x + Math.cos(a) * l, y + Math.sin(a) * l); c.stroke(); }
        c.fillStyle = 'rgba(10,8,6,0.85)'; c.beginPath(); c.arc(x, y, R * 0.45, 0, 6.283); c.fill();
      });
      if (bite) { const [t, s] = bite; c.strokeStyle = 'rgba(80,60,30,0.9)'; c.lineWidth = 6; for (let i = 0; i < 3; i++) { c.beginPath(); c.arc(X(s * (leafletHalfWidth(t, 1e9) + 0.02)), Y(t + (i - 1) * 0.035), 34 - i * 6 + 2, 0, 6.283); c.stroke(); } } // healed brown rim
    },
    (h) => { h.filter = 'blur(2px)'; h.strokeStyle = 'rgb(55,55,55)'; stroke(h, midrib, 10, 3); h.strokeStyle = 'rgb(80,80,80)'; veins.forEach((v) => stroke(h, v, 4, 1.5)); h.filter = 'none'; }, // veins impressed on the upper face
    (x, y) => 0.16 * sstep(0.0, 0.35, cell(x, y)));
};
const LEAFLETS = [makeLeaflet(0), makeLeaflet(1)];
// Sepals: lanceolate with a long attenuate point and a small leafy (spatulate) appendage at the tip;
// two of the five carry thread-like lateral lobes. Inner face grey-woolly, back green with glands.
const SEPAL = [false, true].map((pinnate) => {
  const W = 256, H = 1024, r = rng(pinnate ? 77 : 78);
  const X = (u) => W / 2 + u * W * 0.48, Y = (t) => t * H;
  const hw = (t) => 0.42 * Math.pow(1 - t, 0.9) + 0.1 * Math.exp(-Math.pow((t - 0.86) / 0.05, 2)) + 0.012; // half-width of the card (wid)
  const lobes = pinnate ? [0.26, 0.42, 0.56].map((t) => [t, lerp(0.12, 0.2, r()), lerp(0.75, 0.98, r())]) : [];
  const shape = (ctx) => {
    ctx.beginPath(); for (let i = 0; i <= 160; i++) { const t = i / 160; ctx.lineTo(X(-hw(t)), Y(t)); } for (let i = 160; i >= 0; i--) { const t = i / 160; ctx.lineTo(X(hw(t)), Y(t)); } ctx.closePath(); ctx.fill();
    lobes.forEach(([t, l, reach]) => { for (const s of [-1, 1]) { ctx.lineWidth = 7; ctx.beginPath(); ctx.moveTo(X(s * hw(t) * 0.7), Y(t)); ctx.quadraticCurveTo(X(s * (hw(t) + 0.3)), Y(t + 0.01), X(s * reach), Y(t + l)); ctx.stroke(); } });
  };
  return cardTextures(W, H,
    (m) => { m.fillStyle = m.strokeStyle = '#fff'; shape(m); },
    (c) => { c.fillStyle = '#21391d'; c.fillRect(0, 0, W, H); for (let n = 0; n < 1500; n++) { c.fillStyle = `rgba(${r() < 0.6 ? '70,32,28' : '45,85,40'},${lerp(0.1, 0.35, r())})`; c.beginPath(); c.arc(r() * W, r() * H, lerp(1, 3, r()), 0, 6.283); c.fill(); } }, // glandular dots
    (h) => { h.filter = 'blur(3px)'; h.strokeStyle = 'rgb(170,170,170)'; h.lineWidth = 8; h.beginPath(); h.moveTo(W / 2, 0); h.lineTo(W / 2, H); h.stroke(); h.filter = 'none'; });
});
// card geometry: x across [-wid/2, wid/2], y along [0, len], z off the card; shape(u, v, p) bends it
function cardGeometry(len, wid, segU, segV, shape) {
  const pos = [], uvs = [], idx = [], p = [0, 0, 0];
  for (let j = 0; j <= segV; j++) for (let i = 0; i <= segU; i++) {
    const u = i / segU * 2 - 1, v = j / segV;
    p[0] = u * wid / 2; p[1] = v * len; p[2] = 0; shape(u, v, p);
    pos.push(p[0], p[1], p[2]); uvs.push(i / segU, v);
  }
  for (let j = 0; j < segV; j++) for (let i = 0; i < segU; i++) { const a = j * (segU + 1) + i, b = a + 1, c = a + segU + 1, d = c + 1; idx.push(a, b, c, b, d, c); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx); g.computeVertexNormals(); g.computeTangents();
  return g;
}
// thin foliage: glossy cuticle above, paler matte underside, light transmitted through the blade
function foliageMaterial(tex, { upper, lower, transmit = 0.25, gloss = 0.5, roughness = [0.38, 0.7], woolly = null }) {
  const m = new THREE.MeshPhysicalNodeMaterial({ side: THREE.DoubleSide, alphaTest: 0.5 });
  const c = texture(tex.color, uv());
  const top = frontFacing;
  const base = c.rgb.mul(select(top, color(upper), color(lower)));
  m.colorNode = base;
  m.opacityNode = c.a;
  m.normalNode = normalMap(texture(tex.normal, uv()).rgb);
  m.roughnessNode = select(top, float(roughness[0]), float(roughness[1]));
  m.clearcoatNode = select(top, float(gloss), float(0.0));
  m.clearcoatRoughnessNode = float(0.3);
  m.specularIntensity = 0.3; // the cuticle is the clearcoat; beneath it the wet cell walls reflect weakly
  // a felt of fine hairs on one face scatters light back at grazing angles (sheen)
  if (woolly) { const felt = color('#c4cbbc').mul(0.9); m.sheenNode = woolly === 'upper' ? select(top, felt, color('#000000')) : select(top, color('#000000'), felt); m.sheenRoughnessNode = float(0.55); }
  m.setupLightingModel = () => new ThinPetalLightingModel(base.mul(transmit), true, !!woolly);
  return m;
}
const leafletMats = LEAFLETS.map((t) => foliageMaterial(t, { upper: '#ffffff', lower: '#b4c4a2', transmit: 0.22, gloss: 0.3, roughness: [0.5, 0.75] }));
const sepalMats = SEPAL.map((t) => foliageMaterial(t, { upper: '#a7b39c', lower: '#ffffff', transmit: 0.12, gloss: 0.0, roughness: [0.85, 0.55], woolly: 'upper' }));
const stemMat = new THREE.MeshPhysicalNodeMaterial();
{
  const n = mx_fractal_noise_float(positionLocal.mul(vec3(4.0, 0.6, 4.0)), 3, 2.0, 0.5, 1.0); // fine longitudinal striation
  const blush = smoothstep(0.1, 0.7, mx_noise_float(positionLocal.mul(0.35)));                // reddish anthocyanin patches
  stemMat.colorNode = mix(mix(color('#173a19'), color('#2c5a28'), n.mul(0.5).add(0.5)), color('#4a2a22'), blush.mul(0.55));
  stemMat.roughnessNode = float(0.4);
  stemMat.clearcoatNode = float(0.35); stemMat.clearcoatRoughnessNode = float(0.25); // waxy bloom
}
const prickleMat = new THREE.MeshPhysicalNodeMaterial();
prickleMat.colorNode = mix(color('#2f4a22'), color('#5a2a1c'), smoothstep(0.15, 0.8, uv().x)); // green base, red-brown point
prickleMat.roughnessNode = float(0.3); prickleMat.clearcoatNode = float(0.5);
const glandMat = new THREE.MeshPhysicalNodeMaterial();
glandMat.colorNode = color('#5c1f1a'); glandMat.roughnessNode = float(0.15); glandMat.clearcoatNode = float(1.0);
const glandStalkMat = new THREE.MeshStandardNodeMaterial();
glandStalkMat.colorNode = color('#3b5a2c'); glandStalkMat.roughnessNode = float(0.5);

// orient an object so local +y follows `along` and local +z leans toward `up`
const orient = (obj, along, up) => {
  const y = along.clone().normalize(), z = up.clone().addScaledVector(y, -up.dot(y)).normalize(), x = new THREE.Vector3().crossVectors(y, z);
  obj.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
};
{
  const rand = rng(P.seed + 909);
  // ---- hip: urn-shaped receptacle under the petals, narrowing into the flower stalk
  // ovoid: swells smoothly out of the pedicel, widest just under the rim, slightly necked at the disc
  const hipR = (s) => 0.21 + 0.64 * Math.pow(Math.sin(Math.PI / 2 * s), 1.5) * (1 - 0.07 * sstep(0.82, 1, s));
  const hipProfile = [];
  for (let i = 0; i <= 40; i++) { const s = i / 40; hipProfile.push(new THREE.Vector2(hipR(s), lerp(-2.1, -0.2, s))); }
  hipProfile.push(new THREE.Vector2(0.62, -0.05), new THREE.Vector2(0.001, -0.02));
  const hipMat = new THREE.MeshPhysicalNodeMaterial();
  {
    const n = mx_fractal_noise_float(positionLocal.mul(vec3(9.0, 2.5, 9.0)), 3, 2.0, 0.5, 1.0);
    const flush = smoothstep(-1.6, -0.4, positionLocal.y); // the shoulder under the sepals flushes red
    hipMat.colorNode = mix(mix(color('#1d3d1b'), color('#2e5527'), n.mul(0.5).add(0.5)), color('#47271f'), flush.mul(0.45));
    hipMat.roughnessNode = float(0.55);
    hipMat.sheenNode = color('#9fb0a0').mul(0.25); hipMat.sheenRoughnessNode = float(0.4); // faint glaucous bloom
  }
  const hip = new THREE.Mesh(new THREE.LatheGeometry(hipProfile, 48), hipMat);
  hip.castShadow = hip.receiveShadow = true; roseGroup.add(hip);

  // ---- sepals: five, attached at the rim of the hip, reflexed down and back, margins curled in
  for (let i = 0; i < 5; i++) {
    const az = i * 1.2566 + 0.4 + (rand() - 0.5) * 0.25;
    const pinnate = i === 0 || i === 2; // two of five carry lateral lobes (the rose "riddle" of sepals)
    const len = lerp(2.4, 3.0, rand()), wid = 1.1;
    const pitch0 = lerp(0.15, 0.35, rand()), pitch1 = lerp(1.7, 2.2, rand()), bow = (rand() - 0.5) * 0.5;
    const geo = cardGeometry(len, wid, 14, 48, (u, v, p) => {
      // integrate the reflexing midline: leaves the rim near horizontal, turns down, the tip curls back
      const steps = 32; let y = 0, z = 0;
      for (let k = 0; k < steps * v; k++) { const th = lerp(pitch0, pitch1, Math.pow(k / steps, 1.4)); y += Math.cos(th) * len / steps; z -= Math.sin(th) * len / steps; }
      const x = p[0], body = 0.21 * wid * Math.pow(1 - v, 0.9) + 0.01; // half-width of the blade (the mask's outline)
      p[0] = x + bow * v * v;
      p[1] = y; p[2] = z + 0.35 * Math.pow(Math.min(1, Math.abs(x) / body), 2) * body; // channelled: margins rolled toward the inner face
    });
    const sepal = new THREE.Mesh(geo, sepalMats[pinnate ? 1 : 0]);
    const out = V3(Math.cos(az), 0, Math.sin(az));
    sepal.position.set(out.x * 0.8, -0.32, out.z * 0.8);
    orient(sepal, out, V3(0, 1, 0));
    sepal.castShadow = sepal.receiveShadow = true;
    roseGroup.add(sepal);
  }

  // ---- flower stalk (glandular) and stem (prickly)
  const stalkPts = [V3(0, -2.05, 0), V3(0.12, -4.5, 0.15), V3(0.35, -7.0, 0.45), V3(0.45, -9.0, 0.6)];
  const stemPts = [V3(0.45, -9.0, 0.6), V3(0.3, -14, 1.1), V3(0.7, -20, 1.5), V3(0.55, -27, 2.1), V3(1.0, -34, 2.6)];
  const stalk = new THREE.Mesh(taperTube(stalkPts, 0.2, 0.24, 64, 12), stemMat);
  const stem = new THREE.Mesh(taperTube(stemPts, 0.28, 0.4, 120, 14), stemMat);
  const nodeKnot = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 12), stemMat); nodeKnot.position.copy(stalkPts[3]); nodeKnot.scale.set(1, 1.3, 1);
  [stalk, stem, nodeKnot].forEach((m) => { m.castShadow = m.receiveShadow = true; roseGroup.add(m); });
  const stalkCurve = new THREE.CatmullRomCurve3(stalkPts, false, 'centripetal'), stemCurve = new THREE.CatmullRomCurve3(stemPts, false, 'centripetal');

  // stalked glands on the flower stalk and the base of the hip
  const glandStalk = new THREE.CylinderGeometry(0.004, 0.006, 1, 4, 1, true); glandStalk.translate(0, 0.5, 0);
  const glandHead = new THREE.SphereGeometry(1, 8, 6);
  const gS = [], gH = [];
  const addGland = (p, n, lenScale = 1) => {
    const len = lerp(0.025, 0.07, rand()) * lenScale;
    const q = new THREE.Quaternion().setFromUnitVectors(V3(0, 1, 0), n.clone().add(V3(rand() - 0.5, rand() - 0.5, rand() - 0.5).multiplyScalar(0.5)).normalize());
    gS.push(new THREE.Matrix4().compose(p, q, V3(1, len, 1)));
    gH.push(new THREE.Matrix4().compose(p.clone().add(V3(0, len, 0).applyQuaternion(q)), q, V3(0.012, 0.012, 0.012)));
  };
  for (let i = 0; i < 520; i++) { // densest just below the hip, thinning down the stalk
    const t = Math.pow(rand(), 1.6), a = rand() * 6.283, c = stalkCurve.getPointAt(t), tg = stalkCurve.getTangentAt(t);
    const n = V3(Math.cos(a), 0, Math.sin(a)); n.addScaledVector(tg, -n.dot(tg)).normalize();
    addGland(c.clone().addScaledVector(n, lerp(0.2, 0.24, t)), n);
  }
  for (let i = 0; i < 140; i++) { // scattered over the lower hip, by surface area, shorter
    const s = Math.sqrt(rand()) * 0.6, a = rand() * 6.283, y = lerp(-2.1, -0.2, s), r = hipR(s);
    const slope = (hipR(s + 0.01) - r) / (0.019);
    addGland(V3(Math.cos(a) * r, y, Math.sin(a) * r), V3(Math.cos(a), -slope, Math.sin(a)).normalize(), 0.6);
  }
  const glandStalks = new THREE.InstancedMesh(glandStalk, glandStalkMat, gS.length); gS.forEach((m, i) => glandStalks.setMatrixAt(i, m));
  const glandHeads = new THREE.InstancedMesh(glandHead, glandMat, gH.length); gH.forEach((m, i) => glandHeads.setMatrixAt(i, m));
  roseGroup.add(glandStalks, glandHeads);

  // hooked prickles: broad flattened base along the stem, curving down to a point
  const prickleGeo = taperTube([V3(0, 0, 0), V3(0.2, -0.04, 0), V3(0.32, -0.16, 0), V3(0.37, -0.3, 0)], 0.1, 0.004, 24, 8);
  prickleGeo.scale(1, 1.7, 0.6); // elongated along the stem, flattened sideways
  const pM = [];
  for (let i = 0; i < 30; i++) {
    const t = lerp(0.04, 0.96, (i + rand() * 0.6) / 30), a = rand() * 6.283;
    const c = stemCurve.getPointAt(t), tg = stemCurve.getTangentAt(t);
    const out = V3(Math.cos(a), 0, Math.sin(a)); out.addScaledVector(tg, -out.dot(tg)).normalize();
    const r = lerp(0.28, 0.4, t), s = lerp(0.7, 1.2, rand());
    const basis = new THREE.Matrix4().makeBasis(out, tg.clone().negate(), new THREE.Vector3().crossVectors(out, tg.clone().negate()));
    pM.push(new THREE.Matrix4().compose(c.clone().addScaledVector(out, r * 0.9), new THREE.Quaternion().setFromRotationMatrix(basis), V3(s, s, s)));
  }
  const prickles = new THREE.InstancedMesh(prickleGeo, prickleMat, pM.length); pM.forEach((m, i) => prickles.setMatrixAt(i, m));
  prickles.castShadow = true; roseGroup.add(prickles);

  // ---- compound leaves: petiole + rachis, stipules at the base, odd-pinnate serrated leaflets
  // A leaflet is arched along the midrib, folded slightly into a V, its margin gently undulating
  // (the blade grows faster at the edge than along the midrib), twisted toward the tip.
  const leafletGeo = (len, wid, droop, fold, twist, wave) => cardGeometry(len, wid, 16, 32, (u, v, p) => {
    const x = p[0], arch = -droop * len * v * v;
    const folded = Math.abs(x) * Math.tan(fold);
    const ripple = wave.a * Math.pow(Math.abs(u), 2) * Math.sin(v * wave.k + wave.ph + (u > 0 ? 0 : 1.7)) * wid;
    const tw = twist * v, cs = Math.cos(tw), sn = Math.sin(tw);
    p[0] = x * cs - folded * sn; p[2] = arch + ripple + x * sn + folded * cs;
  });
  const rachisPrickle = taperTube([V3(0, 0, 0), V3(0, -0.06, 0.02), V3(0, -0.1, 0.07)], 0.025, 0.002, 8, 5);
  function compoundLeaf(pairs, s) {
    const g = new THREE.Group();
    const L = (pairs + 1) * 1.55 * s; // rachis length: leaflet pairs sit about half a leaflet apart
    const rachisPts = [V3(0, 0, 0), V3(0, 0.35 * s, 0.25 * L), V3(0, 0.45 * s, 0.55 * L), V3(0, 0.25 * s, 0.82 * L), V3(0, -0.05 * s, L)];
    const rachisCurve = new THREE.CatmullRomCurve3(rachisPts, false, 'centripetal');
    const rachis = new THREE.Mesh(taperTube(rachisPts, 0.065 * s, 0.03 * s, 48, 7), stemMat);
    rachis.castShadow = true; g.add(rachis);
    // small hooked prickles on the underside of the petiole and rachis
    const pr = new THREE.InstancedMesh(rachisPrickle, prickleMat, 4);
    for (let i = 0; i < 4; i++) {
      const t = 0.08 + i * 0.2 + rand() * 0.05, c = rachisCurve.getPointAt(t), tg = rachisCurve.getTangentAt(t);
      pr.setMatrixAt(i, new THREE.Matrix4().compose(c.clone().add(V3(0, -0.05 * s, 0)), new THREE.Quaternion().setFromUnitVectors(V3(0, 0, 1), tg), V3(s, s, s)));
    }
    g.add(pr);
    // stipules: narrow wings fused along the petiole, free pointed auricles at their tips
    for (const sd of [-1, 1]) {
      const st = new THREE.Mesh(cardGeometry(0.9 * s, 0.22 * s, 6, 14, (u, v, p) => { p[0] += sd * v * v * 0.12 * s; p[2] = Math.abs(u) * 0.03 * s + v * v * 0.1 * s; }), leafletMats[0]);
      st.position.set(sd * 0.06 * s, 0.03 * s, 0.05 * s);
      orient(st, V3(sd * 0.12, 0.12, 1), V3(sd * 0.5, 1, 0));
      st.castShadow = true; g.add(st);
    }
    const place = (t, side, size) => {
      const c = rachisCurve.getPointAt(t), tg = rachisCurve.getTangentAt(t);
      // laterals spread ~55-70 degrees from the rachis and nod outward; the terminal continues the rachis
      const dir = side === 0 ? tg.clone().add(V3(0, -0.05, 0)).normalize() : tg.clone().applyAxisAngle(V3(0, 1, 0), side * lerp(0.95, 1.2, rand())).add(V3(0, lerp(-0.05, 0.1, rand()), 0)).normalize();
      const roll = side * lerp(0.15, 0.35, rand());
      const up = V3(0, 1, 0).applyAxisAngle(dir, roll);
      const wave = { a: lerp(0.015, 0.035, rand()), k: lerp(9, 14, rand()), ph: rand() * 6.283 };
      const lf = new THREE.Mesh(leafletGeo(3.3 * s * size, 2.0 * s * size, lerp(0.1, 0.2, rand()), lerp(0.14, 0.28, rand()), (rand() - 0.5) * 0.35, wave), leafletMats[rand() < 0.3 ? 1 : 0]);
      lf.position.copy(c).addScaledVector(dir, (side === 0 ? 0.35 : 0.06) * s); // terminal leaflet on a short petiolule, laterals nearly sessile
      orient(lf, dir, up);
      lf.castShadow = lf.receiveShadow = true; g.add(lf);
    };
    for (let k = 0; k < pairs; k++) {
      const t = (k + 0.85) / (pairs + 0.85), size = lerp(0.72, 0.92, pairs > 1 ? k / (pairs - 1) : 1);
      place(t, -1, size * lerp(0.95, 1.05, rand())); place(t + 0.02, 1, size * lerp(0.95, 1.05, rand()));
    }
    place(1.0, 0, 1.0); // terminal leaflet
    return g;
  }
  [[stalkCurve, 0.98, 1, 0.75, 0.6], [stemCurve, 0.22, 2, 1.0, 3.0], [stemCurve, 0.55, 2, 1.05, 0.7]].forEach(([curve, t, pairs, s, az]) => {
    const leaf = compoundLeaf(pairs, s);
    const c = curve.getPointAt(Math.min(t, 1)), tg = curve.getTangentAt(Math.min(t, 1));
    const out = V3(Math.cos(az), 0, Math.sin(az)); out.addScaledVector(tg, -out.dot(tg)).normalize();
    leaf.position.copy(c).addScaledVector(out, 0.2);
    // leaf axis: out from the stem and rising, its upper face toward the sky
    const axis = out.clone().multiplyScalar(0.8).add(V3(0, 0.55, 0)).normalize();
    const m = new THREE.Matrix4().lookAt(V3(0, 0, 0), axis, V3(0, 1, 0));
    leaf.quaternion.setFromRotationMatrix(m);
    leaf.rotateY(Math.PI);
    roseGroup.add(leaf);
  });
}

/* ============================================================ dew: real droplets */
// Every glint on the rose is an actual water droplet. Droplets are scattered by surface area,
// favour surfaces that can hold water (facing up) and bead along the rolled rims. Tiny and small
// droplets use an opaque water shader (sharp specular + environment + the focused caustic a lens
// throws on its shadow side); medium and large ones are true transmissive refractors.
roseGroup.updateMatrixWorld(true);
const roseInv = new THREE.Matrix4().copy(roseGroup.matrixWorld).invert();
const localUp = V3(0, 1, 0).transformDirection(roseInv);
{
  const rand = rng(P.seed + 5);
  const PA = rose.geometry.attributes.position.array, NA = rose.geometry.attributes.normal.array;
  const vA = V3(), vB = V3(), vC = V3(), nQ = V3();
  const quads = []; let total = 0;
  for (const p of rose.petals) {
    if (p.t < 0.12) continue;
    for (let jv = 0; jv < p.segV; jv++) for (let iu = 0; iu < p.segU; iu++) {
      const a = p.base + jv * (p.segU + 1) + iu, b = a + 1, c = a + p.segU + 1;
      vA.fromArray(PA, a * 3); vB.fromArray(PA, b * 3).sub(vA); vC.fromArray(PA, c * 3).sub(vA);
      const area = vB.clone().cross(vC).length();
      nQ.fromArray(NA, a * 3);
      const holds = 0.12 + 0.88 * sstep(0.12, 0.7, Math.abs(nQ.dot(localUp)));
      total += area * holds * (0.55 + 0.9 * jv / p.segV);
      quads.push(total, p, iu, jv);
    }
  }
  const nQuads = quads.length / 4;
  const pickSurface = () => {
    const r = rand() * total; let lo = 0, hi = nQuads - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (quads[m * 4] < r) lo = m + 1; else hi = m; }
    const p = quads[lo * 4 + 1], iu = quads[lo * 4 + 2], jv = quads[lo * 4 + 3];
    return petalSample(rose, p, ((iu + rand()) / p.segU) * 2 - 1, (jv + rand()) / p.segV);
  };
  const rimPetals = rose.petals.filter((p) => p.t >= 0.15);
  const pickRim = () => {
    const p = rimPetals[Math.floor(rand() * rimPetals.length)];
    const k = rand();
    // margins (u = +-1) from mid-petal up, and across the tip (v = 1)
    if (k < 0.8) return petalSample(rose, p, (rand() < 0.5 ? -1 : 1) * lerp(0.95, 0.995, rand()), lerp(0.35, 0.99, Math.pow(rand(), 0.7)));
    return petalSample(rose, p, (rand() * 2 - 1) * 0.6, lerp(0.97, 0.995, rand()));
  };
  const q = new THREE.Quaternion(), sc = V3(), yUp = V3(0, 1, 0);
  const place = (list, { pos, nor }, r) => {
    const n = nor.clone(); if (n.dot(localUp) < 0) n.negate();
    const flat = lerp(0.62, 0.8, rand()); // contact angle: larger, flatter puddles sag more
    q.setFromUnitVectors(yUp, n).multiply(new THREE.Quaternion().setFromAxisAngle(yUp, rand() * 6.283));
    sc.set(r * lerp(0.92, 1.08, rand()), r * flat, r);
    list.push(new THREE.Matrix4().compose(pos.clone().addScaledVector(n, r * flat * 0.32), q, sc));
  };
  const tiny = [], small = [], refractive = [];
  for (let i = 0; i < 15000; i++) place(tiny, pickSurface(), lerp(0.008, 0.022, Math.pow(rand(), 1.6)));
  for (let i = 0; i < 3800; i++) place(small, pickRim(), lerp(0.014, 0.05, Math.pow(rand(), 1.8)));
  for (let i = 0; i < 2600; i++) place(small, pickSurface(), lerp(0.024, 0.06, Math.pow(rand(), 1.5)));
  for (let i = 0; i < 420; i++) place(refractive, pickSurface(), lerp(0.07, 0.14, Math.pow(rand(), 1.4)));
  for (let i = 0; i < 70; i++) place(refractive, pickSurface(), lerp(0.16, 0.3, rand()));

  // droplets refract the lit petal beneath them (screen-space transmission), add a sharp specular
  // highlight per light and, for the smallest, a slightly broadened lobe so it survives at pixel size
  const dropMat = (rough) => new THREE.MeshPhysicalNodeMaterial({
    color: 0xffffff, metalness: 0, roughness: rough, transmission: 1, ior: 1.333, thickness: 0.06,
    specularIntensity: 1, envMapIntensity: 2.2, clearcoat: 1, clearcoatRoughness: rough * 0.5,
  });
  const water = dropMat(0.09), refractor = dropMat(0.015);
  const instanced = (geo, mat, list) => {
    const im = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((mm, i) => im.setMatrixAt(i, mm));
    im.receiveShadow = true;
    roseGroup.add(im);
  };
  instanced(new THREE.IcosahedronGeometry(1, 1), water, tiny);
  instanced(new THREE.SphereGeometry(1, 14, 10), water, small);
  instanced(new THREE.SphereGeometry(1, 28, 20), refractor, refractive);
}

return {
  rose, roseMesh, roseGroup,
  get cameraBounds() { return cameraBounds; },
  createHero() {
const roseCenter = V3(0, 2.4, 0).applyMatrix4(roseGroup.matrixWorld);
// Hero framing is anchored to the reference photograph: the rose crown sits at (0.63, 0.55)
// of the frame and the butterfly's feet at (0.414, 0.497), viewed ~38 degrees from above.
const HERO = { pos: roseCenter.clone().addScaledVector(V3(-0.4, 0.78, 0.66).normalize(), 23.5), target: roseCenter.clone(), fov: 30 };
{
  const cam = new THREE.PerspectiveCamera(HERO.fov, 4 / 3, 0.5, 600);
  cam.position.copy(HERO.pos);
  for (let it = 0; it < 40; it++) {
    cam.lookAt(HERO.target); cam.updateMatrixWorld();
    const p = roseCenter.clone().project(cam);
    const ex = (p.x * 0.5 + 0.5) - 0.63, ey = (0.5 - p.y * 0.5) - 0.58;
    const right = V3(1, 0, 0).transformDirection(cam.matrixWorld), up = V3(0, 1, 0).transformDirection(cam.matrixWorld);
    const k = HERO.pos.distanceTo(HERO.target) * Math.tan(HERO.fov * D2R / 2) * 2;
    HERO.target.addScaledVector(right, ex * k * 4 / 3).addScaledVector(up, -ey * k);
  }
  cam.lookAt(HERO.target); cam.updateMatrixWorld();
  HERO.cam = cam;
}

    return { perchCenter: roseCenter, hero: HERO };
  },
  async setupStage({ hero: HERO, raycaster, bfly, dustMoon, spriteCloud }) {
    const roseCenter = V3(0, 2.4, 0).applyMatrix4(roseGroup.matrixWorld);
/* ============================================================ cave */
const texLoader = new THREE.TextureLoader();
const loadTex = (url, srgb) => { const t = texLoader.load(url); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; if (srgb) t.colorSpace = THREE.SRGBColorSpace; return t; };
const rockBase = loadTex(resolveAsset('assets/rock-basecolor.jpg'), true);
const rockNormal = loadTex(resolveAsset('assets/rock-normal.jpg'), false);
const rockRough = loadTex(resolveAsset('assets/rock-roughness.jpg'), false);
function rockMaterial(rep) {
  const m = new THREE.MeshStandardNodeMaterial({ side: THREE.BackSide });
  const tuv = uv().mul(rep);
  const wet = smoothstep(0.1, 0.6, mx_fractal_noise_float(positionWorld.mul(0.04), 3, 2.0, 0.5, 1.0));
  m.colorNode = texture(rockBase, tuv).rgb.mul(color('#3c4c78')).mul(mix(0.75, 0.45, wet));
  m.normalNode = normalMap(texture(rockNormal, tuv), vec2(1.4, 1.4));
  m.roughnessNode = texture(rockRough, tuv).r.mul(mix(0.95, 0.35, wet));
  return m;
}
function noisyBlob(radius, wSeg, hSeg, amp, seed) {
  const g = new THREE.SphereGeometry(radius, wSeg, hSeg);
  const r = rng(seed); const dirs = [];
  for (let i = 0; i < 9; i++) dirs.push([V3(r() * 2 - 1, r() * 2 - 1, r() * 2 - 1).normalize(), lerp(1.5, 7, r()), r() * 6.28, lerp(0.3, 1, r())]);
  const p = g.attributes.position, v = V3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i); const n = v.clone().normalize();
    let d = 0; for (const [dd, f, ph, a] of dirs) d += Math.sin(n.dot(dd) * f + ph) * a / f;
    v.addScaledVector(n, d * amp); p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}
const cave = new THREE.Mesh(noisyBlob(95, 160, 100, 22, 4), rockMaterial(vec2(10, 5)));
cave.position.set(0, 28, -18);
cave.receiveShadow = true;
scene.add(cave);
const mound = new THREE.Mesh(noisyBlob(24, 96, 64, 6, 9), (() => { const m = rockMaterial(vec2(5, 3)); m.side = THREE.FrontSide; return m; })());
mound.position.set(2, -52, 0); mound.receiveShadow = true;
scene.add(mound);
cameraBounds = { cave, mound };

/* -------- companion roses, out of focus */
// placed along rays of the hero camera so they land where the reference shows soft blue shapes
[[0.95, 0.15, 70, 1.6, 3], [1.06, 0.5, 52, 1.2, 8], [-0.04, 0.42, 64, 1.4, 13], [0.02, 0.97, 44, 1.1, 21], [0.6, -0.06, 95, 1.8, 34]].forEach(([sx, sy, dist, sc, seed]) => {
  const r = buildRose({ seed: P.seed + seed * 31, N: 30, segU: 18, segV: 20 });
  const m = new THREE.Mesh(r.geometry, roseMat);
  raycaster.setFromCamera(new THREE.Vector2(sx * 2 - 1, 1 - sy * 2), HERO.cam);
  m.position.copy(raycaster.ray.origin).addScaledVector(raycaster.ray.direction, dist);
  const toCam = HERO.pos.clone().sub(m.position).normalize().lerp(V3(0, 1, 0), 0.45).normalize();
  m.quaternion.setFromUnitVectors(V3(0, 1, 0), toCam);
  m.rotateY(seed);
  m.scale.setScalar(sc);
  m.castShadow = m.receiveShadow = true; // petals shade each other on every rose
  scene.add(m);
});

/* ============================================================ light sources, glowworms, spores */
const wallHit = (dir) => { raycaster.set(roseCenter, dir); const h = raycaster.intersectObject(cave, false)[0]; return h ? h.point : null; };

// Key and rim are moved onto the cave wall along their original directions (keeping the irradiance
// they deliver at the rose) and given visible emitters sized so that radiance x area = intensity:
// a disc with a (1 - r^2) radiance profile has mean radiance L/2, so I = (L/2)·pi·R^2.
function placeSource(light, radius, speckled) {
  const dir = light.position.clone().sub(roseCenter).normalize();
  const dOld = light.position.distanceTo(roseCenter);
  const hit = wallHit(dir);
  const dNew = hit.distanceTo(roseCenter) - 1.0;
  light.position.copy(roseCenter).addScaledVector(dir, dNew);
  light.intensity *= (dNew / dOld) ** 2;
  light.userData.sourceRadius = radius;
  if (light.shadow) light.shadow.camera.far = dNew + 40;
  const L = 2 * light.intensity / (Math.PI * radius * radius);
  const m = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
  const rr = length(uv().sub(0.5)).mul(2.0);
  let radiance = color(light.color).mul(L).mul(saturate(rr.mul(rr).oneMinus()));
  // a colony is clumpy; the clumping is normalised to mean 1 so the emitted total is unchanged
  if (speckled) radiance = radiance.mul(mx_fractal_noise_float(vec3(uv().mul(14.0), 3.0), 3, 2.0, 0.5, 1.0).mul(0.9).add(1.0));
  const disc = new THREE.Mesh(new THREE.CircleGeometry(radius, 64), m);
  disc.position.copy(hit).addScaledVector(dir, -0.6);
  disc.lookAt(roseCenter);
  scene.add(disc);
}
placeSource(key, 10, false);   // moonlit opening in the roof
placeSource(rim, 24, true);    // glowworm colony on the back wall
const moonAtRose = () => { const d = key.position.clone().sub(roseCenter); return { dir: d.clone().normalize(), E: key.intensity / d.lengthSq() }; };
{ const m = moonAtRose(); dustMoon.dir.value.copy(m.dir); dustMoon.col.value.set(key.color.r, key.color.g, key.color.b).multiplyScalar(m.E); }
{
  const r = rng(3141);
  const worms = [];
  const colonyDir = rim.position.clone().sub(roseCenter).normalize();
  for (let i = 0; i < 2000 && worms.length < 420; i++) {
    // denser around the colony, sparse elsewhere on the walls and roof
    const dir = r() < 0.35 ? colonyDir.clone().add(V3(r() - 0.5, r() - 0.5, r() - 0.5).multiplyScalar(0.7)).normalize()
                           : V3(r() * 2 - 1, r() * 1.3 - 0.25, r() * 2 - 1).normalize();
    const hit = wallHit(dir); if (!hit) continue;
    const warm = r() < 0.07;
    const c = warm ? new THREE.Color(1.0, 0.62, 0.28) : new THREE.Color().setHSL(lerp(0.55, 0.62, r()), 0.9, 0.5);
    worms.push({ p: hit.addScaledVector(dir, -0.2), c: c.multiplyScalar(lerp(8, 40, Math.pow(r(), 2))), s: lerp(0.1, 0.25, r()) });
  }
  scene.add(spriteCloud(worms));
  // airborne dust and pollen around the flower: colour = albedo (pale, slightly warm), lit by the scene
  // (fluff and pollen clumps, 0.3 - 1.2 mm), most of it in the air around the butterfly, some further out
  const dust = [], bc = bfly.position.clone().add(V3(0, 2.5, 0));
  for (let i = 0; i < 320; i++) {
    const near = r() < 0.65;
    const p = near ? bc.clone().add(V3(r() * 2 - 1, r() * 2 - 1, r() * 2 - 1).normalize().multiplyScalar(lerp(1.0, 8.0, Math.pow(r(), 0.7))))
                   : V3(lerp(-16, 14, r()), lerp(-3, 14, r()), lerp(-14, 12, r()));
    dust.push({ p, c: new THREE.Color(0.85, 0.8, 0.7).multiplyScalar(lerp(0.7, 1.0, r())), s: lerp(0.03, 0.12, Math.pow(r(), 2.0)) });
  }
  scene.add(spriteCloud(dust, { drift: 1.2, scatter: true }));
}

// Reflections come from the cave itself: a radiance probe of the surroundings captured at the rose
// (rose and butterfly hidden, so they do not reflect themselves into it).
{
  roseGroup.visible = false; bfly.visible = false;
  const probe = new THREE.PMREMGenerator(renderer).fromScene(scene, 0.0, 0.5, 400, { position: roseCenter, size: 256 });
  scene.environment = probe.texture;
  roseGroup.visible = true; bfly.visible = true;
}

  },
};
}
