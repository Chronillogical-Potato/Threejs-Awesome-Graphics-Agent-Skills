import * as THREE from "three/webgpu";
import { float, positionWorld, texture, uniform } from "three/tsl";
import {
  SOFTBODY_JELLY_DEFAULTS,
  createSoftbodyJellySystem,
} from "/skills/threejs-procedural-materials/examples/softbody-jelly/softbody-jelly.js";

const LIGHT_DIRECTION = new THREE.Vector3(
  -0.6123724357,
  -0.5,
  0.6123724357,
).normalize();

function makeBenchTexture() {
  const size = 1024;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas 2D is required for the inspection receiver.");
  }

  context.fillStyle = "#dce4e6";
  context.fillRect(0, 0, size, size);
  context.strokeStyle = "#bccbd04a";
  context.lineWidth = 1;
  for (let index = 0; index <= 16; index += 1) {
    const point = (index * size) / 16;
    context.beginPath();
    context.moveTo(point, 0);
    context.lineTo(point, size);
    context.stroke();
    context.beginPath();
    context.moveTo(0, point);
    context.lineTo(size, point);
    context.stroke();
  }

  context.strokeStyle = "#869ba23a";
  context.lineWidth = 1.5;
  for (let y = 0; y <= 4; y += 1) {
    for (let x = 0; x <= 4; x += 1) {
      const originX = (x * size) / 4;
      const originY = (y * size) / 4;
      context.beginPath();
      context.moveTo(originX - 4, originY);
      context.lineTo(originX + 4, originY);
      context.moveTo(originX, originY - 4);
      context.lineTo(originX, originY + 4);
      context.stroke();
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 4;
  return texture;
}

function settleThumbnail(system, camera) {
  const maxSteps = 960;
  const fixedStep = SOFTBODY_JELLY_DEFAULTS.step;
  system.body.wake();

  for (
    let step = 0;
    step < maxSteps && !system.body.sleeping;
    step += 1
  ) {
    system.update({
      delta: fixedStep,
      rawDelta: fixedStep,
      camera,
    });
  }

  // Force one final receiver/thickness refresh after the body reaches sleep.
  system.update({ delta: 0, rawDelta: 1 / 24, camera });
}

export default {
  backend: "webgpu",
  renderer: {
    options: { antialias: true, alpha: false },
    toneMapping: THREE.ACESFilmicToneMapping,
    outputColorSpace: THREE.SRGBColorSpace,
    exposure: 1.12,
    clearColor: 0xdfe6e8,
    clearAlpha: 1,
  },
  camera: {
    fov: 34,
    near: 0.001,
    far: 2,
    position: [0, 0.096, 0.196],
  },
  controls: {
    target: [0, 0.025, 0],
    enableDamping: true,
    dampingFactor: 0.07,
    enablePan: false,
    minDistance: 0.12,
    maxDistance: 0.37,
    minPolarAngle: 0.25,
    maxPolarAngle: Math.PI * 0.47,
  },

  async setup({ scene, camera, controls, canvas }) {
    scene.background = new THREE.Color("#dfe6e8");
    scene.fog = new THREE.FogExp2("#dfe6e8", 0.95);

    const sun = new THREE.DirectionalLight(0xfff1da, 3.0);
    sun.target.position.set(0, 0.025, 0);
    sun.position.copy(sun.target.position).addScaledVector(
      LIGHT_DIRECTION,
      -0.45,
    );
    scene.add(sun, sun.target);

    const system = createSoftbodyJellySystem({
      camera,
      controls,
      domElement: canvas,
    });

    if (new URLSearchParams(window.location.search).get("galleryThumbnail") === "1") {
      settleThumbnail(system, camera);
    }

    const opticalUV = positionWorld.xz
      .sub(system.optics.originNode)
      .div(system.optics.spanNode);
    const shadowField = texture(system.optics.shadowTexture, opticalUV);
    const causticField = system.optics.sampleIrradiance();
    const benchTexture = makeBenchTexture();
    const bench = texture(benchTexture, positionWorld.xz.div(0.16).add(0.5)).rgb;
    const benchMaterial = new THREE.MeshStandardNodeMaterial({
      roughness: 0.63,
      metalness: 0,
    });
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      benchMaterial,
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.00005;
    scene.add(floor, system.group);

    const finalBenchColor = bench
      .mul(float(1).sub(shadowField.r.mul(0.63)))
      .mul(float(1).sub(shadowField.g.mul(0.40)));
    const finalBenchEmission = bench
      .mul(causticField)
      .mul(uniform(sun.color))
      .mul(sun.intensity / Math.PI);
    let previousPaused = false;

    function setDebugMode(mode) {
      system.setDebugMode(mode);
      if (mode === "shadow") {
        benchMaterial.colorNode = shadowField.rgb;
        benchMaterial.emissiveNode = float(0);
      } else if (mode === "caustics") {
        benchMaterial.colorNode = float(0.06);
        benchMaterial.emissiveNode = causticField;
      } else {
        benchMaterial.colorNode = finalBenchColor;
        benchMaterial.emissiveNode = finalBenchEmission;
      }
      benchMaterial.needsUpdate = true;
    }

    setDebugMode("final");

    function resize({ width, height }) {
      camera.aspect = width / height;
      camera.fov = 2 * Math.atan(
        Math.tan((17 * Math.PI) / 180) * Math.max(1, 0.9 / camera.aspect),
      ) * 180 / Math.PI;
      camera.setViewOffset(
        width,
        height,
        0,
        height * (width < 700 ? 0.10 : 0.035),
        width,
        height,
      );
      camera.updateProjectionMatrix();
    }

    return {
      setDebugMode,
      resize,
      update({ delta, rawDelta, camera: viewCamera, state }) {
        if (state.paused !== previousPaused) {
          system.setPaused(state.paused);
          previousPaused = state.paused;
        }
        system.update({
          delta,
          rawDelta,
          camera: viewCamera,
        });
      },
      render({ renderer, scene, camera: viewCamera }) {
        system.updateGPU(renderer);
        renderer.render(scene, viewCamera);
      },
      metrics() {
        return system.metrics();
      },
      dispose() {
        scene.remove(floor, system.group, sun, sun.target);
        system.dispose();
        floor.geometry.dispose();
        benchMaterial.dispose();
        benchTexture.dispose();
      },
    };
  },
};
