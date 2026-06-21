// ==UserScript==
// @name         S2 Wayfinder
// @namespace    local.pokemon-go.s2-cells
// @version      0.5.4
// @description  Draw red S2 level 14 and 17 cell overlays on the Pokemon GO/Campfire game map.
// @match        https://pokemongo.com/gamemap*
// @match        https://www.pokemongo.com/gamemap*
// @match        https://pokemongo.com/*/map*
// @match        https://www.pokemongo.com/*/map*
// @match        https://*.nianticlabs.com/gamesite/pgo*
// @match        https://*.eng.nianticlabs.com/gamesite/pgo*
// @updateURL    https://raw.githubusercontent.com/GHSASH/S2-Wayfinder/main/pokemon-go-s2-cells.user.js
// @downloadURL  https://raw.githubusercontent.com/GHSASH/S2-Wayfinder/main/pokemon-go-s2-cells.user.js
// @run-at       document-start
// @grant        unsafeWindow
// @author       GHSASH
// ==/UserScript==

(function () {
  "use strict";

  const W = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  const STORAGE_KEY = "pokemon-go-s2-cells-overlay";
  const MAP_MARKER = "__pokemonGoS2CellsOverlay";
  const RED = "#ff1f1f";
  const OCCUPIED_FILL = "rgba(255,31,31,0.14)";
  const DEFAULT_STATE = { 14: true, 17: true };
  const MIN_CELL_PIXELS = { 14: 16, 17: 14 };
  const MAX_CELLS = { 14: 1200, 17: 1400 };
  const MAX_SAMPLES = 700;
  const MAX_CAPTURE_TEXT_CHARS = 12000000;
  const MAX_CAPTURE_NODES = 200000;
  const ACTIVE_REDRAW_DELAY_MS = 220;
  const IDLE_REDRAW_DELAY_MS = 40;
  const RESIZE_REDRAW_DELAY_MS = 120;
  const POST_IDLE_INTERACTION_SUPPRESS_MS = 250;
  const FILTER_CLICK_MAX_AGE_MS = 1200;
  const VIEWPORT_PADDING_RATIO = 0.18;
  const MAP_PROTOTYPE_METHODS = [
    "setCenter",
    "setZoom",
    "panTo",
    "fitBounds",
    "getCenter",
    "getZoom",
    "getBounds",
    "getDiv",
  ];
  const FILTER_TYPES = {
    GYMS: "GYMS",
    POKESTOPS: "POKESTOPS",
  };
  const FILTER_PAIR_TYPES = new Set([FILTER_TYPES.GYMS, FILTER_TYPES.POKESTOPS]);
  const FILTER_BUTTON_CLASSES = {
    gymIcon: "_gT-l6GfuOz",
    pokestopIcon: "_h+ZX1vnjNv",
    selected: "_CjCMiZ+P7t",
    xIcon: "_r3A1EYTxcq",
  };

  const state = loadState();
  const attachedMaps = new WeakSet();
  const pendingMapAttachments = new WeakSet();
  const filterStateSubscribers = new Set();
  const occupiedCellsSubscribers = new Set();
  const occupiedL14Cells = new Map();
  const occupiedL17Cells = new Map();
  let selectedFilterTypes = new Set(readInitialFilterTypesFromUrl());
  let lastFilterClick = null;
  let occupiedCellsNotifyTimer = 0;
  let wrappedMapConstructor = null;
  let S2CanvasOverlayClass = null;

  installMapFilterHook();
  installFilterClickTracker();
  installMapObjectCaptureHooks();
  installGoogleHook();
  const filterHookPoll = W.setInterval(installMapFilterHook, 25);
  W.setTimeout(function () {
    W.clearInterval(filterHookPoll);
  }, 30000);
  const captureHookPoll = W.setInterval(installMapObjectCaptureHooks, 100);
  W.setTimeout(function () {
    W.clearInterval(captureHookPoll);
  }, 30000);
  const poll = W.setInterval(function () {
    if (tryWrapGoogleMap()) {
      W.clearInterval(poll);
    }
  }, 25);
  W.setTimeout(function () {
    W.clearInterval(poll);
  }, 30000);

  function loadState() {
    try {
      return Object.assign({}, DEFAULT_STATE, JSON.parse(W.localStorage.getItem(STORAGE_KEY) || "{}"));
    } catch (_) {
      return Object.assign({}, DEFAULT_STATE);
    }
  }

  function saveState() {
    try {
      W.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (_) {
      // Ignore storage failures in restricted frames.
    }
  }

  function readInitialFilterTypesFromUrl() {
    const types = [];
    try {
      const params = new URLSearchParams(W.location.search);
      for (const value of params.values()) {
        if (FILTER_PAIR_TYPES.has(value)) types.push(value);
      }
    } catch (_) {
      // The hook below will read the real provider state once React loads.
    }
    return types;
  }

  function installMapFilterHook() {
    try {
      const chunkName = "webpackChunk_N_E";
      const chunkQueue = W[chunkName] = W[chunkName] || [];

      for (const payload of chunkQueue) {
        wrapWebpackPayload(payload);
      }

      if (chunkQueue.__s2MapFilterPushAccessor) {
        if (chunkQueue.push && !chunkQueue.push.__s2MapFilterPushWrapped) {
          chunkQueue.push = chunkQueue.push;
        }
        return;
      }

      let pushValue = wrapWebpackPushFunction(chunkQueue.push);
      try {
        Object.defineProperty(chunkQueue, "push", {
          configurable: true,
          get: function () {
            return pushValue;
          },
          set: function (nextPush) {
            pushValue = wrapWebpackPushFunction(nextPush);
          },
        });
        safeDefine(chunkQueue, "__s2MapFilterPushAccessor", { value: true });
      } catch (_) {
        chunkQueue.push = pushValue;
      }
    } catch (_) {
      // If the webpack queue is unavailable, the DOM fallback still gates the grid.
    }
  }

  function wrapWebpackPushFunction(originalPush) {
    if (typeof originalPush !== "function" || originalPush.__s2MapFilterPushWrapped) return originalPush;

    function wrappedPush() {
      for (const payload of arguments) {
        wrapWebpackPayload(payload);
      }
      return originalPush.apply(this, arguments);
    }

    copyStatics(originalPush, wrappedPush);
    safeDefine(wrappedPush, "__s2MapFilterPushWrapped", { value: true });
    return wrappedPush;
  }

  function wrapWebpackPayload(payload) {
    if (!payload || !payload[1] || typeof payload[1] !== "object") return;
    const modules = payload[1];
    for (const moduleId of Object.keys(modules)) {
      const factory = modules[moduleId];
      if (typeof factory !== "function" || factory.__s2MapFilterFactoryWrapped) continue;

      const source = functionSource(factory);
      if (moduleId !== "36406" && !looksLikeContextHookModule(source)) {
        continue;
      }

      const wrappedFactory = function (module, exports, require) {
        factory.call(this, module, exports, require);
        patchMapFilterExports(exports);
      };
      copyStatics(factory, wrappedFactory);
      safeDefine(wrappedFactory, "__s2MapFilterFactoryWrapped", { value: true });
      modules[moduleId] = wrappedFactory;
    }
  }

  function functionSource(fn) {
    try {
      return Function.prototype.toString.call(fn);
    } catch (_) {
      return "";
    }
  }

  function looksLikeContextHookModule(source) {
    return source.indexOf("useContext") !== -1 && source.length < 1200;
  }

  function patchMapFilterExports(exports) {
    if (!exports || typeof exports !== "object") return;
    const keys = Array.from(new Set(Object.keys(exports).concat(["Z", "default"])));
    for (const key of keys) {
      patchMapFilterExport(exports, key);
    }
  }

  function patchMapFilterExport(exports, key) {
    let original;
    try {
      original = exports[key];
    } catch (_) {
      return;
    }
    if (typeof original !== "function" || original.__s2MapFilterHookWrapped) return;

    const wrapped = function () {
      const value = original.apply(this, arguments);
      return patchMapFilterContext(value);
    };
    copyStatics(original, wrapped);
    safeDefine(wrapped, "__s2MapFilterHookWrapped", { value: true });

    try {
      exports[key] = wrapped;
      return;
    } catch (_) {
      // Fall through to defineProperty for configurable exports.
    }

    try {
      const descriptor = Object.getOwnPropertyDescriptor(exports, key);
      if (descriptor && descriptor.configurable) {
        Object.defineProperty(exports, key, {
          configurable: true,
          enumerable: descriptor.enumerable,
          writable: true,
          value: wrapped,
        });
      }
    } catch (_) {
      // Non-writable export, leave it unchanged.
    }
  }

  function patchMapFilterContext(context) {
    if (!context || typeof context !== "object") return context;
    if (!Array.isArray(context.selectedMapFilters)) return context;
    if (typeof context.setSelectedMapFilterTypes !== "function") return context;

    setSelectedFilterTypes(context.selectedMapFilters);
    if (context.setSelectedMapFilterTypes.__s2MapFilterSetterWrapped) return context;

    const originalSetter = context.setSelectedMapFilterTypes;
    const wrappedSetter = function (nextTypes) {
      const adjustedTypes = adjustMapFilterTypesForClick(context, nextTypes);
      if (adjustedTypes) {
        setSelectedFilterTypes(adjustedTypes);
        return originalSetter.call(this, adjustedTypes);
      }

      setSelectedFilterTypes(nextTypes);
      return originalSetter.apply(this, arguments);
    };

    copyStatics(originalSetter, wrappedSetter);
    safeDefine(wrappedSetter, "__s2MapFilterSetterWrapped", { value: true });
    try {
      context.setSelectedMapFilterTypes = wrappedSetter;
    } catch (_) {
      // If the context value is immutable, we keep read-only filter tracking.
    }
    return context;
  }

  function adjustMapFilterTypesForClick(context, nextTypes) {
    const next = normalizeFilterTypes(nextTypes);
    const clickedType = getRecentFilterInteractionType();
    const currentPair = new Set(normalizeFilterTypes(context.selectedMapFilters).filter((type) => FILTER_PAIR_TYPES.has(type)));

    if (next.length === 1 && FILTER_PAIR_TYPES.has(next[0])) {
      currentPair.add(next[0]);
      return Array.from(currentPair);
    }

    if (!next.length && clickedType && FILTER_PAIR_TYPES.has(clickedType)) {
      if (currentPair.has(clickedType)) {
        currentPair.delete(clickedType);
      } else {
        currentPair.add(clickedType);
      }
      return Array.from(currentPair);
    }

    return null;
  }

  function normalizeFilterTypes(filtersOrTypes) {
    const values = Array.isArray(filtersOrTypes) ? filtersOrTypes : (filtersOrTypes ? [filtersOrTypes] : []);
    const types = [];
    for (const value of values) {
      let type = null;
      if (typeof value === "string") {
        type = value;
      } else if (value && typeof value.mapFilterType === "string") {
        type = value.mapFilterType;
      }

      if (type && types.indexOf(type) === -1) {
        types.push(type);
      }
    }
    return types;
  }

  function setSelectedFilterTypes(filtersOrTypes) {
    const next = new Set(normalizeFilterTypes(filtersOrTypes));
    if (setsEqual(selectedFilterTypes, next)) return;
    selectedFilterTypes = next;
    notifyFilterStateSubscribers();
  }

  function subscribeToFilterState(handler) {
    filterStateSubscribers.add(handler);
    return function () {
      filterStateSubscribers.delete(handler);
    };
  }

  function notifyFilterStateSubscribers() {
    for (const handler of Array.from(filterStateSubscribers)) {
      try {
        handler();
      } catch (_) {
        // A stale overlay should not prevent other overlays from updating.
      }
    }
  }

  function setsEqual(a, b) {
    if (a.size !== b.size) return false;
    for (const value of a) {
      if (!b.has(value)) return false;
    }
    return true;
  }

  function installFilterClickTracker() {
    const recordFilterClick = function (event) {
      const type = inferFilterTypeFromElement(event.target);
      if (!type) return;
      lastFilterClick = { type, time: nowMs() };
      W.setTimeout(refreshFilterStateFromDom, 80);
      W.setTimeout(refreshFilterStateFromDom, 300);
    };

    try {
      document.addEventListener("pointerdown", recordFilterClick, true);
      document.addEventListener("click", recordFilterClick, true);
    } catch (_) {
      // Document may not be ready in unusual userscript sandboxes.
    }

    W.setTimeout(refreshFilterStateFromDom, 1000);
    W.setTimeout(refreshFilterStateFromDom, 3000);
  }

  function getRecentFilterInteractionType() {
    if (lastFilterClick && nowMs() - lastFilterClick.time <= FILTER_CLICK_MAX_AGE_MS) {
      return lastFilterClick.type;
    }

    try {
      return inferFilterTypeFromElement(document.activeElement);
    } catch (_) {
      return null;
    }
  }

  function refreshFilterStateFromDom() {
    const domState = readFilterTypesFromDom();
    if (domState.seen) {
      setSelectedFilterTypes(domState.types);
    }
  }

  function isPokestopFilterActive() {
    const domState = readFilterTypesFromDom();
    if (domState.seen) {
      return domState.types.indexOf(FILTER_TYPES.POKESTOPS) !== -1;
    }
    return selectedFilterTypes.has(FILTER_TYPES.POKESTOPS);
  }

  function readFilterTypesFromDom() {
    const types = [];
    let seen = false;
    let candidates = [];

    try {
      candidates = Array.from(document.querySelectorAll("button,[role='button'],ion-button"));
    } catch (_) {
      return { seen: false, types };
    }

    for (const candidate of candidates) {
      const type = inferFilterTypeFromButton(candidate);
      if (!type) continue;
      seen = true;
      if (isFilterButtonSelected(candidate) && types.indexOf(type) === -1) {
        types.push(type);
      }
    }

    return { seen, types };
  }

  function inferFilterTypeFromElement(target) {
    let element = target && target.nodeType === 1 ? target : target && target.parentElement;
    for (let depth = 0; element && depth < 8; depth += 1, element = element.parentElement) {
      if (element === document.body || element === document.documentElement) return null;

      const iconType = inferFilterTypeFromClasses(element);
      if (iconType) return iconType;

      if (isButtonLike(element)) {
        const buttonType = inferFilterTypeFromButton(element);
        if (buttonType) return buttonType;
      }
    }
    return null;
  }

  function inferFilterTypeFromButton(element) {
    const iconType = inferFilterTypeFromClasses(element);
    if (iconType) return iconType;

    const text = normalizeFilterText(element.textContent);
    if (/\bpokestops?\b/.test(text) || /\bpoke stops?\b/.test(text) || /\bpokeparadas?\b/.test(text) || /\bpoke paradas?\b/.test(text)) {
      return FILTER_TYPES.POKESTOPS;
    }
    if (/\bgyms?\b/.test(text) || /\bginasios?\b/.test(text) || /\bgimnasios?\b/.test(text)) {
      return FILTER_TYPES.GYMS;
    }
    return null;
  }

  function inferFilterTypeFromClasses(element) {
    if (hasClassDeep(element, FILTER_BUTTON_CLASSES.pokestopIcon)) return FILTER_TYPES.POKESTOPS;
    if (hasClassDeep(element, FILTER_BUTTON_CLASSES.gymIcon)) return FILTER_TYPES.GYMS;
    return null;
  }

  function isFilterButtonSelected(element) {
    if (classListContains(element, FILTER_BUTTON_CLASSES.selected)) return true;
    if (hasClassDeep(element, FILTER_BUTTON_CLASSES.xIcon)) return true;
    return element.getAttribute("aria-pressed") === "true" || element.getAttribute("aria-selected") === "true";
  }

  function isButtonLike(element) {
    if (!element || !element.matches) return false;
    try {
      return element.matches("button,[role='button'],ion-button");
    } catch (_) {
      return false;
    }
  }

  function hasClassDeep(element, className) {
    if (!element) return false;
    if (classListContains(element, className)) return true;
    if (!element.querySelectorAll) return false;

    let descendants = [];
    try {
      descendants = element.querySelectorAll("[class]");
    } catch (_) {
      return false;
    }

    for (const descendant of descendants) {
      if (classListContains(descendant, className)) return true;
    }
    return false;
  }

  function classListContains(element, className) {
    try {
      if (element.classList && element.classList.contains(className)) return true;
    } catch (_) {
      // Some SVG className values are animated objects.
    }

    try {
      return String(element.getAttribute("class") || "").split(/\s+/).indexOf(className) !== -1;
    } catch (_) {
      return false;
    }
  }

  function normalizeFilterText(text) {
    try {
      return String(text || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
    } catch (_) {
      return "";
    }
  }

  function nowMs() {
    return W.performance && typeof W.performance.now === "function" ? W.performance.now() : Date.now();
  }

  function installMapObjectCaptureHooks() {
    installFetchCaptureHook();
    installXhrCaptureHook();
  }

  function installFetchCaptureHook() {
    const originalFetch = W.fetch;
    if (typeof originalFetch !== "function" || originalFetch.__s2MapObjectCaptureWrapped) return;

    function wrappedFetch() {
      const result = originalFetch.apply(this, arguments);
      try {
        result.then(captureMapObjectsFromResponse).catch(function () {});
      } catch (_) {
        // Fetch should behave exactly as the page expects.
      }
      return result;
    }

    copyStatics(originalFetch, wrappedFetch);
    safeDefine(wrappedFetch, "__s2MapObjectCaptureWrapped", { value: true });
    try {
      W.fetch = wrappedFetch;
    } catch (_) {
      // Some pages lock fetch; XHR/provider hooks still cover normal loading.
    }
  }

  function installXhrCaptureHook() {
    const Xhr = W.XMLHttpRequest;
    if (!Xhr || !Xhr.prototype || Xhr.prototype.__s2MapObjectCaptureWrapped) return;

    const proto = Xhr.prototype;
    const originalOpen = proto.open;
    const originalSend = proto.send;
    if (typeof originalOpen !== "function" || typeof originalSend !== "function") return;

    proto.open = function (method, url) {
      this.__s2MapObjectCaptureUrl = url ? String(url) : "";
      return originalOpen.apply(this, arguments);
    };

    proto.send = function () {
      try {
        this.addEventListener("load", function () {
          try {
            if (this.responseType && this.responseType !== "text" && this.responseType !== "json") return;
            if (this.responseType === "json") {
              captureMapObjectsFromJson(this.response);
              return;
            }
            captureMapObjectsFromText(this.responseText, this.responseURL || this.__s2MapObjectCaptureUrl || "");
          } catch (_) {
            // Ignore responses that do not expose text safely.
          }
        });
      } catch (_) {
        // Keep the page request untouched if event subscription fails.
      }
      return originalSend.apply(this, arguments);
    };

    safeDefine(proto, "__s2MapObjectCaptureWrapped", { value: true });
  }

  function captureMapObjectsFromResponse(response) {
    if (!response || typeof response.clone !== "function") return;
    if (!shouldInspectResponse(response.url, response.headers)) return;

    try {
      response.clone().text().then(function (text) {
        captureMapObjectsFromText(text, response.url || "");
      }).catch(function () {});
    } catch (_) {
      // Ignore unreadable/streaming responses.
    }
  }

  function shouldInspectResponse(url, headers) {
    let contentType = "";
    try {
      contentType = headers && typeof headers.get === "function" ? String(headers.get("content-type") || "").toLowerCase() : "";
    } catch (_) {
      contentType = "";
    }

    const requestUrl = String(url || "");
    return (
      contentType.indexOf("json") !== -1 ||
      requestUrl.indexOf("graphql") !== -1 ||
      requestUrl.indexOf("api") !== -1 ||
      requestUrl.indexOf("map") !== -1
    );
  }

  function captureMapObjectsFromText(text, url) {
    if (typeof text !== "string" || !text || text.length > MAX_CAPTURE_TEXT_CHARS) return;
    if (!looksLikeMapObjectsPayload(text, url)) return;

    try {
      captureMapObjectsFromJson(JSON.parse(text));
    } catch (_) {
      // Not a JSON response we can inspect.
    }
  }

  function looksLikeMapObjectsPayload(text, url) {
    return (
      text.indexOf("mapObjectType") !== -1 ||
      text.indexOf("pgoGym") !== -1 ||
      text.indexOf("pgoPokestop") !== -1 ||
      text.indexOf("PGO_GYM") !== -1 ||
      text.indexOf("PGO_POKESTOP") !== -1 ||
      String(url || "").indexOf("MapObjectsByS2Cells") !== -1
    );
  }

  function captureMapObjectsFromJson(root) {
    if (!root || typeof root !== "object") return;

    const seen = new WeakSet();
    let inspected = 0;
    let added = 0;

    function visit(value) {
      if (!value || typeof value !== "object" || inspected > MAX_CAPTURE_NODES) return;
      inspected += 1;

      if (seen.has(value)) return;
      seen.add(value);

      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }

      const object = extractMapObject(value);
      if (object && addOccupiedMapObject(object)) {
        added += 1;
      }

      for (const key of Object.keys(value)) {
        visit(value[key]);
      }
    }

    visit(root);
    if (added) scheduleOccupiedCellsNotify();
  }

  function extractMapObject(value) {
    const mapObjectType = String(value.mapObjectType || value.type || "");
    const isGym = mapObjectType === "PGO_GYM" || Boolean(value.pgoGym);
    const isPokestop = mapObjectType === "PGO_POKESTOP" || Boolean(value.pgoPokestop) || Boolean(value.pokestop);
    if (!isGym && !isPokestop) return null;

    const point = isGym
      ? firstPoint(value.pgoGym, value.mapObjectLocation, value.location, value)
      : firstPoint(value.pgoPokestop, value.pokestop, value.mapObjectLocation, value.location, value);
    if (!point) return null;

    return {
      id: value.id || value.fortId || point.lat.toFixed(7) + "," + point.lng.toFixed(7),
      type: isGym ? "gym" : "pokestop",
      lat: point.lat,
      lng: point.lng,
    };
  }

  function firstPoint() {
    for (let i = 0; i < arguments.length; i += 1) {
      const point = readPoint(arguments[i]);
      if (point) return point;
    }
    return null;
  }

  function readPoint(value) {
    if (!value) return null;

    if (typeof value === "string") {
      return readPointString(value);
    }

    if (typeof value !== "object") return null;

    const direct = normalizePoint(value.latitude, value.longitude) || normalizePoint(value.lat, value.lng);
    if (direct) return direct;

    return (
      readPoint(value.location) ||
      readPoint(value.mapObjectLocation) ||
      readPoint(value.position) ||
      readPoint(value.coordinates)
    );
  }

  function readPointString(value) {
    const match = String(value).match(/-?\d+(?:\.\d+)?/g);
    if (!match || match.length < 2) return null;

    const first = Number(match[0]);
    const second = Number(match[1]);
    return normalizePoint(second, first) || normalizePoint(first, second);
  }

  function normalizePoint(lat, lng) {
    const latitude = Number(lat);
    const longitude = Number(lng);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
    return { lat: latitude, lng: longitude };
  }

  function addOccupiedMapObject(object) {
    const objectKey = object.type + ":" + object.id;
    const l17Cell = latLngToCell(object.lat, object.lng, 17);
    const added = addObjectToCellStats(occupiedL17Cells, l17Cell, object, objectKey);
    if (!added) return false;

    const l14Cell = latLngToCell(object.lat, object.lng, 14);
    addObjectToCellStats(occupiedL14Cells, l14Cell, object, objectKey);
    return true;
  }

  function addObjectToCellStats(statsMap, cell, object, objectKey) {
    const key = cellKey(cell);
    let entry = statsMap.get(key);
    if (!entry) {
      entry = { gyms: new Map(), pokestops: new Map() };
      statsMap.set(key, entry);
    }

    const bucket = object.type === "gym" ? entry.gyms : entry.pokestops;
    if (bucket.has(objectKey)) return false;

    bucket.set(objectKey, object);
    return true;
  }

  function isOccupiedL17Cell(cell) {
    const entry = occupiedL17Cells.get(cellKey(cell));
    return Boolean(entry && (entry.gyms.size || entry.pokestops.size));
  }

  function getL14CellSummary(cell) {
    const entry = occupiedL14Cells.get(cellKey(cell));
    const gyms = entry ? entry.gyms.size : 0;
    const pokestops = entry ? entry.pokestops.size : 0;
    const total = gyms + pokestops;
    const gymRule = getGymRule(total);
    return {
      gyms,
      pokestops,
      total,
      expectedGyms: gymRule.expectedGyms,
      expectedStops: gymRule.expectedStops,
      missingForNextGym: gymRule.missingForNextGym,
      nextGymNumber: gymRule.nextGymNumber,
      maxGymsReached: gymRule.maxGymsReached,
    };
  }

  function getGymRule(total) {
    if (total >= 20) {
      return {
        expectedStops: Math.max(17, total - 3),
        expectedGyms: 3,
        missingForNextGym: 0,
        nextGymNumber: null,
        maxGymsReached: true,
      };
    }

    if (total >= 6) {
      return {
        expectedStops: total - 2,
        expectedGyms: 2,
        missingForNextGym: 20 - total,
        nextGymNumber: 3,
        maxGymsReached: false,
      };
    }

    if (total >= 2) {
      return {
        expectedStops: total - 1,
        expectedGyms: 1,
        missingForNextGym: 6 - total,
        nextGymNumber: 2,
        maxGymsReached: false,
      };
    }

    return {
      expectedStops: total,
      expectedGyms: 0,
      missingForNextGym: 2 - total,
      nextGymNumber: 1,
      maxGymsReached: false,
    };
  }

  function formatStopCount(count) {
    return count + " stop" + (count === 1 ? "" : "s");
  }

  function formatGymCount(count) {
    return count + " gym" + (count === 1 ? "" : "s");
  }

  function scheduleOccupiedCellsNotify() {
    if (occupiedCellsNotifyTimer) return;
    occupiedCellsNotifyTimer = W.setTimeout(function () {
      occupiedCellsNotifyTimer = 0;
      for (const handler of Array.from(occupiedCellsSubscribers)) {
        try {
          handler();
        } catch (_) {
          // Ignore detached overlays.
        }
      }
    }, IDLE_REDRAW_DELAY_MS);
  }

  function subscribeToOccupiedCells(handler) {
    occupiedCellsSubscribers.add(handler);
    return function () {
      occupiedCellsSubscribers.delete(handler);
    };
  }

  function installGoogleHook() {
    const existing = W.google;
    let googleValue = existing;

    function observeGoogle(value) {
      googleValue = value;
      if (!value || value.__s2CellsObserved) return;
      safeDefine(value, "__s2CellsObserved", { value: true });
      hookNestedProperty(value, "maps", observeMaps);
      if (value.maps) observeMaps(value.maps);
    }

    try {
      Object.defineProperty(W, "google", {
        configurable: true,
        get: function () {
          return googleValue;
        },
        set: function (value) {
          observeGoogle(value);
        },
      });
      if (existing) observeGoogle(existing);
    } catch (_) {
      // If the page already locked window.google, polling below is enough.
    }
  }

  function observeMaps(maps) {
    if (!maps || maps.__s2CellsObserved) return;
    safeDefine(maps, "__s2CellsObserved", { value: true });
    installMapConstructorHook(maps);
    installImportLibraryHook(maps);
    tryWrapGoogleMap();
  }

  function hookNestedProperty(object, prop, onSet) {
    let value = object[prop];
    try {
      Object.defineProperty(object, prop, {
        configurable: true,
        get: function () {
          return value;
        },
        set: function (next) {
          value = next;
          onSet(next);
        },
      });
      if (value) onSet(value);
    } catch (_) {
      if (value) onSet(value);
    }
  }

  function safeDefine(object, key, descriptor) {
    try {
      Object.defineProperty(object, key, Object.assign({ configurable: true }, descriptor));
    } catch (_) {
      // Non-critical marker.
    }
  }

  function tryWrapGoogleMap() {
    const maps = W.google && W.google.maps;
    if (!maps || typeof maps.Map !== "function") return false;

    const wrapped = wrapMapConstructor(maps.Map);
    try {
      if (maps.Map !== wrapped) maps.Map = wrapped;
      wrappedMapConstructor = maps.Map;
      return true;
    } catch (_) {
      wrappedMapConstructor = wrapped;
      return false;
    }
  }

  function installMapConstructorHook(maps) {
    if (!maps || maps.__s2CellsMapAccessor) return;

    let mapValue = maps.Map;
    try {
      Object.defineProperty(maps, "Map", {
        configurable: true,
        enumerable: true,
        get: function () {
          return mapValue;
        },
        set: function (next) {
          mapValue = wrapMapConstructor(next);
          if (mapValue) wrappedMapConstructor = mapValue;
        },
      });
      safeDefine(maps, "__s2CellsMapAccessor", { value: true });
      if (mapValue) maps.Map = mapValue;
    } catch (_) {
      try {
        maps.Map = wrapMapConstructor(mapValue);
      } catch (__) {
        // Polling and prototype hooks may still catch an already-created map.
      }
    }
  }

  function installImportLibraryHook(maps) {
    if (!maps || maps.__s2CellsImportLibraryAccessor) return;

    let importValue = maps.importLibrary;
    try {
      Object.defineProperty(maps, "importLibrary", {
        configurable: true,
        enumerable: true,
        get: function () {
          return importValue;
        },
        set: function (next) {
          importValue = wrapImportLibrary(next);
        },
      });
      safeDefine(maps, "__s2CellsImportLibraryAccessor", { value: true });
      if (importValue) maps.importLibrary = importValue;
    } catch (_) {
      try {
        maps.importLibrary = wrapImportLibrary(importValue);
      } catch (__) {
        // Older Maps builds may not expose importLibrary.
      }
    }
  }

  function wrapImportLibrary(originalImportLibrary) {
    if (typeof originalImportLibrary !== "function" || originalImportLibrary.__s2CellsImportLibraryWrapped) {
      return originalImportLibrary;
    }

    const wrappedImportLibrary = function () {
      const result = originalImportLibrary.apply(this, arguments);
      try {
        return Promise.resolve(result).then(function (library) {
          patchImportedMapsLibrary(library);
          return library;
        });
      } catch (_) {
        return result;
      }
    };

    copyStatics(originalImportLibrary, wrappedImportLibrary);
    safeDefine(wrappedImportLibrary, "__s2CellsImportLibraryWrapped", { value: true });
    return wrappedImportLibrary;
  }

  function patchImportedMapsLibrary(library) {
    if (!library || typeof library !== "object" || typeof library.Map !== "function") return;
    try {
      library.Map = wrapMapConstructor(library.Map);
    } catch (_) {
      // Some module namespace objects are read-only.
    }
  }

  function wrapMapConstructor(OriginalMap) {
    if (typeof OriginalMap !== "function") return OriginalMap;
    if (OriginalMap.__s2CellsWrapped) {
      patchMapPrototype(OriginalMap);
      return OriginalMap;
    }

    patchMapPrototype(OriginalMap);

    function WrappedMap() {
      const map = Reflect.construct(OriginalMap, arguments, new.target || WrappedMap);
      registerMapCandidate(map);
      return map;
    }

    try {
      Object.setPrototypeOf(WrappedMap, OriginalMap);
    } catch (_) {
      // Static copying below covers normal Maps constructor usage.
    }
    WrappedMap.prototype = OriginalMap.prototype;
    copyStatics(OriginalMap, WrappedMap);
    safeDefine(WrappedMap, "__s2CellsWrapped", { value: true });
    safeDefine(WrappedMap, "__s2CellsOriginalMap", { value: OriginalMap });
    return WrappedMap;
  }

  function patchMapPrototype(MapCtor) {
    const proto = MapCtor && MapCtor.prototype;
    if (!proto || proto.__s2CellsPrototypePatched) return;

    for (const method of MAP_PROTOTYPE_METHODS) {
      const original = proto[method];
      if (typeof original !== "function" || original.__s2CellsMapMethodWrapped) continue;

      const wrapped = function () {
        registerMapCandidate(this);
        return original.apply(this, arguments);
      };
      copyStatics(original, wrapped);
      safeDefine(wrapped, "__s2CellsMapMethodWrapped", { value: true });

      try {
        proto[method] = wrapped;
      } catch (_) {
        // Native descriptors may be locked in some Maps builds.
      }
    }

    safeDefine(proto, "__s2CellsPrototypePatched", { value: true });
  }

  function registerMapCandidate(map) {
    if (!isGoogleMapLike(map)) return map;
    if (attachedMaps.has(map) || map[MAP_MARKER] || pendingMapAttachments.has(map)) return map;
    pendingMapAttachments.add(map);
    try {
      W.setTimeout(function () {
        pendingMapAttachments.delete(map);
        attachToMap(map);
      }, 0);
    } catch (_) {
      pendingMapAttachments.delete(map);
      attachToMap(map);
    }
    return map;
  }

  function isGoogleMapLike(map) {
    return Boolean(
      map &&
      typeof map.getDiv === "function" &&
      typeof map.getCenter === "function" &&
      typeof map.getZoom === "function"
    );
  }

  function copyStatics(source, target) {
    for (const name of Object.getOwnPropertyNames(source)) {
      if (name === "prototype" || name === "length" || name === "name") continue;
      try {
        Object.defineProperty(target, name, Object.getOwnPropertyDescriptor(source, name));
      } catch (_) {
        // Some native descriptors are not copyable.
      }
    }
  }

  function attachToMap(map) {
    if (!map || attachedMaps.has(map) || map[MAP_MARKER]) return;
    const maps = W.google && W.google.maps;
    if (!maps || !maps.OverlayView) return;

    attachedMaps.add(map);
    const OverlayClass = getS2CanvasOverlayClass(maps);
    const overlay = new OverlayClass(map, maps);
    map[MAP_MARKER] = overlay;
    overlay.setMap(map);
    installControl(map, overlay, maps);
  }

  function getS2CanvasOverlayClass(maps) {
    if (S2CanvasOverlayClass) return S2CanvasOverlayClass;

    S2CanvasOverlayClass = class S2CanvasOverlay extends maps.OverlayView {
      constructor(map, mapsApi) {
        super();
        this.map = map;
        this.maps = mapsApi;
        this.canvas = null;
        this.ctx = null;
        this.tooltip = null;
        this.mapDiv = null;
        this.resizeObserver = null;
        this.frame = 0;
        this.hoverFrame = 0;
        this.timer = 0;
        this.forceNextDraw = false;
        this.listeners = [];
        this.visibleLevels = new Set();
        this.lastMousePosition = null;
        this.isInteracting = false;
        this.suppressInteractionUntil = 0;
        this.unsubscribeFilterState = null;
        this.unsubscribeOccupiedCells = null;
        this.onMapMouseMove = (event) => this.scheduleTooltipUpdate(event);
        this.onMapMouseLeave = () => this.hideTooltip();
      }

      onAdd() {
        const mapDiv = this.map.getDiv();
        this.mapDiv = mapDiv;
        this.canvas = document.createElement("canvas");
        this.canvas.className = "pokemon-go-s2-cells-canvas";
        Object.assign(this.canvas.style, {
          position: "absolute",
          inset: "0",
          width: "100%",
          height: "100%",
          pointerEvents: "none",
          zIndex: "80",
        });
        this.ctx = this.canvas.getContext("2d");
        mapDiv.appendChild(this.canvas);

        this.tooltip = document.createElement("div");
        this.tooltip.className = "pokemon-go-s2-cells-tooltip";
        Object.assign(this.tooltip.style, {
          background: "rgba(20,20,20,0.92)",
          border: "1px solid rgba(255,255,255,0.18)",
          borderRadius: "4px",
          boxShadow: "0 2px 8px rgba(0,0,0,0.28)",
          color: "#fff",
          display: "none",
          font: "12px/1.35 Arial, sans-serif",
          left: "0",
          maxWidth: "240px",
          padding: "7px 9px",
          pointerEvents: "none",
          position: "absolute",
          top: "0",
          whiteSpace: "nowrap",
          zIndex: "90",
        });
        mapDiv.appendChild(this.tooltip);

        if (W.ResizeObserver) {
          this.resizeObserver = new W.ResizeObserver(() => this.scheduleDraw(RESIZE_REDRAW_DELAY_MS, true));
          this.resizeObserver.observe(mapDiv);
        }

        this.unsubscribeFilterState = subscribeToFilterState(() => this.scheduleDraw(IDLE_REDRAW_DELAY_MS, true));
        this.unsubscribeOccupiedCells = subscribeToOccupiedCells(() => this.scheduleDraw(IDLE_REDRAW_DELAY_MS, true));

        const event = this.maps.event;
        this.listeners.push(event.addListener(this.map, "bounds_changed", () => this.beginInteraction(false)));
        this.listeners.push(event.addListener(this.map, "center_changed", () => this.beginInteraction(false)));
        this.listeners.push(event.addListener(this.map, "zoom_changed", () => this.beginInteraction(true)));
        this.listeners.push(event.addListener(this.map, "dragstart", () => this.beginInteraction(true)));
        this.listeners.push(event.addListener(this.map, "dragend", () => this.endInteraction()));
        this.listeners.push(event.addListener(this.map, "idle", () => this.endInteraction()));
        mapDiv.addEventListener("mousemove", this.onMapMouseMove, { passive: true });
        mapDiv.addEventListener("mouseleave", this.onMapMouseLeave, { passive: true });
        this.scheduleDraw(0, true);
      }

      draw() {
        this.scheduleDraw(this.isInteracting ? ACTIVE_REDRAW_DELAY_MS : IDLE_REDRAW_DELAY_MS);
      }

      onRemove() {
        if (this.frame) W.cancelAnimationFrame(this.frame);
        if (this.hoverFrame) W.cancelAnimationFrame(this.hoverFrame);
        if (this.timer) W.clearTimeout(this.timer);
        this.frame = 0;
        this.hoverFrame = 0;
        this.timer = 0;
        for (const listener of this.listeners) {
          this.maps.event.removeListener(listener);
        }
        this.listeners = [];
        if (this.unsubscribeFilterState) this.unsubscribeFilterState();
        if (this.unsubscribeOccupiedCells) this.unsubscribeOccupiedCells();
        this.unsubscribeFilterState = null;
        this.unsubscribeOccupiedCells = null;
        if (this.resizeObserver) this.resizeObserver.disconnect();
        if (this.mapDiv) {
          this.mapDiv.removeEventListener("mousemove", this.onMapMouseMove);
          this.mapDiv.removeEventListener("mouseleave", this.onMapMouseLeave);
        }
        if (this.tooltip && this.tooltip.parentNode) this.tooltip.parentNode.removeChild(this.tooltip);
        if (this.canvas && this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
        this.canvas = null;
        this.ctx = null;
        this.tooltip = null;
        this.mapDiv = null;
      }

      beginInteraction(force) {
        if (!force && nowMs() < this.suppressInteractionUntil) return;
        this.isInteracting = true;
        this.hideTooltip();
        this.setCanvasVisible(false);
        this.scheduleDraw(ACTIVE_REDRAW_DELAY_MS, force);
      }

      endInteraction() {
        this.isInteracting = false;
        this.suppressInteractionUntil = nowMs() + POST_IDLE_INTERACTION_SUPPRESS_MS;
        this.scheduleDraw(IDLE_REDRAW_DELAY_MS, true);
      }

      scheduleDraw(delay, force) {
        this.forceNextDraw = this.forceNextDraw || Boolean(force);
        if (this.timer) W.clearTimeout(this.timer);
        this.timer = W.setTimeout(() => {
          this.timer = 0;
          if (this.frame) return;
          this.frame = W.requestAnimationFrame(() => {
            const shouldForce = this.forceNextDraw;
            this.frame = 0;
            this.forceNextDraw = false;
            this.render(shouldForce);
          });
        }, Math.max(0, delay || 0));
      }

      setCanvasVisible(visible) {
        if (!this.canvas) return;
        const visibility = visible ? "visible" : "hidden";
        if (this.canvas.style.visibility !== visibility) {
          this.canvas.style.visibility = visibility;
        }
        if (!visible) this.hideTooltip();
      }

      render(force) {
        if (!this.canvas || !this.ctx) return;
        const enabledLevels = [17, 14].filter((level) => state[level]);
        if (!enabledLevels.length || this.isInteracting) {
          this.visibleLevels = new Set();
          this.setCanvasVisible(false);
          return;
        }

        const projection = this.getProjection();
        const mapDiv = this.map.getDiv();
        if (!projection || !mapDiv) return;

        const rect = mapDiv.getBoundingClientRect();
        const width = Math.max(0, Math.round(rect.width));
        const height = Math.max(0, Math.round(rect.height));
        if (!width || !height) return;

        resizeCanvas(this.canvas, this.ctx, width, height);
        this.ctx.clearRect(0, 0, width, height);

        const visibleLevels = new Set();
        for (const level of enabledLevels) {
          if (this.drawLevel(level, projection, width, height)) visibleLevels.add(level);
        }
        this.visibleLevels = visibleLevels;
        this.setCanvasVisible(visibleLevels.size > 0);
        if (!this.canShowL14Tooltip()) this.hideTooltip();
      }

      drawLevel(level, projection, width, height) {
        const center = this.map.getCenter && this.map.getCenter();
        if (!center) return false;

        const centerCell = latLngToCell(center.lat(), center.lng(), level);
        const cellPixels = estimateCellPixels(centerCell, projection, this.maps, width, height);
        if (!Number.isFinite(cellPixels) || cellPixels < MIN_CELL_PIXELS[level]) return false;

        const cells = collectVisibleCells({
          level,
          map: this.map,
          projection,
          maps: this.maps,
          width,
          height,
          cellPixels,
          maxCells: MAX_CELLS[level] + 1,
        });
        if (!cells.length || cells.length > MAX_CELLS[level]) return false;

        const vertexCache = new Map();
        const projectedCache = new Map();
        const getVertex = (face, cellLevel, i, j) => {
          const key = face + "/" + cellLevel + "/" + i + "/" + j;
          let vertex = vertexCache.get(key);
          if (!vertex) {
            vertex = vertexLatLng(face, cellLevel, i, j);
            vertex.key = key;
            vertexCache.set(key, vertex);
          }
          return vertex;
        };
        const projectVertex = (vertex) => {
          if (!vertex) return null;
          let point = projectedCache.get(vertex.key);
          if (point === undefined) {
            point = projectLatLng(vertex, projection, this.maps);
            projectedCache.set(vertex.key, point);
          }
          return point;
        };
        const projectCellVertex = (cell, di, dj) => projectVertex(getVertex(cell.face, cell.level, cell.i + di, cell.j + dj));

        const edges = new Map();
        for (const cell of cells) {
          if (!cellTouchesViewport(cell, projectCellVertex, width, height)) continue;
          addCellEdges(edges, cell, getVertex);
        }

        const ctx = this.ctx;
        if (level === 17) {
          this.fillOccupiedCells(cells, projectCellVertex, width, height);
        }

        ctx.save();
        ctx.strokeStyle = RED;
        ctx.globalAlpha = level === 14 ? 0.95 : 0.58;
        ctx.lineWidth = level === 14 ? 1.8 : 1;
        ctx.beginPath();

        for (const edge of edges.values()) {
          const a = projectVertex(edge.a);
          const b = projectVertex(edge.b);
          if (!a || !b) continue;
          if (Math.abs(a.x - b.x) > width * 0.75 || Math.abs(a.y - b.y) > height * 0.75) continue;
          if (!segmentTouchesViewport(a, b, width, height)) continue;
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
        }

        ctx.stroke();
        ctx.restore();
        return true;
      }

      fillOccupiedCells(cells, projectCellVertex, width, height) {
        const ctx = this.ctx;
        let hasFill = false;

        ctx.save();
        ctx.fillStyle = OCCUPIED_FILL;
        ctx.beginPath();

        for (const cell of cells) {
          if (!isOccupiedL17Cell(cell)) continue;

          const points = [
            projectCellVertex(cell, 0, 0),
            projectCellVertex(cell, 1, 0),
            projectCellVertex(cell, 1, 1),
            projectCellVertex(cell, 0, 1),
          ];
          if (points.some((point) => !point)) continue;
          if (!cellPolygonCanDraw(points, width, height)) continue;

          ctx.moveTo(points[0].x, points[0].y);
          ctx.lineTo(points[1].x, points[1].y);
          ctx.lineTo(points[2].x, points[2].y);
          ctx.lineTo(points[3].x, points[3].y);
          ctx.closePath();
          hasFill = true;
        }

        if (hasFill) ctx.fill();
        ctx.restore();
      }

      canShowL14Tooltip() {
        return Boolean(
          this.tooltip &&
          this.mapDiv &&
          !this.isInteracting &&
          state[14] &&
          state[17] &&
          this.visibleLevels.has(17)
        );
      }

      scheduleTooltipUpdate(event) {
        if (!event || !this.mapDiv) return;
        if (event.target && event.target.closest && event.target.closest(".pokemon-go-s2-cells-control")) {
          this.hideTooltip();
          return;
        }
        this.lastMousePosition = { clientX: event.clientX, clientY: event.clientY };
        if (this.hoverFrame) return;

        this.hoverFrame = W.requestAnimationFrame(() => {
          this.hoverFrame = 0;
          this.updateL14Tooltip();
        });
      }

      updateL14Tooltip() {
        if (!this.canShowL14Tooltip() || !this.lastMousePosition) {
          this.hideTooltip();
          return;
        }

        const projection = this.getProjection();
        if (!projection) {
          this.hideTooltip();
          return;
        }

        const rect = this.mapDiv.getBoundingClientRect();
        const x = this.lastMousePosition.clientX - rect.left;
        const y = this.lastMousePosition.clientY - rect.top;
        if (x < 0 || y < 0 || x > rect.width || y > rect.height) {
          this.hideTooltip();
          return;
        }

        const latLng = containerPixelToLatLng(projection, this.maps, x, y);
        if (!latLng) {
          this.hideTooltip();
          return;
        }

        const cell = latLngToCell(latLng.lat(), latLng.lng(), 14);
        const summary = getL14CellSummary(cell);
        this.renderL14Tooltip(summary, x, y, rect.width, rect.height);
      }

      renderL14Tooltip(summary, x, y, width, height) {
        if (!this.tooltip) return;

        const lines = [
          "Pokestops: " + summary.pokestops,
          "Gyms: " + summary.gyms,
          "Total: " + summary.total
        ];

        if (!summary.maxGymsReached) lines.push("Next gym: " + summary.missingForNextGym + " pokestop" + (summary.missingForNextGym === 1 ? "" : "s"));

        this.tooltip.textContent = "";
        for (let i = 0; i < lines.length; i += 1) {
          const row = document.createElement("div");
          row.textContent = lines[i];
          if (i === 0) {
            row.style.fontWeight = "700";
            row.style.marginBottom = "3px";
          }
          this.tooltip.appendChild(row);
        }

        this.tooltip.style.display = "block";
        const tooltipRect = this.tooltip.getBoundingClientRect();
        const offset = 14;
        let left = x + offset;
        let top = y + offset;

        if (left + tooltipRect.width > width - 8) left = x - tooltipRect.width - offset;
        if (top + tooltipRect.height > height - 8) top = y - tooltipRect.height - offset;

        this.tooltip.style.left = Math.max(8, left) + "px";
        this.tooltip.style.top = Math.max(8, top) + "px";
      }

      hideTooltip() {
        if (this.tooltip && this.tooltip.style.display !== "none") {
          this.tooltip.style.display = "none";
        }
      }
    };

    return S2CanvasOverlayClass;
  }

  function resizeCanvas(canvas, ctx, width, height) {
    const dpr = Math.max(1, W.devicePixelRatio || 1);
    const targetWidth = Math.round(width * dpr);
    const targetHeight = Math.round(height * dpr);
    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      canvas.style.width = width + "px";
      canvas.style.height = height + "px";
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function installControl(map, overlay, maps) {
    const control = document.createElement("div");
    control.className = "pokemon-go-s2-cells-control";
    Object.assign(control.style, {
      background: "rgba(255,255,255,0.94)",
      border: "1px solid rgba(0,0,0,0.18)",
      borderRadius: "4px",
      boxShadow: "0 1px 4px rgba(0,0,0,0.25)",
      color: "#111",
      display: "flex",
      gap: "8px",
      margin: "10px",
      padding: "6px 8px",
      font: "12px/1.2 Arial, sans-serif",
      userSelect: "none",
    });

    control.appendChild(createToggle(14, overlay));
    control.appendChild(createToggle(17, overlay));

    maps.OverlayView.preventMapHitsAndGesturesFrom(control);
    map.controls[maps.ControlPosition.TOP_LEFT].push(control);
  }

  function createToggle(level, overlay) {
    const label = document.createElement("label");
    Object.assign(label.style, {
      alignItems: "center",
      cursor: "pointer",
      display: "flex",
      gap: "4px",
      whiteSpace: "nowrap",
    });

    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = Boolean(state[level]);
    input.style.accentColor = RED;
    input.addEventListener("change", function () {
      state[level] = input.checked;
      saveState();
      overlay.scheduleDraw(0, true);
    });

    const text = document.createElement("span");
    text.textContent = "S2 L" + level;

    label.appendChild(input);
    label.appendChild(text);
    return label;
  }

  function collectVisibleCells(options) {
    const boundsCells = collectVisibleCellsFromBounds(options);
    if (boundsCells.length) return boundsCells;
    return collectVisibleCellsBySampling(options);
  }

  function collectVisibleCellsFromBounds(options) {
    const { level, map, maxCells } = options;
    const boundsBox = getPaddedMapBoundsBox(map);
    const center = map && map.getCenter && map.getCenter();
    if (!boundsBox || !center) return [];

    const limit = Math.max(1, maxCells || MAX_CELLS[level] + 1);
    const start = latLngToCell(center.lat(), center.lng(), level);
    const cells = [];
    const queued = new Set([cellKey(start)]);
    const queue = [start];

    for (let index = 0; index < queue.length && cells.length <= limit; index += 1) {
      const cell = queue[index];
      if (!cellIntersectsBoundsBox(cell, boundsBox)) continue;

      cells.push(cell);
      if (cells.length > limit) break;

      for (const neighbor of getCellNeighbors(cell)) {
        const key = cellKey(neighbor);
        if (queued.has(key)) continue;
        queued.add(key);
        queue.push(neighbor);
      }
    }

    return cells;
  }

  function collectVisibleCellsBySampling(options) {
    const { level, projection, maps, width, height, cellPixels } = options;
    const cells = new Map();
    const step = clamp(cellPixels * 0.75, 24, 160);
    const sampleColumns = Math.ceil((width + step * 2) / step);
    const sampleRows = Math.ceil((height + step * 2) / step);
    const adjustedStep = sampleColumns * sampleRows > MAX_SAMPLES
      ? Math.sqrt(((width + step * 2) * (height + step * 2)) / MAX_SAMPLES)
      : step;

    for (let y = -adjustedStep; y <= height + adjustedStep; y += adjustedStep) {
      for (let x = -adjustedStep; x <= width + adjustedStep; x += adjustedStep) {
        const latLng = containerPixelToLatLng(projection, maps, x, y);
        if (!latLng) continue;
        const cell = latLngToCell(latLng.lat(), latLng.lng(), level);
        addCellAndNeighbors(cells, cell);
      }
    }

    const points = [
      [0, 0],
      [width / 2, 0],
      [width, 0],
      [0, height / 2],
      [width / 2, height / 2],
      [width, height / 2],
      [0, height],
      [width / 2, height],
      [width, height],
    ];
    for (const point of points) {
      const latLng = containerPixelToLatLng(projection, maps, point[0], point[1]);
      if (latLng) addCellAndNeighbors(cells, latLngToCell(latLng.lat(), latLng.lng(), level));
    }

    return Array.from(cells.values());
  }

  function addCellAndNeighbors(cells, cell) {
    for (let dj = -1; dj <= 1; dj += 1) {
      for (let di = -1; di <= 1; di += 1) {
        const neighbor = cellFromFaceIJ(cell.face, cell.level, cell.i + di, cell.j + dj);
        const key = cellKey(neighbor);
        if (!cells.has(key)) {
          cells.set(key, neighbor);
        }
      }
    }
  }

  function getPaddedMapBoundsBox(map) {
    const bounds = map && map.getBounds && map.getBounds();
    if (!bounds || typeof bounds.getNorthEast !== "function" || typeof bounds.getSouthWest !== "function") return null;

    const ne = bounds.getNorthEast();
    const sw = bounds.getSouthWest();
    if (!ne || !sw) return null;

    let north = Number(ne.lat());
    let south = Number(sw.lat());
    let east = wrapLng(Number(ne.lng()));
    let west = wrapLng(Number(sw.lng()));
    if (!Number.isFinite(north) || !Number.isFinite(south) || !Number.isFinite(east) || !Number.isFinite(west)) return null;

    if (south > north) {
      const tmp = south;
      south = north;
      north = tmp;
    }

    let lngSpan = east - west;
    if (lngSpan < 0) lngSpan += 360;

    const latPad = Math.max(0.0001, Math.abs(north - south) * VIEWPORT_PADDING_RATIO);
    const lngPad = Math.max(0.0001, lngSpan * VIEWPORT_PADDING_RATIO);

    return {
      north: Math.min(90, north + latPad),
      south: Math.max(-90, south - latPad),
      east: wrapLng(east + lngPad),
      west: wrapLng(west - lngPad),
    };
  }

  function cellIntersectsBoundsBox(cell, box) {
    const points = [
      cellCenterLatLng(cell),
      vertexLatLng(cell.face, cell.level, cell.i, cell.j),
      vertexLatLng(cell.face, cell.level, cell.i + 1, cell.j),
      vertexLatLng(cell.face, cell.level, cell.i + 1, cell.j + 1),
      vertexLatLng(cell.face, cell.level, cell.i, cell.j + 1),
    ];

    for (const point of points) {
      if (pointInBoundsBox(point, box)) return true;
    }

    let minLat = Infinity;
    let maxLat = -Infinity;
    const lngs = [];
    for (const point of points) {
      minLat = Math.min(minLat, point.lat);
      maxLat = Math.max(maxLat, point.lat);
      lngs.push(point.lng);
    }

    if (minLat > box.north || maxLat < box.south) return false;
    return lngRangeIntersectsBounds(lngs, box);
  }

  function pointInBoundsBox(point, box) {
    return (
      point &&
      point.lat >= box.south &&
      point.lat <= box.north &&
      lngInBoundsBox(point.lng, box)
    );
  }

  function lngInBoundsBox(lng, box) {
    const wrapped = wrapLng(lng);
    if (box.west <= box.east) return wrapped >= box.west && wrapped <= box.east;
    return wrapped >= box.west || wrapped <= box.east;
  }

  function lngRangeIntersectsBounds(lngs, box) {
    const west = box.west;
    let east = box.east;
    if (east < west) east += 360;

    let minLng = Infinity;
    let maxLng = -Infinity;
    for (const lng of lngs) {
      const unwrapped = unwrapLngNear(lng, west);
      minLng = Math.min(minLng, unwrapped);
      maxLng = Math.max(maxLng, unwrapped);
    }

    return maxLng >= west && minLng <= east;
  }

  function unwrapLngNear(lng, reference) {
    let value = wrapLng(lng);
    while (value - reference > 180) value -= 360;
    while (value - reference < -180) value += 360;
    return value;
  }

  function wrapLng(lng) {
    return ((((lng + 180) % 360) + 360) % 360) - 180;
  }

  function getCellNeighbors(cell) {
    return [
      cellFromFaceIJ(cell.face, cell.level, cell.i - 1, cell.j),
      cellFromFaceIJ(cell.face, cell.level, cell.i + 1, cell.j),
      cellFromFaceIJ(cell.face, cell.level, cell.i, cell.j - 1),
      cellFromFaceIJ(cell.face, cell.level, cell.i, cell.j + 1),
    ];
  }

  function cellFromFaceIJ(face, level, i, j) {
    const size = 1 << level;
    if (i >= 0 && j >= 0 && i < size && j < size) {
      return { face, level, i, j };
    }

    const s = (i + 0.5) / size;
    const t = (j + 0.5) / size;
    const xyz = normalize(faceUvToXyz(face, stToUv(s), stToUv(t)));
    const wrappedFace = xyzToFace(xyz);
    const uv = faceXyzToUv(wrappedFace, xyz);
    const wrappedI = clamp(Math.floor(uvToSt(uv.u) * size), 0, size - 1);
    const wrappedJ = clamp(Math.floor(uvToSt(uv.v) * size), 0, size - 1);
    return { face: wrappedFace, level, i: wrappedI, j: wrappedJ };
  }

  function cellKey(cell) {
    return cell.face + "/" + cell.level + "/" + cell.i + "/" + cell.j;
  }

  function addCellEdges(edges, cell, getVertex) {
    const f = cell.face;
    const l = cell.level;
    const i = cell.i;
    const j = cell.j;

    addEdge(edges, f, l, "h", j, i, getVertex(f, l, i, j), getVertex(f, l, i + 1, j));
    addEdge(edges, f, l, "v", i + 1, j, getVertex(f, l, i + 1, j), getVertex(f, l, i + 1, j + 1));
    addEdge(edges, f, l, "h", j + 1, i, getVertex(f, l, i + 1, j + 1), getVertex(f, l, i, j + 1));
    addEdge(edges, f, l, "v", i, j, getVertex(f, l, i, j + 1), getVertex(f, l, i, j));
  }

  function addEdge(edges, face, level, axis, fixed, offset, a, b) {
    const key = face + "/" + level + "/" + axis + "/" + fixed + "/" + offset;
    if (!edges.has(key)) edges.set(key, { a, b });
  }

  function estimateCellPixels(cell, projection, maps, width, height) {
    const vertices = [
      vertexLatLng(cell.face, cell.level, cell.i, cell.j),
      vertexLatLng(cell.face, cell.level, cell.i + 1, cell.j),
      vertexLatLng(cell.face, cell.level, cell.i + 1, cell.j + 1),
      vertexLatLng(cell.face, cell.level, cell.i, cell.j + 1),
    ].map((point) => projectLatLng(point, projection, maps));

    if (vertices.some((point) => !point)) return 0;
    const lengths = [];
    for (let i = 0; i < 4; i += 1) {
      const a = vertices[i];
      const b = vertices[(i + 1) % 4];
      if (Math.abs(a.x - b.x) > width * 0.75 || Math.abs(a.y - b.y) > height * 0.75) continue;
      lengths.push(Math.hypot(a.x - b.x, a.y - b.y));
    }
    if (!lengths.length) return 0;
    return lengths.reduce((sum, value) => sum + value, 0) / lengths.length;
  }

  function cellTouchesViewport(cell, projectCellVertex, width, height) {
    const points = [
      projectCellVertex(cell, 0, 0),
      projectCellVertex(cell, 1, 0),
      projectCellVertex(cell, 1, 1),
      projectCellVertex(cell, 0, 1),
    ].filter(Boolean);

    if (points.length < 4) return false;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const point of points) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
    const margin = 48;
    return maxX >= -margin && minX <= width + margin && maxY >= -margin && minY <= height + margin;
  }

  function segmentTouchesViewport(a, b, width, height) {
    const margin = 48;
    const minX = Math.min(a.x, b.x);
    const maxX = Math.max(a.x, b.x);
    const minY = Math.min(a.y, b.y);
    const maxY = Math.max(a.y, b.y);
    return maxX >= -margin && minX <= width + margin && maxY >= -margin && minY <= height + margin;
  }

  function cellPolygonCanDraw(points, width, height) {
    for (let i = 0; i < points.length; i += 1) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      if (Math.abs(a.x - b.x) > width * 0.75 || Math.abs(a.y - b.y) > height * 0.75) return false;
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const point of points) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }

    const margin = 48;
    return maxX >= -margin && minX <= width + margin && maxY >= -margin && minY <= height + margin;
  }

  function projectLatLng(point, projection, maps) {
    try {
      const latLng = new maps.LatLng(point.lat, point.lng);
      const projected = projection.fromLatLngToContainerPixel(latLng);
      return projected ? { x: projected.x, y: projected.y } : null;
    } catch (_) {
      return null;
    }
  }

  function containerPixelToLatLng(projection, maps, x, y) {
    try {
      const point = new maps.Point(x, y);
      return projection.fromContainerPixelToLatLng(point, true);
    } catch (_) {
      return null;
    }
  }

  function latLngToCell(latDeg, lngDeg, level) {
    const xyz = latLngToXyz(latDeg, lngDeg);
    const face = xyzToFace(xyz);
    const uv = faceXyzToUv(face, xyz);
    const s = uvToSt(uv.u);
    const t = uvToSt(uv.v);
    const size = 1 << level;
    return {
      face,
      level,
      i: clamp(Math.floor(s * size), 0, size - 1),
      j: clamp(Math.floor(t * size), 0, size - 1),
    };
  }

  function vertexLatLng(face, level, i, j) {
    return cellLatLngAt(face, level, i, j);
  }

  function cellCenterLatLng(cell) {
    return cellLatLngAt(cell.face, cell.level, cell.i + 0.5, cell.j + 0.5);
  }

  function cellLatLngAt(face, level, i, j) {
    const size = 1 << level;
    const u = stToUv(i / size);
    const v = stToUv(j / size);
    const xyz = normalize(faceUvToXyz(face, u, v));
    return xyzToLatLng(xyz);
  }

  function latLngToXyz(latDeg, lngDeg) {
    const lat = latDeg * Math.PI / 180;
    const lng = lngDeg * Math.PI / 180;
    const cosLat = Math.cos(lat);
    return {
      x: Math.cos(lng) * cosLat,
      y: Math.sin(lng) * cosLat,
      z: Math.sin(lat),
    };
  }

  function xyzToLatLng(xyz) {
    return {
      lat: Math.atan2(xyz.z, Math.sqrt(xyz.x * xyz.x + xyz.y * xyz.y)) * 180 / Math.PI,
      lng: Math.atan2(xyz.y, xyz.x) * 180 / Math.PI,
    };
  }

  function xyzToFace(xyz) {
    const ax = Math.abs(xyz.x);
    const ay = Math.abs(xyz.y);
    const az = Math.abs(xyz.z);
    if (ax > ay && ax > az) return xyz.x < 0 ? 3 : 0;
    if (ay > az) return xyz.y < 0 ? 4 : 1;
    return xyz.z < 0 ? 5 : 2;
  }

  function faceXyzToUv(face, xyz) {
    switch (face) {
      case 0: return { u: xyz.y / xyz.x, v: xyz.z / xyz.x };
      case 1: return { u: -xyz.x / xyz.y, v: xyz.z / xyz.y };
      case 2: return { u: -xyz.x / xyz.z, v: -xyz.y / xyz.z };
      case 3: return { u: xyz.z / xyz.x, v: xyz.y / xyz.x };
      case 4: return { u: xyz.z / xyz.y, v: -xyz.x / xyz.y };
      default: return { u: -xyz.y / xyz.z, v: -xyz.x / xyz.z };
    }
  }

  function faceUvToXyz(face, u, v) {
    switch (face) {
      case 0: return { x: 1, y: u, z: v };
      case 1: return { x: -u, y: 1, z: v };
      case 2: return { x: -u, y: -v, z: 1 };
      case 3: return { x: -1, y: -v, z: -u };
      case 4: return { x: v, y: -1, z: -u };
      default: return { x: v, y: u, z: -1 };
    }
  }

  function uvToSt(uv) {
    return uv >= 0 ? 0.5 * Math.sqrt(1 + 3 * uv) : 1 - 0.5 * Math.sqrt(1 - 3 * uv);
  }

  function stToUv(st) {
    return st >= 0.5 ? (4 * st * st - 1) / 3 : (1 - 4 * (1 - st) * (1 - st)) / 3;
  }

  function normalize(xyz) {
    const norm = Math.hypot(xyz.x, xyz.y, xyz.z);
    return {
      x: xyz.x / norm,
      y: xyz.y / norm,
      z: xyz.z / norm,
    };
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  W.__pokemonGoS2Cells = {
    attachToMap,
    get state() {
      return Object.assign({}, state);
    },
    get selectedFilterTypes() {
      return Array.from(selectedFilterTypes);
    },
    get pokestopFilterActive() {
      return isPokestopFilterActive();
    },
    get occupiedL17CellCount() {
      return occupiedL17Cells.size;
    },
    get occupiedL14CellCount() {
      return occupiedL14Cells.size;
    },
    wrappedMapConstructor: function () {
      return wrappedMapConstructor;
    },
  };
})();
