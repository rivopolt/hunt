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

/* ---- Grupp (nähtavuse piiramine) ---- */
let currentGroupCode = null;      // 4-kohaline string, valitakse käivitusdialoogis
const ADMIN_GROUP_CODE = "1312";  // näeb kõigi gruppide andmeid, filtrit ei rakendata

/* ---- Ulukite jäljed + Hundilipud: ÜKS jagatud andmestik serveris ----
   data/registrations_all.geojson on ainus andmefail — kõik seadmed
   loevad ja kirjutavad sama faili (kirjutamine käib väikese
   Cloudflare Worker API kaudu, vt CONFIG.apiUrl). Midagi ei laadita
   automaatselt kohalikku faili — "salvesta" saadab kirje otse
   serverisse ja laeb kogu andmestiku kohe uuesti. */
let sharedDataset = [];           // [{feature, kind: "track"|"hundilipud", group: L.featureGroup}]
let tracksLayerGroup = null;      // kaardile lisatud/eemaldatud filtreerimise jaoks
let hundilipudLayerGroup = null;
let trackDrawState = null;        // null | { type: "point"|"line", points: [latlng,...] }
let trackPreviewLayers = [];
let hundilipudDrawState = null;   // null | { points: [latlng,...] }
let hundilipudPreviewLayers = [];

/* ---------------------------------------------------------------------- */
/* INIT                                                                    */
/* ---------------------------------------------------------------------- */
document.addEventListener("DOMContentLoaded", initGroupGate);

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
  setupHundilipud();
  setupPria();
  setupFileUpload();
  setupMyFilesBrowser();
  setupLocateControls();
  setupCoordReadout();
  setupPanelToggle();
  setupModals();

  loadSharedDataset();

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
/* GRUPI VALIK (startup gate)                                              */
/* ---------------------------------------------------------------------- */
let pendingNewGroupCode = null;

function initGroupGate() {
  document.getElementById("groupGateCloseBtn").addEventListener("click", hideGroupGate);
  document.getElementById("groupGateStartBtn").addEventListener("click", handleGroupGateStart);
  document.getElementById("groupGateJoinShowBtn").addEventListener("click", () => showGroupGateStep("join"));
  document.getElementById("groupGateJoinBackBtn").addEventListener("click", () => showGroupGateStep("choose"));
  document.getElementById("groupGateJoinConfirmBtn").addEventListener("click", handleGroupGateJoinConfirm);
  document.getElementById("groupGateCreatedContinueBtn").addEventListener("click", handleGroupGateCreatedContinue);
  document.getElementById("groupBadgeBtn").addEventListener("click", () => openGroupGate(false));

  const saved = localStorage.getItem("jaljedGroupCode");
  if (saved && /^\d{4}$/.test(saved)) {
    currentGroupCode = saved;
    updateGroupBadge();
    init();
  } else {
    openGroupGate(true);
  }
}

function openGroupGate(mandatory) {
  document.getElementById("groupGateOverlay").classList.remove("hidden");
  document.getElementById("groupGateCloseBtn").classList.toggle("hidden", mandatory);
  showGroupGateStep("choose");
}

function hideGroupGate() {
  document.getElementById("groupGateOverlay").classList.add("hidden");
}

function showGroupGateStep(step) {
  const labels = { choose: "Choose", created: "Created", join: "Join" };
  Object.keys(labels).forEach(s => {
    document.getElementById(`groupGateStep${labels[s]}`).classList.toggle("hidden", s !== step);
  });
  document.getElementById("groupGateJoinError").classList.add("hidden");
  document.getElementById("groupGateCodeInput").value = "";
}

function handleGroupGateStart() {
  let code;
  do {
    code = String(Math.floor(1000 + Math.random() * 9000));
  } while (code === CONFIG.adminGroupCode);
  pendingNewGroupCode = code;
  document.getElementById("groupGateNewCode").textContent = code;
  showGroupGateStep("created");
}

function handleGroupGateCreatedContinue() {
  setActiveGroup(pendingNewGroupCode);
}

function handleGroupGateJoinConfirm() {
  const val = document.getElementById("groupGateCodeInput").value.trim();
  const errEl = document.getElementById("groupGateJoinError");
  if (!/^\d{4}$/.test(val)) {
    errEl.textContent = "Sisesta täpselt 4 numbrit.";
    errEl.classList.remove("hidden");
    return;
  }
  setActiveGroup(val);
}

function setActiveGroup(code) {
  currentGroupCode = code;
  localStorage.setItem("jaljedGroupCode", code);
  updateGroupBadge();
  hideGroupGate();
  if (!map) {
    init();
  } else {
    loadSharedDataset();
  }
}

function updateGroupBadge() {
  const badge = document.getElementById("groupBadgeBtn");
  const isAdmin = currentGroupCode === CONFIG.adminGroupCode;
  badge.textContent = isAdmin ? "Grupp: 1312 (admin)" : `Grupp: ${currentGroupCode}`;
}

function isVisibleToCurrentGroup(feature) {
  if (currentGroupCode === CONFIG.adminGroupCode) return true;
  return feature.properties && feature.properties.group_code === currentGroupCode;
}

function todayIsoDate(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function applyQuickDateFilter(target, range) {
  let from = "", to = "";
  if (range === "today") { from = todayIsoDate(); to = todayIsoDate(); }
  else if (range === "yesterday") { from = todayIsoDate(-1); to = todayIsoDate(-1); }
  else if (range === "week") { from = todayIsoDate(-7); to = todayIsoDate(); }
  // "all" leaves from/to empty

  document.getElementById(`${target}DateFrom`).value = from;
  document.getElementById(`${target}DateTo`).value = to;
  document.querySelectorAll(`.quickFilterBtn[data-target="${target}"]`).forEach(b => {
    b.classList.toggle("active", b.dataset.range === range);
  });

  if (target === "tracks") applyTracksFilter(); else applyHundilipudFilter();
}

/* ---------------------------------------------------------------------- */
/* ÜHINE ANDMESTIK: ulukite jäljed + hundilipud, üks fail serveris          */
/* ---------------------------------------------------------------------- */

/* ---- Loading (always straight from the server file — never local) ---- */
async function loadSharedDataset() {
  const tracksStatusEl = document.getElementById("tracksStatus");
  const hlStatusEl = document.getElementById("hundilipudStatus");
  tracksStatusEl.textContent = "Laen...";
  hlStatusEl.textContent = "Laen...";
  try {
    const resp = await fetch(`${CONFIG.dataUrl}?_=${Date.now()}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const geojson = await resp.json();

    tracksLayerGroup.clearLayers();
    hundilipudLayerGroup.clearLayers();
    sharedDataset = (geojson.features || []).map(feature => {
      const kind = feature.properties && feature.properties.feature_type === "hundilipud" ? "hundilipud" : "track";
      const group = kind === "hundilipud" ? renderHundilipudFeature(feature) : renderTrackFeature(feature);
      return { feature, kind, group };
    });

    tracksStatusEl.textContent = "Laetud.";
    hlStatusEl.textContent = "Laetud.";
    applyTracksFilter();
    applyHundilipudFilter();
  } catch (err) {
    tracksStatusEl.textContent = "Ei õnnestunud laadida.";
    hlStatusEl.textContent = "Ei õnnestunud laadida.";
    console.warn("loadSharedDataset failed:", err);
  }
}

/* ---- Saving: POST straight to the write API, no local file, ever ---- */
async function submitFeatureToServer(feature, statusElId) {
  const statusEl = document.getElementById(statusElId);
  if (!CONFIG.apiUrl) {
    statusEl.textContent = "Salvestamise API pole veel seadistatud (CONFIG.apiUrl on tühi) — vt README.md.";
    return false;
  }
  statusEl.textContent = "Salvestan serverisse...";
  try {
    const resp = await fetch(`${CONFIG.apiUrl}/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feature })
    });
    const result = await resp.json().catch(() => ({}));
    if (!resp.ok || !result.ok) throw new Error(result.error || `HTTP ${resp.status}`);
    statusEl.textContent = "Salvestatud — nähtav kõigile grupi liikmetele.";
    await loadSharedDataset();
    return true;
  } catch (err) {
    statusEl.textContent = "Salvestamine ebaõnnestus: " + err.message;
    console.warn("submitFeatureToServer failed:", err);
    return false;
  }
}

/* ---------------------------------------------------------------------- */
/* ULUKITE JÄLJED (wildlife track registrations)                            */
/* ---------------------------------------------------------------------- */
function setupTracks() {
  tracksLayerGroup = L.layerGroup().addTo(map);

  const speciesSelect = document.getElementById("trackSpeciesSelect");
  CONFIG.tracks.species.forEach(s => {
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = s.label;
    speciesSelect.appendChild(opt);
  });

  const dirSelect = document.getElementById("trackDirectionSelect");
  CONFIG.tracks.directions.forEach(d => {
    const opt = document.createElement("option");
    opt.value = d.id;
    opt.textContent = d.label;
    dirSelect.appendChild(opt);
  });
  dirSelect.value = "end";

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
  document.querySelectorAll('.quickFilterBtn[data-target="tracks"]').forEach(btn => {
    btn.addEventListener("click", () => applyQuickDateFilter("tracks", btn.dataset.range));
  });
  // Default: only today's tracks are visible until the filter is changed.
  document.getElementById("tracksDateFrom").value = todayIsoDate();
  document.getElementById("tracksDateTo").value = todayIsoDate();
  document.querySelector('.quickFilterBtn[data-target="tracks"][data-range="today"]').classList.add("active");

  document.getElementById("trackDateInput").value = todayIsoDate();

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
  document.getElementById("tracksLoadBtn").addEventListener("click", loadSharedDataset);
}

/* ---- Registration widget open/close ---- */
function toggleTrackRegisterWidget() {
  const widget = document.getElementById("trackRegisterWidget");
  const opening = widget.classList.contains("hidden");
  closeHundilipudWidget();
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
   the "dblclick" event itself in Leaflet, which made line-finishing
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

/* ---- Save: send straight to the server, no local file ---- */
async function saveTrackRegistration() {
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
      feature_type: "track",
      geom_type: type,
      species,
      direction,
      date,
      pack_size: packSize,
      remarks,
      registrant,
      group_code: currentGroupCode,
      registered_at: new Date().toISOString()
    }
  };

  const trackSaveBtn = document.getElementById("trackSaveBtn");
  trackSaveBtn.disabled = true;
  const ok = await submitFeatureToServer(feature, "trackSaveStatus");
  if (ok) {
    cancelTrackDrawing();
    document.getElementById("trackRemarksInput").value = "";
    document.getElementById("trackPackSizeInput").value = "1";
  } else {
    trackSaveBtn.disabled = false;
  }
}

/* ---- Rendering ---- */
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
  if (currentGroupCode === CONFIG.adminGroupCode) html += `Grupp: ${escapeHtml(props.group_code || "—")}<br>`;
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

/* ---- Filtering (species + date range + group), against the shared dataset ---- */
function applyTracksFilter() {
  const checkedSpecies = new Set(
    Array.from(document.querySelectorAll(".trackSpeciesFilterCheckbox:checked")).map(cb => cb.value)
  );
  const from = document.getElementById("tracksDateFrom").value;
  const to = document.getElementById("tracksDateTo").value;

  let visibleCount = 0, totalCount = 0;
  sharedDataset.forEach(entry => {
    if (entry.kind !== "track") return;
    totalCount++;
    const props = entry.feature.properties || {};
    let visible = isVisibleToCurrentGroup(entry.feature) && checkedSpecies.has(props.species);
    if (visible && from && props.date && props.date < from) visible = false;
    if (visible && to && props.date && props.date > to) visible = false;

    const currentlyOn = tracksLayerGroup.hasLayer(entry.group);
    if (visible && !currentlyOn) tracksLayerGroup.addLayer(entry.group);
    if (!visible && currentlyOn) tracksLayerGroup.removeLayer(entry.group);
    if (visible) visibleCount++;
  });

  document.getElementById("tracksCount").textContent = `Näidatud: ${visibleCount} / ${totalCount}`;
}

/* ---------------------------------------------------------------------- */
/* HUNDILIPUD (wolf-scaring flag lines) — always a red dashed line          */
/* ---------------------------------------------------------------------- */
function setupHundilipud() {
  hundilipudLayerGroup = L.layerGroup().addTo(map);

  const registrantSelect = document.getElementById("hundilipudRegistrantSelect");
  CONFIG.hundilipud.registrants.forEach(r => {
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
    document.getElementById("hundilipudRegistrantOtherInput").classList.toggle("hidden", registrantSelect.value !== "other");
  });

  document.getElementById("hundilipudDateInput").value = todayIsoDate();

  document.getElementById("hundilipudToggleBtn").addEventListener("click", toggleHundilipudWidget);
  document.getElementById("hundilipudCloseBtn").addEventListener("click", closeHundilipudWidget);
  document.getElementById("hundilipudDrawStartBtn").addEventListener("click", startHundilipudDrawing);
  document.getElementById("hundilipudFinishBtn").addEventListener("click", finishHundilipudDrawing);
  document.getElementById("hundilipudCancelDrawBtn").addEventListener("click", cancelHundilipudDrawing);
  document.getElementById("hundilipudSaveBtn").addEventListener("click", saveHundilipud);
  document.getElementById("hundilipudLoadBtn").addEventListener("click", loadSharedDataset);

  document.getElementById("hundilipudDateFrom").addEventListener("change", applyHundilipudFilter);
  document.getElementById("hundilipudDateTo").addEventListener("change", applyHundilipudFilter);
  document.querySelectorAll('.quickFilterBtn[data-target="hundilipud"]').forEach(btn => {
    btn.addEventListener("click", () => applyQuickDateFilter("hundilipud", btn.dataset.range));
  });
  document.getElementById("hundilipudDateFrom").value = todayIsoDate();
  document.getElementById("hundilipudDateTo").value = todayIsoDate();
  document.querySelector('.quickFilterBtn[data-target="hundilipud"][data-range="today"]').classList.add("active");
}

/* ---- Widget open/close ---- */
function toggleHundilipudWidget() {
  const widget = document.getElementById("hundilipudWidget");
  const opening = widget.classList.contains("hidden");
  closeTrackRegisterWidget();
  widget.classList.toggle("hidden", !opening);
  document.getElementById("hundilipudToggleBtn").classList.toggle("active", opening);
  if (!opening) cancelHundilipudDrawing();
}

function closeHundilipudWidget() {
  document.getElementById("hundilipudWidget").classList.add("hidden");
  document.getElementById("hundilipudToggleBtn").classList.remove("active");
  cancelHundilipudDrawing();
}

/* ---- Drawing (line only, finished via explicit button — see track
   drawing comment above for why not dblclick) ---- */
function startHundilipudDrawing() {
  cancelHundilipudDrawing();
  hundilipudDrawState = { points: [] };
  document.getElementById("map").classList.add("map-drawing-cursor");
  map.on("click", handleHundilipudDrawClick);

  const hint = document.getElementById("hundilipudDrawHint");
  hint.classList.remove("hidden");
  hint.textContent = "Klõpsa kaardil, et lisada liinile punkte. Kui oled valmis (vähemalt 2 punkti), vajuta \"✔\".";
  document.getElementById("hundilipudCancelDrawBtn").classList.remove("hidden");
  document.getElementById("hundilipudSaveBtn").disabled = true;

  const finishBtn = document.getElementById("hundilipudFinishBtn");
  finishBtn.classList.remove("hidden");
  finishBtn.disabled = true;
}

function handleHundilipudDrawClick(e) {
  if (!hundilipudDrawState) return;
  hundilipudDrawState.points.push(e.latlng);
  redrawHundilipudPreview();
  document.getElementById("hundilipudFinishBtn").disabled = hundilipudDrawState.points.length < 2;
}

function finishHundilipudDrawing() {
  if (!hundilipudDrawState || hundilipudDrawState.points.length < 2) {
    notify("Liini jaoks on vaja vähemalt 2 punkti.");
    return;
  }
  map.off("click", handleHundilipudDrawClick);
  document.getElementById("map").classList.remove("map-drawing-cursor");
  document.getElementById("hundilipudDrawHint").textContent = "Valmis — kontrolli vormi ja vajuta \"💾 Salvesta liin\".";
  document.getElementById("hundilipudFinishBtn").classList.add("hidden");
  document.getElementById("hundilipudSaveBtn").disabled = false;
}

function cancelHundilipudDrawing() {
  map.off("click", handleHundilipudDrawClick);
  document.getElementById("map").classList.remove("map-drawing-cursor");
  hundilipudPreviewLayers.forEach(l => map.removeLayer(l));
  hundilipudPreviewLayers = [];
  hundilipudDrawState = null;
  document.getElementById("hundilipudDrawHint").classList.add("hidden");
  document.getElementById("hundilipudCancelDrawBtn").classList.add("hidden");
  document.getElementById("hundilipudFinishBtn").classList.add("hidden");
  document.getElementById("hundilipudSaveBtn").disabled = true;
}

function redrawHundilipudPreview() {
  hundilipudPreviewLayers.forEach(l => map.removeLayer(l));
  hundilipudPreviewLayers = [];
  const pts = hundilipudDrawState.points;
  pts.forEach(p => hundilipudPreviewLayers.push(L.circleMarker(p, { radius: 4, color: CONFIG.hundilipud.color, weight: 2, fillOpacity: 0.9 }).addTo(map)));
  if (pts.length >= 2) {
    hundilipudPreviewLayers.push(L.polyline(pts, {
      color: CONFIG.hundilipud.color, weight: 3, dashArray: CONFIG.hundilipud.dashArray
    }).addTo(map));
  }
}

/* ---- Save: send straight to the server, no local file ---- */
async function saveHundilipud() {
  if (!hundilipudDrawState || hundilipudDrawState.points.length < 2) {
    notify("Kõigepealt joonista hundilippude liin kaardile.");
    return;
  }

  const date = document.getElementById("hundilipudDateInput").value || todayIsoDate();
  const remarks = document.getElementById("hundilipudRemarksInput").value.trim();
  const registrantSelectVal = document.getElementById("hundilipudRegistrantSelect").value;
  const registrant = registrantSelectVal === "other"
    ? document.getElementById("hundilipudRegistrantOtherInput").value.trim()
    : registrantSelectVal;

  const coords = hundilipudDrawState.points.map(p => [p.lng, p.lat]);
  const feature = {
    type: "Feature",
    geometry: { type: "LineString", coordinates: coords },
    properties: {
      feature_type: "hundilipud",
      date,
      remarks,
      registrant,
      group_code: currentGroupCode,
      registered_at: new Date().toISOString()
    }
  };

  const saveBtn = document.getElementById("hundilipudSaveBtn");
  saveBtn.disabled = true;
  const ok = await submitFeatureToServer(feature, "hundilipudSaveStatus");
  if (ok) {
    cancelHundilipudDrawing();
    document.getElementById("hundilipudRemarksInput").value = "";
  } else {
    saveBtn.disabled = false;
  }
}

/* ---- Rendering ---- */
function hundilipudPopupHtml(props) {
  let html = `<strong>Hundilipud</strong><br>`;
  html += `Kuupäev: ${escapeHtml(props.date || "—")}<br>`;
  if (props.remarks) html += `Märkused: ${escapeHtml(props.remarks)}<br>`;
  if (props.registrant) html += `Registreerija: ${escapeHtml(props.registrant)}<br>`;
  if (currentGroupCode === CONFIG.adminGroupCode) html += `Grupp: ${escapeHtml(props.group_code || "—")}<br>`;
  return html;
}

function renderHundilipudFeature(feature) {
  const latlngs = feature.geometry.coordinates.map(c => L.latLng(c[1], c[0]));
  const line = L.polyline(latlngs, {
    color: CONFIG.hundilipud.color,
    weight: 4,
    opacity: 0.9,
    dashArray: CONFIG.hundilipud.dashArray
  });
  const group = L.featureGroup([line]);
  group.bindPopup(hundilipudPopupHtml(feature.properties || {}));
  return group;
}

/* ---- Filtering (date range + group), against the shared dataset ---- */
function applyHundilipudFilter() {
  const from = document.getElementById("hundilipudDateFrom").value;
  const to = document.getElementById("hundilipudDateTo").value;

  let visibleCount = 0, totalCount = 0;
  sharedDataset.forEach(entry => {
    if (entry.kind !== "hundilipud") return;
    totalCount++;
    const props = entry.feature.properties || {};
    let visible = isVisibleToCurrentGroup(entry.feature);
    if (visible && from && props.date && props.date < from) visible = false;
    if (visible && to && props.date && props.date > to) visible = false;

    const currentlyOn = hundilipudLayerGroup.hasLayer(entry.group);
    if (visible && !currentlyOn) hundilipudLayerGroup.addLayer(entry.group);
    if (!visible && currentlyOn) hundilipudLayerGroup.removeLayer(entry.group);
    if (visible) visibleCount++;
  });

  document.getElementById("hundilipudCount").textContent = `Näidatud: ${visibleCount} / ${totalCount}`;
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
  document.getElementById("mapLocateBtn").addEventListener("click", toggleLiveLocation);
}

function setLocateButtonsActive(active) {
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
      <p>Ulukite jälgede ja hundilippude registreerimise ning kaardistamise
      rakendus: taustakaardid, PRIA põllumassiivid, ulukijälgede/hundilippude
      sisestus ja filtreerimine (grupipõhine nähtavus) ning sinu enda
      üleslaetud kaardikihid ühel vaatel.</p>
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
