import * as THREE from "three/webgpu";
import {
  COVE_RADIUS,
  COVE_Z_JOIN,
  COVE_Z_WALL,
  SPHERE_R,
  createSimulatedCloth,
} from "/skills/threejs-procedural-materials/examples/simulated-cloth/simulated-cloth.js";

const THUMBNAIL_WARMUP_FRAMES = 180;

async function advanceThumbnail(effect) {
  for (let frame = 0; frame < THUMBNAIL_WARMUP_FRAMES; frame += 1) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    effect.update(1 / 60);
  }
}

function makeCove() {
  const geo = new THREE.BufferGeometry();
  const x0 = -3.4, x1 = 3.4, xSteps = 48;
  const profile = [];
  const zFront = 2.5, zJoin = COVE_Z_JOIN, radius = COVE_RADIUS;
  for (let i = 0; i <= 28; i++) {
    const z = zFront + (zJoin - zFront) * (i / 28);
    profile.push([z, 0, 0, 1]);
  }
  for (let i = 1; i <= 20; i++) {
    const theta = -Math.PI / 2 - (Math.PI / 2) * (i / 20);
    const z = zJoin + radius * Math.cos(theta);
    const y = radius + radius * Math.sin(theta);
    const nz = -Math.cos(theta);
    const ny = -Math.sin(theta);
    profile.push([z, y, nz, ny]);
  }
  const zWall = COVE_Z_WALL;
  for (let i = 1; i <= 16; i++) {
    const y = radius + (3.4 - radius) * (i / 16);
    profile.push([zWall, y, 1, 0]);
  }
  const pos = [], nrm = [], uv = [], idx = [];
  for (let ix = 0; ix <= xSteps; ix++) {
    const x = x0 + (x1 - x0) * (ix / xSteps);
    for (let ip = 0; ip < profile.length; ip++) {
      const p = profile[ip];
      pos.push(x, p[1], p[0]);
      nrm.push(0, p[3], p[2]);
      uv.push(ix / xSteps, ip / (profile.length - 1));
    }
  }
  const rows = profile.length;
  for (let ix = 0; ix < xSteps; ix++) {
    for (let ip = 0; ip < rows - 1; ip++) {
      const a = ix * rows + ip;
      const b = (ix + 1) * rows + ip;
      const c = (ix + 1) * rows + ip + 1;
      const d = ix * rows + ip + 1;
      idx.push(a, b, d, b, c, d);
    }
  }
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  return geo;
}

function studioEnvironment(renderer) {
  const envScene = new THREE.Scene();
  envScene.background = new THREE.Color('#9c978f');
  const add = (color, intensity, w, h, x, y, z, look) => {
    const mat = new THREE.MeshStandardMaterial({
      color: 0x000000,
      emissive: new THREE.Color(color),
      emissiveIntensity: intensity,
      roughness: 1,
      metalness: 0,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    mesh.position.set(x, y, z);
    mesh.lookAt(look);
    envScene.add(mesh);
  };
  const at = new THREE.Vector3(0, 0.45, 0);
  add('#fff3e6', 4.5, 2.4, 1.5, 1.7, 2.5, 1.9, at);
  add('#d5e3f6', 1.6, 2.6, 1.8, -2.3, 1.7, 1.3, at);
  add('#fffaf4', 2.4, 1.1, 1.8, -0.4, 2.4, -2.3, at);
  add('#cabbab', 0.7, 4, 4, 0, 3.2, 0.2, new THREE.Vector3(0, 0, 0));
  const pmrem = new THREE.PMREMGenerator(renderer);
  let tex;
  try {
    tex = pmrem.fromScene(envScene, 0.03).texture;
  } finally {
    pmrem.dispose();
    envScene.traverse((object) => {
      if (!object.isMesh) return;
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) material.dispose();
    });
  }
  return tex;
}


function ndcFromEvent(canvas, event) {
  const rect = canvas.getBoundingClientRect();
  return new THREE.Vector2(
    ((event.clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1,
    -((event.clientY - rect.top) / Math.max(rect.height, 1)) * 2 + 1,
  );
}

export default {
  backend: "webgpu",
  renderer: {
    options: { antialias: true, alpha: false },
    toneMapping: THREE.ACESFilmicToneMapping,
    outputColorSpace: THREE.SRGBColorSpace,
    exposure: 0.92,
    clearColor: 0xcfc9c0,
    clearAlpha: 1,
  },
  camera: {
    fov: 32,
    near: 0.05,
    far: 40,
    position: [0.84, 1.53, 1.79],
  },
  controls: { enabled: false },

  async setup({ renderer, scene, camera, canvas }) {
    scene.background = new THREE.Color("#cfc9c0");
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const environment = studioEnvironment(renderer);
    scene.environment = environment;
    scene.environmentIntensity = 0.38;

    const cove = new THREE.Mesh(makeCove(), new THREE.MeshStandardMaterial({
      color: new THREE.Color("#d7d1c8"),
      roughness: 0.92,
      metalness: 0,
    }));
    cove.receiveShadow = true;
    scene.add(cove);

    const stone = new THREE.Mesh(
      new THREE.SphereGeometry(SPHERE_R, 96, 64),
      new THREE.MeshPhysicalNodeMaterial({
        color: new THREE.Color("#2c2926"),
        roughness: 0.36,
        metalness: 0.12,
        clearcoat: 0.2,
        clearcoatRoughness: 0.3,
      }),
    );
    stone.position.set(0, SPHERE_R, 0);
    stone.castShadow = true;
    stone.receiveShadow = true;
    scene.add(stone);

    const key = new THREE.DirectionalLight(0xfff4e8, 3.2);
    key.position.set(2.5, 5.6, 2.4);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 0.4;
    key.shadow.camera.far = 16;
    key.shadow.camera.left = -1.8;
    key.shadow.camera.right = 1.8;
    key.shadow.camera.top = 1.8;
    key.shadow.camera.bottom = -1.8;
    key.shadow.bias = -0.00018;
    key.shadow.normalBias = 0.02;
    key.target.position.set(0, 0.36, 0);
    scene.add(key, key.target);

    const fill = new THREE.DirectionalLight(0xd5e2f4, 0.55);
    fill.position.set(-3.2, 2.4, 1.6);
    scene.add(fill);
    const rim = new THREE.DirectionalLight(0xfffaf6, 0.7);
    rim.position.set(-1.2, 2.8, -2.6);
    scene.add(rim);

    const effect = await createSimulatedCloth({ renderer, scene, camera });
    if (new URLSearchParams(window.location.search).get("galleryThumbnail") === "1") {
      await advanceThumbnail(effect);
    }
    const look = new THREE.Vector3(0, 0.4, 0);
    let radius = 2.35, theta = 0.42, phi = 1.06;
    const camPos = new THREE.Vector3();
    function placeCamera() {
      camPos.setFromSpherical(new THREE.Spherical(radius, phi, theta)).add(look);
      camera.position.copy(camPos);
      camera.lookAt(look);
      camera.updateMatrixWorld();
    }
    placeCamera();

    let activePointer = null;
    let pointerMode = "";
    let lastX = 0, lastY = 0;
    let pickPending = false;
    const previousCursor = canvas.style.cursor;
    function clampLook() {
      look.x = THREE.MathUtils.clamp(look.x, -2.4, 2.4);
      look.y = THREE.MathUtils.clamp(look.y, 0.12, 1.8);
      look.z = THREE.MathUtils.clamp(look.z, -2.4, 2.4);
    }
    const onPointerDown = (event) => {
      if (activePointer !== null || pickPending) return;
      if (event.button === 0 && !event.shiftKey) {
        activePointer = event.pointerId;
        pickPending = true;
        pointerMode = "pending";
        lastX = event.clientX;
        lastY = event.clientY;
        canvas.setPointerCapture(event.pointerId);
        canvas.style.cursor = "grabbing";
        effect.beginGrab(ndcFromEvent(canvas, event)).then((grabbed) => {
          if (activePointer !== event.pointerId) return;
          pointerMode = grabbed ? "grab" : "orbit";
          canvas.style.cursor = grabbed ? "grabbing" : "grab";
        }).catch((error) => {
          if (activePointer === event.pointerId) {
            effect.endGrab();
            activePointer = null;
            pointerMode = "";
            canvas.style.cursor = "grab";
          }
          console.error("Cloth grab failed", error);
        }).finally(() => { pickPending = false; });
        return;
      }
      if (event.button === 2 || event.button === 1 || event.shiftKey) {
        event.preventDefault();
        activePointer = event.pointerId;
        pointerMode = "pan";
        lastX = event.clientX;
        lastY = event.clientY;
        canvas.setPointerCapture(event.pointerId);
        canvas.style.cursor = "move";
      }
    };
    const onPointerMove = (event) => {
      if (activePointer !== event.pointerId) return;
      const dx = event.clientX - lastX, dy = event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
      if (pointerMode === "grab") {
        effect.moveGrab(ndcFromEvent(canvas, event));
      } else if (pointerMode === "orbit") {
        theta -= dx * 0.005;
        phi = THREE.MathUtils.clamp(phi - dy * 0.004, 0.2, 1.42);
        placeCamera();
      } else if (pointerMode === "pan") {
        camera.updateMatrixWorld(true);
        const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
        const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
        const scale = radius / Math.max(canvas.clientHeight, 1);
        look.addScaledVector(right, -dx * scale);
        look.addScaledVector(up, dy * scale);
        clampLook();
        placeCamera();
      }
    };
    const onPointerEnd = (event) => {
      if (activePointer !== event.pointerId) return;
      if (pointerMode === "grab" || pointerMode === "pending") effect.endGrab();
      activePointer = null;
      pointerMode = "";
      canvas.style.cursor = "grab";
    };
    const onWheel = (event) => {
      event.preventDefault();
      radius = THREE.MathUtils.clamp(radius * Math.exp(event.deltaY * 0.0011), 0.75, 7.5);
      placeCamera();
    };
    const onContextMenu = (event) => event.preventDefault();
    canvas.style.cursor = "grab";
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerEnd);
    canvas.addEventListener("pointercancel", onPointerEnd);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("contextmenu", onContextMenu);
    return {
      update({ delta, state }) {
        if (!state?.paused) effect.update(delta);
        placeCamera();
      },
      setDebugMode(mode) { effect.setDebugMode(mode); },
      dispose() {
        canvas.removeEventListener("pointerdown", onPointerDown);
        canvas.removeEventListener("pointermove", onPointerMove);
        canvas.removeEventListener("pointerup", onPointerEnd);
        canvas.removeEventListener("pointercancel", onPointerEnd);
        canvas.removeEventListener("wheel", onWheel);
        canvas.removeEventListener("contextmenu", onContextMenu);
        canvas.style.cursor = previousCursor;
        effect.dispose();
        scene.remove(cove, stone, key, key.target, fill, rim);
        cove.geometry.dispose();
        cove.material.dispose();
        stone.geometry.dispose();
        stone.material.dispose();
        environment.dispose();
      },
    };
  },
};
