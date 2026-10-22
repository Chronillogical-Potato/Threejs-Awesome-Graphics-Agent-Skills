// Renderer revisions are isolated per inspection document, including its host.
// Mixing a renderer from one revision with another revision's TSL is invalid.
export const INSPECTION_THREE_PACKAGES = Object.freeze({
  'three-0180': '0.180.0',
  'three-0186': '0.186.1',
});

export function inspectionRuntimeDocument(template, threePackage) {
  if (!threePackage) return template;
  if (!Object.hasOwn(INSPECTION_THREE_PACKAGES, threePackage)) {
    throw new Error(`Unknown inspection renderer package: ${threePackage}`);
  }
  return template.replaceAll('/node_modules/three/', `/node_modules/${threePackage}/`)
    .replace(`"three": "/node_modules/${threePackage}/build/three.module.js"`,
      `"three": "/node_modules/${threePackage}/build/three.webgpu.js"`);
}
