# Infonäyttö

Kodin info-taulu: lasten Wilma-viestit ja lukujärjestys, varhaiskasvatuksen
hoitoajat, sää, pörssisähkön hinta tänään ja huomenna, perhekalenteri ja
yhteinen muistilista yhdellä ruudulla. Päätelaite on Microsoft Surface Pro 4,
joka ajaa sekä palvelimen että selaimen kioskitilassa.

## Moduulit

| Kortti | Lähde | Päivitysväli |
|---|---|---|
| Lukujärjestys | Wilma (`@wilm-ai/wilma-client`, naulattu 1.4.2) | 20 min, ei öisin |
| Wilma-viestit | sama | sama |
| Hoitoajat | Päikky (oma asiakas) | 30 min, ei öisin |
| Päikky-viestit | sama | sama |
| Sää | Open-Meteo (sijainti postinumerosta, niputettu aineisto) | 20 min |
| Pörssisähkö | porssisahko.net | 20 min |
| Kuukausikeskiarvot | Elering (Nord Pool FI) | kerran vrk |
| Kalenteri | Google Calendarin ICS-syöte | 15 min |
| Muistilista | oma SQLite | — |
| Kouluhälytykset | lukujärjestys + omat asetukset | kellosykli, 20 s |

## Käyttöönotto

**Näyttölaitteelle** käytetään julkaisupakettia, jossa Node-ajonaika on mukana —
kohdekoneelle ei asenneta Nodea eikä npm:ää. Asennus, kioskitila, ylläpito ja
laiteriskit on kuvattu alustakohtaisissa ohjeissa:

- [`asennus/KAYTTOONOTTO.md`](asennus/KAYTTOONOTTO.md) — Windows
- [`asennus/KAYTTOONOTTO-LINUX.md`](asennus/KAYTTOONOTTO-LINUX.md) — Debian +
  linux-surface-ydin, koska SP4 ei ole Windows 11:n virallisesti tuettujen
  laitteiden listalla

**Kehityskoneella:**

```bash
npm install
cp .env.example .env   # lue tiedoston omat kommentit — erityisesti lainausmerkit salasanoissa
npm run build          # kääntää Vue-käyttöliittymän
npm start              # http://localhost:4173
```

Frontend erikseen kehityksessä: `npm run dev` (palvelin) ja `npm run dev:web`
(Vite, proxyttaa `/api` palvelimelle).

### Julkaisupaketti

```bash
npm run release                        # molemmat alustat
npm run release -- --platform win-x64  # vain toinen
```

Tuottaa `julkaisu/`-kansioon `infonaytto-<versio>-win-x64.zip` (~53 MB) ja
`infonaytto-<versio>-linux-x64.tar.gz` (~58 MB) sekä `SHA256SUMS.txt`:n, jolla
laitteelle siirretyn arkiston eheyden voi todeta (`sha256sum -c` tai
`Get-FileHash`). Paketin sisällä `VERSIO.txt` kertoo mistä commitista se on
koottu ja mikä Node siihen on niputettu.

Koonti **keskeytyy** eikä tuota pakettia jos tyyppitarkistus tai testit
kaatuvat, jos ladatun Node-jakelun SHA256 ei täsmää `SHASUMS256.txt`:hen, jos
tuotantoriippuvuuksista löytyy natiivimoduuleja (silloin paketti ei olisi
alustariippumaton), tai jos valmiista arkistosta puuttuu pakettirakenteeseen
kuuluva tiedosto tai löytyy sinne kuulumaton. Rikkinäistä ei paketoida seinälle.

## Komennot

| Komento | Selite |
|---|---|
| `npm start` | Käynnistää palvelimen ja tarjoilee käännetyn käyttöliittymän |
| `npm run dev` | Palvelin uudelleenkäynnistyvänä |
| `npm run dev:web` | Vite-kehityspalvelin frontendille |
| `npm run build` | Kääntää frontendin `web/dist`-kansioon |
| `npm run typecheck` | Tyyppitarkistus molemmille työtiloille |
| `npm test` | Kaikki yksikkötestit: providerit, Wilma, hinnat, viestit, kalenteri, asettelu (ei verkkoa) |
| `npm run test:asennus` | Windows-asentimen päivitys- ja säilytystestit eristetyissä testihakemistoissa; mukana myös `npm test` -ajossa Windowsissa |
| `npm run release` | Kokoaa asennuspaketit (Windows + Linux) omine Node-ajonaikoineen `julkaisu/`-kansioon |
| `npm run test:smoke` | Savutesti **oikeaa Wilmaa vasten** — aja kirjastopäivityksen jälkeen |

## Arkkitehtuuri

Jokainen tietolähde on **provider**, joka hoitaa itse haun, välimuistin ja
virhetilan. Yhden lähteen kaatuminen ei kaada näyttöä: kortti näyttää
viimeisimmän onnistuneen datan vanhentuneena aikaleiman kanssa.

```
server/src/core/       provider-runtime, ajastus, SQLite-tallennus, asetukset, lokitus
server/src/providers/  yksi tiedosto per tietolähde
server/src/routes/     REST-rajapinta ja pääsynhallinta
web/src/components/    yksi kortti per moduuli
```

Selain **ei koskaan** laukaise ulkoista hakua — se lukee vain palvelimen
välimuistia. Tämä on se, mikä pitää Wilman kuormituksen kurissa.

### Lokitus

Lokitetaan vain **tilan muutokset** (`OK → FAILED`, `FAILED → OK`), ei jokaista
hakukierrosta: rikki oleva lähde tuottaa yhden rivin, ei riviä joka 20. minuutti.
Yhtäjaksoinen vikatila kuittaantuu korkeintaan kerran vuorokaudessa — sama katto
koskee katkaisijan jäähdytyksen aikana epäonnistuvia koeyrityksiä
(ks. [`docs/wilma.md`](docs/wilma.md)).

`LOG_LEVEL`: `warn` (oletus) = virheet ja palautumiset. `debug` = kaikki haut,
konsolituloste ja rikkoutuneen vastauksen raaka HTML `data/snapshots`-kansioon.
Lokit ovat kansiossa `data/logs/`, päivittäin kierrätettynä ja kokorajattuna.

Testit ajetaan **eristettynä tuotantotilasta**: `LOG_DIR` ohjaa ne kansioon
`data/logs-test/` ja `DB_PATH` tiedostoon `data/infonaytto-test.db`. Ilman tätä
tekaistut testiproviderit jättivät jälkensä molempiin — lokiin rivejä nimellä
`test-flaky-1234` ja tietokantaan kymmeniä `test-recover-*`-välimuistirivejä
neljän oikean joukkoon. Kumpikin syö juuri sen, minkä varassa vianetsintä on:
luettavan lokin ja tietokannan, jonka sisältö tarkoittaa mitä se sanoo.

## Tarkemmat kuvaukset

Ratkaisut ja niiden perustelut ovat `docs/`-kansiossa, yksi aihe per tiedosto.
Siellä on myös se, mikä on **mitattu oikeaa lähdettä vasten** ja milloin.

| Tiedosto | Mitä siellä on |
|---|---|
| [`docs/tietoturva.md`](docs/tietoturva.md) | Miksi lasten tiedot näkyvät vain näyttölaitteella, PIN-tasot, `TRUSTED_HOSTS`, kioskista poistuminen |
| [`docs/wilma.md`](docs/wilma.md) | Tilin lukituksen esto ja katkaisija, istunnon uusiminen, mitä oikeasta Wilmasta on todennettu, miksi luettu-tilaa ei saada, kirjaston ylläpito |
| [`docs/paikky-toteutus.md`](docs/paikky-toteutus.md) | Päikky-providerin ratkaisut: aikavyöhykemuunnos, varaamaton päivä, tiukempi lukituksen esto, näytettävät lapset |
| [`docs/paikky-rajapinta.md`](docs/paikky-rajapinta.md) | Päikyn dokumentoimaton rajapinta: päätepisteet ja vastausrakenteet, mitattuna oikeilla kutsuilla 31.8.2026 |
| [`docs/saa-ja-sahko.md`](docs/saa-ja-sahko.md) | Sään sijainti postinumerosta ja aineiston lisenssit, pörssisähkön kuukausikeskiarvojen lähde ja ALV-muunnos |
| [`docs/kayttoliittyma.md`](docs/kayttoliittyma.md) | Kosketuseleet, korttien käytös, kouluhälytykset ja paneelien asettelu perusteluineen |
