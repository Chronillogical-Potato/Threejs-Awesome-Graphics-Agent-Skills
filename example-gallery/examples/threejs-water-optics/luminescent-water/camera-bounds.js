// The camera uses the channel's CPU height field and nominal water-level guard.
// Navigation never waits for GPU simulation-buffer readback.
export function waterCameraFloor(x, z, terrain) {
  const MRES = 1024, MT = 10.24 / MRES, WATER_LEVEL = 0;
  const i = Math.min(MRES - 1, Math.max(0, Math.floor(x / MT)));
  const j = ((Math.floor(z / MT) % MRES) + MRES) % MRES;
  const ground = terrain[j * MRES + i];
  return Math.max(ground, WATER_LEVEL) + 0.14;
}
