import * as THREE from "three/webgpu";
import {
  RoomEnvironment,
} from "three/addons/environments/RoomEnvironment.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  atan, exp, floor, fract, length, max, mix, positionWorld, pow,
  smoothstep, float, vec2, vec3, uv,
} from "three/tsl";
import {
  createSimulatedFur,
  FUR_FLOOR,
  FUR_LIGHT_RIG,
} from "/skills/threejs-procedural-materials/examples/simulated-fur/simulated-fur.js";

function buildFurStage(scene) {
  const THREE_FLOOR = FUR_FLOOR;

function shadowBlob(size, strength) {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  m.colorNode = vec3(0.14, 0.09, 0.05);
  m.opacityNode = pow(float(1).sub(smoothstep(float(0), float(0.5), length(uv().sub(0.5)))), 2.2).mul(strength);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), m);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = THREE_FLOOR + 0.004;
  mesh.renderOrder = 1;
  scene.add(mesh);
}
shadowBlob(4.4, 0.38);
shadowBlob(2.5, 0.5);

// ─────────────────────────────────────────────────────────────
// Cozy set: seamless sweep, braided rug, yarn
// ─────────────────────────────────────────────────────────────
const THREE_FLOOR_Y = THREE_FLOOR - 0.058;
{
  // closed infinity cove all around the cat (floor curving up into a round wall), so no edges show
  const prof = [];
  const R0 = 10, RC = 3, top = 15;
  for (let i = 0; i <= 30; i++) prof.push(new THREE.Vector2(R0 * i / 30, THREE_FLOOR_Y));
  for (let i = 1; i <= 32; i++) { const t = (i / 32) * Math.PI / 2; prof.push(new THREE.Vector2(R0 + Math.sin(t) * RC, THREE_FLOOR_Y + RC - Math.cos(t) * RC)); }
  for (let i = 1; i <= 14; i++) prof.push(new THREE.Vector2(R0 + RC, THREE_FLOOR_Y + RC + (top - THREE_FLOOR_Y - RC) * i / 14));
  const g = new THREE.LatheGeometry(prof, 160);
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.93, side: THREE.DoubleSide });
  const wp = positionWorld;
  const rr = length(wp.xz);
  const pool = exp(rr.mul(rr).div(38).add(max(wp.y.sub(0.6), 0).pow(2).div(30)).negate());
  // tiny polka dots on the wall
  const arc = atan(wp.x, wp.z).mul(R0 + RC);
  const cell = vec2(arc.mul(2.2).add(floor(wp.y.mul(2.2)).mul(0.5)), wp.y.mul(2.2));
  const dotM = float(1).sub(smoothstep(float(0.07), float(0.1), length(fract(cell).sub(0.5))));
  const wall = smoothstep(float(THREE_FLOOR_Y + 2.4), float(THREE_FLOOR_Y + 3.4), wp.y);
  const base = mix(vec3(0.62, 0.42, 0.32), vec3(0.93, 0.76, 0.62), pool);
  m.colorNode = base.mul(mix(float(1), float(1.07), dotM.mul(wall)));
  const cyc = new THREE.Mesh(g, m);
  cyc.receiveShadow = true;
  scene.add(cyc);
}
{
  // braided oval-ish round rug: concentric twisted rings
  const cols = ['#c56a4c', '#f0e2cb', '#d9a746', '#f0e2cb', '#8da689', '#f0e2cb', '#c98f7a', '#f0e2cb'];
  const mats = cols.map(c => new THREE.MeshStandardMaterial({ color: c, roughness: 1 }));
  const tube = 0.052;
  const byMat = cols.map(() => []);
  let R = 0.07, k = 0;
  while (R < 2.35) {
    const tg = new THREE.TorusGeometry(R, tube, 10, Math.max(32, Math.round(R * 150)));
    const p = tg.attributes.position;
    const count = Math.round((Math.PI * 2 * R) / 0.075);
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const u = Math.atan2(y, x), cx = Math.cos(u) * R, cy = Math.sin(u) * R;
      const ox = x - cx, oy = y - cy, oz = z;
      const v = Math.atan2(oz, ox * Math.cos(u) + oy * Math.sin(u));
      const sc = 1 + 0.17 * Math.sin(u * count + v + k);
      p.setXYZ(i, cx + ox * sc, cy + oy * sc, oz * sc);
    }
    tg.computeVertexNormals();
    tg.rotateX(-Math.PI / 2);
    tg.scale(1, 0.55, 1);
    byMat[Math.floor(k / 2) % 2 ? k % cols.length : (k * 3) % cols.length].push(tg);
    R += tube * 1.9; k++;
  }
  byMat.forEach((list, i) => {
    if (!list.length) return;
    const mesh = new THREE.Mesh(mergeGeometries(list), mats[i]);
    mesh.position.y = THREE_FLOOR - tube * 0.55;
    mesh.receiveShadow = true;
    scene.add(mesh);
  });
  const under = new THREE.Mesh(new THREE.CircleGeometry(2.36, 96), new THREE.MeshStandardMaterial({ color: 0x6d4a39, roughness: 1 }));
  under.rotation.x = -Math.PI / 2;
  under.position.y = THREE_FLOOR_Y + 0.003;
  under.receiveShadow = true;
  scene.add(under);
}
function yarnBall(radius, hex, pos, seed) {
  const grp = new THREE.Group();
  const mat = new THREE.MeshPhysicalMaterial({ color: hex, roughness: 0.95, sheen: 1, sheenRoughness: 0.5, sheenColor: new THREE.Color(hex).lerp(new THREE.Color(1, 1, 1), 0.5) });
  const core = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.97, 48, 32), mat);
  let r = seed;
  const rnd = () => (r = (r * 16807) % 2147483647) / 2147483647;
  const wraps = [];
  for (let i = 0; i < 46; i++) {
    const ax = new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize();
    const e1 = new THREE.Vector3().crossVectors(ax, Math.abs(ax.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize();
    const e2 = new THREE.Vector3().crossVectors(ax, e1);
    const off = (rnd() - 0.5) * 0.5 * radius, pts = [];
    const rr = Math.sqrt(radius * radius - off * off) * 1.01;
    for (let j = 0; j < 48; j++) {
      const a = (j / 48) * Math.PI * 2;
      pts.push(ax.clone().multiplyScalar(off).addScaledVector(e1, Math.cos(a) * rr).addScaledVector(e2, Math.sin(a) * rr));
    }
    wraps.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, true), 96, radius * 0.045, 6, true));
  }
  const wrap = new THREE.Mesh(mergeGeometries(wraps), mat);
  grp.add(core, wrap);
  grp.position.copy(pos);
  grp.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  scene.add(grp);
  return { grp, mat };
}
{
  const a = yarnBall(0.27, '#e0566b', new THREE.Vector3(2.05, THREE_FLOOR + 0.27, 0.95), 17);
  const tail = new THREE.CatmullRomCurve3([
    new THREE.Vector3(1.9, THREE_FLOOR + 0.05, 1.1), new THREE.Vector3(1.7, THREE_FLOOR + 0.012, 1.35),
    new THREE.Vector3(1.35, THREE_FLOOR + 0.012, 1.4), new THREE.Vector3(1.05, THREE_FLOOR + 0.012, 1.6),
    new THREE.Vector3(1.25, THREE_FLOOR + 0.012, 1.9),
  ]);
  const tm = new THREE.Mesh(new THREE.TubeGeometry(tail, 120, 0.013, 6, false), a.mat);
  tm.castShadow = true;
  scene.add(tm);

  const b = yarnBall(0.2, '#e3a93c', new THREE.Vector3(-2.0, THREE_FLOOR + 0.2, -0.75), 91);
  const wood = new THREE.MeshStandardMaterial({ color: 0xb98356, roughness: 0.5 });
  const bead = new THREE.MeshStandardMaterial({ color: 0x5b8a7d, roughness: 0.35 });
  [[0.5, 0.35], [-0.35, 0.55]].forEach(([rz, rx]) => {
    const n = new THREE.Group();
    const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.9, 12), wood);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.028, 16, 12), bead);
    cap.position.y = 0.45;
    n.add(stick, cap);
    n.position.set(0, 0.12, 0);
    n.rotation.set(rx, 0, rz);
    n.traverse(o => { if (o.isMesh) o.castShadow = true; });
    b.grp.add(n);
  });
}

// ─────────────────────────────────────────────────────────────
}

function ndcFromEvent(canvas, event) {
  const rect = canvas.getBoundingClientRect();
  return new THREE.Vector2(
    ((event.clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1,
    -((event.clientY - rect.top) / Math.max(rect.height, 1)) * 2 + 1,
  );
}

function disposeGroup(group) {
  group.traverse((object) => {
    if (!object.isMesh) return;
    object.geometry?.dispose?.();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) material?.dispose?.();
  });
}

export default {
  backend: "webgpu",
  renderer: {
    options: { antialias: true, alpha: true },
    toneMapping: THREE.NeutralToneMapping,
    outputColorSpace: THREE.SRGBColorSpace,
    exposure: 0.78,
    clearColor: 0x000000,
    clearAlpha: 0,
  },
  camera: {
    fov: 30,
    near: 0.1,
    far: 60,
    position: [0, 2.0, 8.4],
  },
  controls: {
    target: [0, 0.45, 0],
    enableDamping: true,
    dampingFactor: 0.06,
    enablePan: true,
    screenSpacePanning: true,
    minDistance: 4.5,
    maxDistance: 11,
    minPolarAngle: 0.05,
    maxPolarAngle: 1.49,
    rotateSpeed: 0.6,
  },

  async setup({ renderer, scene, camera, controls, canvas }) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    scene.background = null;
    const previousCanvasBackground = canvas.style.background;
    canvas.style.background =
      "radial-gradient(120% 95% at 50% 38%, #e9c9ad 0%, #c99a7c 52%, #9d6f55 100%)";

    const lights = [];
    for (const [index, entry] of FUR_LIGHT_RIG.entries()) {
      const direction = new THREE.Vector3(...entry.direction).normalize();
      const color = new THREE.Color(...entry.color);
      const light = new THREE.DirectionalLight(color, entry.intensity);
      light.position.copy(direction).multiplyScalar(10);
      if (index === 0) {
        light.castShadow = true;
        light.shadow.mapSize.set(4096, 4096);
        Object.assign(light.shadow.camera, {
          left: -3.2, right: 3.2, top: 3.2, bottom: -3.2, near: 1, far: 25,
        });
        light.shadow.bias = -0.0004;
        light.shadow.normalBias = 0.02;
        light.shadow.radius = 3;
      }
      lights.push(light);
      scene.add(light);
    }
    const hemisphere = new THREE.HemisphereLight(0xfff1e6, 0x8a6a52, 0.55);
    scene.add(hemisphere);

    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    let envTex = null;
    try {
      envTex = pmrem.fromScene(room, 0.04).texture;
    } catch (error) {
      console.warn("Fur environment bake failed", error);
    } finally {
      room.dispose();
      pmrem.dispose();
    }

    const stage = new THREE.Group();
    scene.add(stage);
    buildFurStage(stage);

    const effect = createSimulatedFur({ renderer, scene, camera, controls, envMap: envTex });

    let activePointer = null;
    const onPointerDown = (event) => {
      if (activePointer !== null) return;
      const ndc = ndcFromEvent(canvas, event);
      if (event.button === 0) {
        activePointer = event.pointerId;
        if (effect.beginPointer(ndc, event.clientX, event.clientY)) {
          event.preventDefault();
          canvas.setPointerCapture(event.pointerId);
        }
      } else {
        effect.movePointer(ndc, event.clientX, event.clientY);
      }
    };
    const onPointerMove = (event) => {
      if (activePointer !== null && event.pointerId !== activePointer) return;
      effect.movePointer(ndcFromEvent(canvas, event), event.clientX, event.clientY);
    };
    const onPointerUp = (event) => {
      if (activePointer !== null && event.pointerId !== activePointer) return;
      activePointer = null;
      effect.endPointer();
    };
    const onPointerLeave = () => {
      if (activePointer === null) effect.leavePointer();
    };
    canvas.addEventListener("pointerdown", onPointerDown, { capture: true });
    canvas.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("pointerleave", onPointerLeave);

    const boundsMin = new THREE.Vector3(-1.5, FUR_FLOOR + 0.5, -1.8);
    const boundsMax = new THREE.Vector3(1.5, 1.7, 1.8);
    return {
      update({ delta, state }) {
        const previousTarget = controls.target.clone();
        controls.target.clamp(boundsMin, boundsMax);
        camera.position.add(controls.target.clone().sub(previousTarget));
        camera.updateMatrixWorld(true);
        if (!state?.paused) effect.update(delta);
      },
      setDebugMode(mode) { effect.setDebugMode(mode); },
      dispose() {
        canvas.removeEventListener("pointerdown", onPointerDown, { capture: true });
        canvas.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerUp);
        canvas.removeEventListener("pointerleave", onPointerLeave);
        canvas.style.background = previousCanvasBackground;
        effect.dispose();
        disposeGroup(stage);
        scene.remove(stage, hemisphere, ...lights);
        envTex?.dispose?.();
      },
    };
  },
};
