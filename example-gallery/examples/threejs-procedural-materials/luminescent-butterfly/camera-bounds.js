import { Raycaster, Vector3 } from 'three/webgpu';

const ray = new Raycaster(), direction = new Vector3(), origin = new Vector3();

export function constrainButterflyCamera(camera, target, cave, mound) {
  cave.updateMatrixWorld(true); mound.updateMatrixWorld(true);
  const center = cave.getWorldPosition(new Vector3());
  const padding = camera.near + 0.2;
  for (const point of [target, camera.position]) {
    direction.copy(point).sub(center);
    const distance = direction.length();
    if (distance < 1e-8) continue;
    ray.set(center, direction.divideScalar(distance));
    const wall = ray.intersectObject(cave, false)[0];
    if (wall && distance > wall.distance - padding) point.copy(center).addScaledVector(direction, Math.max(0, wall.distance - padding));
    origin.set(point.x, center.y + 200, point.z);
    ray.set(origin, direction.set(0, -1, 0));
    const floor = ray.intersectObject(mound, false)[0];
    if (floor) point.y = Math.max(point.y, floor.point.y + padding);
  }
  camera.lookAt(target); camera.updateMatrixWorld();
}
