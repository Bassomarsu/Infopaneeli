# Infonäyttö

Kodin info-taulu: lasten Wilma-viestit ja lukujärjestys, sää, pörssisähkön hinta
tänään ja huomenna, perhekalenteri ja yhteinen muistilista yhdellä ruudulla.

Päätelaite on Microsoft Surface Pro 4, joka ajaa sekä palvelimen että selaimen
kioskitilassa.

## Käyttöönotto

```bash
npm install
cp .env.example .env      # täytä Wilma-tunnukset ja kalenterin ICS-osoite
npm run build             # kääntää Vue-käyttöliittymän
npm start                 # käynnistää palvelimen, oletuksena http://localhost:4173
```

Kehityksessä frontend erikseen: `npm run dev` (palvelin) ja `npm run dev:web`
(Vite, proxyttaa `/api` palvelimelle).

## Komennot

| Komento | Selite |
|---|---|
| `npm start` | Käynnistää palvelimen ja tarjoilee käännetyn käyttöliittymän |
| `npm run dev` | Palvelin uudelleenkäynnistyvänä |
| `npm run dev:web` | Vite-kehityspalvelin frontendille |
| `npm run build` | Kääntää frontendin `web/dist`-kansioon |
| `npm run typecheck` | Tyyppitarkistus molemmille työtiloille |
| `npm test` | Provider-kerroksen sopimustestit |

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

Lokitetaan vain **tilan muutokset**, ei jokaista hakukierrosta: `OK → FAILED` ja
`FAILED → OK`. Rikki oleva lähde tuottaa yhden rivin, ei riviä joka 20 minuutti.
Yhtäjaksoinen vikatila kuittaantuu korkeintaan kerran vuorokaudessa.

Lokitaso `LOG_LEVEL`-ympäristömuuttujasta. `warn` (oletus) = virheet ja
palautumiset. `debug` = kaikki haut, konsolituloste ja rikkoutuneesta
vastauksesta tallennetaan raaka HTML `data/snapshots`-kansioon vianetsintää
varten.

Lokit: `data/logs/`, päivittäin kierrätettynä ja kokorajattuna.

### Tilin lukituksen esto

Wilman kirjautumisvirheet ovat *fataaleja*: kolmen peräkkäisen jälkeen
katkaisija menee kiinni eikä yrityksiä enää tehdä. Väärällä salasanalla
silmukassa hakkaaminen olisi nopein tapa lukita koko perheen Wilma-tili.
Tämä on testattu (`npm test`).

## Tietoturva

- Tunnukset vain `.env`-tiedostossa, joka on `.gitignore`ssa.
- Wilma-datan lukureitit vastaavat vain **localhostista** — kotiverkon puhelin
  näkee sään ja muistilistan, ei lasten koulutietoja.
- Muistilistan ja asetusten muokkaus muualta kuin näyttölaitteelta vaatii
  `EDIT_PIN`-koodin.
- Salasanoja, evästeitä eikä viestien sisältöjä ei kirjoiteta lokiin.

## Tila

| Vaihe | Sisältö | Tila |
|---|---|---|
| 1 | Runko, lokitus, pörssisähkö | valmis |
| 2 | Sää | kesken |
| 3 | Wilma: viestit ja lukujärjestys | kesken |
| 4 | Lukujärjestyksen asetukset ja päivänvaihto | kesken |
| 5 | Kalenteri ja muistilista | kesken |
| 6 | Kioskikäyttöönotto Surfacella | kesken |
