# Jäljed

Ulukite jälgede ja hundilippude registreerimise ning kaardistamise
veebirakendus. Fork'itud [SAK26](https://github.com/rivopolt/SAK26)
kaardirakendusest — sama Leaflet.js + Maa-amet/PRIA taustaga.

## Mis siin on

- **Taustakaardid:** Maa-amet Põhikaart / Ortofoto (WMS)
- **PRIA põllumassiivid** (WFS, viewport-põhine)
- **Ulukite jäljed** — registreeri Hunt/Ilves/Koer jälgi kaardil punkti või
  joonena (koos suunanooltega), koos kuupäeva/karja suuruse/registreerija/
  märkustega
- **Hundilipud** — joonista hundilippude liin kaardile (punane katkendlik
  joon)
- **Grupid** — jäljed ja liinid on nähtavad ainult sinu enda grupile;
  administraatorigrupp (1312) näeb kõike
- **Minu kaardid** — oma KML/KMZ/SHP failide kuvamine

## Andmearhitektuur: üks jagatud fail serveris

`data/registrations_all.geojson` on **ainus andmefail** — nii jäljed kui
hundilipud (eristatakse `feature_type` väljaga). Kõik seadmed **loevad ja
kirjutavad sama faili**:

- **Lugemine** käib otse GitHub Pages'i staatilise faili pealt — tavaline
  `fetch()`, ei vaja midagi erilist.
- **Kirjutamine** (uue jälje/liini salvestamine) käib väikese **Cloudflare
  Workeri** kaudu (`worker/index.js`). GitHub Pages ise on staatiline ja ei
  saa iseennast muuta — see Worker on ainuke "päris server" osa kogu
  rakendusest ja selle ülesanne on üksainus: võtta vastu uus kirje ja
  lisada see GitHubi API kaudu otse repositooriumi faili sisse.

Tulemus: **ühtegi faili ei looda kellegi seadmesse**. "💾 Salvesta"
saadab kirje kohe serverisse ja laeb terve andmestiku uuesti — kõik sama
grupi liikmed näevad sama andmestikku niipea kui nad lehe värskendavad
või vajutavad "↻ Lae".

### Cloudflare Workeri seadistamine (üks kord)

1. Loo tasuta [Cloudflare](https://dash.cloudflare.com/sign-up) konto
   (ei vaja krediitkaarti Workeri tasuta taseme jaoks).
2. Loo GitHubis **fine-grained personal access token**
   (github.com → Settings → Developer settings → Fine-grained tokens):
   - Repository access: ainult `rivopolt/hunt`
   - Permissions: **Contents → Read and write**
3. Installi [wrangler](https://developers.cloudflare.com/workers/wrangler/)
   CLI (`npm install -g wrangler`) ja logi sisse: `wrangler login`
4. Kausta `worker/` sees:
   ```
   cd worker
   wrangler secret put GITHUB_TOKEN
   # kleebi token, mille lõid sammus 2
   wrangler deploy
   ```
5. Kontrolli `worker/wrangler.toml` väärtused (`GITHUB_REPO`,
   `GITHUB_BRANCH`, `FILE_PATH`, `ALLOWED_ORIGIN`) vastavad sinu
   repole — vaikeväärtused sobivad `rivopolt/hunt` jaoks juba.
6. `wrangler deploy` väljastab Workeri URL-i (nt
   `https://jaljed-api.SINU-NIMI.workers.dev`). Kopeeri see
   `js/config.js` faili `apiUrl` väljale ja tee git push.

Kuni `apiUrl` on tühi, näitab rakendus salvestamisel selget veateadet
selle asemel, et vaikimisi ebaõnnestuda.

**Samaaegsed kirjutused:** Worker loeb-muudab-kirjutab faili GitHubi API
kaudu ja proovib konfliktide korral (kaks inimest salvestavad täpselt
samal hetkel) automaatselt paar korda uuesti — see katab tavapärase
kasutuse. Pole vaja midagi käsitsi mergeda.

## Grupid

Käivitamisel küsitakse: **"Alusta gruppi"** (genereerib juhusliku
4-kohalise koodi, mida saad jagada oma grupi liikmetega) või
**"Liitu grupiga"** (sisesta olemasolev kood). Kood salvestatakse
brauseris ja iga uus jälg/liin märgistatakse selle koodiga
(`group_code` väli). Vaikimisi näed ainult oma grupi kirjeid.

Grupp **1312** on administraatorigrupp — sellega liitudes näed kõigi
gruppide kõiki kirjeid, ühtegi filtrit ei rakendata. Grupi saab hiljem
vahetada paneeli päises oleva "Grupp: XXXX" nupu kaudu.

## Filtreerimine

Nii "Ulukite jäljed" kui "Hundilipud" paneelides:
- Kiirnupud **Täna / Eile / Nädal / Kõik**
- Vabalt valitav kuupäevavahemik
- Ulukite jälgede puhul lisaks liigi järgi (Hunt/Ilves/Koer)

**Vaikimisi näidatakse ainult tänast päeva** — muuda kiirnupu või
kuupäevaväljadega, kui tahad varasemat.

Filtrid ei tee eraldi serveripäringuid — kogu andmestik laetakse korra
ja filtrid lihtsalt näitavad/peidavad juba laaditud kihte, nii et
filtreerimine on kiire ka suurema kirjete arvu juures.

## Andmemudel (üks GeoJSON Feature kirje kohta)

| Väli | Kirjeldus |
|---|---|
| `feature_type` | `"track"` või `"hundilipud"` |
| `geom_type` | `"point"` või `"line"` (ainult track) |
| `species` | `"hunt"` / `"ilves"` / `"koer"` (ainult track) |
| `direction` | `"none"`/`"start"`/`"end"`/`"both"` (ainult track+line) |
| `date` | kuupäev (ISO, `YYYY-MM-DD`) |
| `pack_size` | number või null (ainult track) |
| `remarks` | vaba tekst |
| `registrant` | RP/OP/JL/AV või vabalt sisestatud |
| `group_code` | 4-kohaline grupikood |
| `registered_at` | salvestamise ISO-timestamp |

Kuna see on tavaline GeoJSON FeatureCollection, sobib see ka lihtsaks
analüüsiks väljaspool rakendust (nt Pythoni/QGIS-iga) — pole vaja
midagi eraldi eksportida.

## Käivitamine

Staatiline sait — piisab GitHub Pages'ist. Kirjutamiseks (uute
jälgede/liinide salvestamiseks) on vaja ka Cloudflare Workerit, vt eespool.
