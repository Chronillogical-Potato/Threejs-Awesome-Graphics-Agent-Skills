import { createPhotorealWater } from "/skills/threejs-water-optics/examples/photoreal-water/photoreal-water.js";

const SUN_EL = 31*Math.PI/180, SUN_AZ = 6*Math.PI/180;
const SUNV = [Math.sin(SUN_AZ)*Math.cos(SUN_EL), Math.sin(SUN_EL), -Math.cos(SUN_AZ)*Math.cos(SUN_EL)];
const Q = new URLSearchParams(location.search);
const fixedTime = Q.has("t") ? Number(Q.get("t")) : null;

export default {
  backend: "raw-webgl",
  camera: { fov: 64, near: 0.01, far: 1000, position: [0, 1.55, 0] },
  controls: {
    target: [0, 0, -1.55/Math.tan(0.72)],
    minDistance: 0.3, maxDistance: 25,
    maxPolarAngle: Math.PI/2-0.02,
    screenSpacePanning: false, enablePan: true,
  },
  async setup({ THREE, canvas, camera, controls }) {
    const gl = canvas.getContext("webgl2", {
      antialias: false, alpha: false, depth: false, stencil: false,
      powerPreference: "high-performance", preserveDrawingBuffer: true,
    });
    if (!gl) throw new Error("Photoreal water requires WebGL2.");
    const effect = await createPhotorealWater(gl);
    const listeners = new AbortController();
    const signal = listeners.signal;
    let down = null, tap = null, basis = null, advanceRipples = true;
    const direction = new THREE.Vector3();
    canvas.addEventListener("pointerdown", e => { down = [e.clientX, e.clientY, performance.now()]; }, { signal });
    canvas.addEventListener("pointerup", e => {
      if (down && Math.hypot(e.clientX-down[0],e.clientY-down[1])<8 && performance.now()-down[2]<350) tap = [e.clientX,e.clientY];
      down = null;
    }, { signal });
    canvas.addEventListener("pointercancel", () => { down = null; }, { signal });
    return {
      resize({ bufferWidth, bufferHeight }) { effect.setSize(bufferWidth, bufferHeight); },
      setDebugMode(mode) { effect.setDebugMode(mode); },
      update({ delta, elapsed }) {
        // Keep orbit and pan on the air side of the surface.
        controls.target.y = 0;
        camera.position.y = Math.max(0.05, camera.position.y);
        camera.lookAt(controls.target);
        camera.updateMatrixWorld();
        camera.getWorldDirection(direction);
        const t = fixedTime ?? elapsed, hy = fixedTime === null ? 1 : 0;
        const yaw = Math.atan2(direction.x,-direction.z) + hy*(0.010*Math.sin(t*0.31)+0.005*Math.sin(t*0.83+1.3));
        const pit = Math.asin(direction.y) + hy*(0.007*Math.sin(t*0.47+2.0)+0.003*Math.sin(t*1.13));
        const roll = hy*(0.006*Math.sin(t*0.39+0.4));
        const f = [Math.sin(yaw)*Math.cos(pit),Math.sin(pit),-Math.cos(yaw)*Math.cos(pit)];
        const r = [Math.cos(yaw),0,Math.sin(yaw)];
        const u = [r[1]*f[2]-r[2]*f[1],r[2]*f[0]-r[0]*f[2],r[0]*f[1]-r[1]*f[0]];
        const cr=Math.cos(roll),sr=Math.sin(roll);
        basis = {
          f, r:r.map((x,i)=>x*cr+u[i]*sr), u:u.map((x,i)=>x*cr-r[i]*sr),
          pos:[camera.position.x+hy*0.03*Math.sin(t*0.21),camera.position.y+hy*0.015*Math.sin(t*0.57),camera.position.z+hy*0.03*Math.cos(t*0.17)],
        };
        advanceRipples = delta > 0;
        if (tap) {
          const rect = canvas.getBoundingClientRect();
          const nx=2*(tap[0]-rect.left)/rect.width-1, ny=1-2*(tap[1]-rect.top)/rect.height;
          const tf=Math.tan(64*Math.PI/360), asp=canvas.width/canvas.height;
          const d=f.map((x,i)=>x+nx*asp*tf*basis.r[i]+ny*tf*basis.u[i]);
          if(d[1]<-0.01) {
            const distance=-basis.pos[1]/d[1];
            effect.addDrop(basis.pos[0]+d[0]*distance,basis.pos[2]+d[2]*distance);
          }
          tap=null;
        }
      },
      render({ elapsed }) { effect.render(fixedTime ?? elapsed,basis,SUNV,advanceRipples); },
      metrics() { return { spectrum:"256²", caustics:"1024²", backend:"WebGL2" }; },
      dispose() { listeners.abort(); effect.dispose(); gl.getExtension("WEBGL_lose_context")?.loseContext(); },
    };
  },
};
