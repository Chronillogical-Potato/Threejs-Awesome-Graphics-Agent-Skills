import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { discoverExamples } from "../example-gallery/discovery.mjs";
import { startExampleGallery } from "../example-gallery/server.mjs";

const root = process.cwd();
const forbidden = /(?:^|[/"'`(])(?:\.\.\/)*source_materials(?:\/|$)|\/source_materials\//;
const errors = [];

async function isDirectory(filePath) {
  try {
    return (await stat(filePath)).isDirectory();
  } catch {
    return false;
  }
}

async function collectTextFiles(directory) {
  const files = [];
  if (!(await isDirectory(directory))) return files;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectTextFiles(entryPath));
    } else if (/\.(?:css|html|js|json|md|mjs|ts|tsx|wgsl|glsl)$/i.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files;
}

function relative(filePath) {
  return path.relative(root, filePath).split(path.sep).join("/");
}

async function scanFile(filePath) {
  const text = await readFile(filePath, "utf8");
  if (forbidden.test(text)) {
    errors.push(`${relative(filePath)} references source_materials/`);
  }
}

const examples = await discoverExamples(root);
for (const example of examples) {
  const galleryRoot = path.join(root, example.source.replace(/^\//, ""));
  const skillRoot = path.join(root, "skills", example.skill, "examples", example.slug);
  for (const file of [
    ...await collectTextFiles(galleryRoot),
    ...await collectTextFiles(skillRoot),
  ]) {
    await scanFile(file);
  }
}

const traces = JSON.parse(
  await readFile(path.join(root, "source_materials", "example-traces.json"), "utf8"),
);
for (const [exampleId, exampleTraces] of Object.entries(traces.examples ?? {})) {
  for (const trace of exampleTraces) {
    for (const asset of trace.assets ?? []) {
      if (typeof asset.localPath !== "string") continue;
      if (forbidden.test(asset.localPath)) {
        errors.push(`${exampleId}: traced asset localPath points at ${asset.localPath}`);
      }
    }
  }
}

const { server, url } = await startExampleGallery({
  host: "127.0.0.1",
  port: 0,
});
try {
  const response = await fetch(new URL("/source_materials/README.md", url));
  if (response.status !== 404) {
    errors.push(
      `gallery server should not serve source_materials/ assets; got HTTP ${response.status}`,
    );
  }
  for (const example of examples.filter(example => example.threePackage)) {
    const documentResponse = await fetch(new URL(example.entry, url));
    const html = await documentResponse.text();
    if (documentResponse.status !== 200 || html.includes('/node_modules/three/') ||
        !html.includes(`"three": "/node_modules/${example.threePackage}/build/three.webgpu.js"`)) {
      errors.push(`${example.id}: inspection host does not select its exact renderer revision`);
    }
    const rendererResponse = await fetch(new URL(`/node_modules/${example.threePackage}/build/three.webgpu.js`, url), { method: 'HEAD' });
    if (rendererResponse.status !== 200) errors.push(`${example.id}: exact renderer package is not served`);
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
}

if (errors.length > 0) {
  throw new Error(`Example asset-origin checks failed:\n${errors.join("\n")}`);
}

console.log("Example asset-origin checks passed.");
