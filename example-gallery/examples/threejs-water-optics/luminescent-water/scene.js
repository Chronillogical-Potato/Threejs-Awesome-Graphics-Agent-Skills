import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createLuminescentWater } from '/skills/threejs-water-optics/examples/luminescent-water/luminescent-water.js';
import { loadWaterStage } from './terrain.js';
import { waterCameraFloor } from './camera-bounds.js';

export default {
  backend: 'webgpu',
  renderer: { options: { antialias: false }, toneMapping: THREE.ACESFilmicToneMapping, exposure: 1.05 },
  camera: { fov: 42, near: 0.02, far: 80, position: [5.8, 2.05, 1.6] },
  controls: { enabled: false },
  async setup({ renderer, scene, camera, canvas, resolveAsset }) {
    const stage = await loadWaterStage(resolveAsset);
    scene.background = new THREE.Color(0x000000);
    scene.environment = stage.env;
    scene.environmentIntensity = 0.18;
    scene.fog = new THREE.FogExp2(0x000000, 0.075);
    const moon = new THREE.DirectionalLight(0x6f8fcf, 0.22);
    moon.position.set(-0.35, 0.82, 0.45).normalize().multiplyScalar(10);
    scene.add(moon);
    const controls = new OrbitControls(camera, canvas);
    controls.target.set(5.42, -0.1, 3.1);
    controls.enableDamping = true; controls.dampingFactor = 0.08;
    controls.minDistance = 0.25; controls.maxDistance = 18;
    controls.maxPolarAngle = Math.PI * 0.495;
    controls.update();
    const effect = await createLuminescentWater({ renderer, scene, camera, ...stage });
    const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    let stirring = false, lastHit = null, lastT = 0;
    const onDown = e => {
      if (e.shiftKey) { stirring = true; controls.enabled = false; lastHit = null; e.stopImmediatePropagation(); }
    };
    const onUp = () => { stirring = false; controls.enabled = true; effect.endStir(); };
    const onMove = e => {
      if (!stirring) return;
      const rect = canvas.getBoundingClientRect();
      ndc.set((e.clientX - rect.left) / rect.width * 2 - 1, -(e.clientY - rect.top) / rect.height * 2 + 1);
      ray.setFromCamera(ndc, camera);
      const hit = ray.ray.intersectPlane(plane, new THREE.Vector3()); if (!hit) return;
      const now = performance.now() / 1000, velocity = new THREE.Vector2();
      if (lastHit) {
        const dt = Math.max(now - lastT, 1 / 120);
        velocity.set(THREE.MathUtils.clamp((hit.x - lastHit.x) / dt, -3, 3), THREE.MathUtils.clamp((hit.z - lastHit.z) / dt, -3, 3));
      }
      lastHit = hit; lastT = now; effect.stir(hit, velocity);
    };
    canvas.addEventListener('pointerdown', onDown, { capture: true });
    canvas.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    const constrain = () => {
      controls.target.x = THREE.MathUtils.clamp(controls.target.x, 0.3, 9.94);
      camera.position.x = THREE.MathUtils.clamp(camera.position.x, 0.16, 10.08);
      camera.position.y = Math.max(camera.position.y, waterCameraFloor(camera.position.x, camera.position.z, stage.terrain.H));
      camera.lookAt(controls.target); camera.updateMatrixWorld();
    };
    constrain();
    return {
      update({ delta }) { controls.update(); constrain(); effect.update(delta); },
      render() { effect.render(); },
      setDebugMode(mode) { effect.setDebugMode(mode); },
      dispose() {
        canvas.removeEventListener('pointerdown', onDown, { capture: true });
        canvas.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp); window.removeEventListener('pointercancel', onUp);
        controls.dispose(); effect.dispose(); scene.remove(moon);
        for (const tex of [stage.terrain.tex, stage.colorTex, stage.normalTex, stage.packTex, stage.env]) tex.dispose();
      },
    };
  },
};
