import {
  FixedClock,
  SAND,
  SandRenderer,
  SandSolver,
  StrokeQueue,
} from "/skills/threejs-procedural-materials/examples/deformable-sand/deformable-sand.js";

function createGpuContext(canvas) {
  if (!navigator.gpu) {
    throw new Error("Deformable sand requires a browser with WebGPU support.");
  }
  return navigator.gpu.requestAdapter({ powerPreference: "high-performance" })
    .then(async (adapter) => {
      if (!adapter) throw new Error("No hardware WebGPU adapter is available.");
      const device = await adapter.requestDevice({ label: "Deformable sand GPU" });
      const context = canvas.getContext("webgpu");
      if (!context) throw new Error("The browser could not create a WebGPU canvas context.");
      const format = navigator.gpu.getPreferredCanvasFormat();
      context.configure({ device, format, alphaMode: "opaque" });
      return { adapter, device, context, format };
    });
}

function bedPoint(camera, canvas, event) {
  const rect = canvas.getBoundingClientRect();
  return camera.screenToBed(
    event.clientX - rect.left,
    event.clientY - rect.top,
    rect.width,
    rect.height,
  );
}

export default {
  backend: "raw-webgpu",
  camera: {
    fov: 25,
    near: 0.01,
    far: 4,
    position: [0, 0.52, 0.26],
  },
  controls: { enabled: false },
  async setup({ canvas, runtime, resolveAsset }) {
    const gpu = await createGpuContext(canvas);
    const solver = new SandSolver(gpu.device);
    const sandRenderer = new SandRenderer(
      gpu.device,
      solver,
      gpu.format,
      false,
      resolveAsset("./assets/coconut_tree.glb"),
    );
    const strokes = new StrokeQueue();
    const clock = new FixedClock(SAND.step, SAND.maxSteps);
    const listeners = new AbortController();
    const activePointers = new Set();
    const pointerStartedAt = new Map();
    const keyboardPointerId = -1;
    let keyboardDrawing = false;
    let showPointer = false;
    let simulatedNow = 0;
    let disposed = false;

    await solver.initialize();
    await sandRenderer.initialize();

    const toBed = (event) => bedPoint(sandRenderer.camera, canvas, event);
    const pressureFor = (event) =>
      event.pointerType === "pen" ? event.pressure : 0.75;
    const eventTimelineTime = (event) =>
      event.timeStamp > performance.timeOrigin
        ? event.timeStamp - performance.timeOrigin
        : event.timeStamp;
    const isOlderThanCurrentPointer = (event) => {
      const startedAt = pointerStartedAt.get(event.pointerId);
      if (startedAt === undefined) return false;
      const eventTime = eventTimelineTime(event);
      return Number.isFinite(eventTime) && eventTime > 0 && eventTime < startedAt;
    };

    const beginDraw = (event) => {
      const eventTime = eventTimelineTime(event);
      if (activePointers.has(event.pointerId)) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      event.preventDefault();
      const startedAt = Number.isFinite(eventTime) && eventTime > 0
        ? eventTime
        : performance.now();
      activePointers.add(event.pointerId);
      pointerStartedAt.set(event.pointerId, startedAt);
      canvas.setPointerCapture(event.pointerId);
      canvas.focus({ preventScroll: true });
      const point = toBed(event);
      strokes.begin(point, pressureFor(event), startedAt, event.pointerId);
      showPointer = false;
    };
    const moveDraw = (event) => {
      if (
        isOlderThanCurrentPointer(event)
      ) return;
      event.preventDefault();
      const samples = event.getCoalescedEvents?.() ?? [event];
      for (const sample of samples.length ? samples : [event]) {
        if (isOlderThanCurrentPointer(sample)) continue;
        strokes.move(
          toBed(sample),
          pressureFor(sample),
          eventTimelineTime(sample),
          event.pointerId,
        );
      }
    };
    const endDraw = (event) => {
      if (isOlderThanCurrentPointer(event) || !activePointers.has(event.pointerId)) return;
      strokes.move(
        toBed(event),
        pressureFor(event),
        eventTimelineTime(event),
        event.pointerId,
      );
      strokes.end(event.pointerId);
      activePointers.delete(event.pointerId);
      pointerStartedAt.delete(event.pointerId);
      if (canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
    };

    const cancelPointer = (pointerId) => {
      activePointers.delete(pointerId);
      pointerStartedAt.delete(pointerId);
      strokes.cancel(pointerId);
      if (canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
    };
    const cancelAll = () => {
      const pointers = [...activePointers];
      activePointers.clear();
      pointerStartedAt.clear();
      for (const pointerId of pointers) {
        if (canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
      }
      keyboardDrawing = false;
      showPointer = false;
      strokes.cancel();
    };

    canvas.tabIndex = 0;
    canvas.addEventListener("pointerdown", beginDraw, {
      signal: listeners.signal,
      passive: false,
    });
    canvas.addEventListener("pointermove", moveDraw, {
      signal: listeners.signal,
      passive: false,
    });
    canvas.addEventListener("pointerup", endDraw, { signal: listeners.signal });
    canvas.addEventListener("pointercancel", (event) => {
      if (!isOlderThanCurrentPointer(event)) cancelPointer(event.pointerId);
    }, { signal: listeners.signal });
    canvas.addEventListener("lostpointercapture", (event) => {
      if (activePointers.has(event.pointerId) && !isOlderThanCurrentPointer(event)) {
        cancelPointer(event.pointerId);
      }
    }, { signal: listeners.signal });
    window.addEventListener("blur", cancelAll, { signal: listeners.signal });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) cancelAll();
    }, { signal: listeners.signal });
    canvas.addEventListener("keydown", (event) => {
      if (event.code === "Space") {
        event.preventDefault();
        if (!keyboardDrawing) {
          strokes.begin(strokes.position, 0.75, eventTimelineTime(event), keyboardPointerId);
          keyboardDrawing = true;
        }
      }
      const movement = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
      };
      const direction = movement[event.key];
      if (direction) {
        event.preventDefault();
        showPointer = true;
        strokes.move({
          x: strokes.position.x + direction[0] * 0.003,
          y: strokes.position.y + direction[1] * 0.003,
        }, 0.75, eventTimelineTime(event), keyboardPointerId);
      }
      if (event.key === "[" || event.key === "]") {
        event.preventDefault();
        strokes.radius = Math.max(
          0.006,
          Math.min(0.022, strokes.radius + (event.key === "[" ? -0.001 : 0.001)),
        );
        showPointer = true;
      }
    }, { signal: listeners.signal });
    canvas.addEventListener("keyup", (event) => {
      if (event.code === "Space") {
        event.preventDefault();
        strokes.end(keyboardPointerId);
        keyboardDrawing = false;
      }
    }, { signal: listeners.signal });
    canvas.addEventListener("contextmenu", (event) => event.preventDefault(), {
      signal: listeners.signal,
    });

    runtime.onStateChange((state) => sandRenderer.setDebugMode(state.debugMode));

    return {
      resize({ bufferWidth, bufferHeight }) {
        if (disposed) return;
        canvas.width = Math.max(1, bufferWidth);
        canvas.height = Math.max(1, bufferHeight);
        gpu.context.configure({ device: gpu.device, format: gpu.format, alphaMode: "opaque" });
        sandRenderer.resize(canvas.width, canvas.height);
      },
      update({ delta, elapsed }) {
        if (disposed) return;
        simulatedNow += Math.max(0, delta) * 1000;
        const stepCount = clock.advance(simulatedNow);
        const encoder = gpu.device.createCommandEncoder({ label: "Deformable sand frame" });
        if (stepCount > 0) {
          solver.encode(
            encoder,
            Array.from({ length: stepCount }, () => strokes.nextBatch()),
          );
        }
        sandRenderer.encode(
          encoder,
          gpu.context.getCurrentTexture().createView(),
          strokes.cursor,
          elapsed * 1000,
          showPointer || activePointers.size > 0 || keyboardDrawing,
        );
        gpu.device.queue.submit([encoder.finish()]);
      },
      setDebugMode(mode) {
        sandRenderer.setDebugMode(mode);
      },
      metrics() {
        return {
          resolution: `${SAND.resolution}²`,
          particles: SAND.particles,
          queuedPointers: activePointers.size,
          droppedSeconds: clock.droppedSeconds.toFixed(3),
        };
      },
      dispose() {
        disposed = true;
        listeners.abort();
        sandRenderer.dispose();
        solver.dispose();
        gpu.context.unconfigure();
        gpu.device.destroy();
      },
    };
  },
};
