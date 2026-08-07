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
| `npm test` | Kaikki yksikkötestit: providerit, Wilma, hinnat, viestit, kalenteri, asettelu (ei verkkoa) |
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

Lokit: `data/logs/`, päivittäin kierrätettynä ja kokorajattuna.

Testit ajetaan **eristettynä tuotantotilasta**: `LOG_DIR` ohjaa ne kansioon
`data/logs-test/` ja `DB_PATH` tiedostoon `data/infonaytto-test.db`. Ilman tätä
tekaistut testiproviderit jättivät jälkensä molempiin — lokiin rivejä nimellä
`test-flaky-1234` ja tietokantaan kymmeniä `test-recover-*`-välimuistirivejä
neljän oikean joukkoon. Kumpikin syö juuri sen, minkä varassa vianetsintä on:
luettavan lokin ja tietokannan, jonka sisältö tarkoittaa mitä se sanoo.

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
- **`overview.get()` palautti paljon enemmän kuin kuluvan viikon** — 79 tuntia
  19 eri päivälle, lähes neljä viikkoa eteenpäin. Yksi kutsu kattaa siis
  päivänvaihdon reilusti.

  ⚠️ Tämä on **yksi mittaus lukuvuoden alussa**, ei todistettu sääntö. Koulu
  alkoi 12.8., ja on täysin mahdollista että Wilma julkaisi ensimmäiset viikot
  kerralla ja palaa "vain kuluva viikko" -käytökseen lukuvuoden ollessa
  käynnissä. Siitä riippuu, onko seuraavan viikon lisähaku käytännössä kuollutta
  koodia vai ei. **Aja savutesti uudelleen elokuun lopussa** ja katso pysyykö
  vastaus monen viikon mittaisena.

### Luettu-tilaa ei ole saatavilla — todennettu, ei arvattu

Aamulla postilaatikko oli tyhjä, joten viestien parsinta jäi todentamatta.
Iltapäivällä saapui oikea viesti, ja `wilma_status_observed`-lokirivi vastasi
kysymykseen itse — juuri sitä varten se lisättiin.

**Viestien parsinta toimii**: lähettäjä ja runko tulevat oikein viestin omista
tiedoista. **Luettu-tilaa ei kuitenkaan saada**: `status` palautui arvona `null`,
ja kirjaston lähdekoodi vahvistaa syyn — `parsers/messages.js` ei aseta kenttää
missään, ei listaukselle eikä yksittäiselle viestille.

Aiempi sääntö ("puuttuva arvo tarkoittaa lukematonta") olisi siis merkinnyt
**jokaisen viestin ikuisesti lukemattomaksi**: laskuri ei olisi nollautunut
koskaan, ja lukemattomien tuntitarkistus olisi hakenut jokaisen viestin uudelleen
loputtomiin — juuri sitä turhaa kuormaa, jonka välttämiseksi koko välimuistikerros
on olemassa.

Nyt tuntematon tila on oma arvonsa (`unread: null`): kortti ei väitä viestiä
luetuksi eikä lukemattomaksi, laskuri kertoo vain varmasti lukemattomat, eikä
turhia uudelleenhakuja tehdä. Jos kirjasto joskus alkaa täyttää kentän, se
ilmoittaa itsestään samalla lokirivillä.

### Kuukausikeskiarvot tulevat eri lähteestä kuin vuorokausihinnat

`porssisahko.net` palauttaa vain noin 48 tuntia, joten kuukausikeskiarvoihin
käytetään **Eleringin** (Viron kantaverkkoyhtiö) avointa rajapintaa, joka antaa
Nord Poolin FI-hinnat mielivaltaiselta aikaväliltä yhdellä kutsulla ilman
API-avainta.

Se palauttaa **EUR/MWh ilman arvonlisäveroa**, kun kortti näyttää **snt/kWh
sisältäen ALV:n**. Muunnos on `EUR/MWh × 0,1 × 1,255`, jossa 1,255 on Suomen
25,5 %:n ALV. Kerroin ei ole arvattu: se johdettiin vertaamalla 24:ää
samanaikaista tuntihintaa molemmista lähteistä, ja suhde asettui välille
1,2528–1,2571. Muunnetut lukemat täsmäävät `porssisahko.net`:iin kolmen
desimaalin tarkkuudella.

Historia haetaan **korkeintaan kerran vuorokaudessa**, ei 20 minuutin välein
muun hinnan mukana, ja päättynyttä kuukautta ei haeta uudelleen lainkaan.
Kuluva kuukausi on aina kesken, joten kortti kertoo mihin asti keskiarvo
ulottuu sen sijaan että esittäisi keskeneräisen luvun valmiina.

Nord Pool siirtyi Suomessa 15 minuutin hintaresoluutioon, joten uudemmat
kuukaudet tulevat 96 pisteenä vuorokaudessa ja vanhemmat 24:nä. Arvot
ryhmitellään paikallisiin tunteihin ennen keskiarvoa, jottei resoluutio vinouta
lukua — tämä on testattu.

Lähteen muodon voi todentaa oikealla kutsulla: `ELERING_LIVE=1 npm run
test:prices --workspace=server`. Oletuksena se ohitetaan, koska `npm test` ei
saa tarvita verkkoa.

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
| Kuukausikeskiarvot | Elering (Nord Pool FI) | kerran vrk |
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

## Näytön käyttö kosketuksella

Kaikki vuorovaikutus on suunniteltu sormella käytettäväksi parin metrin
katseluetäisyydeltä: kosketuskohteet ovat vähintään 44×44 pikseliä.

### Lukujärjestyksen selaus

Nuolipainikkeet tai vaakapyyhkäisy kortin päällä siirtävät päivää. Pyyhkäisy
vaatii selvän vaakasuuntaisen liikkeen (yli 50 px, enemmän vaaka- kuin
pystysuuntaan), jottei napautus tai pystyvieritys vaihda päivää vahingossa.

Selaus etenee **päivä kerrallaan, myös tunnittomien päivien yli** — toisin kuin
automaattivalinta, joka hyppää suoraan seuraavaan koulupäivään. Nappi joka ei
näytä tekevän mitään tuntuu rikkinäiseltä, joten perjantaista painamalla
päädytään lauantaihin, jossa lukee "Ei tunteja".

Taaksepäin ei pääse tätä päivää aikaisemmaksi (palvelin ei säilytä menneitä
tunteja) eikä eteenpäin tunnetun datan ohi. Selaus **palautuu automaattitilaan
itsestään viiden minuutin kuluttua**, jottei seinänäyttö jää jumiin satunnaiselle
päivälle sen jälkeen kun joku selasi sitä ohimennen. "Tänään"-painike palauttaa
heti.

### Wilma-viestit

Viestin napauttaminen avaa sen kokonaisuudessaan: lähettäjä, aihe, aika ja koko
teksti. Lista jakautuu välilehtiin **Lukematta** ja **Luetut**.

Luettu-tila on **infonäytön oma kirjanpito** (`message_reads`-taulu), ei Wilman:
viesti on luettu kun se on avattu tällä näytöllä. Wilma ei kerro omaa tilaansa
lainkaan (ks. yllä), joten tämä on ainoa tapa jaotella viestit ilman kirjaston
haarauttamista. Puhelimella luettu viesti näkyy taulussa siis lukemattomana.
Rajoitus on tietoinen ja käyttäjän hyväksymä; se mainitaan viestin
avausnäkymässä, ei kortissa, koska seinäkortilla tila on kallista.

Tila leimataan vastaukseen **pyynnön yhteydessä** eikä kirjoiteta providerin
välimuistiin: merkintä näkyy heti napautuksesta eikä jää odottamaan seuraavaa
Wilma-hakua, eikä paikallinen kirjanpito sekoitu Wilmasta tulleeseen dataan.
Kortti merkitsee viestin luetuksi optimistisesti ja peruu merkinnän jos tallennus
epäonnistuu.

### Sään tuntinäkymä

Minkä tahansa ennustepäivän napauttaminen avaa sen päivän 24 tuntia:
lämpötila, tuntuu kuin, sade ja sateen todennäköisyys, tuuli ja säätila.
Kuluvan päivän kohdalla nykyinen tunti korostetaan ja menneet himmennetään.
Näkymä sulkeutuu painikkeesta, Esc-näppäimestä ja taustaa napauttamalla.

### Kalenterin monipäiväiset tapahtumat

Useamman päivän yli jatkuva tapahtuma näkyy **jokaisena päivänä jota se koskee**,
ja pilleri kertoo monesko päivä on menossa ("3/8"). Aiemmin tapahtuma kiinnittyi
vain alkupäiväänsä ja katosi lopuilta päiviltä.

Koko päivän tapahtuman `DTEND` on iCalendarissa **eksklusiivinen**: 24.–26.7.
kestävä tapahtuma on merkitty päättymään 27.7. Tämä on varmistettu oikeasta
syötteestä, ja `node-ical` antaa loppuhetken valmiiksi paikallisena keskiyönä,
joten kesä- ja talviajan siirtymät hoituvat kirjaston puolella eikä päiviä
lasketa käsin. Yhden tapahtuman laajennus on rajattu 60 vuorokauteen, jottei
virheellinen syöte voi kasvattaa sitä hallitsemattomasti.

### Pörssisähkön kuvaaja

Kuvaajassa on aika-akseli kellonaikoineen ja hinta-akseli apuviivoineen.
Aika-akseli käyttää **samaa 24 sarakkeen rakennetta kuin pylväät**, joten
merkinnät osuvat oikeiden tuntien kohdalle eivätkä tasavälein arvattuina.
Kapealla kortilla ylimääräiset merkinnät piilotetaan `visibility`-arvolla eikä
`display`-arvolla, jolloin sarakeleveydet säilyvät eikä kohdistus lipsu.

Tänään ja huomenna käyttävät **samaa asteikkoa**, jotta päivät ovat suoraan
vertailukelpoisia — eri asteikko käyttäisi tilan paremmin, mutta samannäköinen
pylväs tarkoittaisi eri hintaa. Negatiiviset hinnat piirtyvät nollaviivalta
alaspäin, ja julkaisemattomat tunnit näkyvät viirutuksena — **eivät nollana**,
koska nolla on oikea hinta ja "ei tiedossa" ei ole.

### Paneelien asettelu

Asetuksista avautuu **muokkaustila**, jossa paneeleita voi raahata uuteen
paikkaan ja muuttaa niiden kokoa oikean alakulman kahvasta. Asettelu tallennetaan
palvelimelle, joten se säilyy kioskiselaimen uudelleenkäynnistyksen yli.

Muokkaus on tarkoituksella oma tilansa eikä aina päällä: seinänäytöllä
vahinkoraahaus pöytää pyyhkiessä olisi kohtuuton haitta. Muokkaustilassa
korttien oma vuorovaikutus on lukittu, joten paneelin siirtäminen ei voi
samalla vaihtaa lukujärjestyksen päivää tai merkitä muistiinpanoa tehdyksi.

Paneelin voi pudottaa toisen **päälle mistä kohtaa tahansa** — kohde tunnistetaan
sormen alla olevasta ruudusta, ei raahatun paneelin kulmasta, jottei kosketuksen
epätarkkuus hylkäisi siirtoa.

**Samankokoiset paneelit vaihtavat paikkaa keskenään. Eri kokoiset eivät.**
Tämä on tietoinen rajoitus, ei puute: oletusasettelu täyttää koko ruudukon, joten
eri kokoiselle paneelille ei yksinkertaisesti ole tilaa mihin mennä. Kiertotie on
yksi kosketus: kutista jompaakumpaa ensin, jolloin syntyy aidosti vapaata tilaa
ja normaali siirto hoitaa lopun. Vaihtoehto olisi ollut kokonainen
tiivistysalgoritmi, jonka turvallisuustodistus on paljon heikompi — nykyisessä
mallissa molemmat paneelit siirtyvät toistensa **jo ennestään kelvollisille**
paikoille, joten mikään ei voi mennä päällekkäin tai ruudukon ulkopuolelle.
Hylätty siirto kertoo aina syyn.

Ruudukko on 6 saraketta × 8 riviä. Paneelin **pienin koko on 2×2 solua** — sitä
pienempänä kortti leikkaisi sisältönsä piiloon otsikkoa ja
"vanhentunut"-merkkiä myöten, jolloin rikkinäistä lähdettä ei enää huomaisi.
Palvelin torjuu liian pienet asettelut myös rajapinnassa, ei pelkästään
käyttöliittymässä.

Puhelinnäkymä ei käytä gridiä lainkaan vaan pinoaa kortit yhteen sarakkeeseen
muistilista ensin, joten oma asettelu ei voi rikkoa muistilistan käyttöä
puhelimella.

## Käyttöönotto Surfacella

Katso [`asennus/KAYTTOONOTTO.md`](asennus/KAYTTOONOTTO.md) (Windows) — automaattikäynnistys,
kioskitila, virranhallinta, sekä **laiteriskit joita SP4:n käyttö seinänäyttönä
sisältää**.

Vaihtoehtona [`asennus/KAYTTOONOTTO-LINUX.md`](asennus/KAYTTOONOTTO-LINUX.md) —
sama laite Debian + linux-surface-ytimellä, koska SP4 ei ole Windows 11:n
virallisesti tuettujen laitteiden listalla.
