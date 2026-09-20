import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { exampleRuntime } from "./example-runtime.js";

const params = new URLSearchParams(window.location.search);
const modulePath = params.get("module");
const thumbnailMode = params.get("galleryThumbnail") === "1";

if (!modulePath?.startsWith("/example-gallery/examples/")) {
  throw new Error("Inspection runtime requires a dev example module.");
}

const adapterModule = await import(modulePath);
const adapter = adapterModule.default;

if (!adapter || typeof adapter.setup !== "function") {
  throw new Error(`${modulePath} must default-export an inspection adapter.`);
}

const rawWebGpu = adapter.backend === "raw-webgpu";
const THREE = adapter.backend === "webgpu"
  ? await import("three/webgpu")
  : await import("three");
const canvas = document.querySelector("canvas");
const rendererOptions = {
  canvas,
  antialias: true,
  powerPreference: "high-performance",
  preserveDrawingBuffer: true,
  ...(adapter.renderer?.options ?? {}),
};
const renderer = rawWebGpu
  ? null
  : adapter.backend === "webgpu"
    ? new THREE.WebGPURenderer(rendererOptions)
    : new THREE.WebGLRenderer(rendererOptions);

if (typeof renderer?.init === "function") {
  await renderer.init();
}

if (renderer) {
  renderer.outputColorSpace =
    adapter.renderer?.outputColorSpace ?? THREE.SRGBColorSpace;
  renderer.toneMapping =
    adapter.renderer?.toneMapping ?? THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = adapter.renderer?.exposure ?? 1;
}

if (renderer && adapter.renderer?.clearColor != null) {
  renderer.setClearColor(
    adapter.renderer.clearColor,
    adapter.renderer.clearAlpha ?? 1,
  );
}

const scene = new THREE.Scene();
const cameraConfig = adapter.camera ?? {};
const camera = cameraConfig.type === "orthographic"
  ? new THREE.OrthographicCamera(
      cameraConfig.left ?? -1,
      cameraConfig.right ?? 1,
      cameraConfig.top ?? 1,
      cameraConfig.bottom ?? -1,
      cameraConfig.near ?? 0,
      cameraConfig.far ?? 1,
    )
  : new THREE.PerspectiveCamera(
      cameraConfig.fov ?? 50,
      1,
      cameraConfig.near ?? 0.1,
      cameraConfig.far ?? 2000,
    );

if (cameraConfig.position) {
  camera.position.fromArray(cameraConfig.position);
}
if (cameraConfig.up) {
  camera.up.fromArray(cameraConfig.up);
}

const controlsConfig = adapter.controls ?? {};
const controls = controlsConfig.enabled === false ||
    cameraConfig.type === "orthographic"
  ? null
  : new OrbitControls(camera, canvas);

if (controls) {
  controls.enableDamping = controlsConfig.enableDamping ?? true;
  controls.dampingFactor = controlsConfig.dampingFactor ?? 0.08;
  controls.enablePan = controlsConfig.enablePan ?? true;
  controls.screenSpacePanning = controlsConfig.screenSpacePanning ?? true;
  controls.minDistance = controlsConfig.minDistance ?? 0;
  controls.maxDistance = controlsConfig.maxDistance ?? Infinity;
  controls.minPolarAngle = controlsConfig.minPolarAngle ?? 0;
  controls.maxPolarAngle = controlsConfig.maxPolarAngle ?? Math.PI;
  controls.minAzimuthAngle = controlsConfig.minAzimuthAngle ?? -Infinity;
  controls.maxAzimuthAngle = controlsConfig.maxAzimuthAngle ?? Infinity;
  controls.target.fromArray(controlsConfig.target ?? [0, 0, 0]);
  controls.update();
}

if (renderer) exampleRuntime.bindRenderer(renderer);
exampleRuntime.setCaptureCanvas(canvas);

const context = {
  THREE,
  canvas,
  renderer,
  scene,
  camera,
  controls,
  runtime: exampleRuntime,
  moduleUrl: new URL(modulePath, window.location.origin),
  resolveAsset(relativePath) {
    return new URL(relativePath, new URL(modulePath, window.location.origin))
      .href;
  },
};

const example = await adapter.setup(context) ?? {};
let runtimeState = exampleRuntime.state;
let previous = performance.now();
let elapsed = adapter.initialTime ?? 0;
let metricElapsed = 0;
let metricFrames = 0;
let frameInProgress = false;
const drawingBufferSize = new THREE.Vector2();
let rawBufferWidth = 0;
let rawBufferHeight = 0;

exampleRuntime.onStateChange((state) => {
  runtimeState = state;
  example.setDebugMode?.(state.debugMode);
});

function resize() {
  const width = Math.max(1, canvas.clientWidth);
  const height = Math.max(1, canvas.clientHeight);
  const expectedWidth = Math.round(width * runtimeState.dpr);
  const expectedHeight = Math.round(height * runtimeState.dpr);
  if (rawWebGpu) {
    if (
      rawBufferWidth === expectedWidth &&
      rawBufferHeight === expectedHeight
    ) {
      return;
    }
    rawBufferWidth = expectedWidth;
    rawBufferHeight = expectedHeight;
    if (camera.isPerspectiveCamera) {
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    }
    example.resize?.({
      width,
      height,
      bufferWidth: expectedWidth,
      bufferHeight: expectedHeight,
      dpr: runtimeState.dpr,
    });
    return;
  }

  renderer.getDrawingBufferSize(drawingBufferSize);

  if (
    drawingBufferSize.x === expectedWidth &&
    drawingBufferSize.y === expectedHeight
  ) {
    return;
  }

  renderer.setPixelRatio(runtimeState.dpr);
  renderer.setSize(width, height, false);

  if (camera.isPerspectiveCamera) {
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  example.resize?.({
    width,
    height,
    bufferWidth: expectedWidth,
    bufferHeight: expectedHeight,
    dpr: runtimeState.dpr,
  });
}

async function frame(now) {
  if (frameInProgress) return;
  frameInProgress = true;

  try {
    resize();
    const rawDelta = Math.min((now - previous) / 1000, 0.1);
    previous = now;
    const delta = exampleRuntime.frameDelta(rawDelta);
    elapsed += delta;
    controls?.update();

    await example.update?.({
      delta,
      rawDelta,
      elapsed,
      state: runtimeState,
      camera,
      controls,
    });

    if (example.render) {
      await example.render({
        renderer,
        scene,
        camera,
        elapsed,
        delta,
        rawDelta,
        state: runtimeState,
      });
    } else if (renderer) {
      await renderer.render(scene, camera);
    }

    metricElapsed += rawDelta;
    metricFrames += 1;
    if (metricElapsed >= 1) {
      exampleRuntime.reportMetrics({
        fps: Math.round(metricFrames / metricElapsed),
        ...(renderer ? {
          draws: renderer.info.render.calls,
          triangles: renderer.info.render.triangles,
        } : {}),
        ...example.metrics?.(),
      });
      metricElapsed = 0;
      metricFrames = 0;
    }
  } finally {
    frameInProgress = false;
  }
}

let rawAnimationFrame = 0;
let rawLoopStopped = false;

if (thumbnailMode) {
  // A gallery thumbnail is a still image. Rendering exactly once avoids doing
  // the same expensive post-processing and shader work every animation frame
  // while the parent waits for PNG encoding.
  await frame(performance.now());
  exampleRuntime.ready();
} else if (rawWebGpu) {
  const rawLoop = async (now) => {
    await frame(now);
    if (!rawLoopStopped) rawAnimationFrame = requestAnimationFrame(rawLoop);
  };
  rawAnimationFrame = requestAnimationFrame(rawLoop);
  exampleRuntime.ready();
} else {
  renderer.setAnimationLoop(frame);
  exampleRuntime.ready();
}

window.addEventListener("pagehide", () => {
  rawLoopStopped = true;
  if (rawAnimationFrame) cancelAnimationFrame(rawAnimationFrame);
  renderer?.setAnimationLoop(null);
  controls?.dispose();
  example.dispose?.();
  renderer?.dispose();
}, { once: true });
