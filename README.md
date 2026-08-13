# Jäljed

Ulukite jälgede registreerimise ja kaardistamise veebirakendus. Fork'itud
[SAK26](https://github.com/rivopolt/SAK26) kaardirakendusest — sama
Leaflet.js + Maa-amet/PRIA taustaga, ilma serveripoolse koodita
(töötab GitHub Pages peal).

## Mis siin on

- **Taustakaardid:** Maa-amet Põhikaart / Ortofoto (WMS)
- **PRIA põllumassiivid** (WFS, viewport-põhine)
- **Ulukite jäljed** — registreeri Hunt/Ilves/Koer jälgi kaardil punkti või
  joonena (koos suunanooltega), koos kuupäeva/karja suuruse/märkustega;
  filtreeritav liigi ja kuupäevavahemiku järgi
- **Hundilipud** — joonista hundilippude liin kaardile (punane katkendlik
  joon), sama git-põhine salvestusmuster, oma andmefail
  `data/hundilipud_all.geojson`
- **Minu kaardid** — oma KML/KMZ/SHP failide kuvamine
- **Väliandmed** — Google Sheets / repo CSV-XLSX liitmine kaardikihtidega

## Ulukite jälgede andmemudel

Andmed talletatakse git-põhiselt, sama mustri järgi mis "Minu kaardid":

1. Vajuta kaardil "🐾 Registreeri jälg", täida vorm, joonista geomeetria.
2. "💾 Salvesta jälg" näitab jälge kohe sinu enda seansis ja laadib alla
   ühe väikese `.geojson` faili (üks Feature).
3. Lisa see fail repositooriumis kausta `data/registrations/` ja tee
   `git push`.
4. GitHub Action (`.github/workflows/update-registrations.yml`) liidab
   kõik selle kausta failid automaatselt üheks failiks
   `data/registrations_all.geojson` — see on fail, mida rakendus
   tegelikult laeb ja kõigile näitab.

Iga registreering on eraldi fail, nii et mitme inimese samaaegsed
sisestused ei lähe git-is omavahel konflikti. `data/registrations_all.geojson`
sobib ka lihtsaks analüüsiks väljaspool rakendust (nt Pythoni/QGIS-iga),
kuna see on tavaline GeoJSON FeatureCollection.

Väli iga jälje kohta: `geom_type` (point/line), `species` (hunt/ilves/koer),
`direction` (none/start/end/both, ainult joonte puhul), `date`,
`pack_size`, `remarks`, `registered_at`.

## Käivitamine

Staatiline sait — piisab GitHub Pages'ist. Ava `index.html` GitHub Pages'i
kaudu või kohalikult mis tahes static-file serveriga.

## Edasised sammud (avatud)

Praegu on filtreerimine ja "lihtne analüüs" brauseripoolne (species +
kuupäevavahemik). Kui andmemaht/vajadus kasvab, on loogilised järgmised
sammud kas:
- eraldi lihtne analüüsileht (nt jälgede arv liigi/kuu kaupa, kaardil
  klastrid), lugedes otse `data/registrations_all.geojson` faili; või
- üleminek päris andmebaasile (nt Supabase/PostGIS), kui vaja on
  reaalajas mitme kasutaja samaaegset sisestust või ruumilisi päringuid
  (puhver, ristumine jahipiirkondadega vms).
