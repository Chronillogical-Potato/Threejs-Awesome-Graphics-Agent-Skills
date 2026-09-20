import * as THREE from "three/webgpu";
import {
  GRID,
  ROCKS,
  ContactSpray,
  ShoreSimulation,
  buildWorld,
  createShading,
  enableSolverAcceleration,
  makeNoiseTexture,
  sampleField,
  terrainHeight,
} from "/skills/threejs-spectral-ocean/examples/ocean-beach-waves/ocean-beach-waves.js";

const WASM_URL = "/skills/threejs-spectral-ocean/assets/ocean-beach-waves/solver-kernels.wasm";
const STATE_URL = "/skills/threejs-spectral-ocean/assets/ocean-beach-waves/initial-state.bin.gz";
const START_VIEW = { x: 18, z: -32.5, eye: 3.3, look: [-3.5, 0, -49] };
const DOMAIN = { minX: -10.5, maxX: 34, minZ: -74, maxZ: 23 };

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function makeField() {
  const texture = new THREE.DataTexture(
    new Float32Array(GRID.nx * GRID.nz * 4),
    GRID.nx,
    GRID.nz,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

async function readGzipFloatState(url) {
  const response = await fetch(url);
  if (!response.ok || !response.body || typeof DecompressionStream === "undefined") {
    throw new Error(`Unable to load coastal warm state (${response.status}).`);
  }
  const stream = response.body.pipeThrough(new DecompressionStream("gzip"));
  return new Float32Array(await new Response(stream).arrayBuffer());
}

function hydrateSimulation(simulation, values) {
  const keys = ["h", "u", "v", "foam", "old", "wet", "film", "qx", "qz"];
  if (
    values[0] !== 185 ||
    values[1] !== simulation.g.nx ||
    values[2] !== simulation.g.nz ||
    values.length !== 8 + simulation.n * keys.length
  ) {
    throw new Error("Coastal warm state dimensions do not match the solver.");
  }
  keys.forEach((key, index) => {
    simulation[key].set(
      values.subarray(8 + index * simulation.n, 8 + (index + 1) * simulation.n),
    );
  });
  simulation.time = values[3];
  simulation.steps = values[4];
}

export default {
  backend: "webgpu",
  renderer: {
    options: { antialias: false, samples: 4 },
    outputColorSpace: THREE.SRGBColorSpace,
    toneMapping: THREE.NeutralToneMapping,
    exposure: 1,
    clearColor: 0xb4c5cb,
  },
  camera: {
    fov: 57,
    near: 0.18,
    far: 5000,
    position: [-3.8, 4.5, 15.5],
  },
  controls: {
    target: START_VIEW.look,
    enableDamping: false,
    enablePan: true,
    screenSpacePanning: false,
    minDistance: 1,
    maxDistance: 1000,
    minPolarAngle: Math.PI / 2 - 1.5,
    maxPolarAngle: Math.PI / 2 - 0.05,
  },
  async setup({ renderer, scene, camera, controls, runtime }) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.autoUpdate = false;
    const fields = {
      surface: makeField(),
      previous: makeField(),
      material: makeField(),
      previousMaterial: makeField(),
      flow: makeField(),
      previousFlow: makeField(),
    };
    const noiseTexture = makeNoiseTexture();
    const shading = createShading(noiseTexture, fields);
    const world = buildWorld(scene, shading);
    const spray = new ContactSpray(scene, shading);
    const simulation = new ShoreSimulation();
    let wasmAccelerated = false;
    try {
      const wasmResponse = await fetch(WASM_URL);
      if (wasmResponse.ok) {
        wasmAccelerated = await enableSolverAcceleration(
          simulation,
          await wasmResponse.arrayBuffer(),
        );
      }
    } catch {
      wasmAccelerated = false;
    }

    try {
      hydrateSimulation(simulation, await readGzipFloatState(STATE_URL));
    } catch {
      for (let block = 0; block < 9; block += 1) {
        for (let step = 0; step < 240; step += 1) simulation.step(1 / 60);
      }
    }

    const packet = {
      surface: fields.surface.image.data,
      material: fields.material.image.data,
      flow: fields.flow.image.data,
    };
    let previousTime = simulation.time;
    let currentTime = simulation.time;
    let renderTime = simulation.time;
    let accumulator = 0;
    let nextPublish = simulation.time;
    let disposed = false;

    function bindFields() {
      fields.surface.needsUpdate = true;
      fields.previous.needsUpdate = true;
      fields.material.needsUpdate = true;
      fields.previousMaterial.needsUpdate = true;
      fields.flow.needsUpdate = true;
      fields.previousFlow.needsUpdate = true;
      shading.bindFields();
    }

    function installPacket(initial = false) {
      if (!initial) {
        fields.previous.image.data.set(fields.surface.image.data);
        fields.previousMaterial.image.data.set(fields.material.image.data);
        fields.previousFlow.image.data.set(fields.flow.image.data);
        previousTime = currentTime;
      }
      simulation.pack(packet);
      currentTime = simulation.time;
      if (initial) {
        fields.previous.image.data.set(fields.surface.image.data);
        fields.previousMaterial.image.data.set(fields.material.image.data);
        fields.previousFlow.image.data.set(fields.flow.image.data);
        previousTime = currentTime;
        renderTime = currentTime;
      }
      bindFields();
      if (!initial) spray.arrival({ ...packet, time: currentTime, state: simulation.state });

      for (const mesh of world.rocks) {
        const rock = mesh.userData.rock;
        const level = sampleField(packet.surface, rock.x + rock.rx * 1.16, rock.z);
        const previousReach = mesh.userData.wetReach ?? 0.24;
        mesh.userData.previousReach = previousReach;
        mesh.userData.wetReach = Math.max(previousReach - 0.008, level + 0.07);
      }
    }

    installPacket(true);
    camera.position.y = terrainHeight(START_VIEW.x, START_VIEW.z) + START_VIEW.eye;
    controls?.update();

    function constrainCamera() {
      if (!controls) return;
      controls.target.x = clamp(controls.target.x, DOMAIN.minX, DOMAIN.maxX);
      controls.target.z = clamp(controls.target.z, DOMAIN.minZ, DOMAIN.maxZ);
      controls.target.y = 0;
      controls.maxPolarAngle = Math.PI / 2 - 0.05;
      controls.minDistance = 1;
      controls.maxDistance = 1000;
      const floor = terrainHeight(camera.position.x, camera.position.z) + 0.18;
      if (camera.position.y < floor) camera.position.y = floor;
    }

    const setDebugMode = (mode) => {
      shading.U.inspection.value = ({
        final: 0,
        normals: 1,
        foam: 2,
        wetness: 3,
        flow: 4,
      })[mode] ?? 0;
    };
    runtime.onStateChange((state) => setDebugMode(state.debugMode));

    return {
      update({ delta, elapsed }) {
        if (disposed) return;
        constrainCamera();
        accumulator += Math.max(0, delta);
        const count = Math.min(6, Math.floor((accumulator + 1e-7) * 60));
        if (count > 0) {
          for (let index = 0; index < count; index += 1) simulation.step(1 / 60);
          accumulator -= count / 60;
        }
        if (simulation.time >= nextPublish - 1e-5) {
          installPacket();
          nextPublish = simulation.time + 1 / 30;
        }

        renderTime = Math.min(currentTime, renderTime + Math.max(0, delta));
        const alpha =
          currentTime > previousTime
            ? clamp((renderTime - previousTime) / (currentTime - previousTime), 0, 1)
            : 1;
        shading.U.alpha.value = alpha;
        shading.U.time.value = previousTime + (currentTime - previousTime) * alpha;
        shading.U.strength.value = simulation.state.strength;
        shading.U.wind.value = simulation.state.wind;
        shading.U.tide.value = simulation.state.tide;
        shading.mirror.target.position.y = shading.U.tide.value;
        for (const mesh of world.rocks) {
          const from = mesh.userData.previousReach ?? mesh.userData.wetReach ?? 0.24;
          const to = mesh.userData.wetReach ?? from;
          mesh.userData.renderWetReach = from + (to - from) * alpha;
        }
        camera.updateMatrixWorld();
        shading.updateCamera(camera);
        spray.update(shading.U.time.value, camera);
      },
      setDebugMode,
      metrics() {
        const metrics = simulation.metrics();
        return {
          kernel: wasmAccelerated ? "WebAssembly" : "JavaScript",
          time: metrics.time.toFixed(2),
          maxDepth: metrics.maxH.toFixed(3),
          volume: metrics.volume.toFixed(2),
          foam: metrics.foam.toFixed(1),
          wetCells: metrics.wetCells,
          spray: spray.totalEmitted,
          nonfinite: metrics.nonfinite,
        };
      },
      dispose() {
        disposed = true;
        for (const texture of Object.values(fields)) texture.dispose();
        noiseTexture.dispose();
        shading.mirror.target.dispose?.();
        shading.mirror.dispose?.();
        for (const object of [world.terrain, world.water, world.sky, world.pebbles, ...world.rocks]) {
          object.geometry?.dispose?.();
        }
        for (const material of [shading.sand, shading.rock, shading.water, shading.skyMaterial]) {
          material?.dispose?.();
        }
        spray.mesh.geometry?.dispose?.();
        spray.mesh.material?.dispose?.();
        simulation.kernels = null;
      },
    };
  },
};
