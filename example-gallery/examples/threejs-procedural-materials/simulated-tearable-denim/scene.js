import {
  TearableDenim, settledDenimDrape,
} from "/skills/threejs-procedural-materials/examples/simulated-tearable-denim/simulated-tearable-denim.js";
import { acquireGpu } from "./gpu-device.ts";

export default {
  backend: "raw-webgpu",
  camera: {
    fov: 20, near: 0.05, far: 3,
    position: [0, -Math.sin(0.16)*0.98, -0.01+Math.cos(0.16)*0.98],
  },
  controls: {
    target: [0,0,-0.01], minDistance:0.3, maxDistance:1.15,
    enablePan:true, minAzimuthAngle:-1.35, maxAzimuthAngle:1.35,
  },
  async setup({ THREE, canvas, camera, controls }) {
    const { device } = await acquireGpu(navigator.gpu);
    const context = canvas.getContext("webgpu");
    if (!context) { device.destroy(); throw new Error("WebGPU canvas unavailable."); }
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode:"opaque" });
    const effect = new TearableDenim(device, format);
    await effect.initialize(settledDenimDrape());
    const listeners = new AbortController();
    const signal = listeners.signal;
    let disposed = false;
    let failure = null;
    const fail = message => { failure = new Error(message); };
    device.addEventListener("uncapturederror", e => fail(e.error.message), { signal });
    device.lost.then(info => { if (!disposed) fail("WebGPU device lost: "+info.message); });
    controls.mouseButtons.LEFT = null;
    controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN;
    controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE;
    controls.touches.ONE = null;
    const pointer = (event, phase) => {
      const rect = canvas.getBoundingClientRect();
      effect.pointer({
        phase,id:event.pointerId,time:performance.timeOrigin+performance.now(),
        x:event.clientX-rect.left,y:event.clientY-rect.top,
      });
    };
    canvas.style.touchAction = "none";
    canvas.addEventListener("pointerdown", e => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      canvas.setPointerCapture(e.pointerId); pointer(e,"down");
    }, { signal });
    canvas.addEventListener("pointermove", e => pointer(e,"move"), { signal });
    canvas.addEventListener("pointerup", e => pointer(e,"up"), { signal });
    canvas.addEventListener("pointercancel", e => pointer(e,"cancel"), { signal });
    canvas.addEventListener("wheel", e => {
      if (!effect.gripping) return;
      e.preventDefault(); e.stopImmediatePropagation(); effect.wheel(e.deltaY);
    }, { signal, capture:true, passive:false });
    window.addEventListener("blur", () => effect.cancelPointers(), { signal });
    document.addEventListener("visibilitychange", () => { if(document.hidden) effect.cancelPointers(); }, { signal });
    const reset = document.createElement("button");
    reset.textContent = "Reset denim";
    reset.style.cssText = "position:fixed;right:16px;top:16px;z-index:2;padding:8px 12px;border:1px solid #667085;border-radius:6px;background:#10131bcc;color:#eee;cursor:pointer";
    reset.addEventListener("click", () => effect.reset(), { signal });
    canvas.parentElement.append(reset);
    window.addEventListener("keydown", e => { if(e.key.toLowerCase()==="r") effect.reset(); }, { signal });
    return {
      resize({ width, height, bufferWidth, bufferHeight }) {
        const scale=Math.min(1,Math.sqrt(2_000_000/(bufferWidth*bufferHeight)));
        canvas.width=Math.max(1,Math.round(bufferWidth*scale));
        canvas.height=Math.max(1,Math.round(bufferHeight*scale));
        effect.setSize(canvas.width,canvas.height,width,height);
      },
      setDebugMode(mode) { effect.setDebugMode(mode); },
      update({ delta }) {
        if(failure) throw failure;
        controls.enabled = !effect.gripping;
        camera.position.z = Math.max(0.04,camera.position.z);
        camera.lookAt(controls.target);
        effect.camera = {
          target:controls.target.toArray(),distance:camera.position.distanceTo(controls.target),
          pitch:0,yaw:0,fovY:camera.fov*Math.PI/180,
          eye:camera.position.toArray(),up:camera.up.toArray(),
        };
        effect.update(delta,performance.timeOrigin+performance.now());
      },
      async render({ elapsed }) {
        const encoder=device.createCommandEncoder({ label:"denim-frame" });
        effect.encode(encoder,context.getCurrentTexture().createView(),elapsed);
        device.queue.submit([encoder.finish()]);
        await device.queue.onSubmittedWorkDone();
      },
      metrics() { return { nodes:effect.scene.nodeCount, detached:effect.topology.freedCount, sleeping:effect.sleeping }; },
      dispose() {
        disposed=true; listeners.abort(); reset.remove();
        effect.dispose(); context.unconfigure(); device.destroy();
      },
    };
  },
};
