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
| `npm test` | Provider-kerros, Wilma-hakulogiikka ja lukujärjestyksen päivänvalinta (ei verkkoa) |
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

Lokitetaan vain **tilan muutokset**, ei jokaista hakukierrosta: `OK → FAILED` ja
`FAILED → OK`. Rikki oleva lähde tuottaa yhden rivin, ei riviä joka 20 minuutti.
Yhtäjaksoinen vikatila kuittaantuu korkeintaan kerran vuorokaudessa.

Lokitaso `LOG_LEVEL`-ympäristömuuttujasta. `warn` (oletus) = virheet ja
palautumiset. `debug` = kaikki haut, konsolituloste ja rikkoutuneesta
vastauksesta tallennetaan raaka HTML `data/snapshots`-kansioon vianetsintää
varten.

Lokit: `data/logs/`, päivittäin kierrätettynä ja kokorajattuna. Testit kirjoittavat
omaan kansioonsa `data/logs-test/` (`LOG_DIR`-muuttuja), jottei tuotantoloki
täyty tekaistujen testiproviderien riveistä — loki on luettava silloin kun sitä
oikeasti tarvitaan.

### Tilin lukituksen esto

Wilman kirjautumisvirheet ovat *fataaleja*: kolmen peräkkäisen jälkeen
katkaisija menee kiinni eikä yrityksiä enää tehdä. Väärällä salasanalla
silmukassa hakkaaminen olisi nopein tapa lukita koko perheen Wilma-tili.
Tämä on testattu (`npm test`).

Muut virheet — 500, 429, satunnainen 404 — **eivät** pudota istuntoa. Ne
jäävät providerin backoffin hoidettavaksi samalla istunnolla, jottei
tilapäinen häiriö muuttuisi uusien kirjautumisten sarjaksi juuri silloin kun
Wilma on jo vaikeuksissa.

### Wilman kysely on niukkaa

- Kuluva viikko haetaan yhdellä kutsulla per lapsi. Seuraavaa viikkoa kysytään
  vain jos kuluvassa ei ole mitään tämän päivän jälkeen, ja silloinkin
  korkeintaan kuuden tunnin välein — muuten viikonloput ja kesäloma tarkoittaisivat
  turhaa kutsua joka 20. minuutti viikkokausia.
- Viestin lähettäjä ja luettu-tila eivät ole listauksessa lainkaan, vaan vain
  viestin omissa tiedoissa. Ne haetaan kerran per viesti ja kannetaan eteenpäin;
  vielä lukemattomat tarkistetaan uudelleen korkeintaan tunnin välein ja
  korkeintaan kolme per kierros.

### Mitä oikeasta Wilmasta on todennettu (7.8.2026)

`npm run test:smoke` ajettiin oikeilla tunnuksilla. Kaksi asiaa, joita Wilma ei
dokumentoi, ovat nyt mitattuja eivätkä arvattuja:

- **`schedule.list({date})` palauttaa viikon, ei yhtä päivää.** Providerin
  oletus pitää.
- **`overview.get()` palauttaa paljon enemmän kuin kuluvan viikon** — mittaus
  antoi 79 tuntia 19 eri päivälle, lähes neljä viikkoa eteenpäin. Yksi kutsu
  kattaa siis päivänvaihdon reilusti, ja seuraavan viikon lisähaku jää
  käytännössä lepäämään keskellä lukuvuotta.

Yksi asia jäi **todentamatta**: postilaatikko ja arkisto olivat molemmat tyhjiä,
joten viestien parsintaa eikä `Message.status`-kentän merkitystä (luettu vs.
lukematon) ei ole nähty kertaakaan oikealla datalla. Savutesti sanoo tämän
suoraan sen sijaan että raportoisi läpimenon. Ensimmäinen oikea Wilma-viesti on
se hetki, jolloin tulkinta kannattaa tarkistaa.

## Tietoturva

- Tunnukset vain `.env`-tiedostossa, joka on `.gitignore`ssa. `.env.example` on
  malli ja **menee gittiin** — siihen ei kirjoiteta oikeita arvoja. Nimet ovat
  hämäävän lähellä toisiaan, joten tämä on helppo sekoittaa.
- Wilma-datan lukureitit vastaavat vain **localhostista** — kotiverkon puhelin
  näkee sään ja muistilistan, ei lasten koulutietoja. Puhelimessa kortilla lukee
  "Vain infonäytöllä" eikä se jää pyörimään ikuiseen "Haetaan…"-tilaan.
  Todennettu oikealla datalla: lähiverkon vastauksesta ei löydy lapsen nimeä,
  oppilasnumeroa, oppiainetta eikä opettajan nimeä.
- Muistilistan ja asetusten muokkaus muualta kuin näyttölaitteelta vaatii
  `EDIT_PIN`-koodin.
- Salasanoja, evästeitä eikä viestien sisältöjä ei kirjoiteta lokiin.

## Moduulit

| Kortti | Lähde | Päivitysväli |
|---|---|---|
| Lukujärjestys | Wilma (`@wilm-ai/wilma-client`, naulattu 1.4.2) | 20 min, ei öisin |
| Wilma-viestit | sama | sama |
| Sää | Open-Meteo | 20 min |
| Pörssisähkö | porssisahko.net | 20 min |
| Kalenteri | Google Calendarin ICS-syöte | 15 min |
| Muistilista | oma SQLite | — |

Lukujärjestys näyttää kuluvan päivän ja vaihtaa itsestään seuraavaan
koulupäivään asetettuna kellonaikana (oletus 12:00). Viikonloput ja tunnittomat
päivät ohitetaan. Näytettävät lapset ja asettelu (rinnakkain / allekkain)
valitaan asetuksista, jotka tallennetaan palvelimelle.

Otsikko kertoo aina eksplisiittisesti päivän ("Huomenna 12.8.", "Maanantaina
17.8."), ja vihje *"vaihtui klo 12:00"* näytetään vain silloin kun kello
**oikeasti** vaihtoi näkymän. Loman aikana seuraavat tunnit ovat yhtä kaukana
kellonajasta riippumatta, joten vihjettä ei silloin näytetä. Säännöt on lukittu
testeillä (`web/test/schedule-day.ts`) — tämä otsikko on ehtinyt valehdella
kahdesti.

## Käyttöönotto Surfacella

Katso [`asennus/KAYTTOONOTTO.md`](asennus/KAYTTOONOTTO.md) — automaattikäynnistys,
kioskitila, virranhallinta, sekä **laiteriskit joita SP4:n käyttö seinänäyttönä
sisältää**.
