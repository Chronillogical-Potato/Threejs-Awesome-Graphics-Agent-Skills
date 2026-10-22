import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createLuminescentJellyfish } from '/skills/threejs-procedural-materials/examples/luminescent-jellyfish/luminescent-jellyfish.js';

export default {
  backend: 'webgpu',
  renderer: { options: { antialias: false }, toneMapping: THREE.AgXToneMapping, exposure: 1 },
  camera: { fov: 40, near: 0.05, far: 600, position: [0, 0, 0] },
  controls: { enabled: false },
  async setup({ renderer, camera, canvas }) {
    renderer.autoClear = false; renderer.setClearColor(0x000000, 0);
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true; controls.dampingFactor = 0.06;
    controls.rotateSpeed = 0.5; controls.zoomSpeed = 0.6;
    controls.minDistance = 1.2; controls.maxDistance = 40; controls.enablePan = true;
    controls.target.set(0.05, 0.1, -7.6); controls.update();
    const effect = await createLuminescentJellyfish({ renderer, camera });
    const r = new THREE.Vector3(), u = new THREE.Vector3(), fw = new THREE.Vector3();
    const floatOffset = new THREE.Vector3(); let clockT = 0;
    const size = new THREE.Vector2(); renderer.getDrawingBufferSize(size);
    effect.resize({ bufferWidth: Math.max(1, size.x), bufferHeight: Math.max(1, size.y) });
    return {
      update({ delta }) {
        clockT += delta;
        camera.position.sub(floatOffset); controls.update();
        camera.updateMatrixWorld(); camera.matrixWorld.extractBasis(r, u, fw);
        floatOffset.set(0, 0, 0).addScaledVector(r, 0.045 * Math.sin(clockT * 0.41) + 0.02 * Math.sin(clockT * 1.13 + 2))
          .addScaledVector(u, 0.05 * Math.sin(clockT * 0.29 + 1) + 0.015 * Math.sin(clockT * 0.97))
          .addScaledVector(fw, 0.03 * Math.sin(clockT * 0.21 + 4));
        camera.position.add(floatOffset);
        camera.rotateZ(0.004 * Math.sin(clockT * 0.33)); camera.rotateX(0.0025 * Math.sin(clockT * 0.47 + 1));
        camera.updateMatrixWorld(); effect.update(delta, controls.target);
      },
      resize(size) { effect.resize(size); },
      render() { effect.render(); },
      setDebugMode(mode) { effect.setDebugMode(mode); },
      dispose() { controls.dispose(); effect.dispose(); },
    };
  },
};
