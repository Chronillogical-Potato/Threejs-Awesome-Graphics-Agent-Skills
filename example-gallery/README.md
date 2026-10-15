# Visual example gallery

This is repository-level development tooling. It is not distributed as an agent skill.

Run:

```sh
npm run dev
```

Capture all examples or one exact/partial example ID:

```sh
npm run capture:examples
npm run capture:examples -- --example threejs-volumetric-clouds/weather-volume-clouds
npm run capture:examples -- --example weather-volume-clouds --debug density
```

The server discovers development adapters:

```text
example-gallery/examples/<skill-name>/<example-name>/scene.js
example-gallery/examples/<skill-name>/<example-name>/example.json
```

The matching skill example contains only the reusable effect implementation.
The development adapter owns its scene, runtime integration, metadata, and
supporting static assets. No central manifest is edited when an adapter is
added.

Overview thumbnails are captured in a bounded parallel batch in an isolated
headless browser, so scene startup and shader compilation do not block the
gallery page. Each thumbnail remains a 960 × 540 render at DPR 1.5 (a 1440 ×
810 PNG), and the page keeps completed images for the current gallery session.

## Example metadata

```json
{
  "title": "Procedural Planet Surface",
  "description": "Coupled macro terrain, craters, biomes, and procedural normals.",
  "backend": "WebGPU / TSL",
  "techniques": ["tangential domain warp", "crater profiles", "altitude filtering"],
  "defaultViewport": { "width": 1440, "height": 900 },
  "defaultDpr": 1,
  "debugModes": [
    { "value": "final", "label": "Final" },
    { "value": "macro", "label": "Macro height" }
  ],
  "controls": ["pause", "timeScale", "dpr", "capture"]
}
```

Development provenance belongs in
[`source_materials/example-traces.json`](../source_materials/example-traces.json),
keyed by the discovered `<skill>/<example>` ID. Source IDs must exist in
[`source_materials/trace-manifest.json`](../source_materials/trace-manifest.json).
Every listed file and copied asset is validated against the reviewed trace.
Trace boundaries use `reference-extraction` for accepted implementation sources
and `reviewed-reference` for supporting or negative evidence. Development
`example.json` files must not contain repository identities, revisions, or
source paths.

Import the optional runtime contract:

```js
import {
  exampleRuntime,
} from "/example-gallery/runtime/example-runtime.js"
```

Use it to:

- read and react to pause, DPR, time scale, and debug mode;
- bind a Three.js renderer's pixel ratio;
- scale animation delta;
- report FPS, draw calls, triangles, or active quality tier;
- expose a canvas for capture;
- report runtime errors to the gallery.

An example remains runnable standalone. The runtime becomes a no-op parent bridge when the page is not inside the gallery.

## Water and denim inspection

`photoreal-water` uses a caller-owned WebGL2 context (`raw-webgl` backend).
Drag to orbit, right-drag to pan and tap to disturb the surface. The camera
stays above water. Its diagnostics show caustics, no-post and isolated glare.

`simulated-tearable-denim` uses raw WebGPU. Drag with the primary pointer to
grip and tear, right-drag to orbit, middle-drag to pan, and scroll while gripping
to change grip depth. Use **Reset denim** or R to restore the settled state.
Normal, wear and yarn-presence modes inspect the sheet while explicit fibres
keep their shading. There is no floor; detached pieces fall out of view.
The denim drawing buffer retains a two-million-pixel cap.

Nonvisual material-state, module and lossless asset contracts run with the
other examples under `npm run test:references`.

## Gallery self-test

The development fixture is excluded from the normal gallery:

```sh
npm run dev:examples:fixture
```

It verifies the runtime protocol without presenting itself as a skill example.
