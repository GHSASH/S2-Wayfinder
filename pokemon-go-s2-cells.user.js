// ==UserScript==
// @name         S2 Wayfinder
// @namespace    local.pokemon-go.s2-cells
// @version      0.6.0
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
  const INTERACTION_RADIUS_METERS = 20;
  const INTERACTION_RADIUS_COLOR = "#00a6ff";
  const NEAR_GYM_FILL = {
    1: { color: "#ffd400", opacity: 0.30 },
    2: { color: "#ffe680", opacity: 0.18 },
  };
  const EXTRA_MAP_DROP_TYPES = ["PGO_POKESTOP"];
  const EXTRA_MAP_DROP_TYPES_MIN_S2_LEVEL = 13;
  const EXTRA_MAP_DROP_TYPES_MAX_CELLS = 64;
  const DEFAULT_STATE = { 14: true, 17: true, interactionRadius: false };
  const MIN_CELL_PIXELS = { 14: 16, 17: 14 };
  const MAX_CELLS = { 14: 1200, 17: 1400 };
  const MAX_SAMPLES = 700;
  const MAX_CAPTURE_TEXT_CHARS = 12000000;
  const MAX_CAPTURE_NODES = 200000;
  const ACTIVE_REDRAW_DELAY_MS = 32;
  const IDLE_REDRAW_DELAY_MS = 40;
  const RESIZE_REDRAW_DELAY_MS = 120;
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

  const state = loadState();
  const attachedMaps = new WeakSet();
  const pendingMapAttachments = new WeakSet();
  const occupiedCellsSubscribers = new Set();
  const occupiedMapObjects = new Map();
  const occupiedL14Cells = new Map();
  const occupiedL17Cells = new Map();
  let occupiedCellsNotifyTimer = 0;
  let expandedMapObjectRequestCount = 0;
  let lastExpandedMapObjectRequest = null;
  let wrappedMapConstructor = null;
  let S2GridOverlayClass = null;

  installMapObjectCaptureHooks();
  installGoogleHook();
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

  function installMapObjectCaptureHooks() {
    installFetchCaptureHook();
    installXhrCaptureHook();
  }

  function installFetchCaptureHook() {
    const originalFetch = W.fetch;
    if (typeof originalFetch !== "function" || originalFetch.__s2MapObjectCaptureWrapped) return;

    function wrappedFetch() {
      const args = Array.prototype.slice.call(arguments);
      expandFetchMapObjectRequest(args);
      const result = originalFetch.apply(this, args);
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
      const args = Array.prototype.slice.call(arguments);
      if (args.length) {
        const expandedBody = expandMapObjectRequestBody(args[0]);
        if (expandedBody !== args[0]) args[0] = expandedBody;
      }
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
      return originalSend.apply(this, args);
    };

    safeDefine(proto, "__s2MapObjectCaptureWrapped", { value: true });
  }

  function expandFetchMapObjectRequest(args) {
    const init = args[1];
    if (!init || typeof init !== "object" || !Object.prototype.hasOwnProperty.call(init, "body")) return;

    const expandedBody = expandMapObjectRequestBody(init.body);
    if (expandedBody === init.body) return;

    args[1] = Object.assign({}, init, { body: expandedBody });
  }

  function expandMapObjectRequestBody(body) {
    if (typeof body !== "string" || body.indexOf("realityChannelMapObjectsByS2CellsInput") === -1) return body;

    let root;
    try {
      root = JSON.parse(body);
    } catch (_) {
      return body;
    }

    const requests = Array.isArray(root) ? root : [root];
    let addedDropTypes = 0;
    let expandedCellCount = 0;
    let expandedLevel = null;

    for (const request of requests) {
      const input = request &&
        request.variables &&
        request.variables.realityChannelMapObjectsByS2CellsInput;
      if (!input || !Array.isArray(input.sourcesByS2Cells)) continue;

      const level = Number(input.s2CellLevel);
      const cellCount = input.sourcesByS2Cells.length;
      if (!Number.isInteger(level) || level < EXTRA_MAP_DROP_TYPES_MIN_S2_LEVEL) continue;
      if (cellCount > EXTRA_MAP_DROP_TYPES_MAX_CELLS) continue;

      let addedForInput = 0;
      for (const sourceCell of input.sourcesByS2Cells) {
        addedForInput += addExtraDropTypesToSourceCell(sourceCell);
      }

      if (addedForInput) {
        addedDropTypes += addedForInput;
        expandedLevel = level;
        expandedCellCount += cellCount;
      }
    }

    if (!addedDropTypes) return body;

    expandedMapObjectRequestCount += 1;
    lastExpandedMapObjectRequest = {
      addedDropTypes,
      cellCount: expandedCellCount,
      level: expandedLevel,
      timestamp: Date.now(),
    };
    return JSON.stringify(root);
  }

  function addExtraDropTypesToSourceCell(sourceCell) {
    if (!sourceCell || !Array.isArray(sourceCell.sources)) return 0;

    let added = 0;
    for (const source of sourceCell.sources) {
      if (!source || !Array.isArray(source.dropTypes)) continue;
      if (!canExpandMapObjectSource(source)) continue;
      for (const dropType of EXTRA_MAP_DROP_TYPES) {
        if (source.dropTypes.indexOf(dropType) !== -1) continue;
        source.dropTypes.push(dropType);
        added += 1;
      }
    }
    return added;
  }

  function canExpandMapObjectSource(source) {
    const dropTypes = source.dropTypes;
    return (
      dropTypes.indexOf("PGO_GYM") !== -1 ||
      dropTypes.indexOf("PGO_POWERSPOT") !== -1 ||
      dropTypes.indexOf("PGO_ROUTE") !== -1
    );
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
    if (!occupiedMapObjects.has(objectKey)) {
      occupiedMapObjects.set(objectKey, object);
    }

    const l17Cell = latLngToCell(object.lat, object.lng, 17);
    const added = addObjectToCellStats(occupiedL17Cells, l17Cell, object, objectKey);
    if (!added) return false;

    const l14Cell = latLngToCell(object.lat, object.lng, 14);
    addObjectToCellStats(occupiedL14Cells, l14Cell, object, objectKey);
    return true;
  }

  function getVisibleOccupiedMapObjects(map) {
    const boundsBox = getPaddedMapBoundsBox(map);
    if (!boundsBox) return Array.from(occupiedMapObjects.values());

    const objects = [];
    for (const object of occupiedMapObjects.values()) {
      if (pointInBoundsBox(object, boundsBox)) objects.push(object);
    }
    return objects;
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

  function getL14NearGymHighlight(cell) {
    const summary = getL14CellSummary(cell);
    if (summary.total <= 0 || summary.maxGymsReached) return null;
    if (summary.missingForNextGym <= 0 || summary.missingForNextGym >= 3) return null;
    return NEAR_GYM_FILL[summary.missingForNextGym] || null;
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
    const OverlayClass = getS2GridOverlayClass(maps);
    const overlay = new OverlayClass(map, maps);
    map[MAP_MARKER] = overlay;
    overlay.setMap(map);
    installControl(map, overlay, maps);
  }

  function getS2GridOverlayClass(maps) {
    if (S2GridOverlayClass) return S2GridOverlayClass;

    S2GridOverlayClass = class S2GridOverlay extends maps.OverlayView {
      constructor(map, mapsApi) {
        super();
        this.map = map;
        this.maps = mapsApi;
        this.tooltip = null;
        this.mapDiv = null;
        this.resizeObserver = null;
        this.frame = 0;
        this.hoverFrame = 0;
        this.timer = 0;
        this.listeners = [];
        this.visibleLevels = new Set();
        this.gridPolygonsByLevel = {
          14: new Map(),
          17: new Map(),
        };
        this.occupiedFillPolygons = new Map();
        this.nearGymFillPolygons = new Map();
        this.interactionRadiusCircles = new Map();
        this.lastMousePosition = null;
        this.isInteracting = false;
        this.unsubscribeOccupiedCells = null;
        this.onMapMouseMove = (event) => this.scheduleTooltipUpdate(event);
        this.onMapMouseLeave = () => this.hideTooltip();
      }

      onAdd() {
        const mapDiv = this.map.getDiv();
        this.mapDiv = mapDiv;

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
        if (this.unsubscribeOccupiedCells) this.unsubscribeOccupiedCells();
        this.unsubscribeOccupiedCells = null;
        if (this.resizeObserver) this.resizeObserver.disconnect();
        if (this.mapDiv) {
          this.mapDiv.removeEventListener("mousemove", this.onMapMouseMove);
          this.mapDiv.removeEventListener("mouseleave", this.onMapMouseLeave);
        }
        this.clearLevel(14);
        this.clearLevel(17);
        this.clearOccupiedFills();
        this.clearNearGymFills();
        this.clearInteractionRadiusCircles();
        if (this.tooltip && this.tooltip.parentNode) this.tooltip.parentNode.removeChild(this.tooltip);
        this.tooltip = null;
        this.mapDiv = null;
      }

      beginInteraction(force) {
        this.isInteracting = true;
        this.hideTooltip();
        this.scheduleDraw(ACTIVE_REDRAW_DELAY_MS, force);
      }

      endInteraction() {
        this.isInteracting = false;
        this.scheduleDraw(IDLE_REDRAW_DELAY_MS, true);
      }

      scheduleDraw(delay, force) {
        const wait = Math.max(0, delay || 0);
        if (this.frame) return;
        if (this.timer) {
          if (!force || wait > 0) return;
          W.clearTimeout(this.timer);
          this.timer = 0;
        }

        const draw = () => {
          this.timer = 0;
          this.frame = W.requestAnimationFrame(() => {
            this.frame = 0;
            this.render();
          });
        };

        if (wait > 0) {
          this.timer = W.setTimeout(draw, wait);
        } else {
          draw();
        }
      }

      render() {
        if (!this.mapDiv) return;
        const enabledLevels = [17, 14].filter((level) => state[level]);
        const showInteractionRadius = Boolean(state.interactionRadius);
        if (!enabledLevels.length && !showInteractionRadius) {
          this.visibleLevels = new Set();
          this.clearLevel(14);
          this.clearLevel(17);
          this.clearOccupiedFills();
          this.clearNearGymFills();
          this.clearInteractionRadiusCircles();
          this.hideTooltip();
          return;
        }

        const projection = this.getProjection();
        const mapDiv = this.map.getDiv();
        if (!projection || !mapDiv) return;

        const rect = mapDiv.getBoundingClientRect();
        const width = Math.max(0, Math.round(rect.width));
        const height = Math.max(0, Math.round(rect.height));
        if (!width || !height) return;

        const visibleLevels = new Set();
        if (showInteractionRadius) {
          this.updateInteractionRadiusCircles();
        } else {
          this.clearInteractionRadiusCircles();
        }

        if (enabledLevels.indexOf(17) === -1) {
          this.clearLevel(17);
          this.clearOccupiedFills();
        }
        if (enabledLevels.indexOf(14) === -1) {
          this.clearLevel(14);
          this.clearNearGymFills();
        }

        for (const level of enabledLevels) {
          if (this.drawLevel(level, projection, width, height)) visibleLevels.add(level);
        }
        this.visibleLevels = visibleLevels;
        if (!visibleLevels.has(17)) this.clearOccupiedFills();
        if (!visibleLevels.has(14)) this.clearNearGymFills();
        if (!this.canShowL14Tooltip()) this.hideTooltip();
      }

      drawLevel(level, projection, width, height) {
        const center = this.map.getCenter && this.map.getCenter();
        if (!center) return false;

        const centerCell = latLngToCell(center.lat(), center.lng(), level);
        const cellPixels = estimateCellPixels(centerCell, projection, this.maps, width, height);
        if (!Number.isFinite(cellPixels) || cellPixels < MIN_CELL_PIXELS[level]) {
          this.clearLevel(level);
          if (level === 17) this.clearOccupiedFills();
          if (level === 14) this.clearNearGymFills();
          return false;
        }

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
        if (!cells.length || cells.length > MAX_CELLS[level]) {
          this.clearLevel(level);
          if (level === 17) this.clearOccupiedFills();
          if (level === 14) this.clearNearGymFills();
          return false;
        }

        const polygons = this.gridPolygonsByLevel[level];
        const wanted = new Set();
        for (const cell of cells) {
          const key = cellKey(cell);
          wanted.add(key);
          this.ensureGridPolygon(level, key, cell);
        }

        for (const [key, polygon] of Array.from(polygons.entries())) {
          if (!wanted.has(key)) {
            polygon.setMap(null);
            polygons.delete(key);
          }
        }

        if (level === 17) this.updateOccupiedFills(cells);
        if (level === 14) this.updateNearGymFills(cells);
        return true;
      }

      ensureGridPolygon(level, key, cell) {
        const polygons = this.gridPolygonsByLevel[level];
        if (polygons.has(key)) return polygons.get(key);

        const isL14 = level === 14;
        const polygon = new this.maps.Polygon({
          paths: cellToGooglePath(cell),
          map: this.map,
          clickable: false,
          geodesic: true,
          fillOpacity: 0,
          strokeColor: RED,
          strokeOpacity: isL14 ? 0.95 : 0.58,
          strokeWeight: isL14 ? 1.8 : 1,
          zIndex: isL14 ? 1400 : 1300,
        });
        polygons.set(key, polygon);
        return polygon;
      }

      updateOccupiedFills(cells) {
        const wanted = new Set();
        for (const cell of cells) {
          if (!isOccupiedL17Cell(cell)) continue;
          const key = cellKey(cell);
          wanted.add(key);
          if (this.occupiedFillPolygons.has(key)) continue;

          const polygon = new this.maps.Polygon({
            paths: cellToGooglePath(cell),
            map: this.map,
            clickable: false,
            geodesic: true,
            fillColor: RED,
            fillOpacity: 0.14,
            strokeOpacity: 0,
            strokeWeight: 0,
            zIndex: 1200,
          });
          this.occupiedFillPolygons.set(key, polygon);
        }

        for (const [key, polygon] of Array.from(this.occupiedFillPolygons.entries())) {
          if (!wanted.has(key)) {
            polygon.setMap(null);
            this.occupiedFillPolygons.delete(key);
          }
        }
      }

      updateNearGymFills(cells) {
        const wanted = new Set();
        for (const cell of cells) {
          const highlight = getL14NearGymHighlight(cell);
          if (!highlight) continue;

          const key = cellKey(cell);
          const path = cellToGooglePath(cell);
          wanted.add(key);

          const existing = this.nearGymFillPolygons.get(key);
          if (existing) {
            if (typeof existing.setPath === "function") {
              existing.setPath(path);
            } else {
              existing.setOptions({ paths: path });
            }
            existing.setOptions({
              fillColor: highlight.color,
              fillOpacity: highlight.opacity,
            });
            continue;
          }

          const polygon = new this.maps.Polygon({
            paths: path,
            map: this.map,
            clickable: false,
            geodesic: true,
            fillColor: highlight.color,
            fillOpacity: highlight.opacity,
            strokeOpacity: 0,
            strokeWeight: 0,
            zIndex: 1190,
          });
          this.nearGymFillPolygons.set(key, polygon);
        }

        for (const [key, polygon] of Array.from(this.nearGymFillPolygons.entries())) {
          if (!wanted.has(key)) {
            polygon.setMap(null);
            this.nearGymFillPolygons.delete(key);
          }
        }
      }

      updateInteractionRadiusCircles() {
        const wanted = new Set();
        const objects = getVisibleOccupiedMapObjects(this.map);
        for (const object of objects) {
          const key = object.type + ":" + object.id;
          wanted.add(key);

          const center = { lat: object.lat, lng: object.lng };
          const existing = this.interactionRadiusCircles.get(key);
          if (existing) {
            existing.setCenter(center);
            existing.setRadius(INTERACTION_RADIUS_METERS);
            continue;
          }

          const circle = new this.maps.Circle({
            center,
            map: this.map,
            clickable: false,
            fillColor: INTERACTION_RADIUS_COLOR,
            fillOpacity: 0.08,
            radius: INTERACTION_RADIUS_METERS,
            strokeColor: INTERACTION_RADIUS_COLOR,
            strokeOpacity: 0.72,
            strokeWeight: 1.4,
            zIndex: 1250,
          });
          this.interactionRadiusCircles.set(key, circle);
        }

        for (const [key, circle] of Array.from(this.interactionRadiusCircles.entries())) {
          if (!wanted.has(key)) {
            circle.setMap(null);
            this.interactionRadiusCircles.delete(key);
          }
        }
      }

      clearLevel(level) {
        const polygons = this.gridPolygonsByLevel[level];
        for (const polygon of polygons.values()) {
          polygon.setMap(null);
        }
        polygons.clear();
      }

      clearOccupiedFills() {
        for (const polygon of this.occupiedFillPolygons.values()) {
          polygon.setMap(null);
        }
        this.occupiedFillPolygons.clear();
      }

      clearNearGymFills() {
        for (const polygon of this.nearGymFillPolygons.values()) {
          polygon.setMap(null);
        }
        this.nearGymFillPolygons.clear();
      }

      clearInteractionRadiusCircles() {
        for (const circle of this.interactionRadiusCircles.values()) {
          circle.setMap(null);
        }
        this.interactionRadiusCircles.clear();
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

    return S2GridOverlayClass;
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
      flexWrap: "wrap",
      gap: "8px",
      margin: "10px",
      padding: "6px 8px",
      font: "12px/1.2 Arial, sans-serif",
      userSelect: "none",
    });

    control.appendChild(createToggle(14, overlay));
    control.appendChild(createToggle(17, overlay));
    control.appendChild(createInteractionRadiusToggle(overlay));

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

  function createInteractionRadiusToggle(overlay) {
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
    input.checked = Boolean(state.interactionRadius);
    input.style.accentColor = INTERACTION_RADIUS_COLOR;
    input.addEventListener("change", function () {
      state.interactionRadius = input.checked;
      saveState();
      overlay.scheduleDraw(0, true);
    });

    const text = document.createElement("span");
    text.textContent = "20m";
    text.title = "20 meter circles around loaded Pokestops and Gyms";

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

  function cellToGooglePath(cell) {
    return [
      vertexLatLng(cell.face, cell.level, cell.i, cell.j),
      vertexLatLng(cell.face, cell.level, cell.i + 1, cell.j),
      vertexLatLng(cell.face, cell.level, cell.i + 1, cell.j + 1),
      vertexLatLng(cell.face, cell.level, cell.i, cell.j + 1),
    ].map(function (point) {
      return { lat: point.lat, lng: point.lng };
    });
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
    get occupiedL17CellCount() {
      return occupiedL17Cells.size;
    },
    get occupiedL14CellCount() {
      return occupiedL14Cells.size;
    },
    get expandedMapObjectRequestCount() {
      return expandedMapObjectRequestCount;
    },
    get lastExpandedMapObjectRequest() {
      return lastExpandedMapObjectRequest ? Object.assign({}, lastExpandedMapObjectRequest) : null;
    },
    wrappedMapConstructor: function () {
      return wrappedMapConstructor;
    },
  };
})();
