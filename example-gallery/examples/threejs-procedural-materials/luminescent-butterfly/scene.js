import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createLuminescentButterfly, LUMINESCENT_BUTTERFLY_DEFAULTS } from '/skills/threejs-procedural-materials/examples/luminescent-butterfly/luminescent-butterfly.js';
import { createButterflyStage } from './stage.js';
import { constrainButterflyCamera } from './camera-bounds.js';

export default {
  backend: 'webgpu',
  renderer: { options: { antialias: false }, toneMapping: THREE.AgXToneMapping, exposure: 0.3 },
  camera: { fov: 30, near: 0.5, far: 600 },
  controls: { enabled: false },
  async setup({ renderer, scene, camera, canvas, resolveAsset }) {
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    scene.background = new THREE.Color(0x010208);
    scene.fog = new THREE.FogExp2(0x02040e, 0.0075);
    const stage = createButterflyStage({ renderer, scene, camera, resolveAsset, defaults: LUMINESCENT_BUTTERFLY_DEFAULTS });
    const placement = stage.createHero();
    const effect = await createLuminescentButterfly({
      renderer, scene, camera, perchSurface: stage.rose, perchMesh: stage.roseMesh,
      ...placement, setupStage: stage.setupStage,
    });
    const controls = new OrbitControls(camera, canvas);
    camera.position.copy(effect.hero.pos); camera.fov = effect.hero.fov; camera.updateProjectionMatrix();
    controls.target.copy(effect.hero.target);
    controls.enableDamping = true; controls.dampingFactor = 0.06;
    controls.rotateSpeed = 0.45; controls.zoomSpeed = 0.7; controls.panSpeed = 0.6;
    controls.minDistance = 5; controls.maxDistance = 95;
    controls.maxPolarAngle = Math.PI * 0.62;
    controls.update();
    const constrain = () => constrainButterflyCamera(camera, controls.target, stage.cameraBounds.cave, stage.cameraBounds.mound);
    constrain();
    await renderer.compileAsync(scene, camera);
    return {
      update({ delta }) { if (controls.update()) constrain(); effect.update(delta, controls.target); },
      render() { effect.render(); },
      setDebugMode(mode) { effect.setDebugMode(mode); },
      dispose() {
        controls.dispose(); effect.dispose();
        const geometries = new Set(), materials = new Set(), textures = new Set();
        scene.traverse(o => {
          if (o.geometry) geometries.add(o.geometry);
          if (o.material) for (const m of (Array.isArray(o.material) ? o.material : [o.material])) materials.add(m);
          o.shadow?.dispose();
        });
        for (const m of materials) for (const v of Object.values(m)) if (v?.isTexture) textures.add(v);
        scene.environment?.dispose();
        for (const g of geometries) g.dispose();
        for (const m of materials) m.dispose();
        for (const t of textures) t.dispose();
        scene.clear();
      },
    };
  },
};
