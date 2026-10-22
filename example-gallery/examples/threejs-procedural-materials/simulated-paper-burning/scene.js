import * as THREE from 'three/webgpu';
import {
	Fn, If, Loop, Break, float, int, uint, vec2, vec3, vec4, ivec3, uvec2, uvec3,
	instancedArray, instanceIndex, vertexIndex, uniform, select, mix, clamp, smoothstep,
	min, max, abs, floor, fract, exp, length, normalize, cross, dot, sin,
	atomicAdd, atomicLoad, atomicStore, atomicMin, atomicMax, textureStore, texture, texture3D, uv, pass,
	workgroupArray, workgroupBarrier, workgroupId, invocationLocalIndex, cos,
	getViewPosition, interleavedGradientNoise, screenCoordinate, varying, positionWorld, positionView,
	normalView, normalMap, transformNormalToView, faceDirection, mx_noise_float, mx_noise_vec3,
	mx_fractal_noise_float, mx_worley_noise_float
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';

import { createSimulatedPaperBurning } from '/skills/threejs-procedural-materials/examples/simulated-paper-burning/simulated-paper-burning.js';

export default {
  backend: 'webgpu',
  renderer: {
    options: { antialias: true, requiredLimits: { maxStorageBuffersPerShaderStage: 10 } },
    toneMapping: THREE.ACESFilmicToneMapping, exposure: 0.8,
  },
  camera: { fov: 26, near: 0.02, far: 20 },
  controls: { enabled: false },
  async setup({ renderer, scene, camera, canvas, resolveAsset }) {
    if (renderer.backend.isWebGPUBackend !== true) throw new Error('WebGPU backend required');
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    scene.background = new THREE.Color(0x8a8783);
{
	const az = THREE.MathUtils.degToRad( 48 ), el = THREE.MathUtils.degToRad( 46 ), dist = 0.7;
	camera.position.set( Math.sin( az ) * Math.cos( el ) * dist, Math.sin( el ) * dist, Math.cos( az ) * Math.cos( el ) * dist );
}
const controls = new OrbitControls( camera, renderer.domElement );
controls.target.set( 0.0, 0, 0.0 );
controls.enableDamping = true;
controls.minDistance = 0.25; controls.maxDistance = 2.5; controls.maxPolarAngle = Math.PI * 0.47;
controls.update();
const KEY_AZIMUTH = Math.atan2( - 0.45, - 0.75 );   // where the window light should come from, around the sheet
const envTex = await new HDRLoader().loadAsync( resolveAsset('assets/env-daylight.hdr') );
envTex.mapping = THREE.EquirectangularReflectionMapping;
const keyDir = ( () => {
	const { width: w, height: h, data } = envTex.image;
	const half = data instanceof Uint16Array, get = ( i ) => half ? THREE.DataUtils.fromHalfFloat( data[ i ] ) : data[ i ];
	const lum = new Float32Array( w * h );
	for ( let i = 0; i < w * h; i ++ ) lum[ i ] = 0.2126 * get( i * 4 ) + 0.7152 * get( i * 4 + 1 ) + 0.0722 * get( i * 4 + 2 );
	const thr = Float32Array.from( lum ).sort()[ Math.floor( w * h * 0.997 ) ];
	const d = new THREE.Vector3();
	for ( let r = 0; r < h; r ++ ) for ( let c = 0; c < w; c ++ ) {
		const L = lum[ r * w + c ]; if ( L < thr ) continue;
		const u = ( c + 0.5 ) / w, v = 1 - ( r + 0.5 ) / h;
		const phi = ( u - 0.5 ) * Math.PI * 2, y = Math.sin( ( v - 0.5 ) * Math.PI ), rr = Math.sqrt( 1 - y * y );
		d.x += Math.cos( phi ) * rr * L; d.y += y * L; d.z += Math.sin( phi ) * rr * L;
	}
	return d.normalize();
} )();
const envYaw = KEY_AZIMUTH - Math.atan2( keyDir.z, keyDir.x );
scene.environment = envTex;
scene.environmentRotation.set( 0, - envYaw, 0 );
scene.environmentIntensity = 0.9;

const sun = new THREE.DirectionalLight( 0xfff6ee, 1.6 );
{
	const el = Math.max( Math.asin( keyDir.y ), THREE.MathUtils.degToRad( 32 ) );
	sun.position.set( Math.cos( KEY_AZIMUTH ) * Math.cos( el ), Math.sin( el ), Math.sin( KEY_AZIMUTH ) * Math.cos( el ) ).multiplyScalar( 1.5 );
}
sun.castShadow = true;
sun.shadow.mapSize.set( 2048, 2048 );
Object.assign( sun.shadow.camera, { left: - 0.32, right: 0.32, top: 0.32, bottom: - 0.32, near: 0.5, far: 3.5 } );
sun.shadow.bias = - 0.0012;
sun.shadow.normalBias = 0.001;
sun.shadow.radius = 6;
scene.add( sun );
const hemi = new THREE.HemisphereLight( 0xe9eef5, 0x6d655c, 0.0 );
scene.add( hemi );

const printTex = await new THREE.TextureLoader().loadAsync(resolveAsset('assets/tibo.png'));
printTex.colorSpace = THREE.SRGBColorSpace; printTex.anisotropy = 8;
const effect = await createSimulatedPaperBurning({ renderer, scene, camera, printTex });
const { fireLight, FIRE_LIGHT_COL } = effect;
const FLOOR_REPEAT = 1.2;                            // metres per texture repeat (6×6 tiles ≈ 20 cm each)
const texLoader = new THREE.TextureLoader();
const loadFloor = async ( name, srgb ) => {
	const t = await texLoader.loadAsync( resolveAsset(`assets/floor-${ name }.jpg`) );
	t.wrapS = t.wrapT = THREE.RepeatWrapping;
	t.anisotropy = 8;
	if ( srgb ) t.colorSpace = THREE.SRGBColorSpace;
	return t;
};
const [ floorColor, floorNormal, floorRough, floorHeight ] = await Promise.all( [
	loadFloor( 'basecolor', true ), loadFloor( 'normal', false ),
	loadFloor( 'roughness', false ), loadFloor( 'height', false ),
] );

const groundMat = new THREE.MeshStandardNodeMaterial();
{
	const p = positionWorld.xz;
	const fuv = vec2( p.x, p.y.negate() ).div( FLOOR_REPEAT );
	const hgt = texture( floorHeight, fuv ).r;
	const fl = fireLight( positionWorld );
	// soot settles into pores and grout first, then films over the tile face
	const sootN = mx_fractal_noise_float( vec3( p.mul( vec2( 90, 60 ) ), 2.0 ), 3, 2.0, 0.5, 1.0 ).mul( 0.5 ).add( 0.75 );
	// large-scale breakup so the deposit reads as a smear, not the sheet's outline
	const sootBreak = smoothstep( - 0.35, 0.45, mx_fractal_noise_float( vec3( p.mul( 22.0 ), 3.3 ), 3, 2.0, 0.5, 1.0 ) );
	const soot = clamp( fl.soot.mul( sootN ).mul( sootBreak ).mul( hgt.oneMinus().mul( 0.8 ).add( 0.6 ) ), 0.0, 1.0 );
	let base = texture( floorColor, fuv ).rgb;
	// pale ash veil streaked by the noise, with sooty smudges only where burning paper sat longest
	const ashStreak = mx_fractal_noise_float( vec3( p.mul( vec2( 40, 140 ) ), 6.0 ), 3, 2.0, 0.5, 1.0 ).mul( 0.5 ).add( 0.6 );
	base = mix( base, vec3( 0.30, 0.295, 0.285 ), smoothstep( 0.02, 0.4, soot ).mul( ashStreak ).mul( 0.55 ) );
	base = mix( base, vec3( 0.03, 0.028, 0.026 ), smoothstep( 0.45, 1.2, soot ).mul( 0.6 ) );
	const albedo = base.toVar();
	groundMat.colorNode = albedo;
	groundMat.roughnessNode = mix( texture( floorRough, fuv ).r, float( 0.95 ), smoothstep( 0.1, 0.8, soot ) );
	groundMat.normalNode = normalMap( texture( floorNormal, fuv ) );
	groundMat.emissiveNode = albedo.mul( FIRE_LIGHT_COL ).mul( fl.irr );
}
const ground = new THREE.Mesh( new THREE.PlaneGeometry( 6, 6 ), groundMat );
ground.rotation.x = - Math.PI / 2;
ground.receiveShadow = true;
scene.add( ground );

const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.002);
let downAt = null;
const onDown = e => { downAt = [e.clientX, e.clientY]; };
const onUp = e => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) { downAt = null; return; }
  downAt = null;
  const rect = canvas.getBoundingClientRect();
  ndc.set((e.clientX - rect.left) / rect.width * 2 - 1, -(e.clientY - rect.top) / rect.height * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hit = ray.ray.intersectPlane(plane, new THREE.Vector3());
  if (hit) effect.ignite(hit);
};
const onCancel = () => { downAt = null; };
canvas.addEventListener('pointerdown', onDown); canvas.addEventListener('pointerup', onUp);
canvas.addEventListener('pointercancel', onCancel);
const constrain = () => {
  controls.target.x = THREE.MathUtils.clamp(controls.target.x, -1.8, 1.8);
  controls.target.y = THREE.MathUtils.clamp(controls.target.y, 0, 1.5);
  controls.target.z = THREE.MathUtils.clamp(controls.target.z, -1.8, 1.8);
  camera.position.x = THREE.MathUtils.clamp(camera.position.x, -2.8, 2.8);
  camera.position.z = THREE.MathUtils.clamp(camera.position.z, -2.8, 2.8);
  camera.position.y = Math.max(camera.position.y, 0.08);
  camera.lookAt(controls.target); camera.updateMatrixWorld();
};
constrain();
return {
  update({ delta }) { controls.update(); constrain(); if (delta > 0) effect.update(delta); },
  render() { effect.render(); },
  setDebugMode(mode) { effect.setDebugMode(mode); },
  dispose() {
    canvas.removeEventListener('pointerdown', onDown); canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointercancel', onCancel);
    controls.dispose(); effect.dispose(); printTex.dispose(); envTex.dispose();
    for (const t of [floorColor, floorNormal, floorRough, floorHeight]) t.dispose();
    scene.remove(ground, sun, hemi); ground.geometry.dispose(); ground.material.dispose();
    sun.dispose();
  },
};
  },
};
