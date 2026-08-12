/* ==========================================================================
   KAARDIRAKENDUS - app.js
   ========================================================================== */

let map;
let currentBaseLayer = null;
const baseLayerObjects = {};
let userLocationMarker = null;
let userAccuracyCircle = null;
let locationWatchId = null;

/* ---- PRIA ---- */
let priaLayersMeta = [];        // [{name, title}] from GetCapabilities
const priaLayersState = {};     // typeName -> { color, geo, loading }

/* ---- Minu kaardid (uploaded + MyFiles layers) ---- */
const myLayers = {};             // id -> entry (see addGeoJsonToMap for shape)
let myLayerCounter = 0;
let searchHighlightMarker = null;

/* ---- Ulukite jäljed (wildlife track registrations) ---- */
let tracksLayerGroup = null;      // master group added to the map
let tracksSessionGroup = null;    // this-browser-only drafts, downloaded but maybe not yet pushed
let tracksData = [];              // [{feature, group}] for the loaded (merged) dataset
let trackDrawState = null;        // null | { type: "point"|"line", points: [latlng,...] }
let trackPreviewLayers = [];      // live preview shown while drawing

/* ---- Väliandmed (Google Sheets / repo-fail join) ---- */
const sheetState = {
  source: "google",
  id: null,
  gid: null,
  headers: [],
  rows: [],
  workbook: null,
  timerHandle: null
};

/* ---------------------------------------------------------------------- */
/* INIT                                                                    */
/* ---------------------------------------------------------------------- */
document.addEventListener("DOMContentLoaded", init);

function init() {
  const savedView = getSavedMapView();

  map = L.map("map", {
    zoomControl: false,
    attributionControl: true,
    minZoom: CONFIG.mapMinZoom,
    maxZoom: CONFIG.mapMaxZoom
  }).setView(
    savedView ? [savedView.lat, savedView.lng] : CONFIG.initialView.center,
    savedView ? savedView.zoom : CONFIG.initialView.zoom
  );

  // Zoom control lives bottom-right, stacked just above the "📍 Minu
  // asukoht" button — puts both within easy thumb-reach on mobile,
  // instead of making people reach to the top of the screen.
  L.control.zoom({ position: "bottomright" }).addTo(map);

  buildBaseLayers();
  setupBaseLayerUI();
  setupCollapseToggles();
  setupTracks();
  setupPria();
  setupFileUpload();
  setupMyFilesBrowser();
  setupSearch();
  setupSheets();
  setupLocateControls();
  setupCoordReadout();
  setupPanelToggle();
  setupModals();

  map.on("moveend", debounce(() => {
    refreshAllEnabledPriaLayers();
    refreshAllMyLayers();
    saveMapView();
  }, 400));
}

function getSavedMapView() {
  try { return JSON.parse(localStorage.getItem("lastMapView") || "null"); }
  catch (e) { return null; }
}

function saveMapView() {
  const c = map.getCenter();
  localStorage.setItem("lastMapView", JSON.stringify({ lat: c.lat, lng: c.lng, zoom: map.getZoom() }));
}

/* ---------------------------------------------------------------------- */
/* COLLAPSIBLE SECTIONS                                                     */
/* ---------------------------------------------------------------------- */
function setupCollapseToggles() {
  document.querySelectorAll(".collapseBtn").forEach(btn => {
    btn.addEventListener("click", () => {
      const target = document.getElementById(btn.dataset.target);
      if (!target) return;
      const collapsed = target.classList.toggle("collapsed");
      btn.textContent = collapsed ? "▸" : "▾";
    });
  });
}

/* ---------------------------------------------------------------------- */
/* BASE LAYERS                                                              */
/* ---------------------------------------------------------------------- */
function buildBaseLayers() {
  CONFIG.baseLayers.forEach(cfg => {
    let layer;
    if (cfg.type === "maaamet-wms") {
      layer = L.tileLayer.wms(CONFIG.maaametWmsUrl, {
        layers: cfg.layer,
        format: cfg.format,
        version: "1.1.1",
        transparent: false,
        uppercase: true,
        crs: L.CRS.EPSG3857,
        // Maa-amet has no native imagery past zoom 18, but the map itself
        // (and features like search) can reach zoom 19 — maxNativeZoom
        // makes Leaflet upscale the zoom-18 tiles instead of just showing
        // a blank background once you go past 18 (this was the "background
        // map disappears" bug).
        maxNativeZoom: 18,
        maxZoom: CONFIG.mapMaxZoom,
        minZoom: 3,
        attribution: cfg.attribution
      });
      layer.on("tileerror", () => {
        showBanner(`"${cfg.name}" kihi pildid ei laadinud serverist. Kontrolli config.js failis kihi nime.`);
      });
    }
    baseLayerObjects[cfg.id] = layer;
    if (cfg.default) {
      currentBaseLayer = layer;
      layer.addTo(map);
    }
  });
}

function setupBaseLayerUI() {
  // Base layer switching lives entirely as quick buttons on the map itself.
  document.querySelectorAll(".mapQuickBtn[data-layer-id]").forEach(btn => {
    btn.addEventListener("click", () => switchBaseLayer(btn.dataset.layerId));
  });
  updateBaseLayerUISync();
}

function switchBaseLayer(id) {
  if (currentBaseLayer) map.removeLayer(currentBaseLayer);
  currentBaseLayer = baseLayerObjects[id];
  currentBaseLayer.addTo(map);
  currentBaseLayer.bringToBack();
  updateBaseLayerUISync(id);
}

function updateBaseLayerUISync(id) {
  const activeId = id || (CONFIG.baseLayers.find(c => c.default) || {}).id;
  document.querySelectorAll(".mapQuickBtn[data-layer-id]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.layerId === activeId);
  });
}

/* ---------------------------------------------------------------------- */
/* ULUKITE JÄLJED (wildlife track registrations)                            */
/* ---------------------------------------------------------------------- */
function setupTracks() {
  tracksLayerGroup = L.layerGroup().addTo(map);
  tracksSessionGroup = L.layerGroup().addTo(map);

  // Populate the species <select> in the registration form.
  const speciesSelect = document.getElementById("trackSpeciesSelect");
  CONFIG.tracks.species.forEach(s => {
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = s.label;
    speciesSelect.appendChild(opt);
  });

  // Populate the direction <select>; default to "arrow at end".
  const dirSelect = document.getElementById("trackDirectionSelect");
  CONFIG.tracks.directions.forEach(d => {
    const opt = document.createElement("option");
    opt.value = d.id;
    opt.textContent = d.label;
    dirSelect.appendChild(opt);
  });
  dirSelect.value = "end";

  // Populate the registrant <select> (RP/OP/JL/AV + "Muu" free-text option).
  const registrantSelect = document.getElementById("trackRegistrantSelect");
  CONFIG.tracks.registrants.forEach(r => {
    const opt = document.createElement("option");
    opt.value = r;
    opt.textContent = r;
    registrantSelect.appendChild(opt);
  });
  const otherOpt = document.createElement("option");
  otherOpt.value = "other";
  otherOpt.textContent = "Muu...";
  registrantSelect.appendChild(otherOpt);
  registrantSelect.addEventListener("change", () => {
    document.getElementById("trackRegistrantOtherInput").classList.toggle("hidden", registrantSelect.value !== "other");
  });

  // Species filter checkboxes (left panel), all checked by default.
  const filterEl = document.getElementById("tracksSpeciesFilter");
  CONFIG.tracks.species.forEach(s => {
    const row = document.createElement("label");
    row.className = "trackSpeciesRow";
    row.innerHTML = `
      <input type="checkbox" class="trackSpeciesFilterCheckbox" value="${s.id}" checked>
      <span class="trackSpeciesSwatch" style="background:${s.color}"></span>
      <span>${s.label}</span>
    `;
    filterEl.appendChild(row);
  });
  document.querySelectorAll(".trackSpeciesFilterCheckbox").forEach(cb => {
    cb.addEventListener("change", applyTracksFilter);
  });
  document.getElementById("tracksDateFrom").addEventListener("change", applyTracksFilter);
  document.getElementById("tracksDateTo").addEventListener("change", applyTracksFilter);

  document.getElementById("trackDateInput").value = todayIsoDate();

  // Toggle direction row depending on point/line choice.
  document.querySelectorAll('input[name="trackGeomType"]').forEach(radio => {
    radio.addEventListener("change", () => {
      document.getElementById("trackDirectionRow")
        .classList.toggle("hidden", radio.value !== "line" || !radio.checked);
      if (radio.checked) cancelTrackDrawing();
    });
  });

  document.getElementById("trackRegisterToggleBtn").addEventListener("click", toggleTrackRegisterWidget);
  document.getElementById("trackRegisterCloseBtn").addEventListener("click", closeTrackRegisterWidget);
  document.getElementById("trackDrawStartBtn").addEventListener("click", startTrackDrawing);
  document.getElementById("trackFinishLineBtn").addEventListener("click", finishTrackDrawing);
  document.getElementById("trackCancelDrawBtn").addEventListener("click", cancelTrackDrawing);
  document.getElementById("trackSaveBtn").addEventListener("click", saveTrackRegistration);
  document.getElementById("tracksLoadBtn").addEventListener("click", loadTracksData);

  restoreSessionDrafts();
  loadTracksData();
}

function todayIsoDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/* ---- Registration widget open/close ---- */
function toggleTrackRegisterWidget() {
  const widget = document.getElementById("trackRegisterWidget");
  const opening = widget.classList.contains("hidden");
  document.getElementById("mapSearchWidget").classList.add("hidden");
  widget.classList.toggle("hidden", !opening);
  document.getElementById("trackRegisterToggleBtn").classList.toggle("active", opening);
  if (!opening) cancelTrackDrawing();
}

function closeTrackRegisterWidget() {
  document.getElementById("trackRegisterWidget").classList.add("hidden");
  document.getElementById("trackRegisterToggleBtn").classList.remove("active");
  cancelTrackDrawing();
}

/* ---- Drawing on the map ----
   Lines finish via an explicit "✔ Lõpeta joon" button rather than
   double-click — double-click fires two ordinary "click" events before
   the "dblclick" event itself in Leaflet, which made the line-finishing
   unreliable (it depended on precise browser/timing behavior). A button
   is unambiguous and works the same everywhere. */
function startTrackDrawing() {
  cancelTrackDrawing();
  const type = document.querySelector('input[name="trackGeomType"]:checked').value;
  trackDrawState = { type, points: [] };
  document.getElementById("map").classList.add("map-drawing-cursor");
  map.on("click", handleTrackDrawClick);

  const hint = document.getElementById("trackDrawHint");
  hint.classList.remove("hidden");
  hint.textContent = type === "point"
    ? "Klõpsa kaardil, et paigutada punkt."
    : "Klõpsa kaardil, et lisada joonele punkte. Kui oled valmis (vähemalt 2 punkti), vajuta \"✔\".";
  document.getElementById("trackCancelDrawBtn").classList.remove("hidden");
  document.getElementById("trackSaveBtn").disabled = true;

  const finishBtn = document.getElementById("trackFinishLineBtn");
  if (type === "line") {
    finishBtn.classList.remove("hidden");
    finishBtn.disabled = true;
  } else {
    finishBtn.classList.add("hidden");
  }
}

function handleTrackDrawClick(e) {
  if (!trackDrawState) return;
  trackDrawState.points.push(e.latlng);
  redrawTrackPreview();
  if (trackDrawState.type === "point") {
    finishTrackDrawing();
  } else {
    document.getElementById("trackFinishLineBtn").disabled = trackDrawState.points.length < 2;
  }
}

function finishTrackDrawing() {
  if (!trackDrawState) return;
  if (trackDrawState.type === "line" && trackDrawState.points.length < 2) {
    notify("Joone jaoks on vaja vähemalt 2 punkti.");
    return;
  }
  map.off("click", handleTrackDrawClick);
  document.getElementById("map").classList.remove("map-drawing-cursor");
  document.getElementById("trackDrawHint").textContent = "Valmis — kontrolli vormi ja vajuta \"💾 Salvesta jälg\".";
  document.getElementById("trackFinishLineBtn").classList.add("hidden");
  document.getElementById("trackSaveBtn").disabled = false;
}

function cancelTrackDrawing() {
  map.off("click", handleTrackDrawClick);
  document.getElementById("map").classList.remove("map-drawing-cursor");
  trackPreviewLayers.forEach(l => map.removeLayer(l));
  trackPreviewLayers = [];
  trackDrawState = null;
  document.getElementById("trackDrawHint").classList.add("hidden");
  document.getElementById("trackCancelDrawBtn").classList.add("hidden");
  document.getElementById("trackFinishLineBtn").classList.add("hidden");
  document.getElementById("trackSaveBtn").disabled = true;
}

function redrawTrackPreview() {
  trackPreviewLayers.forEach(l => map.removeLayer(l));
  trackPreviewLayers = [];
  const pts = trackDrawState.points;
  if (pts.length === 0) return;

  if (trackDrawState.type === "point") {
    const m = L.circleMarker(pts[0], { radius: 7, color: "#1a73e8", weight: 2, fillOpacity: 0.7 }).addTo(map);
    trackPreviewLayers.push(m);
    return;
  }

  pts.forEach(p => trackPreviewLayers.push(L.circleMarker(p, { radius: 4, color: "#1a73e8", weight: 2, fillOpacity: 0.9 }).addTo(map)));
  if (pts.length >= 2) {
    trackPreviewLayers.push(L.polyline(pts, { color: "#1a73e8", weight: 3, dashArray: "6,4" }).addTo(map));
  }
}

/* ---- Save (build GeoJSON feature, render, buffer, download) ---- */
function saveTrackRegistration() {
  if (!trackDrawState || trackDrawState.points.length === 0) {
    notify("Kõigepealt joonista jälg kaardile.");
    return;
  }
  const type = trackDrawState.type;
  if (type === "line" && trackDrawState.points.length < 2) {
    notify("Joone jaoks on vaja vähemalt 2 punkti.");
    return;
  }

  const species = document.getElementById("trackSpeciesSelect").value;
  const direction = type === "line" ? document.getElementById("trackDirectionSelect").value : "none";
  const date = document.getElementById("trackDateInput").value || todayIsoDate();
  const packSizeRaw = document.getElementById("trackPackSizeInput").value;
  const packSize = packSizeRaw === "" ? null : Number(packSizeRaw);
  const remarks = document.getElementById("trackRemarksInput").value.trim();
  const registrantSelectVal = document.getElementById("trackRegistrantSelect").value;
  const registrant = registrantSelectVal === "other"
    ? document.getElementById("trackRegistrantOtherInput").value.trim()
    : registrantSelectVal;

  const coords = type === "point"
    ? [trackDrawState.points[0].lng, trackDrawState.points[0].lat]
    : trackDrawState.points.map(p => [p.lng, p.lat]);

  const feature = {
    type: "Feature",
    geometry: { type: type === "point" ? "Point" : "LineString", coordinates: coords },
    properties: {
      geom_type: type,
      species,
      direction,
      date,
      pack_size: packSize,
      remarks,
      registrant,
      registered_at: new Date().toISOString()
    }
  };

  // Render immediately in the session-only layer so it's visible right away.
  const group = renderTrackFeature(feature);
  group.addTo(tracksSessionGroup);

  // Buffer to localStorage so a page refresh before pushing doesn't lose it.
  const drafts = getSessionDrafts();
  drafts.push(feature);
  localStorage.setItem("trackSessionDrafts", JSON.stringify(drafts));

  downloadFeatureAsGeoJson(feature);

  const statusEl = document.getElementById("trackSaveStatus");
  statusEl.textContent = "Fail allalaaditud. Lisa see kausta data/registrations/ ja tee git push, et see kõigile jäädavalt kaardile jääks (vt ⓘ).";

  cancelTrackDrawing();
  document.getElementById("trackRemarksInput").value = "";
  document.getElementById("trackPackSizeInput").value = "1";
}

function downloadFeatureAsGeoJson(feature) {
  const p = feature.properties;
  const safeDate = (p.date || todayIsoDate()).replace(/[^0-9-]/g, "");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `jalg_${p.species}_${safeDate}_${stamp}.geojson`;
  const blob = new Blob([JSON.stringify(feature, null, 2)], { type: "application/geo+json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function getSessionDrafts() {
  try { return JSON.parse(localStorage.getItem("trackSessionDrafts") || "[]"); }
  catch (e) { return []; }
}

function restoreSessionDrafts() {
  getSessionDrafts().forEach(feature => renderTrackFeature(feature).addTo(tracksSessionGroup));
}

/* ---- Rendering (shared by loaded dataset + session drafts) ---- */
function speciesConfig(id) {
  return CONFIG.tracks.species.find(s => s.id === id) || { id, label: id || "Teadmata", color: "#666" };
}

function trackPopupHtml(props) {
  const sp = speciesConfig(props.species);
  const dir = CONFIG.tracks.directions.find(d => d.id === props.direction);
  let html = `<strong>${escapeHtml(sp.label)}</strong><br>`;
  html += `Kuupäev: ${escapeHtml(props.date || "—")}<br>`;
  html += `Karja suurus: ${props.pack_size ?? "—"}<br>`;
  if (props.geom_type === "line") html += `Suund: ${escapeHtml(dir ? dir.label : "—")}<br>`;
  if (props.remarks) html += `Märkused: ${escapeHtml(props.remarks)}<br>`;
  if (props.registrant) html += `Registreerija: ${escapeHtml(props.registrant)}<br>`;
  return html;
}

function computeBearingDeg(from, to) {
  const lat1 = from.lat * Math.PI / 180, lat2 = to.lat * Math.PI / 180;
  const dLon = (to.lng - from.lng) * Math.PI / 180;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function createArrowMarker(latlng, bearingDeg, color) {
  return L.marker(latlng, {
    icon: L.divIcon({
      className: "",
      html: `<div class="trackArrowIcon" style="color:${color}; transform: rotate(${bearingDeg}deg);"></div>`,
      iconSize: [12, 12],
      iconAnchor: [6, 6]
    }),
    interactive: false
  });
}

// Renders one GeoJSON feature (point or line, with optional direction
// arrows) as a small L.featureGroup, so it can be added/removed from the
// map as a single unit for filtering.
function renderTrackFeature(feature) {
  const props = feature.properties || {};
  const sp = speciesConfig(props.species);
  const layers = [];

  if (feature.geometry.type === "Point") {
    const latlng = L.latLng(feature.geometry.coordinates[1], feature.geometry.coordinates[0]);
    layers.push(L.circleMarker(latlng, {
      radius: 7, color: sp.color, weight: 2, fillColor: sp.color, fillOpacity: 0.75
    }));
  } else if (feature.geometry.type === "LineString") {
    const latlngs = feature.geometry.coordinates.map(c => L.latLng(c[1], c[0]));
    layers.push(L.polyline(latlngs, { color: sp.color, weight: 4, opacity: 0.9 }));
    const dir = props.direction || "none";
    if (dir === "start" || dir === "both") {
      layers.push(createArrowMarker(latlngs[0], computeBearingDeg(latlngs[1], latlngs[0]), sp.color));
    }
    if (dir === "end" || dir === "both") {
      const n = latlngs.length;
      layers.push(createArrowMarker(latlngs[n - 1], computeBearingDeg(latlngs[n - 2], latlngs[n - 1]), sp.color));
    }
  }

  const group = L.featureGroup(layers);
  group.bindPopup(trackPopupHtml(props));
  return group;
}

/* ---- Loading the merged dataset + filtering ---- */
function loadTracksData() {
  const statusEl = document.getElementById("tracksStatus");
  statusEl.textContent = "Laen...";
  fetch(`${CONFIG.tracks.dataUrl}?_=${Date.now()}`)
    .then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then(geojson => {
      tracksLayerGroup.clearLayers();
      tracksData = (geojson.features || []).map(feature => ({
        feature,
        group: renderTrackFeature(feature)
      }));
      statusEl.textContent = `Laetud (${tracksData.length}).`;
      applyTracksFilter();
    })
    .catch(err => {
      statusEl.textContent = "Ei õnnestunud laadida.";
      console.warn("loadTracksData failed:", err);
    });
}

function applyTracksFilter() {
  const checkedSpecies = new Set(
    Array.from(document.querySelectorAll(".trackSpeciesFilterCheckbox:checked")).map(cb => cb.value)
  );
  const from = document.getElementById("tracksDateFrom").value;
  const to = document.getElementById("tracksDateTo").value;

  let visibleCount = 0;
  tracksData.forEach(entry => {
    const props = entry.feature.properties || {};
    let visible = checkedSpecies.has(props.species);
    if (visible && from && props.date && props.date < from) visible = false;
    if (visible && to && props.date && props.date > to) visible = false;

    const currentlyOn = tracksLayerGroup.hasLayer(entry.group);
    if (visible && !currentlyOn) tracksLayerGroup.addLayer(entry.group);
    if (!visible && currentlyOn) tracksLayerGroup.removeLayer(entry.group);
    if (visible) visibleCount++;
  });

  document.getElementById("tracksCount").textContent = `Näidatud: ${visibleCount} / ${tracksData.length}`;
}

/* ---------------------------------------------------------------------- */
/* PRIA WFS: grouped layer list, quick presets, colors, saved searches      */
/* ---------------------------------------------------------------------- */
function setupPria() {
  document.getElementById("priaLoadLayersBtn").addEventListener("click", loadPriaLayerList);
  document.getElementById("priaSelectMainBtn").addEventListener("click", selectMainPolludLayer);
  document.getElementById("priaSelectAllPolludBtn").addEventListener("click", selectAllPolludLayers);
  document.getElementById("priaOtherToggleBtn").addEventListener("click", toggleOtherPriaGroup);

  document.getElementById("priaPresetSaveBtn").addEventListener("click", savePriaPreset);
  document.getElementById("priaPresetLoadBtn").addEventListener("click", loadPriaPreset);
  document.getElementById("priaPresetDeleteBtn").addEventListener("click", deletePriaPreset);

  refreshPriaPresetSelect();
}

function normalizeEstonian(str) {
  return String(str || "").toLowerCase()
    .replace(/õ/g, "o").replace(/ä/g, "a").replace(/ö/g, "o").replace(/ü/g, "u");
}

function isPolludLayer(info) {
  return normalizeEstonian(info.title).includes("pollu") || normalizeEstonian(info.name).includes("pollu");
}

async function loadPriaLayerList() {
  setStatus("priaStatus", "Laen kihtide loendit...");
  try {
    const url = `${CONFIG.pria.wfsUrl}?service=WFS&version=2.0.0&request=GetCapabilities`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    const xml = new DOMParser().parseFromString(text, "text/xml");
    const featureTypeNodes = xml.getElementsByTagNameNS("*", "FeatureType");

    const layers = [];
    for (const ft of featureTypeNodes) {
      const nameEl = ft.getElementsByTagNameNS("*", "Name")[0];
      const titleEl = ft.getElementsByTagNameNS("*", "Title")[0];
      if (nameEl) {
        layers.push({
          name: nameEl.textContent.trim(),
          title: titleEl ? titleEl.textContent.trim() : nameEl.textContent.trim()
        });
      }
    }
    if (layers.length === 0) throw new Error("Vastusest ei leitud ühtegi kihti (FeatureType)");

    priaLayersMeta = layers;
    renderPriaLayerList();
    setStatus("priaStatus", `${layers.length} kihti leitud.`);
  } catch (err) {
    setStatus("priaStatus", `Kihtide loendi laadimine ebaõnnestus (${err.message}).`);
  }
}

function renderPriaLayerList() {
  const mainList = document.getElementById("priaMainGroupList");
  const otherList = document.getElementById("priaOtherGroupList");
  const otherToggleBtn = document.getElementById("priaOtherToggleBtn");
  mainList.innerHTML = "";
  otherList.innerHTML = "";

  const mainGroup = priaLayersMeta.filter(isPolludLayer);
  const otherGroup = priaLayersMeta.filter(info => !isPolludLayer(info));

  document.getElementById("priaQuickButtons").classList.toggle("hidden", mainGroup.length === 0);

  mainGroup.forEach(info => mainList.appendChild(buildPriaLayerRow(info)));
  otherGroup.forEach(info => otherList.appendChild(buildPriaLayerRow(info)));

  if (otherGroup.length > 0) {
    otherToggleBtn.classList.remove("hidden");
    otherToggleBtn.textContent = `▸ Näita muid kihte (${otherGroup.length})`;
    otherList.classList.add("hidden");
  } else {
    otherToggleBtn.classList.add("hidden");
  }
}

function toggleOtherPriaGroup() {
  const otherList = document.getElementById("priaOtherGroupList");
  const btn = document.getElementById("priaOtherToggleBtn");
  const nowHidden = otherList.classList.toggle("hidden");
  const count = priaLayersMeta.filter(info => !isPolludLayer(info)).length;
  btn.textContent = (nowHidden ? "▸ Näita muid kihte (" : "▾ Peida muud kihid (") + count + ")";
}

function buildPriaLayerRow(info) {
  const row = document.createElement("div");
  row.className = "layerRow";
  const label = document.createElement("label");
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.dataset.typeName = info.name;
  cb.checked = !!priaLayersState[info.name];
  const swatch = document.createElement("span");
  swatch.className = "colorSwatch";
  swatch.style.background = getColorForTypeName(info.name);
  const span = document.createElement("span");
  span.textContent = info.title;
  span.title = info.name;
  cb.addEventListener("change", () => togglePriaLayer(info.name, cb.checked));
  label.appendChild(cb);
  label.appendChild(swatch);
  label.appendChild(span);
  row.appendChild(label);
  return row;
}

function selectMainPolludLayer() {
  const mainGroup = priaLayersMeta.filter(isPolludLayer);
  if (mainGroup.length === 0) {
    setStatus("priaStatus", "Kihtide loendit pole veel laetud või ei leitud 'PÕLLUD' kihte.");
    return;
  }
  // Prefer the shortest matching name as the most likely "primary" layer.
  const best = mainGroup.slice().sort((a, b) => a.name.length - b.name.length)[0];
  setPriaCheckbox(best.name, true);
  setStatus("priaStatus", `Valitud peamine kiht: ${best.title}`);
}

function selectAllPolludLayers() {
  const mainGroup = priaLayersMeta.filter(isPolludLayer);
  mainGroup.forEach(info => setPriaCheckbox(info.name, true));
  setStatus("priaStatus", `${mainGroup.length} 'PÕLLUD' kihti valitud.`);
}

function getColorForTypeName(name) {
  const stored = JSON.parse(localStorage.getItem("pria_layer_colors") || "{}");
  if (stored[name]) return stored[name];
  const palette = CONFIG.pria.colorPalette;
  const usedColors = Object.values(stored);
  const color = palette.find(c => !usedColors.includes(c)) || palette[Object.keys(stored).length % palette.length];
  stored[name] = color;
  localStorage.setItem("pria_layer_colors", JSON.stringify(stored));
  return color;
}

function togglePriaLayer(typeName, enabled) {
  if (enabled) {
    const color = getColorForTypeName(typeName);
    const geo = L.geoJSON(null, {
      style: { color, weight: 2, fillColor: color, fillOpacity: 0.15 },
      pointToLayer: (feature, latlng) => L.circleMarker(latlng, { radius: 6, color, fillColor: color, fillOpacity: 0.6 }),
      onEachFeature: bindFeaturePopup
    }).addTo(map);
    priaLayersState[typeName] = { color, geo };
    fetchPriaLayerData(typeName);
  } else {
    const state = priaLayersState[typeName];
    if (state && state.geo) map.removeLayer(state.geo);
    delete priaLayersState[typeName];
  }
}

function refreshAllEnabledPriaLayers() {
  Object.keys(priaLayersState).forEach(typeName => fetchPriaLayerData(typeName));
}

function fetchPriaLayerData(typeName) {
  const state = priaLayersState[typeName];
  if (!state || state.loading) return;

  if (map.getZoom() < CONFIG.pria.minZoom) {
    setStatus("priaStatus", `Suumi lähemale (praegu ${map.getZoom()}, vajalik ${CONFIG.pria.minZoom}+).`);
    state.geo.clearLayers();
    return;
  }

  const bounds = map.getBounds();
  const bbox = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()].join(",") + ",EPSG:4326";

  const params = new URLSearchParams({
    service: "WFS", version: "2.0.0", request: "GetFeature",
    typeNames: typeName, outputFormat: "application/json",
    srsName: "EPSG:4326", count: String(CONFIG.pria.maxFeatures), bbox
  });

  state.loading = true;
  setStatus("priaStatus", `Laen "${typeName}" andmeid...`);

  fetch(`${CONFIG.pria.wfsUrl}?${params.toString()}`)
    .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
    .then(geojson => {
      state.geo.clearLayers();
      state.geo.addData(geojson);
      const n = (geojson.features || []).length;
      setStatus("priaStatus",
        n >= CONFIG.pria.maxFeatures
          ? `"${typeName}": ${n}+ objekti (piirmäär täis)`
          : `"${typeName}": ${n} objekti laetud`);
    })
    .catch(err => setStatus("priaStatus", `Viga "${typeName}" laadimisel (${err.message})`))
    .finally(() => { state.loading = false; });
}

/* ---- PRIA saved / predefined searches ---- */
function getPriaPresets() {
  return JSON.parse(localStorage.getItem("pria_presets") || "{}");
}

function savePriaPreset() {
  const nameInput = document.getElementById("priaPresetName");
  const name = nameInput.value.trim();
  if (!name) { notify("Sisesta eelseadistusele nimi."); return; }
  const enabledTypeNames = Object.keys(priaLayersState);
  if (enabledTypeNames.length === 0) { notify("Vali enne vähemalt üks PRIA kiht."); return; }
  const presets = getPriaPresets();
  presets[name] = { typeNames: enabledTypeNames };
  localStorage.setItem("pria_presets", JSON.stringify(presets));
  nameInput.value = "";
  refreshPriaPresetSelect(name);
  setStatus("priaStatus", `Eelseadistus "${name}" salvestatud.`);
}

async function loadPriaPreset() {
  const select = document.getElementById("priaPresetSelect");
  const name = select.value;
  if (!name) return;
  const preset = getPriaPresets()[name];
  if (!preset) return;
  if (priaLayersMeta.length === 0) await loadPriaLayerList();
  Object.keys(priaLayersState).forEach(typeName => {
    if (!preset.typeNames.includes(typeName)) setPriaCheckbox(typeName, false);
  });
  preset.typeNames.forEach(typeName => setPriaCheckbox(typeName, true));
  setStatus("priaStatus", `Eelseadistus "${name}" rakendatud.`);
}

function setPriaCheckbox(typeName, checked) {
  const cb = document.querySelector(
    `#priaMainGroupList input[data-type-name="${cssEscape(typeName)}"], #priaOtherGroupList input[data-type-name="${cssEscape(typeName)}"]`
  );
  if (cb) {
    if (cb.checked !== checked) {
      cb.checked = checked;
      cb.dispatchEvent(new Event("change"));
    }
  } else {
    togglePriaLayer(typeName, checked);
  }
}

async function deletePriaPreset() {
  const select = document.getElementById("priaPresetSelect");
  const name = select.value;
  if (!name) return;
  if (!(await showConfirm(`Kustutada eelseadistus "${name}"?`))) return;
  const presets = getPriaPresets();
  delete presets[name];
  localStorage.setItem("pria_presets", JSON.stringify(presets));
  refreshPriaPresetSelect();
}

function refreshPriaPresetSelect(selectName) {
  const select = document.getElementById("priaPresetSelect");
  const presets = getPriaPresets();
  select.innerHTML = '<option value="">— vali salvestatud otsing —</option>';
  Object.keys(presets).forEach(name => {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  });
  if (selectName) select.value = selectName;
}

/* ---------------------------------------------------------------------- */
/* GEOLOCATION ("blue dot")                                                 */
/* ---------------------------------------------------------------------- */
function setupLocateControls() {
  document.getElementById("locateBtn").addEventListener("click", toggleLiveLocation);
  document.getElementById("mapLocateBtn").addEventListener("click", toggleLiveLocation);
  document.getElementById("fitEstoniaBtn").addEventListener("click", () => map.fitBounds(CONFIG.estoniaBounds));
}

function setLocateButtonsActive(active) {
  document.getElementById("locateBtn").classList.toggle("active", active);
  document.getElementById("mapLocateBtn").classList.toggle("active", active);
}

function toggleLiveLocation() {
  if (locationWatchId !== null) {
    navigator.geolocation.clearWatch(locationWatchId);
    locationWatchId = null;
    setLocateButtonsActive(false);
    return;
  }
  if (!navigator.geolocation) { notify("Brauser ei toeta asukoha tuvastamist."); return; }

  setLocateButtonsActive(true);
  let firstFix = true;
  locationWatchId = navigator.geolocation.watchPosition(
    pos => {
      const { latitude, longitude, accuracy } = pos.coords;
      updateUserLocationMarker(latitude, longitude, accuracy);
      if (firstFix) {
        map.setView([latitude, longitude], 16);
        firstFix = false;
      } else {
        // "Follow me": keep the current position centered as it moves,
        // without forcing the zoom level back to 16 each time.
        map.panTo([latitude, longitude], { animate: true });
      }
    },
    err => {
      showBanner("Asukoha tuvastamine ebaõnnestus: " + err.message);
      setLocateButtonsActive(false);
      locationWatchId = null;
    },
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 }
  );
}

function updateUserLocationMarker(lat, lng, accuracy) {
  const latlng = [lat, lng];
  if (!userLocationMarker) {
    userLocationMarker = L.marker(latlng, {
      icon: L.divIcon({
        className: "userLocationDot",
        html: '<div class="dotOuter"><div class="dotInner"></div></div>',
        iconSize: [22, 22], iconAnchor: [11, 11]
      }),
      zIndexOffset: 1000
    }).addTo(map);
  } else {
    userLocationMarker.setLatLng(latlng);
  }
  if (!userAccuracyCircle) {
    userAccuracyCircle = L.circle(latlng, { radius: accuracy, color: "#1a73e8", weight: 1, fillColor: "#1a73e8", fillOpacity: 0.12 }).addTo(map);
  } else {
    userAccuracyCircle.setLatLng(latlng);
    userAccuracyCircle.setRadius(accuracy);
  }
}

/* ---------------------------------------------------------------------- */
/* COORDINATE READOUT                                                       */
/* ---------------------------------------------------------------------- */
function setupCoordReadout() {
  const el = document.getElementById("coordReadout");
  map.on("mousemove", e => { el.textContent = `${e.latlng.lat.toFixed(6)}, ${e.latlng.lng.toFixed(6)}`; });
  map.on("click", e => { el.textContent = `${e.latlng.lat.toFixed(6)}, ${e.latlng.lng.toFixed(6)} (klikitud)`; });
}

/* ---------------------------------------------------------------------- */
/* LEFT PANEL TOGGLE                                                        */
/* ---------------------------------------------------------------------- */
function setupPanelToggle() {
  const panel = document.getElementById("layerPanel");
  const openerBtn = document.getElementById("panelOpenerBtn");
  document.getElementById("panelToggleBtn").addEventListener("click", () => {
    panel.classList.add("collapsed");
    setTimeout(() => map.invalidateSize(), 300);
  });
  openerBtn.addEventListener("click", () => {
    panel.classList.remove("collapsed");
    setTimeout(() => map.invalidateSize(), 300);
  });
}

/* ---------------------------------------------------------------------- */
/* MODALS                                                                   */
/* ---------------------------------------------------------------------- */
function setupModals() {
  document.getElementById("modalCloseBtn").addEventListener("click", closeModal);
  document.getElementById("modalOverlay").addEventListener("click", e => {
    if (e.target.id === "modalOverlay") closeModal();
  });
  document.querySelectorAll(".infoIconBtn[data-info]").forEach(btn => {
    btn.addEventListener("click", () => {
      const tpl = document.getElementById(`tpl-${btn.dataset.info}`);
      if (tpl) openModal("Info", tpl.innerHTML);
    });
  });
  document.getElementById("appInfoBtn").addEventListener("click", () => {
    openModal("Rakenduse info", `
      <h3>Jäljed</h3>
      <p>Ulukite jälgede registreerimise ja kaardistamise rakendus: taustakaardid,
      PRIA põllumassiivid, ulukijälgede sisestus ja filtreerimine, sinu enda
      üleslaetud kaardikihid ning Google Sheets/repo-fail väliandmed ühel vaatel.</p>
      <p><strong>Andmete allikad ja litsentsid:</strong></p>
      <ul>
        <li>Maa- ja Ruumiamet — taustakaardid (CC BY 4.0)</li>
        <li>PRIA — põllumassiivide avalik WFS-teenus</li>
        <li>OpenStreetMap panustajad</li>
      </ul>
      <p>Vajuta iga jaotise juures oleva ⓘ nupu peale täpsema info nägemiseks.</p>
    `);
  });
}

function openModal(title, html) {
  document.getElementById("modalTitle").textContent = title;
  document.getElementById("modalBody").innerHTML = html;
  document.getElementById("modalOverlay").classList.remove("hidden");
}

function closeModal() {
  document.getElementById("modalOverlay").classList.add("hidden");
}

/* Replacement for native confirm() — some embedded Android WebViews
   (e.g. RC-controller browsers) silently block window.confirm()/alert(),
   which made destructive actions and error messages appear to do
   nothing at all. This uses our own modal instead, which always works. */
function showConfirm(message) {
  return new Promise(resolve => {
    openModal("Kinnita", `
      <p>${escapeHtml(message)}</p>
      <div class="confirmBtnRow">
        <button id="confirmYesBtn" class="wideBtn dangerWideBtn">Jah</button>
        <button id="confirmNoBtn" class="wideBtn secondaryBtn">Ei</button>
      </div>
    `);
    document.getElementById("confirmYesBtn").addEventListener("click", () => { closeModal(); resolve(true); });
    document.getElementById("confirmNoBtn").addEventListener("click", () => { closeModal(); resolve(false); });
  });
}

/* Replacement for native alert() — same WebView reliability reasoning.
   Shows a dismissable in-page notice instead of a blocking system dialog. */
function notify(message) {
  openModal("Teade", `<p>${escapeHtml(message)}</p>`);
}

/* ---------------------------------------------------------------------- */
/* WARNING BANNER                                                           */
/* ---------------------------------------------------------------------- */
let bannerTimeout = null;
function showBanner(text) {
  let banner = document.getElementById("warningBanner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "warningBanner";
    banner.className = "warningBanner";
    document.getElementById("mapPanel").appendChild(banner);
  }
  banner.textContent = text;
  banner.classList.add("visible");
  clearTimeout(bannerTimeout);
  bannerTimeout = setTimeout(() => banner.classList.remove("visible"), 7000);
}

/* ---------------------------------------------------------------------- */
/* FILE UPLOAD                                                              */
/* ---------------------------------------------------------------------- */
function setupFileUpload() {
  document.getElementById("fileInput").addEventListener("change", async (e) => {
    const files = Array.from(e.target.files);
    for (const file of files) {
      try { await handleUploadedFile(file); }
      catch (err) { notify(`Faili "${file.name}" töötlemine ebaõnnestus: ${err.message}`); }
    }
    e.target.value = "";
  });
}

async function handleUploadedFile(file) {
  const ext = file.name.split(".").pop().toLowerCase();

  if (ext === "kml") {
    addKmlStringToMap(await file.text(), file.name, "upload");
  } else if (ext === "kmz") {
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const kmlEntry = Object.values(zip.files).find(f => f.name.toLowerCase().endsWith(".kml"));
    if (!kmlEntry) throw new Error("KMZ failist ei leitud .kml sisu");
    addKmlStringToMap(await kmlEntry.async("text"), file.name, "upload");
  } else if (ext === "zip") {
    if (typeof shp !== "function") throw new Error("Shapefile'i teisendaja (shpjs) ei ole laetud.");
    addGeoJsonToMap(await shp(await file.arrayBuffer()), file.name, "upload");
  } else {
    throw new Error("Toetatud on ainult .kml, .kmz ja .zip (shapefile) failid");
  }

  // Note: GitHub Pages can't run server-side code, so this file is only
  // visible in this browser/session. To make it permanently visible to
  // everyone with the link, commit it into MyFiles/uploads/ in the repo
  // and push — see the ⓘ info button for "Minu kaardid".
}

function addKmlStringToMap(kmlText, label, source) {
  const dom = new DOMParser().parseFromString(kmlText, "text/xml");
  addGeoJsonToMap(toGeoJSON.kml(dom), label, source);
}

/* ---------------------------------------------------------------------- */
/* MINU KAARDID: viewport+zoom-aware rendering, thematic colors, labels     */
/* ---------------------------------------------------------------------- */
function getSavedLayerPrefs(name) {
  try {
    const all = JSON.parse(localStorage.getItem("myLayerPrefs") || "{}");
    return all[name] || null;
  } catch (e) { return null; }
}

function saveLayerPrefs(entry) {
  const all = JSON.parse(localStorage.getItem("myLayerPrefs") || "{}");
  all[entry.name] = {
    minZoom: entry.minZoom,
    maxZoom: entry.maxZoom,
    labelMinZoom: entry.labelMinZoom,
    labelField: entry.labelField,
    colorMode: entry.colorMode,
    fillColor: entry.fillColor,
    outlineColor: entry.outlineColor,
    fillTransparencyPercent: entry.fillTransparencyPercent,
    thematicField: entry.thematicField,
    thematicColorOverrides: entry.thematicColorOverrides
  };
  localStorage.setItem("myLayerPrefs", JSON.stringify(all));
}

function normalizeToFeatureArray(geojson) {
  if (!geojson) return [];
  if (geojson.type === "FeatureCollection") return geojson.features || [];
  if (geojson.type === "Feature") return [geojson];
  return [{ type: "Feature", properties: {}, geometry: geojson }];
}

function computeFeatureBounds(feature) {
  try { return L.geoJSON(feature).getBounds(); } catch (e) { return null; }
}

function collectFieldNamesFromFeatures(features) {
  const set = new Set();
  features.forEach(f => { if (f.properties) Object.keys(f.properties).forEach(k => set.add(k)); });
  return Array.from(set);
}

function addGeoJsonToMap(geojson, label, source) {
  // Avoid loading the same MyFiles entry twice (e.g. auto-load + manual click)
  const already = Object.values(myLayers).find(e => e.name === label && e.source === source);
  if (already) return;

  const id = "layer_" + (++myLayerCounter);
  const features = normalizeToFeatureArray(geojson);
  features.forEach(f => { f.__bounds = computeFeatureBounds(f); });

  const saved = getSavedLayerPrefs(label);

  const defaultFillColor = CONFIG.myLayers.colorPalette[Object.keys(myLayers).length % CONFIG.myLayers.colorPalette.length];

  const entry = {
    id, name: label, source,
    rawFeatures: features,
    fields: collectFieldNamesFromFeatures(features),
    labelField: saved ? saved.labelField : null,
    minZoom: saved ? saved.minZoom : CONFIG.myLayers.defaultMinZoom,
    maxZoom: (saved && saved.maxZoom !== undefined) ? saved.maxZoom : CONFIG.myLayers.defaultMaxZoom,
    labelMinZoom: saved ? saved.labelMinZoom : CONFIG.myLayers.defaultLabelMinZoom,
    visible: true,
    colorMode: saved ? saved.colorMode : "single",
    // fillColor replaces the old singleColor key; fall back to it if present
    // (older saved preferences from before Fill/Outline were split apart).
    fillColor: saved ? (saved.fillColor || saved.singleColor || defaultFillColor) : defaultFillColor,
    // Outline defaults to match the fill color (so a fresh layer looks like
    // one solid color until the user deliberately picks a different outline).
    outlineColor: (saved && saved.outlineColor) ? saved.outlineColor
      : (saved ? (saved.fillColor || saved.singleColor || defaultFillColor) : defaultFillColor),
    fillTransparencyPercent: (saved && saved.fillTransparencyPercent !== undefined) ? saved.fillTransparencyPercent : 80,
    thematicField: saved ? saved.thematicField : null,
    thematicColorOverrides: (saved && saved.thematicColorOverrides) ? saved.thematicColorOverrides : {},
    thematicColorMap: null,
    thematicLegend: [],
    renderedLayer: null,
    uiCollapsed: false
  };
  updateThematicColorMap(entry);

  myLayers[id] = entry;
  renderMyLayersList();
  refreshSearchLayerOptions();
  renderMyLayerForCurrentView(entry);

  try {
    const overallBounds = L.latLngBounds([]);
    features.forEach(f => { if (f.__bounds && f.__bounds.isValid()) overallBounds.extend(f.__bounds); });
    if (overallBounds.isValid()) map.fitBounds(overallBounds, { maxZoom: 16 });
  } catch (e) { /* ignore */ }
}

function normalizeThematicValue(v) {
  return (v === undefined || v === null || v === "") ? "(tühi)" : String(v);
}

function updateThematicColorMap(entry) {
  if (entry.colorMode !== "thematic" || !entry.thematicField) {
    entry.thematicColorMap = null;
    entry.thematicLegend = [];
    return;
  }
  const values = new Set();
  entry.rawFeatures.forEach(f => values.add(normalizeThematicValue(f.properties ? f.properties[entry.thematicField] : undefined)));
  const sorted = Array.from(values).sort();
  const palette = CONFIG.myLayers.colorPalette;
  const knownColors = CONFIG.myLayers.knownThematicColors || {};
  const overrides = entry.thematicColorOverrides || {};

  let paletteIndex = 0;
  const map2 = new Map();
  sorted.forEach(v => {
    let color;
    if (overrides[v]) {
      color = overrides[v]; // 1. explicit per-layer manual override wins
    } else {
      const knownMatch = knownColors[v.toLowerCase()];
      if (knownMatch) {
        color = knownMatch; // 2. known dataset default (e.g. hernes/kaer/mais/nisu)
      } else {
        color = palette[paletteIndex % palette.length]; // 3. fallback auto-cycling palette
        paletteIndex++;
      }
    }
    map2.set(v, color);
  });
  entry.thematicColorMap = map2;
  entry.thematicLegend = sorted.map(v => ({ value: v, color: map2.get(v) }));
}

function fillColorForFeature(entry, feature) {
  if (entry.colorMode === "thematic" && entry.thematicColorMap) {
    const v = normalizeThematicValue(feature.properties ? feature.properties[entry.thematicField] : undefined);
    return entry.thematicColorMap.get(v) || "#999999";
  }
  return entry.fillColor;
}

function fillOpacityForEntry(entry) {
  // fillTransparencyPercent (UI label: "Transp.") drives both fill and
  // outline opacity together: 0 = fully solid, 100 = fully invisible.
  const pct = (entry.fillTransparencyPercent !== undefined) ? entry.fillTransparencyPercent : 80;
  return 1 - (pct / 100);
}

function renderMyLayerForCurrentView(entry) {
  if (entry.renderedLayer) {
    map.removeLayer(entry.renderedLayer);
    entry.renderedLayer = null;
  }
  if (!entry.visible) return;

  const zoom = map.getZoom();
  if (zoom < entry.minZoom || zoom > entry.maxZoom) return;

  const viewBounds = map.getBounds();
  const visibleFeatures = entry.rawFeatures.filter(f => f.__bounds && f.__bounds.isValid() && viewBounds.intersects(f.__bounds));
  if (visibleFeatures.length === 0) return;

  const showLabels = zoom >= entry.labelMinZoom && !!entry.labelField;
  const opacityValue = fillOpacityForEntry(entry);

  const geoLayer = L.geoJSON({ type: "FeatureCollection", features: visibleFeatures }, {
    style: (feature) => {
      const fill = fillColorForFeature(entry, feature);
      return { color: entry.outlineColor, weight: 3, opacity: opacityValue, fillColor: fill, fillOpacity: opacityValue };
    },
    pointToLayer: (feature, latlng) => {
      const fill = fillColorForFeature(entry, feature);
      return L.circleMarker(latlng, { radius: 7, color: entry.outlineColor, opacity: opacityValue, fillColor: fill, fillOpacity: opacityValue });
    },
    onEachFeature: (feature, layer) => {
      bindFeaturePopup(feature, layer);
      if (showLabels) {
        const val = feature.properties ? feature.properties[entry.labelField] : undefined;
        if (val !== undefined && val !== "") {
          layer.bindTooltip(String(val), { permanent: true, direction: "center", className: "featureLabel" });
        }
      }
    }
  }).addTo(map);

  entry.renderedLayer = geoLayer;
}

function refreshAllMyLayers() {
  Object.values(myLayers).forEach(renderMyLayerForCurrentView);
}

function isPhoneField(key, value) {
  const keyNorm = normalizeEstonian(key);
  if (/telefon|phone|gsm|\btel\b/.test(keyNorm)) return true;
  const valStr = String(value).trim();
  const digitsOnly = valStr.replace(/\D/g, "");
  return /^[+]?[\d\s\-()]{6,16}$/.test(valStr) && digitsOnly.length >= 5;
}

function formatPhoneForTel(raw) {
  let cleaned = String(raw).replace(/[^\d+]/g, "");
  if (!cleaned) return null;
  if (!cleaned.startsWith("+")) {
    if (cleaned.startsWith("372")) {
      cleaned = "+" + cleaned;
    } else if (cleaned.length >= 7 && cleaned.length <= 8) {
      cleaned = "+372" + cleaned; // bare Estonian local number
    } else {
      cleaned = "+" + cleaned;
    }
  }
  return cleaned;
}

function getFeatureCenter(feature, layer) {
  try {
    if (layer.getBounds) {
      const b = layer.getBounds();
      if (b && b.isValid()) return b.getCenter();
    }
    if (layer.getLatLng) return layer.getLatLng();
  } catch (e) { /* ignore */ }
  if (feature.__bounds && feature.__bounds.isValid()) return feature.__bounds.getCenter();
  return null;
}

function bindFeaturePopup(feature, layer) {
  const props = feature.properties || {};
  const keys = Object.keys(props);

  const rows = keys.map(k => {
    const v = props[k];
    const vStr = String(v);
    if (isPhoneField(k, v)) {
      const telHref = formatPhoneForTel(vStr);
      const valueHtml = telHref
        ? `<a href="tel:${escapeHtml(telHref)}">${escapeHtml(vStr)}</a>`
        : escapeHtml(vStr);
      return `<tr><td>${escapeHtml(k)}</td><td>${valueHtml}</td></tr>`;
    }
    return `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(vStr)}</td></tr>`;
  }).join("");

  const center = getFeatureCenter(feature, layer);
  const dirLinkHtml = center
    ? `<a href="https://www.google.com/maps/dir/?api=1&destination=${center.lat},${center.lng}" ` +
      `target="_blank" rel="noopener" class="popupDirLink">🚗 Google Maps juhised</a>`
    : "";

  const tableHtml = rows ? `<table class="popupTable">${rows}</table>` : "";
  if (!tableHtml && !dirLinkHtml) return;

  layer.bindPopup(`${tableHtml}${dirLinkHtml}`);
}

/* ---- Minu kaardid: list UI (zoom controls, colors, labels, remove/delete) ---- */
function renderMyLayersList() {
  const container = document.getElementById("myLayersList");
  container.innerHTML = "";

  Object.values(myLayers).forEach(entry => {
    const row = document.createElement("div");
    row.className = "myLayerRow";

    /* top line: collapse toggle (first) + visibility + name + info/remove */
    const topLine = document.createElement("div");
    topLine.className = "myLayerTopLine";

    const collapseToggleBtn = document.createElement("button");
    collapseToggleBtn.className = "smallIconBtn";
    collapseToggleBtn.title = "Ahenda/laienda kihi seaded";
    collapseToggleBtn.textContent = entry.uiCollapsed ? "▸" : "▾";
    topLine.appendChild(collapseToggleBtn);

    const visLabel = document.createElement("label");
    const visCb = document.createElement("input");
    visCb.type = "checkbox";
    visCb.checked = entry.visible;
    visCb.addEventListener("change", () => {
      entry.visible = visCb.checked;
      renderMyLayerForCurrentView(entry);
    });
    const nameSpan = document.createElement("span");
    nameSpan.className = "myLayerName";
    nameSpan.textContent = "📄 " + entry.name;
    visLabel.appendChild(visCb);
    visLabel.appendChild(nameSpan);
    topLine.appendChild(visLabel);

    const btnGroup = document.createElement("span");
    btnGroup.className = "myLayerBtnGroup";

    const infoBtn = document.createElement("button");
    infoBtn.className = "smallIconBtn";
    infoBtn.title = "Kihi info";
    infoBtn.textContent = "ⓘ";
    infoBtn.addEventListener("click", () => showMyLayerInfo(entry.id));

    const removeBtn = document.createElement("button");
    removeBtn.className = "smallIconBtn";
    removeBtn.title = "Eemalda kaardilt (praeguses seansis)";
    removeBtn.textContent = "✕";
    removeBtn.addEventListener("click", () => removeMyLayer(entry.id));

    btnGroup.appendChild(infoBtn);
    btnGroup.appendChild(removeBtn);
    topLine.appendChild(btnGroup);
    row.appendChild(topLine);

    /* Everything below the top line is collapsible per layer, to keep
       the list manageable once several layers are loaded. */
    const detailsWrapper = document.createElement("div");
    detailsWrapper.className = "myLayerDetails";
    if (entry.uiCollapsed) detailsWrapper.classList.add("collapsed");

    collapseToggleBtn.addEventListener("click", () => {
      entry.uiCollapsed = !entry.uiCollapsed;
      detailsWrapper.classList.toggle("collapsed", entry.uiCollapsed);
      collapseToggleBtn.textContent = entry.uiCollapsed ? "▸" : "▾";
    });

    /* zoom-level controls */
    const zoomRow = document.createElement("div");
    zoomRow.className = "myLayerZoomRow";

    const minZoomLabel = document.createElement("label");
    minZoomLabel.className = "smallLabel";
    minZoomLabel.textContent = "Zoom min:";
    const minZoomInput = document.createElement("input");
    minZoomInput.type = "number";
    minZoomInput.min = "0"; minZoomInput.max = "19";
    minZoomInput.className = "zoomNumberInput";
    minZoomInput.value = entry.minZoom;
    minZoomInput.addEventListener("change", () => {
      entry.minZoom = parseInt(minZoomInput.value, 10) || 0;
      renderMyLayerForCurrentView(entry);
      saveLayerPrefs(entry);
    });

    const maxZoomLabel = document.createElement("label");
    maxZoomLabel.className = "smallLabel";
    maxZoomLabel.textContent = "Zoom max:";
    const maxZoomInput = document.createElement("input");
    maxZoomInput.type = "number";
    maxZoomInput.min = "0"; maxZoomInput.max = "19";
    maxZoomInput.className = "zoomNumberInput";
    maxZoomInput.value = entry.maxZoom;
    maxZoomInput.addEventListener("change", () => {
      entry.maxZoom = parseInt(maxZoomInput.value, 10) || 19;
      renderMyLayerForCurrentView(entry);
      saveLayerPrefs(entry);
    });

    zoomRow.appendChild(minZoomLabel);
    zoomRow.appendChild(minZoomInput);
    zoomRow.appendChild(maxZoomLabel);
    zoomRow.appendChild(maxZoomInput);
    detailsWrapper.appendChild(zoomRow);

    const labelZoomRow = document.createElement("div");
    labelZoomRow.className = "myLayerZoomRow";
    const labelZoomLabel = document.createElement("label");
    labelZoomLabel.className = "smallLabel";
    labelZoomLabel.textContent = "Sildid alates suumist:";
    const labelZoomInput = document.createElement("input");
    labelZoomInput.type = "number";
    labelZoomInput.min = "0"; labelZoomInput.max = "19";
    labelZoomInput.className = "zoomNumberInput";
    labelZoomInput.value = entry.labelMinZoom;
    labelZoomInput.addEventListener("change", () => {
      entry.labelMinZoom = parseInt(labelZoomInput.value, 10) || 0;
      renderMyLayerForCurrentView(entry);
      saveLayerPrefs(entry);
    });
    labelZoomRow.appendChild(labelZoomLabel);
    labelZoomRow.appendChild(labelZoomInput);
    detailsWrapper.appendChild(labelZoomRow);

    /* label field picker */
    if (entry.fields.length > 0) {
      const labelRow = document.createElement("div");
      labelRow.className = "myLayerLabelRow";
      const labelText = document.createElement("span");
      labelText.className = "smallLabel";
      labelText.textContent = "Sildi väli:";
      const select = document.createElement("select");
      const noneOpt = document.createElement("option");
      noneOpt.value = ""; noneOpt.textContent = "(puudub)";
      select.appendChild(noneOpt);
      entry.fields.forEach(f => {
        const opt = document.createElement("option");
        opt.value = f; opt.textContent = f;
        if (f === entry.labelField) opt.selected = true;
        select.appendChild(opt);
      });
      select.addEventListener("change", () => {
        entry.labelField = select.value || null;
        renderMyLayerForCurrentView(entry);
        saveLayerPrefs(entry);
      });
      labelRow.appendChild(labelText);
      labelRow.appendChild(select);
      detailsWrapper.appendChild(labelRow);

      /* color mode: single vs thematic */
      const colorRow = document.createElement("div");
      colorRow.className = "myLayerLabelRow";
      const colorLabelText = document.createElement("span");
      colorLabelText.className = "smallLabel";
      colorLabelText.textContent = "Värvimine:";
      const modeSelect = document.createElement("select");
      ["single", "thematic"].forEach(mode => {
        const opt = document.createElement("option");
        opt.value = mode;
        opt.textContent = mode === "single" ? "Ühtne värv" : "Temaatiline (välja järgi)";
        if (mode === entry.colorMode) opt.selected = true;
        modeSelect.appendChild(opt);
      });
      colorRow.appendChild(colorLabelText);
      colorRow.appendChild(modeSelect);
      detailsWrapper.appendChild(colorRow);

      const colorSubRow = document.createElement("div");
      colorSubRow.className = "myLayerLabelRow";

      function renderColorSubControls() {
        colorSubRow.innerHTML = "";

        if (entry.colorMode === "single") {
          const fillLabel = document.createElement("span");
          fillLabel.className = "smallLabel colorFieldLabel";
          fillLabel.textContent = "Värv:";
          const fillInput = document.createElement("input");
          fillInput.type = "color";
          fillInput.className = "colorSwatchInput";
          fillInput.value = entry.fillColor;
          fillInput.addEventListener("input", () => {
            entry.fillColor = fillInput.value;
            renderMyLayerForCurrentView(entry);
            saveLayerPrefs(entry);
          });
          colorSubRow.appendChild(fillLabel);
          colorSubRow.appendChild(fillInput);
        } else {
          const fieldSelect = document.createElement("select");
          const noneOpt2 = document.createElement("option");
          noneOpt2.value = ""; noneOpt2.textContent = "(vali väli)";
          fieldSelect.appendChild(noneOpt2);
          entry.fields.forEach(f => {
            const opt = document.createElement("option");
            opt.value = f; opt.textContent = f;
            if (f === entry.thematicField) opt.selected = true;
            fieldSelect.appendChild(opt);
          });
          fieldSelect.addEventListener("change", () => {
            entry.thematicField = fieldSelect.value || null;
            updateThematicColorMap(entry);
            renderMyLayerForCurrentView(entry);
            renderLegend();
            saveLayerPrefs(entry);
          });
          colorSubRow.appendChild(fieldSelect);
        }

        // Outline color applies regardless of fill mode (single or thematic) —
        // keeps borders consistent even when fill varies by category.
        const outlineLabel = document.createElement("span");
        outlineLabel.className = "smallLabel colorFieldLabel";
        outlineLabel.textContent = "Joon:";
        const outlineInput = document.createElement("input");
        outlineInput.type = "color";
        outlineInput.className = "colorSwatchInput";
        outlineInput.value = entry.outlineColor;
        outlineInput.addEventListener("input", () => {
          entry.outlineColor = outlineInput.value;
          renderMyLayerForCurrentView(entry);
          saveLayerPrefs(entry);
        });
        colorSubRow.appendChild(outlineLabel);
        colorSubRow.appendChild(outlineInput);

        // Transparency applies to both fill and outline together (0% = solid,
        // 100% = fully see-through).
        const transparencyLabel = document.createElement("span");
        transparencyLabel.className = "smallLabel colorFieldLabel";
        transparencyLabel.textContent = "Transp.:";
        const transparencyInput = document.createElement("input");
        transparencyInput.type = "number";
        transparencyInput.min = "0"; transparencyInput.max = "100"; transparencyInput.step = "5";
        transparencyInput.className = "zoomNumberInput";
        transparencyInput.value = entry.fillTransparencyPercent;
        transparencyInput.addEventListener("change", () => {
          let pct = parseInt(transparencyInput.value, 10);
          if (isNaN(pct)) pct = 80;
          pct = Math.max(0, Math.min(100, pct));
          transparencyInput.value = pct;
          entry.fillTransparencyPercent = pct;
          renderMyLayerForCurrentView(entry);
          saveLayerPrefs(entry);
        });
        colorSubRow.appendChild(transparencyLabel);
        colorSubRow.appendChild(transparencyInput);
      }

      const legendBox = document.createElement("div");
      legendBox.className = "thematicLegend";

      function renderLegend() {
        legendBox.innerHTML = "";
        if (entry.colorMode !== "thematic" || !entry.thematicField) return;
        entry.thematicLegend.forEach(item => {
          const chip = document.createElement("span");
          chip.className = "legendChip";

          const sw = document.createElement("input");
          sw.type = "color";
          sw.className = "legendColorInput";
          sw.value = item.color;
          sw.title = `Vali "${item.value}" jaoks oma värv`;
          sw.addEventListener("input", () => {
            entry.thematicColorOverrides = entry.thematicColorOverrides || {};
            entry.thematicColorOverrides[item.value] = sw.value;
            updateThematicColorMap(entry);
            renderMyLayerForCurrentView(entry);
            saveLayerPrefs(entry);
          });

          chip.appendChild(sw);
          chip.appendChild(document.createTextNode(" " + item.value));
          legendBox.appendChild(chip);
        });
      }

      modeSelect.addEventListener("change", () => {
        entry.colorMode = modeSelect.value;
        updateThematicColorMap(entry);
        renderMyLayerForCurrentView(entry);
        renderColorSubControls();
        renderLegend();
        saveLayerPrefs(entry);
      });

      renderColorSubControls();
      renderLegend();
      detailsWrapper.appendChild(colorSubRow);
      detailsWrapper.appendChild(legendBox);
    }

    row.appendChild(detailsWrapper);
    container.appendChild(row);
  });
}

function showMyLayerInfo(id) {
  const entry = myLayers[id];
  if (!entry) return;
  const fieldsHtml = entry.fields.length
    ? `<ul>${entry.fields.map(f => `<li>${escapeHtml(f)}</li>`).join("")}</ul>`
    : "<p>Sellel kihil ei ole tuvastatud andmevälju.</p>";
  openModal(entry.name, `
    <h3>${escapeHtml(entry.name)}</h3>
    <p><strong>Objekte kihil:</strong> ${entry.rawFeatures.length}</p>
    <p><strong>Kiht ilmub alates suumist:</strong> ${entry.minZoom} &nbsp;|&nbsp;
       <strong>sildid alates:</strong> ${entry.labelMinZoom}</p>
    <p><strong>Saadaolevad andmeväljad:</strong></p>
    ${fieldsHtml}
    <p class="smallNote">Klõpsa kaardil otse objektil, et näha selle konkreetse objekti kõiki väärtusi.</p>
  `);
}

async function removeMyLayer(id) {
  const entry = myLayers[id];
  if (!entry) return;
  if (!(await showConfirm(`Eemaldada kiht "${entry.name}" praegusest vaatest? (Fail jääb repositooriumis alles.)`))) return;
  if (entry.renderedLayer) map.removeLayer(entry.renderedLayer);
  delete myLayers[id];
  renderMyLayersList();
  refreshSearchLayerOptions();
}

/* ---------------------------------------------------------------------- */
/* MyFiles BROWSER — git-based (GitHub Pages can't run PHP)                 */
/* Reads a static MyFiles/manifest.json, kept in sync by a GitHub Action    */
/* whenever someone commits files into MyFiles/uploads/ and pushes.        */
/* ---------------------------------------------------------------------- */
function setupMyFilesBrowser() {
  document.getElementById("refreshMyFilesBtn").addEventListener("click", () => loadMyFilesList(true));
  loadMyFilesList(true); // auto-load all files listed in the manifest at startup
}

function loadMyFilesList(autoLoadAll) {
  setStatus("myFilesStatus", "Loen MyFiles nimekirja...");
  // Cache-bust so GitHub Pages' CDN doesn't serve a stale manifest right
  // after the Action has just updated it.
  const url = `${CONFIG.myFiles.manifestUrl}?t=${Date.now()}`;

  fetch(url)
    .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
    .then(data => {
      const files = (data && Array.isArray(data.files)) ? data.files : [];
      renderMyFilesFileList(files);
      setStatus("myFilesStatus", files.length ? "" : "MyFiles kaust on tühi.");
      if (autoLoadAll) {
        files.forEach(fname => loadMyFilesEntry(fname));
      }
    })
    .catch(err => {
      setStatus("myFilesStatus",
        `MyFiles nimekirja (${CONFIG.myFiles.manifestUrl}) ei õnnestunud lugeda. ` +
        `Kontrolli, et see fail on repositooriumis olemas. Detail: ${err.message}`);
      console.warn(err);
    });
}

function renderMyFilesFileList(files) {
  const container = document.getElementById("myFilesFileList");
  container.innerHTML = "";
  files.forEach(fname => {
    const row = document.createElement("div");
    row.className = "layerRow";
    const btn = document.createElement("button");
    btn.className = "smallLoadBtn";
    btn.textContent = "📂 " + fname;
    btn.addEventListener("click", () => loadMyFilesEntry(fname));
    row.appendChild(btn);
    container.appendChild(row);
  });
}

async function loadMyFilesEntry(fname) {
  if (Object.values(myLayers).some(e => e.name === fname && e.source === "myfiles")) return; // already loaded

  const url = CONFIG.myFiles.uploadsUrlBase + encodeURIComponent(fname);
  const ext = fname.split(".").pop().toLowerCase();
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    if (ext === "kml") {
      addKmlStringToMap(await resp.text(), fname, "myfiles");
    } else if (ext === "kmz") {
      const zip = await JSZip.loadAsync(await resp.arrayBuffer());
      const kmlEntry = Object.values(zip.files).find(f => f.name.toLowerCase().endsWith(".kml"));
      if (!kmlEntry) throw new Error("KMZ failist ei leitud .kml sisu");
      addKmlStringToMap(await kmlEntry.async("text"), fname, "myfiles");
    } else if (ext === "zip") {
      if (typeof shp !== "function") throw new Error("Shapefile'i teisendaja (shpjs) ei ole laetud.");
      addGeoJsonToMap(await shp(await resp.arrayBuffer()), fname, "myfiles");
    } else {
      throw new Error("Tundmatu failitüüp");
    }
  } catch (err) {
    console.warn(`Faili "${fname}" laadimine ebaõnnestus: ${err.message}`);
  }
}

/* ---------------------------------------------------------------------- */
/* SEARCH + Google Maps directions (Minu kaardid)                          */
/* ---------------------------------------------------------------------- */
function setupSearch() {
  document.getElementById("searchLayerSelect").addEventListener("change", refreshSearchFieldOptions);
  document.getElementById("searchGoBtn").addEventListener("click", performSearch);
  document.getElementById("mapSearchToggleBtn").addEventListener("click", toggleSearchWidget);
  document.getElementById("searchCloseBtn").addEventListener("click", () => closeSearchWidget());
  refreshSearchLayerOptions();
}

function toggleSearchWidget() {
  const widget = document.getElementById("mapSearchWidget");
  const nowHidden = widget.classList.toggle("hidden");
  document.getElementById("mapSearchToggleBtn").classList.toggle("active", !nowHidden);
  if (!nowHidden) closeTrackRegisterWidget();
}

function closeSearchWidget() {
  document.getElementById("mapSearchWidget").classList.add("hidden");
  document.getElementById("mapSearchToggleBtn").classList.remove("active");
}

function refreshSearchLayerOptions() {
  const select = document.getElementById("searchLayerSelect");
  const previous = select.value;
  select.innerHTML = "";
  Object.values(myLayers).forEach(entry => {
    const opt = document.createElement("option");
    opt.value = entry.id;
    opt.textContent = "📄 " + entry.name;
    select.appendChild(opt);
  });
  if (select.options.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "(lisa esmalt fail 'Minu kaardid' alt)";
    select.appendChild(opt);
  } else if (previous && Array.from(select.options).some(o => o.value === previous)) {
    select.value = previous;
  }
  refreshSearchFieldOptions();
}

function refreshSearchFieldOptions() {
  const layerId = document.getElementById("searchLayerSelect").value;
  const fieldSelect = document.getElementById("searchFieldSelect");
  fieldSelect.innerHTML = "";
  const entry = myLayers[layerId];
  if (!entry) return;
  entry.fields.forEach(f => {
    const opt = document.createElement("option");
    opt.value = f; opt.textContent = f;
    fieldSelect.appendChild(opt);
  });
  const guess = entry.fields.find(f => /nimi|name|kood|code|objekt|^id$/i.test(f));
  if (guess) fieldSelect.value = guess;
}

function performSearch() {
  const layerId = document.getElementById("searchLayerSelect").value;
  const field = document.getElementById("searchFieldSelect").value;
  const query = document.getElementById("searchTextInput").value.trim().toLowerCase();
  const resultBox = document.getElementById("searchResult");

  const entry = myLayers[layerId];
  if (!entry || !field || !query) {
    setStatus("searchStatus", "Vali kiht, väli ja sisesta otsitav väärtus.");
    resultBox.classList.add("hidden");
    return;
  }

  const matches = entry.rawFeatures.filter(f =>
    f.properties && String(f.properties[field] ?? "").toLowerCase().includes(query)
  );

  if (matches.length === 0) {
    setStatus("searchStatus", "Ühtegi objekti ei leitud.");
    resultBox.classList.add("hidden");
    return;
  }

  const feature = matches[0];
  const bounds = feature.__bounds;
  const center = bounds && bounds.isValid() ? bounds.getCenter() : null;

  setStatus("searchStatus",
    matches.length > 1 ? `${matches.length} vastet leitud, näidatakse esimest.` : "1 vaste leitud.");

  if (searchHighlightMarker) { map.removeLayer(searchHighlightMarker); searchHighlightMarker = null; }

  if (center) {
    const targetZoom = Math.max(map.getZoom(), entry.minZoom, entry.labelMinZoom, 16);
    map.setView(center, targetZoom);
    if (currentBaseLayer) currentBaseLayer.bringToBack(); // defensive: keep base map behind everything
    searchHighlightMarker = L.circleMarker(center, {
      radius: 12, color: "#ff0000", weight: 3, fillOpacity: 0
    }).addTo(map);
  }

  resultBox.classList.remove("hidden");
  resultBox.innerHTML = "";
  const rows = Object.entries(feature.properties || {})
    .map(([k, v]) => {
      const vStr = String(v);
      if (isPhoneField(k, v)) {
        const telHref = formatPhoneForTel(vStr);
        const valueHtml = telHref ? `<a href="tel:${escapeHtml(telHref)}">${escapeHtml(vStr)}</a>` : escapeHtml(vStr);
        return `<tr><td>${escapeHtml(k)}</td><td>${valueHtml}</td></tr>`;
      }
      return `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(vStr)}</td></tr>`;
    })
    .join("");
  resultBox.innerHTML = `<table class="popupTable">${rows}</table>`;

  if (center) {
    const dirLink = document.createElement("a");
    dirLink.href = `https://www.google.com/maps/dir/?api=1&destination=${center.lat},${center.lng}`;
    dirLink.target = "_blank";
    dirLink.rel = "noopener";
    dirLink.className = "wideBtn directionsLink";
    dirLink.textContent = "🚗 Ava Google Mapsi juhised";
    resultBox.appendChild(dirLink);
  }
}

/* ---------------------------------------------------------------------- */
/* VÄLIANDMED: Google Sheets (JSONP) / repo-fail CSV-XLSX (both backend-free) */
/* ---------------------------------------------------------------------- */
function setupSheets() {
  document.getElementById("sheetLoadBtn").addEventListener("click", () => loadSheetData(false));
  document.getElementById("repoFileLoadBtn").addEventListener("click", () => loadRepoFileData(false));
  document.getElementById("repoFileTabSelect").addEventListener("change", applyRepoFileTab);

  document.querySelectorAll('input[name="sheetSource"]').forEach(radio => {
    radio.addEventListener("change", () => {
      sheetState.source = radio.value;
      document.getElementById("googleSourceControls").classList.toggle("hidden", radio.value !== "google");
      document.getElementById("repoFileSourceControls").classList.toggle("hidden", radio.value !== "repofile");
    });
  });

  document.getElementById("sheetJoinBtn").addEventListener("click", performSheetJoin);
  document.getElementById("sheetRefreshTargetsBtn").addEventListener("click", refreshJoinTargetOptions);
  document.getElementById("sheetTargetLayerSelect").addEventListener("change", populateTargetFieldOptions);
  document.getElementById("sheetAutoRefreshSelect").addEventListener("change", (e) => {
    setupSheetAutoRefresh(parseInt(e.target.value, 10));
  });
}

function parseGoogleSheetUrl(raw) {
  const val = raw.trim();
  const idMatch = val.match(/\/d\/([a-zA-Z0-9-_]+)/);
  const gidMatch = val.match(/[#&?]gid=(\d+)/);
  return { id: idMatch ? idMatch[1] : val, gid: gidMatch ? gidMatch[1] : CONFIG.sheets.defaultGid };
}

/* Google Sheets via JSONP — this bypasses CORS entirely (script tags
   aren't subject to the same-origin restrictions fetch()/XHR are), so it
   works from a pure static host like GitHub Pages with zero backend. */
function loadGoogleSheetJSONP(id, gid) {
  return new Promise((resolve, reject) => {
    const callbackName = "sak26SheetCb_" + Date.now() + "_" + Math.floor(Math.random() * 1e6);
    const script = document.createElement("script");
    let settled = false;

    const timeoutHandle = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("Sheet ei vastanud (kontrolli linki ja jagamisõigusi)."));
    }, 15000);

    function cleanup() {
      delete window[callbackName];
      script.remove();
      clearTimeout(timeoutHandle);
    }

    window[callbackName] = (response) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(response);
    };

    script.src = `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:json;responseHandler=${callbackName}&gid=${gid}`;
    script.onerror = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("Sheeti ei õnnestunud laadida (kontrolli linki/ID-d ja jagamisõigusi)."));
    };
    document.head.appendChild(script);
  });
}

function gvizResponseToRows(response) {
  const cols = (response.table && response.table.cols) || [];
  const headers = cols.map((c, i) => (c.label && c.label.trim()) || c.id || `col${i}`);
  const rows = ((response.table && response.table.rows) || []).map(r => {
    const obj = {};
    (r.c || []).forEach((cell, i) => {
      const header = headers[i];
      if (!header) return;
      let value = "";
      if (cell) value = (cell.f !== undefined && cell.f !== null) ? cell.f : (cell.v !== undefined && cell.v !== null ? cell.v : "");
      obj[header] = value;
    });
    return obj;
  });
  return { headers, rows };
}

async function loadSheetData(silent) {
  const input = document.getElementById("sheetUrlInput").value.trim();
  if (!input) { if (!silent) notify("Sisesta Google Sheeti link või ID."); return; }

  const { id, gid } = parseGoogleSheetUrl(input);
  sheetState.id = id; sheetState.gid = gid; sheetState.source = "google";

  if (!silent) setStatus("sheetStatus", "Loen Sheeti...");

  try {
    const response = await loadGoogleSheetJSONP(id, gid);
    if (response.status === "error") {
      const msg = (response.errors && response.errors[0] && response.errors[0].detailed_message) || "Tundmatu viga";
      throw new Error(msg);
    }
    const { headers, rows } = gvizResponseToRows(response);
    if (rows.length === 0) {
      throw new Error("Sheetist ei leitud ridu (kas jagamisõigused on 'kõigil, kellel link on'?)");
    }
    sheetState.headers = headers;
    sheetState.rows = rows;

    document.getElementById("sheetJoinControls").classList.remove("hidden");
    populateKeyColumnOptions();
    refreshJoinTargetOptions();

    if (!silent) setStatus("sheetStatus", `${rows.length} rida loetud (${headers.length} veergu).`);
  } catch (err) {
    setStatus("sheetStatus", `Sheeti lugemine ebaõnnestus (${err.message}).`);
  }
}

/* Repo file (CSV/XLSX) — a plain same-origin fetch of a file committed
   into the repo. No CORS issue at all since it's served from the same
   domain as the app itself. This is the replacement for a live OneDrive
   fetch: export your Excel/OneDrive data, commit the export, push. */
async function loadRepoFileData(silent) {
  const input = document.getElementById("repoFileUrlInput").value.trim();
  if (!input) { if (!silent) notify("Sisesta faili tee repositooriumis."); return; }

  if (/^https?:\/\//i.test(input)) {
    setStatus("sheetStatus",
      "See väli võtab vastu ainult faili tee SINU GitHubi repositooriumis (nt " +
      "\"MyFiles/data/valiandmed.xlsx\"), mitte välist linki. OneDrive/SharePoint/Google " +
      "linki ei saa siia otse panna — CORS piirangute tõttu ei saa GitHub Pages seda " +
      "otse lugeda. Ekspordi fail (CSV/XLSX), lisa see oma repositooriumisse ja sisesta " +
      "siia selle tee (vt ⓘ info).");
    return;
  }

  if (!silent) setStatus("sheetStatus", "Loen repo faili...");

  try {
    const resp = await fetch(`${input}?t=${Date.now()}`); // cache-bust
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const ext = input.split(".").pop().toLowerCase();

    if (ext === "csv") {
      const text = await resp.text();
      const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
      if (!parsed.data || parsed.data.length === 0) throw new Error("CSV-st ei leitud ridu.");
      sheetState.headers = parsed.meta.fields || [];
      sheetState.rows = parsed.data;
      sheetState.workbook = null;
      document.getElementById("repoFileTabRow").classList.add("hidden");
    } else if (ext === "xlsx" || ext === "xls") {
      const buf = await resp.arrayBuffer();
      const workbook = XLSX.read(new Uint8Array(buf), { type: "array" });
      if (!workbook.SheetNames || workbook.SheetNames.length === 0) throw new Error("Failist ei leitud ühtegi töölehte");
      sheetState.workbook = workbook;

      const tabRow = document.getElementById("repoFileTabRow");
      const tabSelect = document.getElementById("repoFileTabSelect");
      tabSelect.innerHTML = "";
      workbook.SheetNames.forEach(name => {
        const opt = document.createElement("option");
        opt.value = name; opt.textContent = name;
        tabSelect.appendChild(opt);
      });
      tabRow.classList.toggle("hidden", workbook.SheetNames.length <= 1);
      applyRepoFileTab();
    } else {
      throw new Error("Toetatud on ainult .csv, .xlsx ja .xls failid.");
    }

    sheetState.source = "repofile";
    document.getElementById("sheetJoinControls").classList.remove("hidden");
    populateKeyColumnOptions();
    refreshJoinTargetOptions();

    if (!silent) setStatus("sheetStatus", `${sheetState.rows.length} rida loetud (${sheetState.headers.length} veergu).`);
  } catch (err) {
    setStatus("sheetStatus", `Repo faili lugemine ebaõnnestus (${err.message}).`);
  }
}

function applyRepoFileTab() {
  if (!sheetState.workbook) return;
  const tabSelect = document.getElementById("repoFileTabSelect");
  const sheetName = tabSelect.value || sheetState.workbook.SheetNames[0];
  const ws = sheetState.workbook.Sheets[sheetName];
  if (!ws) return;

  const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
  sheetState.rows = rows;
  const headers = new Set();
  rows.forEach(r => Object.keys(r).forEach(k => headers.add(k)));
  sheetState.headers = Array.from(headers);

  document.getElementById("sheetJoinControls").classList.remove("hidden");
  populateKeyColumnOptions();
  refreshJoinTargetOptions();
}

function populateKeyColumnOptions() {
  const select = document.getElementById("sheetKeyColumnSelect");
  select.innerHTML = "";
  sheetState.headers.forEach(h => {
    const opt = document.createElement("option");
    opt.value = h; opt.textContent = h;
    select.appendChild(opt);
  });
  const guess = sheetState.headers.find(h => /nimi|name|objekt|object|^id$/i.test(h));
  if (guess) select.value = guess;
}

function refreshJoinTargetOptions() {
  const select = document.getElementById("sheetTargetLayerSelect");
  const previous = select.value;
  select.innerHTML = "";
  Object.values(myLayers).forEach(entry => {
    const opt = document.createElement("option");
    opt.value = `my:${entry.id}`;
    opt.textContent = "📄 " + entry.name;
    select.appendChild(opt);
  });
  Object.keys(priaLayersState).forEach(typeName => {
    const opt = document.createElement("option");
    opt.value = `pria:${typeName}`;
    opt.textContent = "🌾 " + typeName;
    select.appendChild(opt);
  });
  if (select.options.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "(pole ühtegi sobivat kihti)";
    select.appendChild(opt);
  } else if (previous && Array.from(select.options).some(o => o.value === previous)) {
    select.value = previous;
  }
  populateTargetFieldOptions();
}

function resolveJoinTarget(targetId) {
  if (!targetId) return null;
  if (targetId.startsWith("my:")) {
    const entry = myLayers[targetId.slice(3)];
    return entry ? { kind: "my", entry, features: entry.rawFeatures } : null;
  }
  if (targetId.startsWith("pria:")) {
    const typeName = targetId.slice(5);
    const state = priaLayersState[typeName];
    if (!state) return null;
    const features = [];
    state.geo.eachLayer(l => { if (l.feature) features.push(l.feature); });
    return { kind: "pria", typeName, features };
  }
  return null;
}

function populateTargetFieldOptions() {
  const targetId = document.getElementById("sheetTargetLayerSelect").value;
  const fieldSelect = document.getElementById("sheetTargetFieldSelect");
  fieldSelect.innerHTML = "";
  const target = resolveJoinTarget(targetId);
  if (!target) return;
  const fields = target.kind === "my" ? target.entry.fields : collectFieldNamesFromFeatures(target.features);
  fields.forEach(f => {
    const opt = document.createElement("option");
    opt.value = f; opt.textContent = f;
    fieldSelect.appendChild(opt);
  });
  const guess = fields.find(f => /nimi|name|objekt|object|^id$/i.test(f));
  if (guess) fieldSelect.value = guess;
}

function performSheetJoin() {
  const keyColumn = document.getElementById("sheetKeyColumnSelect").value;
  const targetId = document.getElementById("sheetTargetLayerSelect").value;
  const targetField = document.getElementById("sheetTargetFieldSelect").value;

  if (!keyColumn || !targetId || !targetField) {
    setStatus("sheetJoinStatus", "Vali kõik kolm välja enne ühendamist.");
    return;
  }
  const target = resolveJoinTarget(targetId);
  if (!target) {
    setStatus("sheetJoinStatus", "Valitud kaardikihti ei leitud.");
    return;
  }

  const lookup = new Map();
  sheetState.rows.forEach(row => {
    const key = normalizeJoinKey(row[keyColumn]);
    if (key) lookup.set(key, row);
  });

  const matchedKeys = new Set();
  let matchedCount = 0;

  target.features.forEach(feature => {
    const rawValue = feature.properties ? feature.properties[targetField] : undefined;
    const key = normalizeJoinKey(rawValue);
    const row = key ? lookup.get(key) : null;
    if (row) {
      feature.properties = { ...feature.properties, ...row };
      matchedKeys.add(key);
      matchedCount++;
    }
  });

  const unmatchedSheetRows = sheetState.rows.filter(row => {
    const key = normalizeJoinKey(row[keyColumn]);
    return key && !matchedKeys.has(key);
  });

  if (target.kind === "my") {
    target.entry.fields = collectFieldNamesFromFeatures(target.entry.rawFeatures);
    renderMyLayersList();
    renderMyLayerForCurrentView(target.entry);
    refreshSearchFieldOptions();
  } else {
    refreshAllEnabledPriaLayers();
  }

  let msg = `${matchedCount} kaardiobjekti ühendatud Sheeti andmetega.`;
  if (unmatchedSheetRows.length > 0) {
    const sample = unmatchedSheetRows.slice(0, 5).map(r => r[keyColumn]).join(", ");
    msg += ` ${unmatchedSheetRows.length} Sheeti reale ei leitud kaardilt vastavat objekti (nt: ${sample}${unmatchedSheetRows.length > 5 ? ", ..." : ""}).`;
  }
  setStatus("sheetJoinStatus", msg);
}

function normalizeJoinKey(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim().toLowerCase();
}

function setupSheetAutoRefresh(ms) {
  clearInterval(sheetState.timerHandle);
  sheetState.timerHandle = null;
  if (ms > 0) {
    sheetState.timerHandle = setInterval(async () => {
      if (sheetState.source === "repofile") await loadRepoFileData(true);
      else await loadSheetData(true);
      performSheetJoin();
    }, ms);
  }
}

/* ---------------------------------------------------------------------- */
/* HELPERS                                                                  */
/* ---------------------------------------------------------------------- */
function setStatus(elId, text) {
  const el = document.getElementById(elId);
  if (el) el.textContent = text;
}

function debounce(fn, wait) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function cssEscape(str) {
  return window.CSS && CSS.escape ? CSS.escape(str) : str.replace(/["\\]/g, "\\$&");
}
