const elements = {
  search: document.querySelector("#search"),
  refresh: document.querySelector("#refresh"),
  toggleView: document.querySelector("#toggle-view"),
  count: document.querySelector("#example-count"),
  runtimeSummary: document.querySelector("#runtime-summary"),
  list: document.querySelector("#example-list"),
  empty: document.querySelector("#empty-state"),
  single: document.querySelector("#single-view"),
  overview: document.querySelector("#overview"),
  viewport: document.querySelector("#viewport"),
  dpr: document.querySelector("#dpr"),
  timeScale: document.querySelector("#time-scale"),
  debugControl: document.querySelector("#debug-control"),
  debugMode: document.querySelector("#debug-mode"),
  pause: document.querySelector("#pause"),
  reload: document.querySelector("#reload"),
  capture: document.querySelector("#capture"),
  standalone: document.querySelector("#standalone"),
  stage: document.querySelector("#stage"),
  frame: document.querySelector("#example-frame"),
  toolbar: document.querySelector(".toolbar"),
  frameStatus: document.querySelector("#frame-status"),
  frameMetrics: document.querySelector("#frame-metrics"),
  frameSize: document.querySelector("#frame-size"),
};

const DEFAULT_GALLERY_DPR = 1.5;
const OVERVIEW_THUMBNAIL_CONCURRENCY = 16;
const OVERVIEW_THUMBNAIL_TIMEOUT_MS = 60000;

const overviewThumbnailCache = new Map();
const overviewThumbnailRequests = new Map();
const overviewThumbnailJobs = new Set();
const overviewThumbnailQueue = [];
let activeOverviewThumbnailCount = 0;
let overviewThumbnailsSuspended = false;
let refreshPending = false;

const state = {
  examples: [],
  filtered: [],
  selectedId: null,
  mode: "overview",
  paused: false,
  dpr: DEFAULT_GALLERY_DPR,
  timeScale: 1,
  debugMode: "final",
  viewport: "responsive",
};

function selectedExample() {
  return state.examples.find((example) => example.id === state.selectedId) ?? null;
}

// Lets the runtime document start fetching the heavy renderer build during HTML
// parse instead of waiting for the adapter's import chain to reveal it.
function applyBackendHint(url, example) {
  if (/^webgpu/i.test(example.backend ?? "")) {
    url.searchParams.set("galleryBackend", "webgpu");
  }
}

function exampleUrl(example) {
  const url = new URL(example.entry, window.location.origin);
  url.searchParams.set("galleryDpr", state.dpr);
  url.searchParams.set("galleryTimeScale", state.timeScale);
  url.searchParams.set("galleryPaused", state.paused ? "1" : "0");
  url.searchParams.set("galleryDebugMode", state.debugMode);
  applyBackendHint(url, example);
  return url.href;
}

function sendState() {
  elements.frame.contentWindow?.postMessage(
    {
      source: "threejs-example-gallery",
      type: "set-state",
      state: {
        paused: state.paused,
        dpr: state.dpr,
        timeScale: state.timeScale,
        debugMode: state.debugMode,
      },
    },
    window.location.origin,
  );
}

function setFrameStatus(label, status = "idle") {
  elements.frameStatus.textContent = label;
  elements.frameStatus.dataset.state = status;
}

function applyViewport() {
  const example = selectedExample();
  let dimensions = null;
  if (state.viewport === "default" && example) {
    dimensions = example.defaultViewport;
  } else if (state.viewport !== "responsive") {
    const [width, height] = state.viewport.split("x").map(Number);
    dimensions = { width, height };
  }

  elements.stage.dataset.fit = dimensions ? "fixed" : "responsive";

  if (!dimensions) {
    elements.frame.style.width = "100%";
    elements.frame.style.height = "100%";
    elements.frameSize.textContent = "responsive";
    return;
  }

  elements.frame.style.width = `${dimensions.width}px`;
  elements.frame.style.height = `${dimensions.height}px`;
  elements.frameSize.textContent = `${dimensions.width} × ${dimensions.height}`;
}

function updateDebugModes(example) {
  elements.debugMode.replaceChildren();
  if (example.debugModes.length === 0) {
    state.debugMode = "final";
    elements.debugControl.remove();
    return;
  }

  if (!elements.debugControl.isConnected) {
    elements.toolbar.insertBefore(elements.debugControl, elements.pause);
  }
  elements.debugControl.hidden = false;
  for (const mode of example.debugModes) {
    const option = document.createElement("option");
    option.value = mode.value;
    option.textContent = mode.label;
    elements.debugMode.append(option);
  }
  if (!example.debugModes.some((mode) => mode.value === state.debugMode)) {
    state.debugMode = example.debugModes[0].value;
  }
  elements.debugMode.value = state.debugMode;
}

function overviewThumbnailUrl(example) {
  const url = new URL("/api/thumbnail", window.location.origin);
  url.searchParams.set("example", example.id);
  return url.href;
}

function setOverviewThumbnailCache(example, result) {
  overviewThumbnailCache.set(example.id, result);
  return result;
}

function revokeOverviewThumbnailCache() {
  for (const result of overviewThumbnailCache.values()) {
    if (result.status === "ready") URL.revokeObjectURL(result.src);
  }
  overviewThumbnailCache.clear();
}

function settleOverviewThumbnailJob(job, attempt, result) {
  if (job.settled || job.attempt !== attempt) return;
  job.settled = true;
  job.attempt = null;
  clearTimeout(job.timeoutId);
  overviewThumbnailJobs.delete(job);
  job.controller = null;
  activeOverviewThumbnailCount = Math.max(0, activeOverviewThumbnailCount - 1);

  job.resolve(setOverviewThumbnailCache(job.example, result));
  runOverviewThumbnailQueue();
}

function failOverviewThumbnailJob(job, attempt, message) {
  settleOverviewThumbnailJob(job, attempt, {
    status: "error",
    message: message || "Thumbnail render failed.",
  });
}

function startOverviewThumbnailJob(job) {
  const attempt = Symbol(job.example.id);
  const controller = new AbortController();
  job.attempt = attempt;
  job.controller = controller;
  activeOverviewThumbnailCount += 1;
  overviewThumbnailJobs.add(job);
  job.timeoutId = window.setTimeout(
    () => {
      controller.abort();
      failOverviewThumbnailJob(job, attempt, "Thumbnail render timed out.");
    },
    OVERVIEW_THUMBNAIL_TIMEOUT_MS,
  );

  void (async () => {
    try {
      const response = await fetch(overviewThumbnailUrl(job.example), {
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error((await response.text()) || `HTTP ${response.status}`);
      }
      const blob = await response.blob();
      if (job.attempt !== attempt) return;
      settleOverviewThumbnailJob(job, attempt, {
        status: "ready",
        src: URL.createObjectURL(blob),
      });
    } catch (error) {
      if (job.attempt !== attempt) return;
      failOverviewThumbnailJob(job, attempt, error.message);
    }
  })();
}

function runOverviewThumbnailQueue() {
  while (
    !overviewThumbnailsSuspended &&
    activeOverviewThumbnailCount < OVERVIEW_THUMBNAIL_CONCURRENCY &&
    overviewThumbnailQueue.length > 0
  ) {
    startOverviewThumbnailJob(overviewThumbnailQueue.shift());
  }
}

/* An inspected example gets the GPU to itself: the isolated capture request is
   cancelled and returned to the queue rather than settled, so no work is lost
   and nothing competes with the scene being looked at. */
function suspendOverviewThumbnails() {
  overviewThumbnailsSuspended = true;
  for (const job of [...overviewThumbnailJobs]) {
    clearTimeout(job.timeoutId);
    overviewThumbnailJobs.delete(job);
    job.attempt = null;
    job.controller?.abort();
    job.controller = null;
    activeOverviewThumbnailCount = Math.max(0, activeOverviewThumbnailCount - 1);
    overviewThumbnailQueue.unshift(job);
  }
}

function resumeOverviewThumbnails() {
  if (!overviewThumbnailsSuspended) return;
  overviewThumbnailsSuspended = false;
  runOverviewThumbnailQueue();
}

function renderOverviewThumbnail(example) {
  const key = example.id;
  const cached = overviewThumbnailCache.get(key);
  if (cached) return Promise.resolve(cached);

  const active = overviewThumbnailRequests.get(key);
  if (active) return active;

  const request = new Promise((resolve) => {
    overviewThumbnailQueue.push({ example, resolve, settled: false });
    runOverviewThumbnailQueue();
  });
  overviewThumbnailRequests.set(key, request);
  request.finally(() => {
    if (overviewThumbnailRequests.get(key) === request) {
      overviewThumbnailRequests.delete(key);
    }
  });
  return request;
}

function applyOverviewThumbnailResult(shell, image, result) {
  if (!shell.isConnected) return;

  if (result.status === "ready") {
    image.src = result.src;
    shell.dataset.state = "ready";
    shell.dataset.message = "";
    return;
  }

  shell.dataset.state = "error";
  shell.dataset.message = result.message;
}

function clearOverview() {
  elements.overview.replaceChildren();
}

function groupLabel(skill) {
  return skill.replace(/^threejs-/, "").replace(/-/g, " ");
}

function syncListSelection({ reveal = false } = {}) {
  let current = null;
  for (const button of elements.list.querySelectorAll(".example-link")) {
    const selected = button.dataset.exampleId === state.selectedId;
    button.setAttribute("aria-current", String(selected));
    if (selected) current = button;
  }

  for (const section of elements.list.querySelectorAll(".skill-group")) {
    section.dataset.hasCurrent = String(section.contains(current));
  }

  if (reveal && current) current.scrollIntoView({ block: "nearest" });
}

function renderList() {
  const scrollTop = elements.list.scrollTop;
  elements.list.replaceChildren();
  const groups = new Map();
  for (const example of state.filtered) {
    const group = example.skill ?? "Gallery fixtures";
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(example);
  }

  for (const [skill, examples] of groups) {
    const section = document.createElement("section");
    section.className = "skill-group";
    const heading = document.createElement("h3");
    const name = document.createElement("span");
    name.className = "group-name";
    name.textContent = groupLabel(skill);
    const count = document.createElement("span");
    count.className = "group-count";
    count.textContent = String(examples.length);
    heading.append(name, count);
    section.append(heading);

    for (const example of examples) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "example-link";
      button.dataset.exampleId = example.id;
      button.setAttribute(
        "aria-current",
        String(example.id === state.selectedId),
      );
      const title = document.createElement("strong");
      title.textContent = example.title;
      button.append(title);
      button.addEventListener("click", () => selectExample(example.id));
      section.append(button);
    }
    elements.list.append(section);
  }

  elements.list.scrollTop = scrollTop;
  syncListSelection();
}

function renderOverview() {
  clearOverview();

  for (const example of state.filtered) {
    const article = document.createElement("article");
    article.className = "overview-card";
    article.tabIndex = 0;
    article.dataset.active = String(example.id === state.selectedId);
    article.setAttribute("role", "button");
    article.setAttribute("aria-label", `Inspect ${example.title}`);
    const inspectExample = () => {
      state.mode = "single";
      selectExample(example.id);
    };
    article.addEventListener("click", inspectExample);
    article.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.code === "Space") {
        event.preventDefault();
        inspectExample();
      }
    });

    const thumbnailShell = document.createElement("div");
    thumbnailShell.className = "overview-thumbnail-shell";
    thumbnailShell.dataset.state = "loading";
    thumbnailShell.dataset.message = "Rendering thumbnail…";

    const thumbnail = document.createElement("img");
    thumbnail.className = "overview-thumbnail";
    thumbnail.alt = "";
    thumbnail.decoding = "async";
    thumbnail.loading = "lazy";
    thumbnail.setAttribute("aria-hidden", "true");
    thumbnailShell.append(thumbnail);

    const footer = document.createElement("footer");
    const title = document.createElement("strong");
    title.textContent = example.title;
    const inspect = document.createElement("span");
    inspect.className = "inspect-label";
    inspect.textContent = "Inspect";
    footer.append(title, inspect);
    article.append(thumbnailShell, footer);
    elements.overview.append(article);

    const cached = overviewThumbnailCache.get(example.id);
    if (cached) {
      applyOverviewThumbnailResult(thumbnailShell, thumbnail, cached);
      continue;
    }

    renderOverviewThumbnail(example).then((result) => {
      applyOverviewThumbnailResult(thumbnailShell, thumbnail, result);
    });
  }
}

function renderMode() {
  const hasExamples = state.examples.length > 0;
  elements.empty.hidden = hasExamples;
  elements.single.hidden = !hasExamples || state.mode !== "single";
  elements.overview.hidden = !hasExamples || state.mode !== "overview";
  elements.toggleView.setAttribute(
    "aria-current",
    String(state.mode === "overview"),
  );
  if (state.mode === "overview") {
    renderOverview();
    resumeOverviewThumbnails();
  } else {
    clearOverview();
    suspendOverviewThumbnails();
  }
}

function showOverview() {
  state.mode = "overview";
  const url = new URL(window.location.href);
  url.searchParams.delete("example");
  history.replaceState(null, "", url);
  syncListSelection({ reveal: true });
  renderMode();
}

function selectExample(id, { reload = true } = {}) {
  state.selectedId = id;
  const example = selectedExample();
  if (!example) return;

  state.mode = "single";
  state.dpr = Math.max(DEFAULT_GALLERY_DPR, example.defaultDpr);
  state.viewport = "responsive";
  state.debugMode = example.debugModes[0]?.value ?? "final";

  elements.dpr.value = String(state.dpr);
  elements.viewport.value = state.viewport;
  elements.timeScale.value = String(state.timeScale);
  updateDebugModes(example);
  elements.standalone.href = exampleUrl(example);
  elements.pause.textContent = state.paused ? "Resume" : "Pause";
  applyViewport();
  syncListSelection({ reveal: true });
  renderMode();

  if (reload) {
    setFrameStatus("loading");
    elements.frameMetrics.textContent = "";
    elements.frame.src = exampleUrl(example);
  }

  const url = new URL(window.location.href);
  url.searchParams.set("example", id);
  history.replaceState(null, "", url);
}

function applyFilter() {
  const query = elements.search.value.trim().toLowerCase();
  state.filtered = state.examples.filter((example) => {
    if (!query) return true;
    const haystack = [
      example.title,
      example.description,
      example.skill,
      example.backend,
      ...example.techniques,
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(query);
  });
  renderList();
  if (state.mode === "overview") renderOverview();
}

function setRuntimeSummary(label, status = "idle") {
  elements.runtimeSummary.textContent = label;
  elements.runtimeSummary.dataset.state = status;
}

async function loadExamples({ preserveSelection = true } = {}) {
  setRuntimeSummary("discovering", "loading");
  const response = await fetch("/api/examples", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Discovery failed with ${response.status}`);
  }
  const payload = await response.json();
  state.examples = payload.examples;
  state.filtered = payload.examples;
  elements.count.textContent = `${payload.count} ${
    payload.count === 1 ? "example" : "examples"
  }`;
  setRuntimeSummary("runtime ready", "ready");

  const requested = new URL(window.location.href).searchParams.get("example");
  const previous = preserveSelection && state.mode === "single"
    ? state.selectedId
    : null;
  const nextId = [requested, previous].find((id) =>
    state.examples.some((example) => example.id === id)
  ) ?? null;

  renderList();
  renderMode();
  if (nextId) selectExample(nextId);
}

function adjacentExample(offset) {
  if (state.filtered.length === 0) return;
  const index = state.filtered.findIndex(
    (example) => example.id === state.selectedId,
  );
  const next =
    (Math.max(index, 0) + offset + state.filtered.length) %
    state.filtered.length;
  selectExample(state.filtered[next].id);
}

elements.search.addEventListener("input", applyFilter);
elements.refresh.addEventListener("click", async () => {
  refreshPending = true;
  elements.refresh.classList.add("is-refreshing");
  try {
    await loadExamples();
  } catch (error) {
    setRuntimeSummary("discovery failed", "error");
    console.error(error);
  } finally {
    refreshPending = false;
  }
});

// Stop on a whole turn so the icon always lands where it started.
elements.refresh.addEventListener("animationiteration", () => {
  if (!refreshPending) elements.refresh.classList.remove("is-refreshing");
});
elements.toggleView.addEventListener("click", () => {
  if (state.mode === "overview") return;
  showOverview();
});
elements.viewport.addEventListener("change", () => {
  state.viewport = elements.viewport.value;
  applyViewport();
});
elements.dpr.addEventListener("change", () => {
  state.dpr = Number(elements.dpr.value);
  sendState();
});
elements.timeScale.addEventListener("change", () => {
  state.timeScale = Number(elements.timeScale.value);
  sendState();
});
elements.debugMode.addEventListener("change", () => {
  state.debugMode = elements.debugMode.value;
  sendState();
});
elements.pause.addEventListener("click", () => {
  state.paused = !state.paused;
  elements.pause.textContent = state.paused ? "Resume" : "Pause";
  sendState();
});
elements.reload.addEventListener("click", () => {
  const example = selectedExample();
  if (example) {
    setFrameStatus("loading");
    elements.frame.src = exampleUrl(example);
  }
});
elements.capture.addEventListener("click", () => {
  const example = selectedExample();
  if (!example) return;
  elements.frame.contentWindow?.postMessage(
    {
      source: "threejs-example-gallery",
      type: "capture",
      filename: `${example.slug}-${state.debugMode}.png`,
    },
    window.location.origin,
  );
});

elements.frame.addEventListener("load", () => {
  setFrameStatus("loaded");
  sendState();
  elements.frame.contentWindow?.postMessage(
    { source: "threejs-example-gallery", type: "ping" },
    window.location.origin,
  );
});

window.addEventListener("message", (event) => {
  if (event.origin !== window.location.origin) return;
  if (event.data?.source !== "threejs-example") return;

  // Only the inspected frame drives the status strip.
  if (event.source !== elements.frame.contentWindow) return;

  if (event.data.type === "ready") {
    setFrameStatus("ready", "ready");
  } else if (event.data.type === "runtime-error") {
    setFrameStatus(event.data.message || "runtime error", "error");
  } else if (event.data.type === "metrics") {
    elements.frameMetrics.textContent = Object.entries(event.data.metrics ?? {})
      .map(([key, value]) => `${key} ${value}`)
      .join(" · ");
  } else if (event.data.type === "capture") {
    const url = URL.createObjectURL(event.data.blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = event.data.filename ?? "example.png";
    anchor.click();
    URL.revokeObjectURL(url);
  } else if (event.data.type === "capture-error") {
    setFrameStatus(event.data.message, "error");
  }
});

window.addEventListener("pagehide", revokeOverviewThumbnailCache);

window.addEventListener("keydown", (event) => {
  const typing =
    event.target instanceof HTMLInputElement ||
    event.target instanceof HTMLSelectElement;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    elements.search.focus();
    return;
  }
  if (typing) return;

  if (event.key === "j" || event.key === "ArrowDown") {
    event.preventDefault();
    adjacentExample(1);
  } else if (event.key === "k" || event.key === "ArrowUp") {
    event.preventDefault();
    adjacentExample(-1);
  } else if (event.key.toLowerCase() === "r") {
    elements.reload.click();
  } else if (event.key.toLowerCase() === "g") {
    elements.toggleView.click();
  } else if (event.code === "Space") {
    event.preventDefault();
    elements.pause.click();
  }
});

loadExamples({ preserveSelection: false }).catch((error) => {
  setRuntimeSummary("discovery failed", "error");
  elements.empty.hidden = false;
  elements.empty.querySelector("h2").textContent = error.message;
});
