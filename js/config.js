/* ==========================================================================
   KAARDIRAKENDUSE SEADISTUS (CONFIG)
   ==========================================================================
   Kõik teenuste aadressid ja vaikeväärtused on koondatud siia.
   ========================================================================== */

const CONFIG = {

  initialView: {
    center: [58.65, 25.0],
    zoom: 7
  },

  // Overall map zoom bounds. minZoom stops people zooming out past a
  // point where none of this app's Estonia-specific layers are useful.
  mapMinZoom: 3,
  mapMaxZoom: 19,

  estoniaBounds: [
    [57.5, 21.7],
    [59.7, 28.2]
  ],

  /* ------------------------------------------------------------------
     TAUSTAKAARDID (BASE LAYERS)
     ------------------------------------------------------------------
     Standardne OGC WMS GetMap päring (L.tileLayer.wms) Maa-ameti
     WMS-C teenuse vastu — töötab otse EPSG:3857-ga.
  ------------------------------------------------------------------- */
  maaametWmsUrl: "https://tiles.maaamet.ee/tm/",

  baseLayers: [
    { id: "maaamet_kaart", name: "Põhikaart (Maa-amet)", type: "maaamet-wms",
      layer: "kaart", format: "image/png", attribution: "Maa- ja Ruumiamet, CC BY 4.0", default: true },
    { id: "maaamet_foto", name: "Ortofoto (Maa-amet)", type: "maaamet-wms",
      layer: "foto", format: "image/jpeg", attribution: "Maa- ja Ruumiamet, CC BY 4.0" }
  ],

  /* ------------------------------------------------------------------
     ULUKITE JÄLJED (wildlife track registrations)
     ------------------------------------------------------------------
     Same git-based persistence pattern as "Minu kaardid" below: a
     registration drawn on the map downloads as one small .geojson file,
     which gets dropped into data/registrations/ and pushed. A GitHub
     Action then merges every file in that folder into the single
     dataUrl file below, which is what the app actually loads on
     startup. One file per registration avoids merge conflicts when
     several people add tracks around the same time.
  ------------------------------------------------------------------- */
  tracks: {
    folder: "data/registrations/",
    dataUrl: "data/registrations_all.geojson",
    species: [
      { id: "hunt", label: "Hunt", color: "#8b0000" },
      { id: "ilves", label: "Ilves", color: "#d2691e" },
      { id: "koer", label: "Koer", color: "#607d8b" }
    ],
    directions: [
      { id: "none",  label: "Suund puudub" },
      { id: "start", label: "Nool alguses" },
      { id: "end",   label: "Nool lõpus" },
      { id: "both",  label: "Nool mõlemas otsas" }
    ]
  },

  /* ------------------------------------------------------------------
     PRIA WFS (põllumassiivid)
     ------------------------------------------------------------------
     Kihtide loend tuuakse dünaamiliselt WFS GetCapabilities päringust.
     "PÕLLUD" mustri järgi tuvastatud kihid (nt PRIA_PÕLLUD) rühmitatakse
     nimekirjas eraldi ja neile pakutakse kiirvalikuid.
  ------------------------------------------------------------------- */
  pria: {
    wfsUrl: "https://kls.pria.ee/geoserver/pria_avalik/ows",
    minZoom: 14,
    maxFeatures: 2000,
    colorPalette: [
      "#e6194B", "#3cb44b", "#ffe119", "#4363d8", "#f58231",
      "#911eb4", "#42d4f4", "#f032e6", "#bfef45", "#469990",
      "#9A6324", "#800000", "#808000", "#000075", "#a9a9a9"
    ]
  },

  /* ------------------------------------------------------------------
     MINU KAARDID (oma kihid) — vaikeväärtused
     ------------------------------------------------------------------
     Iga kihi kohta muudetavad, kuid need on vaikeväärtused uue kihi
     lisamisel: kiht ise ilmub alates suumitasemest 13 (nagu PRIA),
     sildid ilmuvad alles suumitasemest 15 (et vältida teksti
     ülekuhjumist väiksemas suumis).
  ------------------------------------------------------------------- */
  myLayers: {
    defaultMinZoom: 1,
    defaultMaxZoom: 19,
    defaultLabelMinZoom: 15,
    colorPalette: [
      "#8b00ff", "#ff8c00", "#009688", "#e91e63", "#3f51b5",
      "#795548", "#607d8b", "#cddc39", "#00bcd4", "#f44336"
    ],
    // Fixed colors for specific thematic values, matched case-insensitively.
    // Takes priority over the auto-cycling palette above whenever a
    // thematic field's value matches one of these — e.g. for
    // PriaKaerNisuMaisHernes1Field_DISS.zip's crop-type field.
    knownThematicColors: {
      "hernes": "#3aa655",   // green (pea)
      "kaer": "#f28b82",     // light red/coral (oats)
      "mais": "#8b6b1f",     // dark yellow/brownish (maize)
      "nisu": "#fff2a8"      // light yellow (wheat)
    }
  },

  /* ------------------------------------------------------------------
     VÄLIANDMED (Google Sheets / repo-fail CSV-XLSX)
     ------------------------------------------------------------------
     Google Sheets loetakse JSONP kaudu (script-tag trikk) — see töötab
     puhtal staatilisel hostimisel (GitHub Pages jm) ilma igasuguse
     serveri/backendita, kuna JSONP ei allu brauseri CORS piirangutele
     samamoodi nagu fetch()/XHR.

     "OneDrive/Excel" andmeallikas on asendatud "repo-failiga": ekspordi
     oma Exceli/OneDrive andmed CSV- või XLSX-failina ja lisa see faili
     repositooriumisse (git push) — rakendus loeb seda tavalise
     samast-domeenist faili päringuna (ei vaja proksit, ei vaja PHP-d).
  ------------------------------------------------------------------- */
  sheets: {
    defaultGid: "0"
  },

  /* ------------------------------------------------------------------
     MINU KAARDID: git-põhine failihaldus (GitHub Pages ei toeta PHP-d)
     ------------------------------------------------------------------
     Failide nimekiri tuleb staatilisest manifest.json failist, mida
     GitHub Action ("update-manifest.yml") automaatselt uuendab iga
     kord, kui keegi lisab/eemaldab faile MyFiles/uploads/ kaustast ja
     teeb git push.
  ------------------------------------------------------------------- */
  myFiles: {
    manifestUrl: "MyFiles/manifest.json",
    uploadsUrlBase: "MyFiles/uploads/"
  }
};
