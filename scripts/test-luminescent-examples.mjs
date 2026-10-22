import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build, transform } from 'esbuild';
import { Vector3 } from 'three';
import { BackSide, Mesh, MeshBasicMaterial, PerspectiveCamera, SphereGeometry } from 'three/webgpu';
import { taperTube } from '../skills/threejs-procedural-materials/examples/luminescent-butterfly/luminescent-butterfly.js';
import { waterCameraFloor } from '../example-gallery/examples/threejs-water-optics/luminescent-water/camera-bounds.js';
import { constrainButterflyCamera } from '../example-gallery/examples/threejs-procedural-materials/luminescent-butterfly/camera-bounds.js';
import { inspectionRuntimeDocument, INSPECTION_THREE_PACKAGES } from '../example-gallery/runtime/renderer-imports.mjs';
import { discoverExamples } from '../example-gallery/discovery.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const fixture = JSON.parse(await readFile(path.join(root, 'source_materials/luminescent-parity.json'), 'utf8'));
assert.equal(fixture.schemaVersion, 1);

// Digests record the accepted intake arithmetic. No local intake files are needed.
for (const region of fixture.regions) {
  const text = await readFile(path.join(root, region.file), 'utf8');
  const start = text.indexOf(region.start);
  const end = text.indexOf(region.end, start + region.start.length);
  assert.ok(start >= 0 && end > start, `${region.name}: missing mechanism boundaries`);
  let code = text.slice(start, end);
  if (region.trimEnd) {
    assert.ok(code.trimEnd().endsWith(region.trimEnd), `${region.name}: invalid terminal boundary`);
    code = code.trimEnd().slice(0, -region.trimEnd.length);
  }
  const canonical = (await transform(code, {
    loader: 'js', format: 'esm', minifyWhitespace: true, legalComments: 'none',
  })).code;
  assert.equal(createHash('sha256').update(canonical).digest('hex'), region.sha256, region.name);
}

const examples = [
  ['threejs-water-optics', 'luminescent-water'],
  ['threejs-procedural-materials', 'simulated-paper-burning'],
  ['threejs-procedural-materials', 'luminescent-jellyfish'],
  ['threejs-procedural-materials', 'luminescent-butterfly'],
];
const rootImports = {
  name: 'gallery-absolute-imports',
  setup(builder) {
    builder.onResolve({ filter: /^\/skills\// }, args => ({ path: path.join(root, args.path.slice(1)) }));
  },
};
const effectBundles = new Map();
const discovered = await discoverExamples(root);
const runtimeTemplate = await readFile(path.join(root, 'example-gallery/runtime/index.html'), 'utf8');
for (const [skill, slug] of examples) {
  const effect = path.join(root, 'skills', skill, 'examples', slug, `${slug}.js`);
  const adapter = path.join(root, 'example-gallery/examples', skill, slug, 'scene.js');
  const metadata = JSON.parse(await readFile(path.join(path.dirname(adapter), 'example.json'), 'utf8'));
  const alias = metadata.threePackage;
  const rendererImports = {
    name: 'exact-renderer-revision',
    setup(builder) {
      builder.onResolve({ filter: /^three(?:\/.*)?$/ }, args => ({
        path: require.resolve(args.path === 'three' ? `${alias}/webgpu` : alias + args.path.slice(5)),
      }));
    },
  };
  const linked = await build({ entryPoints: [effect, adapter], bundle: true, write: false,
    outdir: '/unused', platform: 'browser', format: 'esm', plugins: [rootImports, rendererImports], logLevel: 'silent' });
  effectBundles.set(slug, linked.outputFiles.find(file => path.basename(file.path) === `${slug}.js`).text);
  const runtimeDocument = inspectionRuntimeDocument(runtimeTemplate, alias);
  assert.ok(!runtimeDocument.includes('/node_modules/three/'), `${slug}: host and effect must share one renderer revision`);
  assert.ok(runtimeDocument.includes(`"three": "/node_modules/${alias}/build/three.webgpu.js"`));
  const installed = JSON.parse(await readFile(path.join(root, 'node_modules', alias, 'package.json'), 'utf8'));
  assert.equal(installed.version, INSPECTION_THREE_PACKAGES[alias]);
  const item = discovered.find(item => item.id === `${skill}/${slug}`);
  assert.equal(item.threePackage, alias);
  const text = await readFile(effect, 'utf8');
  assert.ok(!/source_materials|new THREE\.(?:WebGPU|WebGL)Renderer|setAnimationLoop|requestAnimationFrame|innerWidth|innerHeight|AudioContext|\.mp3/.test(text), `${slug}: effect boundary`);
  const scene = await readFile(adapter, 'utf8');
  assert.ok(!/AudioContext|\.mp3|\.innerHTML|createElement\(['"](?:button|div|pre)['"]\)/.test(scene), `${slug}: scene only`);
  assert.deepEqual(metadata.controls, [], `${slug}: no scene control UI`);
  assert.deepEqual(metadata.debugModes, [], `${slug}: diagnostics do not add UI`);
}

// Execute the public constructors and first-frame orchestration with real Three
// objects, but a recording renderer. This catches runtime API/initialization
// errors that export linking cannot catch, without creating a browser or GPU.
function recordingRenderer(three) {
  const draws = [];
  let target = null, mrt = null;
  return {
    draws, toneMapping: three.AgXToneMapping, outputColorSpace: three.SRGBColorSpace,
    xr: { enabled: false }, autoClear: false,
    compute() {}, async computeAsync() {},
    getArrayBufferAsync() { throw new Error('Water startup/navigation must not read simulation buffers'); },
    setRenderTarget(value) { target = value; },
    setMRT(value) { mrt = value; },
    setClearColor() {}, setScissorTest() {}, clear() {},
    render(object) { draws.push({ object, target, mrt }); },
  };
}
async function bundledEffect(slug) {
  return import(`data:text/javascript;base64,${Buffer.from(effectBundles.get(slug)).toString('base64')}`);
}
{
  const three = await import('three-0186/webgpu');
  const { createLuminescentJellyfish } = await bundledEffect('luminescent-jellyfish');
  const renderer = recordingRenderer(three);
  const camera = new three.PerspectiveCamera(40, 16 / 9, 0.05, 600);
  const pivot = new three.Vector3(0.05, 0.1, -7.6);
  camera.lookAt(pivot); camera.updateMatrixWorld();
  const animals = await createLuminescentJellyfish({ renderer, camera });
  animals.resize({ bufferWidth: 960, bufferHeight: 540 });
  animals.update(0, pivot);
  animals.render();
  const layers = renderer.draws.filter(draw => draw.mrt?.getClearColor('aux'));
  assert.ok(layers.length > 0, 'first frame includes tissue layers');
  assert.ok(layers.every(draw => draw.mrt.getClearColor('aux').a === 0), 'empty optical depth clears to zero');
  animals.dispose();
}
{
  const three = await import('three-0180/webgpu');
  const { createLuminescentWater } = await bundledEffect('luminescent-water');
  const renderer = recordingRenderer(three);
  const scene = new three.Scene();
  const camera = new three.PerspectiveCamera(42, 16 / 9, 0.02, 80);
  camera.position.set(5.8, 2.05, 1.6);
  camera.lookAt(5.42, -0.1, 3.1); camera.updateMatrixWorld();
  const terrain = { H: new Float32Array(1024 * 1024),
    tex: new three.DataTexture(new Uint16Array(1024 * 1024 * 4), 1024, 1024, three.RGBAFormat, three.HalfFloatType) };
  const textures = Array.from({ length: 4 }, () => new three.DataTexture(new Uint8Array([127, 127, 255, 255]), 1, 1));
  const water = await createLuminescentWater({ renderer, scene, camera, terrain,
    colorTex: textures[0], normalTex: textures[1], packTex: textures[2], packMean: 0.5, env: textures[3] });
  water.update(0); water.render();
  assert.ok(scene.children.some(mesh => mesh.visible && mesh.count > 0), 'first frame has visible river chunks');
  assert.ok(renderer.draws.length >= 2, 'first frame schedules caustics and the final composite');
  water.dispose(); terrain.tex.dispose(); textures.forEach(texture => texture.dispose());
}

// Navigation uses the CPU terrain/nominal-level guard, without GPU readbacks.
const terrain = new Float32Array(1024 * 1024).fill(-0.3);
assert.ok(Math.abs(waterCameraFloor(5, 2.3, terrain) - 0.14) < 1e-6);
const ti = Math.floor(5 / 0.01), tj = Math.floor(2.3 / 0.01);
terrain[tj * 1024 + ti] = 1;
assert.ok(Math.abs(waterCameraFloor(5, 2.3, terrain) - 1.14) < 1e-6);
terrain.fill(-0.3);
assert.equal(waterCameraFloor(5, -0.01, terrain), waterCameraFloor(5, 10.23, terrain));

const cave = new Mesh(new SphereGeometry(10, 64, 48), new MeshBasicMaterial({ side: BackSide }));
const mound = new Mesh(new SphereGeometry(1, 32, 24), new MeshBasicMaterial());
mound.position.y = -4;
const camera = new PerspectiveCamera(30, 4 / 3, 0.5, 600);
camera.position.set(0, -4.5, 0);
const target = new Vector3(20, 0, 0);
constrainButterflyCamera(camera, target, cave, mound);
assert.ok(target.length() <= 9.3 + 1e-5, 'pan target remains inside cave');
assert.ok(camera.position.y >= -2.3 - 1e-5, 'camera clears the raised surface');
camera.position.set(0, 0, 30);
constrainButterflyCamera(camera, target, cave, mound);
assert.ok(camera.position.length() <= 9.3 + 1e-5, 'zoom remains inside cave');
for (const object of [cave, mound]) { object.geometry.dispose(); object.material.dispose(); }

// Tapered appendage geometry retains arc-length ring placement and endpoint radii.
const geometry = taperTube([new Vector3(0, 0, 0), new Vector3(0, 1, 0)], 0.2, 0.4);
const positions = geometry.getAttribute('position');
assert.equal(positions.count, 33 * 8);
assert.equal(geometry.index.count, 32 * 7 * 6);
const point = new Vector3();
for (const [ring, y, radius] of [[0, 0, 0.2], [32, 1, 0.4]]) {
  for (let i = 0; i < 8; i++) {
    point.fromBufferAttribute(positions, ring * 8 + i);
    assert.ok(Math.abs(point.y - y) < 1e-6);
    assert.ok(Math.abs(Math.hypot(point.x, point.z) - radius) < 1e-6);
  }
}
geometry.dispose();

console.log(`Luminescent/combustion checks passed: ${fixture.regions.length} arithmetic regions, exact renderer APIs and first-frame orchestration, camera clearance and geometry. No browser or GPU was used.`);
