#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";
import { discoverExamples } from "./discovery.mjs";
import { createThumbnailRenderer } from "./thumbnail-renderer.mjs";
import { inspectionRuntimeDocument } from "./runtime/renderer-imports.mjs";

const galleryRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(galleryRoot, "..");
const publicRoot = path.join(galleryRoot, "public");

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".glb", "model/gltf-binary"],
  [".gltf", "model/gltf+json"],
  [".hdr", "image/vnd.radiance"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".ktx2", "image/ktx2"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".ts", "text/javascript; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".webp", "image/webp"],
  [".wgsl", "text/plain; charset=utf-8"],
]);

function parseArgs(argv) {
  const options = {
    host: "127.0.0.1",
    port: 4173,
    open: false,
    includeFixtures: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--host" && argv[index + 1]) {
      options.host = argv[index + 1];
      index += 1;
    } else if (argument === "--port" && argv[index + 1]) {
      options.port = Number.parseInt(argv[index + 1], 10);
      index += 1;
    } else if (argument === "--open") {
      options.open = true;
    } else if (argument === "--include-fixtures") {
      options.includeFixtures = true;
    } else if (argument === "--help" || argument === "-h") {
      console.log(`Three.js example gallery

Usage:
  node example-gallery/server.mjs [options]

Options:
  --host <host>          Bind host (default: 127.0.0.1)
  --port <port>          Bind port; use 0 for any free port (default: 4173)
  --open                 Open the gallery in the system browser
  --include-fixtures     Include gallery self-test fixtures
`);
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete option: ${argument}`);
    }
  }

  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error("--port must be an integer from 0 to 65535.");
  }
  return options;
}

const transpileCache = new Map();

async function fileStats(filePath) {
  try {
    const metadata = await stat(filePath);
    return metadata.isFile() ? metadata : null;
  } catch {
    return null;
  }
}

async function existingFile(filePath) {
  return (await fileStats(filePath)) !== null;
}

function entityTag(metadata, variant) {
  const size = metadata.size.toString(16);
  const modified = Math.round(metadata.mtimeMs).toString(16);
  return `W/"${size}-${modified}${variant}"`;
}

/* Development caching: every response is revalidated, so an edited scene, skill,
   or asset is served the moment it changes. Unchanged bytes answer 304, which
   spares each example frame a repeat download of the renderer build — the
   overview alone opens one frame per example. */
function revalidationHeaders(metadata, variant = "") {
  return {
    "cache-control": "no-cache",
    etag: entityTag(metadata, variant),
    "last-modified": metadata.mtime.toUTCString(),
  };
}

function notModified(request, headers) {
  const ifNoneMatch = request.headers["if-none-match"];
  if (typeof ifNoneMatch !== "string") return false;
  return ifNoneMatch
    .split(",")
    .some((candidate) => candidate.trim() === headers.etag);
}

function sendNotModified(response, headers) {
  response.writeHead(304, headers);
  response.end();
  return true;
}

function safePath(root, pathname) {
  const target = path.resolve(root, `.${pathname}`);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return target;
}

async function sendFile(request, response, filePath) {
  const metadata = await fileStats(filePath);
  if (!metadata) return false;

  const headers = revalidationHeaders(metadata);
  if (notModified(request, headers)) return sendNotModified(response, headers);

  response.writeHead(200, {
    "content-type":
      contentTypes.get(path.extname(filePath).toLowerCase()) ??
      "application/octet-stream",
    "content-length": metadata.size,
    "x-content-type-options": "nosniff",
    ...headers,
  });
  if (request.method === "HEAD") {
    response.end();
  } else {
    createReadStream(filePath).pipe(response);
  }
  return true;
}

async function resolveServableFile(root, pathname) {
  const target = safePath(root, pathname);
  if (!target) return null;
  if (await existingFile(target)) return target;
  if (path.extname(target) !== "") return null;

  for (const extension of [".ts", ".js", ".glsl", ".frag", ".vert"]) {
    const candidate = `${target}${extension}`;
    if (await existingFile(candidate)) return candidate;
  }
  return null;
}

async function sendRawModule(request, response, filePath) {
  const metadata = await fileStats(filePath);
  if (!metadata) return false;

  const headers = revalidationHeaders(metadata, "-raw");
  if (notModified(request, headers)) return sendNotModified(response, headers);

  const source = await readFile(filePath, "utf8");
  const payload = `export default ${JSON.stringify(source)};\n`;
  response.writeHead(200, {
    "content-type": "text/javascript; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "x-content-type-options": "nosniff",
    ...headers,
  });
  response.end(request.method === "HEAD" ? undefined : payload);
  return true;
}

// Memoized against size and mtime: an edit re-transpiles, a reload does not.
async function transpileTypeScript(filePath, tag) {
  const cached = transpileCache.get(filePath);
  if (cached?.tag === tag) return cached.code;

  const source = await readFile(filePath, "utf8");
  const result = await transform(source, {
    loader: "ts",
    format: "esm",
    target: "es2022",
    legalComments: "none",
    tsconfigRaw: {
      compilerOptions: {
        experimentalDecorators: true,
        useDefineForClassFields: false,
      },
    },
  });
  transpileCache.set(filePath, { tag, code: result.code });
  return result.code;
}

async function sendTypeScriptModule(request, response, filePath) {
  const metadata = await fileStats(filePath);
  if (!metadata) return false;

  const headers = revalidationHeaders(metadata, "-ts");
  if (notModified(request, headers)) return sendNotModified(response, headers);

  const code = await transpileTypeScript(filePath, headers.etag);
  response.writeHead(200, {
    "content-type": "text/javascript; charset=utf-8",
    "content-length": Buffer.byteLength(code),
    "x-content-type-options": "nosniff",
    ...headers,
  });
  response.end(request.method === "HEAD" ? undefined : code);
  return true;
}

async function sendProjectModule(request, response, root, pathname, raw) {
  const filePath = await resolveServableFile(root, pathname);
  if (!filePath) return false;
  if (raw) return sendRawModule(request, response, filePath);
  if (path.extname(filePath) === ".ts") {
    return sendTypeScriptModule(request, response, filePath);
  }
  return sendFile(request, response, filePath);
}

export function createExampleGalleryServer({ includeFixtures = false } = {}) {
  const thumbnailRenderer = createThumbnailRenderer();
  let knownExamples = new Map();
  const server = createServer(async (request, response) => {
    try {
      if (!["GET", "HEAD"].includes(request.method ?? "")) {
        response.writeHead(405, { allow: "GET, HEAD" }).end("Method not allowed");
        return;
      }

      const url = new URL(request.url ?? "/", "http://localhost");
      const rawModule = url.search === "?raw" || url.searchParams.has("raw");
      if (url.pathname === "/api/examples") {
        const examples = await discoverExamples(projectRoot, { includeFixtures });
        knownExamples = new Map(examples.map((example) => [example.id, example]));
        const payload = JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            count: examples.length,
            examples,
          },
          null,
          2,
        );
        response.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "content-length": Buffer.byteLength(payload),
        });
        response.end(request.method === "HEAD" ? undefined : payload);
        return;
      }

      if (url.pathname === "/api/thumbnail") {
        if (knownExamples.size === 0) {
          const examples = await discoverExamples(projectRoot, {
            includeFixtures,
          });
          knownExamples = new Map(
            examples.map((example) => [example.id, example]),
          );
        }

        const example = knownExamples.get(url.searchParams.get("example"));
        if (!example) {
          response.writeHead(404, {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store",
          });
          response.end("Unknown thumbnail request");
          return;
        }

        const address = request.socket.localAddress ?? "127.0.0.1";
        const hostname = address.startsWith("::ffff:")
          ? address.slice("::ffff:".length)
          : address;
        const originHost = hostname.includes(":") ? `[${hostname}]` : hostname;
        const origin = `http://${originHost}:${request.socket.localPort}`;
        const controller = new AbortController();
        const abort = () => controller.abort();
        request.once("aborted", abort);
        response.once("close", () => {
          if (!response.writableEnded) abort();
        });

        try {
          const png = await thumbnailRenderer.render(example, origin, {
            signal: controller.signal,
          });
          if (controller.signal.aborted) return;

          response.writeHead(200, {
            "content-type": "image/png",
            "content-length": png.length,
            "cache-control": "no-store",
          });
          response.end(request.method === "HEAD" ? undefined : png);
        } catch (error) {
          if (controller.signal.aborted) return;
          response.writeHead(500, {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store",
          });
          response.end(`Thumbnail render failed: ${error.message}`);
        } finally {
          request.off("aborted", abort);
        }
        return;
      }

      if (url.pathname === "/" || url.pathname === "/gallery") {
        await sendFile(request, response, path.join(publicRoot, "index.html"));
        return;
      }

      if (url.pathname === "/example-gallery/runtime/index.html") {
        const examples = await discoverExamples(projectRoot, { includeFixtures });
        const example = examples.find(candidate =>
          new URL(candidate.entry, url).searchParams.get('module') === url.searchParams.get('module'));
        const template = await readFile(path.join(galleryRoot, 'runtime/index.html'), 'utf8');
        const payload = inspectionRuntimeDocument(template, example?.threePackage);
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': Buffer.byteLength(payload),
        });
        response.end(request.method === 'HEAD' ? undefined : payload);
        return;
      }

      if (url.pathname.startsWith("/gallery/")) {
        if (
          await sendProjectModule(
            request,
            response,
            publicRoot,
            url.pathname.slice("/gallery".length),
            rawModule,
          )
        ) return;
      }

      const allowedProjectPrefixes = [
        "/skills/",
        "/example-gallery/",
        "/node_modules/",
      ];
      if (includeFixtures) {
        allowedProjectPrefixes.push("/example-gallery/fixtures/");
      }
      if (
        allowedProjectPrefixes.some((prefix) =>
          url.pathname.startsWith(prefix)
        )
      ) {
        if (
          await sendProjectModule(
            request,
            response,
            projectRoot,
            url.pathname,
            rawModule,
          )
        ) return;
      }

      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end(`Example gallery error: ${error.message}`);
    }
  });
  server.once("close", () => void thumbnailRenderer.close());
  return server;
}

function openBrowser(url) {
  const command = process.platform === "darwin"
    ? ["open", [url]]
    : process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : ["xdg-open", [url]];
  const child = spawn(command[0], command[1], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

export async function startExampleGallery(options = {}) {
  const server = createExampleGalleryServer(options);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 4173, options.host ?? "127.0.0.1", resolve);
  });
  const address = server.address();
  const host = options.host === "0.0.0.0" ? "127.0.0.1" : options.host;
  const url = `http://${host}:${address.port}/`;
  return { server, url };
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const { url } = await startExampleGallery(options);
    console.log(`Three.js example gallery: ${url}`);
    console.log("Press Ctrl+C to stop.");
    if (options.open) openBrowser(url);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
