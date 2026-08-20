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
let trackEditEntry = null;        // null | the sharedDataset entry currently being edited
let hundilipudEditEntry = null;   // null | the sharedDataset entry currently being edited

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
  setupScaleBar();
  setupPanelToggle();
  setupModals();
  setupStats();

  loadSharedDataset();
  logPresence();

  // Keep the shared dataset in sync across devices without anyone
  // needing to hit "↻ Lae" manually — safe against the disappearing-
  // element issue since loadSharedDataset() now merges rather than
  // blindly overwrites (see recentlyDeletedKeys / __localOnly above).
  setInterval(loadSharedDataset, 3 * 60 * 1000);

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
/* GRUPI VALIK (kuni 5 gruppi: liitu, halda, eemalda)                       */
/* ---------------------------------------------------------------------- */
const MAX_GROUPS = 5;
let pendingNewGroupCode = null;
let groupGateMode = "initial";  // "initial" (esimene seadistus) | "manage" (lisamine/haldus hiljem)

/* ---- Salvestus (kuni 5 liidetud gruppi + üks aktiivne) ---- */
function getJoinedGroups() {
  try {
    const arr = JSON.parse(localStorage.getItem("jaljedGroups") || "[]");
    return Array.isArray(arr) ? arr.filter(c => /^\d{4}$/.test(c)) : [];
  } catch (e) { return []; }
}
function saveJoinedGroups(groups) {
  localStorage.setItem("jaljedGroups", JSON.stringify(groups));
}
function getActiveGroup() {
  const g = localStorage.getItem("jaljedActiveGroup");
  return g && /^\d{4}$/.test(g) ? g : null;
}
function setActiveGroupCode(code) {
  localStorage.setItem("jaljedActiveGroup", code || "");
  currentGroupCode = code;
  updateGroupBadge();
}
function isAdminUser() {
  return getJoinedGroups().includes(CONFIG.adminGroupCode);
}

// One-time migration from the old single-group storage key.
function migrateOldGroupStorage() {
  const old = localStorage.getItem("jaljedGroupCode");
  if (old && /^\d{4}$/.test(old) && getJoinedGroups().length === 0) {
    saveJoinedGroups([old]);
    localStorage.setItem("jaljedActiveGroup", old);
  }
  localStorage.removeItem("jaljedGroupCode");
}

function initGroupGate() {
  migrateOldGroupStorage();

  document.getElementById("groupGateCloseBtn").addEventListener("click", hideGroupGate);
  document.getElementById("groupGateStartBtn").addEventListener("click", handleGroupGateStart);
  document.getElementById("groupGateJoinShowBtn").addEventListener("click", () => showGroupGateStep("join"));
  document.getElementById("groupGateJoinBackBtn").addEventListener("click", () => showGroupGateStep("choose"));
  document.getElementById("groupGateJoinConfirmBtn").addEventListener("click", handleGroupGateJoinConfirm);
  document.getElementById("groupGateCreatedContinueBtn").addEventListener("click", handleGroupGateCreatedContinue);
  document.getElementById("groupGateChooseBackBtn").addEventListener("click", () => {
    showGroupGateStep("manage");
    renderGroupGateList();
  });
  document.getElementById("groupGateAddBtn").addEventListener("click", () => showGroupGateStep("choose"));
  document.getElementById("groupBadgeBtn").addEventListener("click", openGroupGate);
  document.getElementById("groupBadgeBtnOuter").addEventListener("click", openGroupGate);

  const groups = getJoinedGroups();
  if (groups.length > 0) {
    let active = getActiveGroup();
    if (!active || !groups.includes(active)) active = groups[0];
    setActiveGroupCode(active);
    init();
  } else {
    openGroupGate();
  }
}

function openGroupGate() {
  document.getElementById("groupGateOverlay").classList.remove("hidden");
  const groups = getJoinedGroups();
  document.getElementById("groupGateCloseBtn").classList.toggle("hidden", groups.length === 0);
  if (groups.length > 0) {
    groupGateMode = "manage";
    showGroupGateStep("manage");
    renderGroupGateList();
  } else {
    groupGateMode = "initial";
    showGroupGateStep("choose");
  }
}

function hideGroupGate() {
  document.getElementById("groupGateOverlay").classList.add("hidden");
}

function showGroupGateStep(step) {
  const labels = { choose: "Choose", created: "Created", join: "Join", manage: "Manage" };
  Object.keys(labels).forEach(s => {
    document.getElementById(`groupGateStep${labels[s]}`).classList.toggle("hidden", s !== step);
  });
  document.getElementById("groupGateJoinError").classList.add("hidden");
  document.getElementById("groupGateCodeInput").value = "";
  document.getElementById("groupGateChooseBackBtn").classList.toggle("hidden", !(step === "choose" && groupGateMode === "manage"));

  if (step === "choose") {
    const title = document.getElementById("groupGateChooseTitle");
    const subtitle = document.getElementById("groupGateChooseSubtitle");
    if (groupGateMode === "manage") {
      title.textContent = "Lisa grupp";
      subtitle.textContent = "Alusta uut gruppi või liitu olemasoleva grupikoodiga.";
    } else {
      title.textContent = "Tere tulemast!";
      subtitle.textContent = "Jäljed ja hundilipud on nähtavad ainult sinu enda grupi liikmetele. Alusta uut gruppi või liitu olemasolevaga.";
    }
  }
}

function renderGroupGateList() {
  const groups = getJoinedGroups();
  const active = getActiveGroup();
  const listEl = document.getElementById("groupGateList");
  listEl.innerHTML = "";

  groups.forEach(code => {
    const isActive = code === active;
    const row = document.createElement("div");
    row.className = "groupGateRow" + (isActive ? " active" : "");
    row.innerHTML = `
      <span class="groupGateRowCode">${escapeHtml(code)}${code === CONFIG.adminGroupCode ? " (admin)" : ""}</span>
      <span class="groupGateRowActiveLabel">${isActive ? "✓ aktiivne" : "vali aktiivseks"}</span>
      <button class="groupGateRowRemove" title="Eemalda grupp">✕</button>
    `;
    row.querySelector(".groupGateRowActiveLabel").addEventListener("click", (e) => {
      e.stopPropagation();
      activateGroup(code);
    });
    row.addEventListener("click", () => activateGroup(code));
    row.querySelector(".groupGateRowRemove").addEventListener("click", (e) => {
      e.stopPropagation();
      removeGroup(code);
    });
    listEl.appendChild(row);
  });

  document.getElementById("groupGateAddBtn").classList.toggle("hidden", groups.length >= MAX_GROUPS);
  document.getElementById("groupGateMaxNote").classList.toggle("hidden", groups.length < MAX_GROUPS);
}

function activateGroup(code) {
  setActiveGroupCode(code);
  renderGroupGateList();
  loadSharedDataset();
}

function removeGroup(code) {
  const groups = getJoinedGroups().filter(g => g !== code);
  saveJoinedGroups(groups);

  if (getActiveGroup() === code) {
    setActiveGroupCode(groups[0] || null);
  }

  if (groups.length === 0) {
    groupGateMode = "initial";
    document.getElementById("groupGateCloseBtn").classList.add("hidden");
    showGroupGateStep("choose");
  } else {
    renderGroupGateList();
  }
  loadSharedDataset();
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
  commitGroupJoin(pendingNewGroupCode);
}

function handleGroupGateJoinConfirm() {
  const val = document.getElementById("groupGateCodeInput").value.trim();
  const errEl = document.getElementById("groupGateJoinError");
  if (!/^\d{4}$/.test(val)) {
    errEl.textContent = "Sisesta täpselt 4 numbrit.";
    errEl.classList.remove("hidden");
    return;
  }
  commitGroupJoin(val);
}

function commitGroupJoin(code) {
  let groups = getJoinedGroups();
  if (!groups.includes(code)) {
    if (groups.length >= MAX_GROUPS) {
      notify(`Maksimaalselt ${MAX_GROUPS} gruppi korraga. Eemalda mõni grupp enne uue lisamist.`);
      showGroupGateStep("manage");
      renderGroupGateList();
      return;
    }
    groups = [...groups, code];
    saveJoinedGroups(groups);
  }
  setActiveGroupCode(code);

  if (groupGateMode === "initial") {
    hideGroupGate();
    if (!map) {
      init();
    } else {
      loadSharedDataset();
      logPresence();
    }
  } else {
    showGroupGateStep("manage");
    renderGroupGateList();
    loadSharedDataset();
    logPresence();
  }
}

function updateGroupBadge() {
  const groups = getJoinedGroups();
  const active = getActiveGroup();

  let html;
  if (groups.length === 0) {
    html = "Grupp: —";
  } else {
    const parts = groups.map(g => {
      const label = escapeHtml(g === CONFIG.adminGroupCode ? `${g} (admin)` : g);
      return g === active ? `<strong class="badgeActiveGroup">${label}</strong>` : `<span class="badgeInactiveGroup">${label}</span>`;
    });
    html = "Grupid: " + parts.join(", ");
  }
  document.getElementById("groupBadgeBtn").innerHTML = html;
  document.getElementById("groupBadgeBtnOuter").innerHTML = html;
  updateActiveGroupNotes(active);
}

// Shown inside the "Registreeri jälg" / "Hundilipud" panels so it's
// unmistakable which group a new drawing will be saved into.
function updateActiveGroupNotes(active) {
  const text = active ? `📍 Salvestatakse gruppi: ${active}` : "⚠️ Ühtegi gruppi pole valitud";
  const trackEl = document.getElementById("trackActiveGroupNote");
  const hundilipudEl = document.getElementById("hundilipudActiveGroupNote");
  if (trackEl) trackEl.textContent = text;
  if (hundilipudEl) hundilipudEl.textContent = text;
}

// Visible if the feature belongs to ANY group the person has joined —
// admin membership (group 1312) bypasses this and sees everything.
function isVisibleToCurrentGroup(feature) {
  if (isAdminUser()) return true;
  const code = feature.properties && feature.properties.group_code;
  return getJoinedGroups().includes(code);
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
// registered_at + group_code is the identity key used throughout (see
// the Worker's findFeatureIndex) — every feature has had this since day
// one, no separate id field needed.
function featureKey(feature) {
  return `${feature.properties && feature.properties.registered_at}:${feature.properties && feature.properties.group_code}`;
}

// Keys deleted locally this session — masked out of every subsequent
// server fetch so a stale read (GitHub Pages can take up to ~a minute
// to republish after a commit) can't make a deleted item reappear.
const recentlyDeletedKeys = new Set();

async function loadSharedDataset() {
  const tracksStatusEl = document.getElementById("tracksStatus");
  const hlStatusEl = document.getElementById("hundilipudStatus");
  tracksStatusEl.textContent = "Laen...";
  hlStatusEl.textContent = "Laen...";
  try {
    const resp = await fetch(`${CONFIG.dataUrl}?_=${Date.now()}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const geojson = await resp.json();

    const serverFeatures = (geojson.features || []).filter(f => !recentlyDeletedKeys.has(featureKey(f)));
    const serverKeys = new Set(serverFeatures.map(featureKey));

    // Keep any very-recent local-only adds/edits the server fetch
    // doesn't have yet, so a periodic or post-save reload never makes
    // a just-drawn element flash and vanish again.
    const pendingLocalOnly = sharedDataset.filter(e => e.__localOnly && !serverKeys.has(featureKey(e.feature)));

    tracksLayerGroup.clearLayers();
    hundilipudLayerGroup.clearLayers();
    sharedDataset = serverFeatures.map(feature => {
      const ft = feature.properties && feature.properties.feature_type;
      if (ft === "presence") return { feature, kind: "presence", group: null };
      const kind = ft === "hundilipud" ? "hundilipud" : "track";
      const group = kind === "hundilipud" ? renderHundilipudFeature(feature) : renderTrackFeature(feature);
      return { feature, kind, group };
    }).concat(pendingLocalOnly);

    tracksStatusEl.textContent = "Laetud.";
    hlStatusEl.textContent = "Laetud.";
    applyTracksFilter();
    applyHundilipudFilter();
    refreshGroupStats();
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

    // Show it on the map right away rather than waiting on this reload
    // to reflect it — GitHub Pages can take up to a minute to republish
    // after the commit, so loadSharedDataset() might still fetch the OLD
    // file for a bit. That's fine now: it merges rather than overwrites,
    // so this call is just a best-effort nudge toward other devices/tabs
    // picking up the change sooner than the 3-minute poll.
    const kind = feature.properties.feature_type === "hundilipud" ? "hundilipud" : "track";
    addFeatureLocallyAndDisplay(feature, kind);
    loadSharedDataset();

    statusEl.textContent = "Salvestatud! Nähtav kohe sinu kaardil, ja mõne hetke pärast (kui GitHub Pages värskendub) ka teistel seadmetel.";
    return true;
  } catch (err) {
    statusEl.textContent = "Salvestamine ebaõnnestus: " + err.message;
    console.warn("submitFeatureToServer failed:", err);
    return false;
  }
}

// Adds a just-saved feature straight into the in-memory dataset and
// re-renders it, without waiting on a server round-trip.
function addFeatureLocallyAndDisplay(feature, kind) {
  const group = kind === "hundilipud" ? renderHundilipudFeature(feature) : renderTrackFeature(feature);
  sharedDataset.push({ feature, kind, group, __localOnly: true });
  if (kind === "track") applyTracksFilter(); else applyHundilipudFilter();
  refreshGroupStats();
}

// Replaces an entry in-place (used after a successful edit) — removes
// the old rendered layer and adds the freshly rendered one.
function replaceFeatureLocally(oldEntry, newFeature, kind) {
  if (oldEntry.group) {
    tracksLayerGroup.removeLayer(oldEntry.group);
    hundilipudLayerGroup.removeLayer(oldEntry.group);
  }
  const idx = sharedDataset.indexOf(oldEntry);
  const group = kind === "hundilipud" ? renderHundilipudFeature(newFeature) : renderTrackFeature(newFeature);
  const newEntry = { feature: newFeature, kind, group, __localOnly: true };
  if (idx !== -1) sharedDataset.splice(idx, 1, newEntry);
  else sharedDataset.push(newEntry);
  if (kind === "track") applyTracksFilter(); else applyHundilipudFilter();
  refreshGroupStats();
}

// Removes an entry (used after a successful delete).
function removeFeatureLocally(entry) {
  recentlyDeletedKeys.add(featureKey(entry.feature));
  if (entry.group) {
    tracksLayerGroup.removeLayer(entry.group);
    hundilipudLayerGroup.removeLayer(entry.group);
  }
  const idx = sharedDataset.indexOf(entry);
  if (idx !== -1) sharedDataset.splice(idx, 1);
  refreshGroupStats();
}

async function submitFeatureUpdate(originalFeature, newFeature, statusElId) {
  const statusEl = document.getElementById(statusElId);
  if (!CONFIG.apiUrl) {
    statusEl.textContent = "Salvestamise API pole veel seadistatud (CONFIG.apiUrl on tühi) — vt README.md.";
    return false;
  }
  statusEl.textContent = "Salvestan muudatusi serverisse...";
  try {
    const resp = await fetch(`${CONFIG.apiUrl}/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        match: { registered_at: originalFeature.properties.registered_at, group_code: originalFeature.properties.group_code },
        feature: newFeature
      })
    });
    const result = await resp.json().catch(() => ({}));
    if (!resp.ok || !result.ok) throw new Error(result.error || `HTTP ${resp.status}`);
    statusEl.textContent = "Muudatused salvestatud!";
    return true;
  } catch (err) {
    statusEl.textContent = "Muutmine ebaõnnestus: " + err.message;
    console.warn("submitFeatureUpdate failed:", err);
    return false;
  }
}

async function submitFeatureDelete(feature) {
  if (!CONFIG.apiUrl) {
    notify("Salvestamise API pole veel seadistatud (CONFIG.apiUrl on tühi) — vt README.md.");
    return false;
  }
  try {
    const resp = await fetch(`${CONFIG.apiUrl}/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        match: { registered_at: feature.properties.registered_at, group_code: feature.properties.group_code }
      })
    });
    const result = await resp.json().catch(() => ({}));
    if (!resp.ok || !result.ok) throw new Error(result.error || `HTTP ${resp.status}`);
    return true;
  } catch (err) {
    notify("Kustutamine ebaõnnestus: " + err.message);
    console.warn("submitFeatureDelete failed:", err);
    return false;
  }
}

async function confirmDeleteFeature(feature, kind) {
  const label = kind === "hundilipud" ? "hundilipud liin" : "ulukijälg";
  const ok = await showConfirm(`Kustutada see ${label} jäädavalt kõigi grupi liikmete jaoks?`);
  if (!ok) return;

  const entry = sharedDataset.find(e =>
    e.feature.properties.registered_at === feature.properties.registered_at &&
    e.feature.properties.group_code === feature.properties.group_code
  );
  const success = await submitFeatureDelete(feature);
  if (success && entry) {
    removeFeatureLocally(entry);
    loadSharedDataset();
  }
}

/* ---------------------------------------------------------------------- */
/* KOHALOLU / STATISTIKA                                                   */
/* ---------------------------------------------------------------------- */
/* A once-per-day-per-device "I'm here" ping, used only to estimate how
   many distinct devices/logins a group has had. It carries no location
   (geometry: null) — GeoJSON explicitly allows an unlocated Feature. */
function getDeviceId() {
  let id = localStorage.getItem("jaljedDeviceId");
  if (!id) {
    id = "dev-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    localStorage.setItem("jaljedDeviceId", id);
  }
  return id;
}

async function logPresence() {
  if (!CONFIG.apiUrl || !currentGroupCode) return;
  const today = todayIsoDate();
  const dedupKey = `${today}:${currentGroupCode}`;
  if (localStorage.getItem("jaljedPresenceLogged") === dedupKey) return; // already pinged today for this group

  const feature = {
    type: "Feature",
    geometry: null,
    properties: {
      feature_type: "presence",
      device_id: getDeviceId(),
      group_code: currentGroupCode,
      date: today,
      registered_at: new Date().toISOString()
    }
  };

  try {
    const resp = await fetch(`${CONFIG.apiUrl}/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feature })
    });
    const result = await resp.json().catch(() => ({}));
    if (resp.ok && result.ok) {
      localStorage.setItem("jaljedPresenceLogged", dedupKey);
      sharedDataset.push({ feature, kind: "presence", group: null });
      refreshGroupStats();
    }
  } catch (err) {
    console.warn("logPresence failed:", err);
  }
}

// Approximate, low-effort stats for the current group (or, for the
// admin group, across everything): distinct devices seen, total
// "logins" (once-a-day pings), how many tracks/hundilipud lines exist
// in total, and the most recent activity timestamp.
function populateStatsGroupSelect() {
  const sel = document.getElementById("statsGroupSelect");
  if (!sel) return;
  const previousValue = sel.value || "all";

  sel.innerHTML = "";
  const allOpt = document.createElement("option");
  allOpt.value = "all";
  allOpt.textContent = isAdminUser() ? "Kõik grupid" : "Kõik minu grupid";
  sel.appendChild(allOpt);

  // Admin sees every group code that appears anywhere in the dataset;
  // everyone else can only pick from groups they've actually joined.
  const codes = isAdminUser()
    ? Array.from(new Set(
        sharedDataset.map(e => e.feature.properties && e.feature.properties.group_code).filter(Boolean)
      )).sort()
    : getJoinedGroups();

  codes.forEach(code => {
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = code === CONFIG.adminGroupCode ? `${code} (admin)` : code;
    sel.appendChild(opt);
  });

  if (Array.from(sel.options).some(o => o.value === previousValue)) sel.value = previousValue;
}

function refreshGroupStats() {
  const el = id => document.getElementById(id);
  if (!el("statsDevices")) return; // stats panel not in the DOM yet

  populateStatsGroupSelect();
  const selectedGroup = document.getElementById("statsGroupSelect").value || "all";

  const relevant = selectedGroup === "all"
    ? sharedDataset.filter(e => isVisibleToCurrentGroup(e.feature))
    : sharedDataset.filter(e => e.feature.properties && e.feature.properties.group_code === selectedGroup);

  const deviceIds = new Set();
  let logins = 0, trackCount = 0, hundilipudCount = 0, lastActivity = null;

  relevant.forEach(e => {
    const props = e.feature.properties || {};
    if (e.kind === "presence") {
      logins++;
      if (props.device_id) deviceIds.add(props.device_id);
    } else if (e.kind === "track") {
      trackCount++;
    } else if (e.kind === "hundilipud") {
      hundilipudCount++;
    }
    if (props.registered_at && (!lastActivity || props.registered_at > lastActivity)) {
      lastActivity = props.registered_at;
    }
  });

  el("statsDevices").textContent = deviceIds.size;
  el("statsLogins").textContent = logins;
  el("statsTracks").textContent = trackCount;
  el("statsHundilipud").textContent = hundilipudCount;
  el("statsLastActivity").textContent = lastActivity ? new Date(lastActivity).toLocaleString("et-EE") : "—";
}

function setupStats() {
  document.getElementById("statsGroupSelect").addEventListener("change", refreshGroupStats);
}

/* ---------------------------------------------------------------------- */
/* ULUKITE JÄLJED (wildlife track registrations)                            */
/* ---------------------------------------------------------------------- */
function setupTracks() {
  tracksLayerGroup = L.layerGroup().addTo(map);

  // "Karja suurus" labels only show once zoomed in past labelMinZoom —
  // toggled via a container class rather than opening/closing each
  // tooltip individually, so it stays cheap regardless of how many
  // tracks are on the map.
  updateTrackLabelVisibility();
  map.on("zoomend", updateTrackLabelVisibility);

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
  document.getElementById("trackEditCancelBtn").addEventListener("click", () => {
    exitTrackEditMode();
    cancelTrackDrawing();
  });
}

/* ---- Registration widget open/close ---- */
function toggleTrackRegisterWidget() {
  const widget = document.getElementById("trackRegisterWidget");
  const opening = widget.classList.contains("hidden");
  if (opening) openTrackRegisterWidget(); else closeTrackRegisterWidget();
}

function openTrackRegisterWidget() {
  closeHundilipudWidget();
  document.getElementById("trackRegisterWidget").classList.remove("hidden");
  document.getElementById("trackRegisterToggleBtn").classList.add("active");
}

function closeTrackRegisterWidget() {
  document.getElementById("trackRegisterWidget").classList.add("hidden");
  document.getElementById("trackRegisterToggleBtn").classList.remove("active");
  cancelTrackDrawing();
  exitTrackEditMode();
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
      group_code: trackEditEntry ? trackEditEntry.feature.properties.group_code : currentGroupCode,
      registered_at: trackEditEntry ? trackEditEntry.feature.properties.registered_at : new Date().toISOString()
    }
  };
  if (trackEditEntry) feature.properties.updated_at = new Date().toISOString();

  const trackSaveBtn = document.getElementById("trackSaveBtn");
  trackSaveBtn.disabled = true;

  if (trackEditEntry) {
    const originalFeature = trackEditEntry.feature;
    const ok = await submitFeatureUpdate(originalFeature, feature, "trackSaveStatus");
    if (ok) {
      replaceFeatureLocally(trackEditEntry, feature, "track");
      exitTrackEditMode();
      cancelTrackDrawing();
      loadSharedDataset();
    } else {
      trackSaveBtn.disabled = false;
    }
    return;
  }

  const ok = await submitFeatureToServer(feature, "trackSaveStatus");
  if (ok) {
    cancelTrackDrawing();
    document.getElementById("trackRemarksInput").value = "";
    document.getElementById("trackPackSizeInput").value = "1";
  } else {
    trackSaveBtn.disabled = false;
  }
}

/* ---- Edit mode: pre-fill the form from an existing feature, keep its
   geometry (redrawing is optional — draw again to replace it), and
   route Save through /update instead of /save on submit. ---- */
function openTrackEditForm(feature) {
  const entry = sharedDataset.find(e =>
    e.kind === "track" &&
    e.feature.properties.registered_at === feature.properties.registered_at &&
    e.feature.properties.group_code === feature.properties.group_code
  );
  trackEditEntry = entry || { feature }; // fall back to the popup's own feature if not found in dataset

  openTrackRegisterWidget();
  const props = feature.properties;

  document.querySelector(`input[name="trackGeomType"][value="${props.geom_type}"]`).checked = true;
  document.getElementById("trackDirectionRow").classList.toggle("hidden", props.geom_type !== "line");
  document.getElementById("trackSpeciesSelect").value = props.species;
  document.getElementById("trackDirectionSelect").value = props.direction || "none";
  document.getElementById("trackDateInput").value = props.date || todayIsoDate();
  document.getElementById("trackPackSizeInput").value = props.pack_size ?? "";
  document.getElementById("trackRemarksInput").value = props.remarks || "";

  const regSel = document.getElementById("trackRegistrantSelect");
  const otherInput = document.getElementById("trackRegistrantOtherInput");
  if (Array.from(regSel.options).some(o => o.value === props.registrant)) {
    regSel.value = props.registrant;
    otherInput.classList.add("hidden");
  } else {
    regSel.value = "other";
    otherInput.value = props.registrant || "";
    otherInput.classList.remove("hidden");
  }

  // Pre-load the existing geometry so Save works without redrawing —
  // if the person clicks "Alusta joonistamist" anyway, the normal
  // drawing flow just overwrites this with a fresh geometry.
  const coords = feature.geometry.coordinates;
  trackDrawState = {
    type: props.geom_type,
    points: props.geom_type === "point"
      ? [L.latLng(coords[1], coords[0])]
      : coords.map(c => L.latLng(c[1], c[0]))
  };
  document.getElementById("trackSaveBtn").disabled = false;
  document.getElementById("trackDrawHint").classList.add("hidden");

  document.getElementById("trackEditBanner").classList.remove("hidden");
  document.getElementById("trackSaveBtn").textContent = "💾 Salvesta muudatused";
}

function exitTrackEditMode() {
  trackEditEntry = null;
  document.getElementById("trackEditBanner").classList.add("hidden");
  document.getElementById("trackSaveBtn").textContent = "💾 Salvesta jälg";
}

/* ---- Rendering ---- */
function speciesConfig(id) {
  return CONFIG.tracks.species.find(s => s.id === id) || { id, label: id || "Teadmata", color: "#666" };
}

function trackPopupHtml(props) {
  const sp = speciesConfig(props.species);
  let html = `<strong>${escapeHtml(sp.label)}</strong><br>`;
  html += `Kuupäev: ${escapeHtml(props.date || "—")}<br>`;
  html += `Karja suurus: ${props.pack_size ?? "—"}<br>`;
  if (props.remarks) html += `Märkused: ${escapeHtml(props.remarks)}<br>`;
  if (props.registrant) html += `Registreerija: ${escapeHtml(props.registrant)}<br>`;
  if (isAdminUser()) html += `Grupp: ${escapeHtml(props.group_code || "—")}<br>`;
  return html;
}

// Builds the popup DOM node: the info HTML plus an Edit/Delete action
// row wired directly to real event listeners (avoids brittle inline
// onclick="" strings, and closes over the actual feature/kind).
function buildFeaturePopupContent(infoHtml, feature, kind) {
  const container = document.createElement("div");
  container.className = "popupContent";
  container.innerHTML = infoHtml;

  const btnRow = document.createElement("div");
  btnRow.className = "popupActionRow";

  const editBtn = document.createElement("button");
  editBtn.className = "popupEditBtn";
  editBtn.textContent = "✏️ Muuda";
  editBtn.addEventListener("click", () => {
    map.closePopup();
    if (kind === "hundilipud") openHundilipudEditForm(feature);
    else openTrackEditForm(feature);
  });

  const delBtn = document.createElement("button");
  delBtn.className = "popupDeleteBtn";
  delBtn.textContent = "✕ Kustuta";
  delBtn.addEventListener("click", () => {
    map.closePopup();
    confirmDeleteFeature(feature, kind);
  });

  btnRow.appendChild(editBtn);
  btnRow.appendChild(delBtn);
  container.appendChild(btnRow);
  return container;
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

// Thematic-by-date coloring: today = full strength, yesterday = lighter,
// everything older = lighter still. The base hue (species color for
// tracks, red for hundilipud) stays the same — only lightness changes.
function dateCategory(dateStr) {
  if (!dateStr) return "older";
  if (dateStr === todayIsoDate()) return "today";
  if (dateStr === todayIsoDate(-1)) return "yesterday";
  return "older";
}

function lightenHexColor(hex, amount) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const num = parseInt(m[1], 16);
  const r = (num >> 16) & 255, g = (num >> 8) & 255, b = num & 255;
  const mix = c => Math.round(c + (255 - c) * amount);
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

function dateThemedColor(baseColor, dateStr) {
  const category = dateCategory(dateStr);
  if (category === "today") return baseColor;
  if (category === "yesterday") return lightenHexColor(baseColor, 0.4);
  return lightenHexColor(baseColor, 0.7); // older
}

function updateTrackLabelVisibility() {
  const visible = map.getZoom() >= CONFIG.tracks.labelMinZoom;
  map.getContainer().classList.toggle("track-labels-visible", visible);
}

function renderTrackFeature(feature) {
  const props = feature.properties || {};
  const sp = speciesConfig(props.species);
  const color = dateThemedColor(sp.color, props.date);
  const layers = [];
  let mainLayer;

  if (feature.geometry.type === "Point") {
    const latlng = L.latLng(feature.geometry.coordinates[1], feature.geometry.coordinates[0]);
    mainLayer = L.circleMarker(latlng, {
      radius: 7, color, weight: 2, fillColor: color, fillOpacity: 0.75
    });
    layers.push(mainLayer);
  } else if (feature.geometry.type === "LineString") {
    const latlngs = feature.geometry.coordinates.map(c => L.latLng(c[1], c[0]));
    mainLayer = L.polyline(latlngs, { color, weight: 4, opacity: 0.9 });
    layers.push(mainLayer);
    const dir = props.direction || "none";
    if (dir === "start" || dir === "both") {
      layers.push(createArrowMarker(latlngs[0], computeBearingDeg(latlngs[1], latlngs[0]), color));
    }
    if (dir === "end" || dir === "both") {
      const n = latlngs.length;
      layers.push(createArrowMarker(latlngs[n - 1], computeBearingDeg(latlngs[n - 2], latlngs[n - 1]), color));
    }
  }

  // "Karja suurus" label — only shown once zoomed in enough to read
  // without cluttering the map (toggled via a container class, see
  // updateLabelVisibility()), so it doesn't render at all otherwise.
  if (mainLayer && props.pack_size != null && props.pack_size !== "") {
    mainLayer.bindTooltip(String(props.pack_size), {
      permanent: true,
      direction: "top",
      offset: [0, -6],
      className: "trackPackSizeLabel"
    });
  }

  const group = L.featureGroup(layers);
  group.bindPopup(() => buildFeaturePopupContent(trackPopupHtml(props), feature, "track"));
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
  document.getElementById("hundilipudEditCancelBtn").addEventListener("click", () => {
    exitHundilipudEditMode();
    cancelHundilipudDrawing();
  });

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
  if (opening) openHundilipudWidget(); else closeHundilipudWidget();
}

function openHundilipudWidget() {
  closeTrackRegisterWidget();
  document.getElementById("hundilipudWidget").classList.remove("hidden");
  document.getElementById("hundilipudToggleBtn").classList.add("active");
}

function closeHundilipudWidget() {
  document.getElementById("hundilipudWidget").classList.add("hidden");
  document.getElementById("hundilipudToggleBtn").classList.remove("active");
  cancelHundilipudDrawing();
  exitHundilipudEditMode();
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
      group_code: hundilipudEditEntry ? hundilipudEditEntry.feature.properties.group_code : currentGroupCode,
      registered_at: hundilipudEditEntry ? hundilipudEditEntry.feature.properties.registered_at : new Date().toISOString()
    }
  };
  if (hundilipudEditEntry) feature.properties.updated_at = new Date().toISOString();

  const saveBtn = document.getElementById("hundilipudSaveBtn");
  saveBtn.disabled = true;

  if (hundilipudEditEntry) {
    const originalFeature = hundilipudEditEntry.feature;
    const ok = await submitFeatureUpdate(originalFeature, feature, "hundilipudSaveStatus");
    if (ok) {
      replaceFeatureLocally(hundilipudEditEntry, feature, "hundilipud");
      exitHundilipudEditMode();
      cancelHundilipudDrawing();
      loadSharedDataset();
    } else {
      saveBtn.disabled = false;
    }
    return;
  }

  const ok = await submitFeatureToServer(feature, "hundilipudSaveStatus");
  if (ok) {
    cancelHundilipudDrawing();
    document.getElementById("hundilipudRemarksInput").value = "";
  } else {
    saveBtn.disabled = false;
  }
}

/* ---- Edit mode (same pattern as track edit — see that comment) ---- */
function openHundilipudEditForm(feature) {
  const entry = sharedDataset.find(e =>
    e.kind === "hundilipud" &&
    e.feature.properties.registered_at === feature.properties.registered_at &&
    e.feature.properties.group_code === feature.properties.group_code
  );
  hundilipudEditEntry = entry || { feature };

  openHundilipudWidget();
  const props = feature.properties;

  document.getElementById("hundilipudDateInput").value = props.date || todayIsoDate();
  document.getElementById("hundilipudRemarksInput").value = props.remarks || "";

  const regSel = document.getElementById("hundilipudRegistrantSelect");
  const otherInput = document.getElementById("hundilipudRegistrantOtherInput");
  if (Array.from(regSel.options).some(o => o.value === props.registrant)) {
    regSel.value = props.registrant;
    otherInput.classList.add("hidden");
  } else {
    regSel.value = "other";
    otherInput.value = props.registrant || "";
    otherInput.classList.remove("hidden");
  }

  hundilipudDrawState = { points: feature.geometry.coordinates.map(c => L.latLng(c[1], c[0])) };
  document.getElementById("hundilipudSaveBtn").disabled = false;
  document.getElementById("hundilipudDrawHint").classList.add("hidden");

  document.getElementById("hundilipudEditBanner").classList.remove("hidden");
  document.getElementById("hundilipudSaveBtn").textContent = "💾 Salvesta muudatused";
}

function exitHundilipudEditMode() {
  hundilipudEditEntry = null;
  document.getElementById("hundilipudEditBanner").classList.add("hidden");
  document.getElementById("hundilipudSaveBtn").textContent = "💾 Salvesta liin";
}

/* ---- Rendering ---- */
function hundilipudPopupHtml(props) {
  let html = `<strong>Hundilipud</strong><br>`;
  html += `Kuupäev: ${escapeHtml(props.date || "—")}<br>`;
  if (props.remarks) html += `Märkused: ${escapeHtml(props.remarks)}<br>`;
  if (props.registrant) html += `Registreerija: ${escapeHtml(props.registrant)}<br>`;
  if (isAdminUser()) html += `Grupp: ${escapeHtml(props.group_code || "—")}<br>`;
  return html;
}

function renderHundilipudFeature(feature) {
  const latlngs = feature.geometry.coordinates.map(c => L.latLng(c[1], c[0]));
  const color = dateThemedColor(CONFIG.hundilipud.color, feature.properties && feature.properties.date);
  const line = L.polyline(latlngs, {
    color,
    weight: 4,
    opacity: 0.9,
    dashArray: CONFIG.hundilipud.dashArray
  });
  const group = L.featureGroup([line]);
  group.bindPopup(() => buildFeaturePopupContent(hundilipudPopupHtml(feature.properties || {}), feature, "hundilipud"));
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
        map.setView([latitude, longitude], 15);
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
/* SCALE BAR — deliberately custom rather than Leaflet's built-in         */
/* L.control.scale, so its width always matches the quick-button stack    */
/* above it (Leaflet's own scale control picks its own "nice number"      */
/* width instead of a fixed one). Ported from SAK26.                       */
/* ---------------------------------------------------------------------- */
function setupScaleBar() {
  updateScaleBar();
  setTimeout(updateScaleBar, 300); // defensive: catch any late layout settling on first paint
  map.on("zoomend", updateScaleBar);
  map.on("moveend", updateScaleBar);
  window.addEventListener("resize", debounce(updateScaleBar, 200));
}

function updateScaleBar() {
  const lineEl = document.querySelector("#mapScaleBar .mapScaleBarLine");
  const labelEl = document.getElementById("mapScaleBarLabel");
  if (!lineEl || !labelEl || !map) return;

  const widthPx = lineEl.getBoundingClientRect().width;
  if (!widthPx) return;

  const centerY = map.getSize().y / 2;
  const p1 = map.containerPointToLatLng([0, centerY]);
  const p2 = map.containerPointToLatLng([widthPx, centerY]);
  const meters = map.distance(p1, p2);

  labelEl.textContent = formatScaleMeters(meters);
}

function formatScaleMeters(meters) {
  let rounded;
  if (meters < 20) rounded = Math.round(meters);
  else if (meters < 200) rounded = Math.round(meters / 5) * 5;
  else if (meters < 2000) rounded = Math.round(meters / 50) * 50;
  else rounded = Math.round(meters / 500) * 500;
  return `${rounded} m`;
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
