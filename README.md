# Infonäyttö

Kodin info-taulu: lasten Wilma-viestit ja lukujärjestys, sää, pörssisähkön hinta
tänään ja huomenna, perhekalenteri ja yhteinen muistilista yhdellä ruudulla.

Päätelaite on Microsoft Surface Pro 4, joka ajaa sekä palvelimen että selaimen
kioskitilassa.

## Käyttöönotto

Näyttölaitteelle: käytä **julkaisupakettia** (ks. alla). Se sisältää oman
Node-ajonaikansa, joten kohdekoneelle ei asenneta Nodea eikä npm:ää.

Kehityskoneella:

```bash
npm install
cp .env.example .env      # täytä Wilma-tunnukset ja kalenterin ICS-osoite
npm run build             # kääntää Vue-käyttöliittymän
npm start                 # käynnistää palvelimen, oletuksena http://localhost:4173
```

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

Asennus kohdekoneella: pura arkisto ja aja `asennus/asenna.ps1` (Windows) tai
`asennus/asenna.sh` (Linux). Asennin kysyy kaikki `.env`-asetukset, kirjoittaa
tiedoston rajatuin oikeuksin, tarjoaa automaattikäynnistyksen ja Windowsissa
työpöytäpikakuvakkeen joka avaa näytön suoraan kioskitilaan. Lopuksi se
käynnistää palvelimen ja odottaa `/api/health`-vastausta — jos se ei tule,
asennin sanoo sen suoraan eikä väitä onnistuneensa. Päivitysasennus säilyttää
`data/`-kansion (tietokanta, muistilista, hälytysäänet, lokit).

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

Lokitetaan vain **tilan muutokset**, ei jokaista hakukierrosta: `OK → FAILED` ja
`FAILED → OK`. Rikki oleva lähde tuottaa yhden rivin, ei riviä joka 20 minuutti.
Yhtäjaksoinen vikatila kuittaantuu korkeintaan kerran vuorokaudessa — sama katto
koskee myös katkaisijan jäähdytyksen aikana epäonnistuvia koeyrityksiä
(ks. "Tilin lukituksen esto").

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
katkaisija menee kiinni eikä uusia yrityksiä tehdä välittömästi. Väärällä
salasanalla silmukassa hakkaaminen olisi nopein tapa lukita koko perheen
Wilma-tili. Tämä on testattu (`npm test`).

Katkaisija ei kuitenkaan jää kiinni pysyvästi käyttäjän uudelleen-
käynnistykseen asti — seinänäyttöä ei valvo kukaan, joten lukossa pysyminen
tarkoittaisi kuollutta korttia päiväkausiksi. Sen sijaan se **jäähtyy**: 30
minuutin kuluttua tehdään yksi koeyritys. Jos sekin epäonnistuu, jäähdytys
kaksinkertaistuu (60 min, 120 min, ...) aina 4 tunnin kattoon asti; onnistunut
koeyritys nollaa katkaisijan täysin — laskurit, jäähdytyksen ja tilan.

Myös kirjautumisen verkkovirhe tai uudelleenohjaussilmukka lasketaan
kirjautumisvirheeksi. Näin tyhjä istuntovälimuisti ei aiheuta uutta
kirjautumiskierrosta jokaisella tavallisella hakuvuorolla koko katkon ajan.
Rajoitus koskee hakukierroksia: yksi kierros voi sisältää oppilaslistan
kirjautumisen ja erillisen kirjautumisen kullekin lapselle. Kirjasto voi myös
uusia kirjautumisen sisäisesti, joten kierrosten määrä ei ole HTTP-pyyntöjen määrä.

Jäähdytys ja Wilman hiljaiset tunnit (23–05, ks. alla) eivät kertaannu:
koeyritys joka osuisi hiljaisiin tunteihin vain odottaa seuraavaa aktiivista
kierrosta, kuten mikä tahansa muukin haku — jäähdytyksen laskuri ei ala
uudelleen sen takia.

### Testaa yhteys — manuaalinen ohitus

Neljän tunnin jäähdytys on pitkä aika katsoa kuollutta korttia silloin kun syy
on jo korjattu (salasana vaihdettu takaisin, verkko palannut). Asetusten
**Wilma-yhteys → Testaa yhteys** ohittaa jäähdytyksen, pudottaa vanhan
istunnon ja yrittää heti uudella kirjautumisella.

> **Salasanan korjaaminen `.env`-tiedostoon vaatii palvelimen uudelleen-
> käynnistyksen.** Tiedosto luetaan vain prosessin käynnistyessä
> (`--env-file`, ks. `server/package.json`), joten ajossa oleva palvelin
> käyttää yhä käynnistyshetken arvoa. "Testaa yhteys" yrittäisi silloin
> uudestaan samalla vanhalla salasanalla ja kuluttaisi yhden yrityksen
> turhaan. Järjestys on siis: korjaa `.env` → käynnistä palvelin uudelleen →
> vasta tarvittaessa Testaa yhteys.
Onnistuminen nollaa katkaisijan täysin; epäonnistuminen säilyttää
automaattisen katkaisijan laskurit ja jäähdytyksen. Jos automaattinen
hakuvuoro osuu manuaalitestin ajalle, haku siirtyy seuraavaan vuoroon.

Painike vaatii muokkausoikeuden (`EDIT_PIN`) — ei `FULL_PIN`iä, koska se ei
paljasta Wilma-dataa, vain sen onnistuiko haku. **Rajoitin on palvelimella**,
ei käyttöliittymässä: selainpuolinen esto katoaisi sivun päivityksellä, jolloin
rajoitusta ei käytännössä olisi. Rajoitin koskee Wilma-tiliä kokonaisuutena,
ei yhtä laitetta tai IP-osoitetta kerrallaan.

Rajat ovat **5 min per yritys** ja **12 yritystä vuorokaudessa**. Pelkkä
viiden minuutin väli sallisi 288 yritystä vuorokaudessa, ja kosketusnäyttö on
fyysisesti koko perheen ulottuvilla — vuorokausikatto on se, mikä estää
napista tulemasta hakkausvektoria. 12 riittää silti tunnin yhtäjaksoiseen
vianetsintään. Nämäkin rajat koskevat hakukierroksia, eivät yksittäisiä
kirjautumispyyntöjä.

Yksittäinen haun HTTP-virhe ei pudota istuntoa. Kahden peräkkäisen
epäonnistumisen jälkeen istunto uusitaan kerran saman häiriöjakson aikana.
Pitkittyvä häiriö ei siis aiheuta kirjautumista jokaisella kierroksella.
Onnistunut haku nollaa tämän laskurin.

Yli 90 minuutin tauko hakuyrityksissä pudottaa istunnon ennen seuraavaa
hakua. Tämä kattaa yön hiljaiset tunnit myös silloin, kun illalla luotu
istunto ei ehtinyt palauttaa tietoja ennen yötä. Aikakatkaisun jälkeen
valmistuva vanha kirjautuminen ei saa korvata uuden kierroksen istuntoa.
Istunnon uusimisen syy kirjataan lokiin, ja virheen sisempi syy, esimerkiksi
`redirect count exceeded`, näytetään kortissa pelkän `fetch failed` -tekstin lisäksi.

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

Sama kirjanpito kattaa nyt myös Päikyn. `message_reads`-taulun avain on
`(source, message_id)`, ja **tunniste on tekstiä**: Wilman tunniste on numero,
Päikyn merkkijono. Kirjoituspolku pakottaa muunnoksen (`asTextId`), koska
`node:sqlite` sitoo JS-numeron TEXT-sarakkeeseen muodossa `"86922.0"` — yksikin
numerona läpi mennyt tunniste kirjoittaisi rivin, jota mikään haku ei löydä, ja
kaikki viestit näyttäisivät ikuisesti lukemattomilta ilman virhettä missään.
Tämä on testattu erikseen (`server/test/message-reads.ts`).

**Migraatio ottaa varmuuskopion.** Ensimmäisellä käynnistyksellä vanha
yhden lähteen taulu muunnetaan uuteen muotoon, ja sitä ennen kanta kopioidaan
tiedostoon `data/infonaytto-ennen-viestilahteita.db`. Kopio on olemassa yhtä
tarkoitusta varten: **vanhaan julkaisuun palataan palauttamalla se**. Vanha
koodi ei osaa lukea uutta taulua, ja koska `data/` säilyy julkaisupaketin
päivityksessä, ilman kopiota rollback tarkoittaisi palvelinta joka ei käynnisty
lainkaan. Migraatio on idempotentti eikä kopioi mitään, jos muunnosta ei
tarvita.

"Merkitse kaikki luetuiksi" merkitsee valitun lähteen **kaikki** lukemattomat,
ei vain listalla näkyviä — siksi painike kertoo lukumäärän. Teko on
peruuttamaton: kumoamisreittiä ei ole.

### Päikky — varhaiskasvatuksen hoitoajat

Päikyssä ei ole virallista rajapintaa, mutta huoltajasovellus on React-SPA
JSON-REST-taustan päällä, ja se on käytettävissä huoltajan omilla tunnuksilla.
Toisin kuin Wilmassa, tässä ei ole valmista kirjastoa — asiakas on kirjoitettu
itse, mutta se on silti *vähemmän* työtä kuin Wilma, koska mitään ei tarvitse
jäsentää HTML:stä.

Täysi kuvaus päätepisteistä, todennettuine vastausrakenteineen, on
tiedostossa **`docs/paikky-rajapinta.md`**. Se on mitattu oikeilla kutsuilla,
ei arvattu. Tärkeimmät varaukset:

- **Ajat tulevat UTC:nä** (`05:00:00Z` = 08:00 Suomen kesäaikaa) ja muunnetaan
  palvelimella. Muunnos on `core/time.ts`:n `isoToLocalClock`, ei providerin
  sisällä — käyttöjärjestelmän vyöhykettä lukevat oikotiet (`getHours()`,
  `toLocaleTimeString()` ilman `timeZone`-optiota) näyttäisivät oikealta
  kehityskoneella ja olisivat kolme tuntia väärässä Linux-asennuksella,
  jonka oletusvyöhyke on UTC.
- **Kuukausikutsu palauttaa kalenteriruudukon kokonaisina viikkoina**, ei
  kuukautta. Seuraava kuukausi haetaan vain jos tarvittava päivä puuttuu
  vastauksesta — ei sen perusteella että ollaan kuun lopussa. Helmikuu 2027
  on ainoa kuukausi viiteen vuoteen, jonka ruudukko ei ylivuoda lainkaan.
- **`plannable` ilman merkintöjä ≠ vapaapäivä.** Se tarkoittaa varaamatonta
  päivää, ja se on ainoa Päikyn tieto joka on toimintakehotus: varaus
  lukittuu `lockingTime`-hetkellä, ja ohittaminen maksaa hoitopaikan.
  Vapaapäivä on eri asia — silloin päivältä puuttuu lapsen avain kokonaan.
- **Uloskirjausaikaa ei haeta.** `balance?day=` olisi ainoa lähde sille, mutta
  sen `actual`-taulukko täyttyy vasta uloskirjauksesta — eli tieto valmistuu
  illalla, kun näyttöä ei enää katsota. Haettu lapsi näkyy pelkkänä "haettu".

Tilin lukituksen esto on tiukempi kuin Wilmassa (`fatalLimit: 2`, jäähdytys
2 h → 12 h, manuaalitestejä 3/vrk), koska Päikyssä **yksi hakukierros on yksi
kirjautuminen** ja sama tunnus on huoltajan omassa puhelimessa. Wilman luvut
on mitoitettu eri tilanteeseen eikä niitä peritä.

Näytettävät lapset valitaan asetuksista erikseen Päikylle
(`visiblePaikkyChildren`), samalla säännöllä kuin Wilmalla: **`null` tai tyhjä
lista tarkoittaa kaikkia**, jottei viimeisenkin valinnan poistaminen jätä
korttia tyhjäksi. Sama sääntö on kolmessa paikassa — `useScheduleDay`,
`ScheduleCard`in otsikko ja `PaikkyCareDays`in suodatin — ja jos ne eriävät,
kortin otsikko nimeää lapsen jonka rivejä ei näy.

**Ilman `PAIKKY_*`-tunnuksia Päikkyä ei ole olemassa.** Provider rekisteröidään
vain jos tunnukset on annettu, joten `/api/dashboard` ei sisällä `paikky`-avainta
lainkaan eivätkä kortit kasvata itselleen välilehtiä. Tämä on tarkoituksellista
ja eri linja kuin Wilmalla: Wilma on tämän näytön olemassaolon syy, ja sen
puuttuvista tunnuksista kerrotaan kortissa. Päikky on lisäosa, ja kenenkään
muun asennuksessa ei pidä näkyä tyhjää "Hoitoajat"-välilehteä.

Viestipäätepiste (`/api/v2/communications`) on toteutuksen heikoiten
todennettu osa: postilaatikko oli tyhjä rajapintaa selvitettäessä, joten
kenttänimet on luettu selainkoodista. Siksi jäsentäjä pudottaa yksittäisen
kelvottoman viestin sen sijaan että kaataisi haun, ja **viestien virhe ei
kaada hoitoaikoja** — se raportoidaan omana kenttänään (`messagesError`),
jotta vika näkyy mutta ei vie mukanaan sitä dataa, jota varten kortti on.

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
- Wilma- ja **Päikky-datan** lukureitit vastaavat vain **localhostista** —
  kotiverkon puhelin näkee sään ja muistilistan, ei lasten koulu- eikä
  varhaiskasvatustietoja. Puhelimessa kortilla lukee "Vain infonäytöllä" eikä
  se jää pyörimään ikuiseen "Haetaan…"-tilaan. Todennettu oikealla datalla:
  lähiverkon vastauksesta ei löydy lapsen nimeä, oppilasnumeroa, oppiainetta
  eikä opettajan nimeä.
- **Päikyn läsnäolotieto on erikseen harkittava.** Kortti näyttää "paikalla
  klo 8:00 alkaen", kun lapsi on kirjattu sisään. Se on alaikäisen
  sijaintitieto, ja seinänäyttö on yhteisessä tilassa, jossa käy vieraita —
  toisin kuin Wilma-viesti, jonka näkee vasta napauttamalla, tämä rivi on
  esillä ilman mitään elettä. Verkkopuolen suoja (edellinen kohta) ei kosketa
  tätä lainkaan: se säätelee kuka verkossa, ei kuka huoneessa. Varausajat
  ("varattu 8:00–16:10") ovat tavallista aikataulua; toteutunut läsnäolo ei.
- Salasanoja, evästeitä eikä viestien sisältöjä ei kirjoiteta lokiin.
- **Kaksi PIN-koodia (`EDIT_PIN` ja `FULL_PIN`).** Puhelimessa yläpalkin
  lukkokuvake avaa syöttökentän; koodi jää selaimen muistiin, ja sen voi
  unohtaa dialogista tai asetuksista. Molemmat menevät samaan kenttään —
  palvelin päättää tason ja kertoo sen näytöllä.

  | Koodi | Antaa | Ei anna |
  |---|---|---|
  | `EDIT_PIN` | Muistilista, asetukset, hälytykset | Lasten Wilma-tiedot |
  | `FULL_PIN` | Kaiken, myös Wilma-tiedot | — |

  PIN ei ole sidottu verkko-osoitteeseen, joten se toimii silloinkin kun
  puhelimen IP:tä ei tiedä tai DHCP vaihtaa sen — juuri se tilanne johon
  `TRUSTED_HOSTS` ei taivu.

  **`FULL_PIN` on vähintään kuusi merkkiä.** Lyhyempää ei oteta käyttöön
  lainkaan: taso jää pois päältä ja loki kertoo miksi. Pelkkä varoitus jättäisi
  heikon suojan voimaan hiljaa, ja käyttäjä luulisi suojanneensa lasten tiedot.
  `EDIT_PIN`-koodille ei vastaavaa rajaa — se avaa vain ostoslistan ja
  asetukset, eli eri panokset ja eri vaatimus. Tyhjä arvo tarkoittaa että
  kyseinen taso ei ole käytössä, eikä käyttöliittymä tarjoa sitä.

  Arvausrajoitin: viisi väärää yritystä lukitsee lähteen 15 minuutiksi, ja
  lukituksen aikana myös oikea koodi torjutaan. Kuusimerkkisen koodin
  läpikäynti kestäisi vuosikymmeniä. Rajoitinta kuluttaa **vain aito väärä
  arvaus** — puuttuva otsikko tai oikea koodi väärällä tasolla ei koskaan.
  Ilman tätä erottelua tavallisen muokkauskoodin käyttäjä olisi lukinnut
  itsensä ulos muutamassa minuutissa, koska sama otsikko lähtee jokaisessa
  taustapollauksessa.

  Rehellinen varauma: koodi jää selaimen muistiin kunnes se erikseen
  unohdetaan, eikä sitä ole sidottu laitteeseen. Jos puhelin katoaa, ainoa
  keino perua sen pääsy on vaihtaa koodi — mikä katkaisee kaikki laitteet
  kerralla.
- **Luotetut laitteet (`TRUSTED_HOSTS`).** `.env`-tiedostoon voi listata
  pilkulla erotettuna IP-osoitteita ja/tai konenimiä (esim. oma puhelin), jotka
  saavat täsmälleen samat oikeudet kuin näyttölaite itse: näkevät Wilma-datan,
  voivat merkitä viestin luetuksi ja muokata muistilistaa ja asetuksia ilman
  PIN-koodia. Lista on **tarkoituksella vain `.env`:ssä**, ei asetusnäkymässä
  eikä rajapinnassa: jos listaa voisi muokata rajapinnan kautta, kuka tahansa
  muokkausoikeuden saanut laite voisi lisätä itsensä siihen ja ohittaa koko
  rajauksen. Muutos vaatii siis tiedostojärjestelmäpääsyn koneelle ja
  palvelimen uudelleenkäynnistyksen. Tyhjä tai asettamaton `TRUSTED_HOSTS`
  vastaa täsmälleen nykyistä käytöstä.

  Täyden Wilma-näkyvyyden voi antaa myös `FULL_PIN`-koodilla (ks. yllä). Ne
  ovat eri työkaluja samaan tarpeeseen: laitelista on sidottu osoitteeseen ja
  toimii ilman että kukaan syöttää mitään, koodi taas toimii miltä tahansa
  laitteelta mutta jää selaimen muistiin.

  Rehellinen varauma: tämä ei ole vahva todennus, vaan verkko-osoitteen
  luottamista.
  - **DHCP voi antaa saman IP:n toiselle laitteelle myöhemmin** — reitittimeltä
    kannattaa varata luotetulle laitteelle kiinteä IP, muuten luottamus voi
    ajan myötä siirtyä täysin toiselle laitteelle huomaamatta.
  - **Konenimeen luottaminen on heikompaa kuin osoitteeseen**, koska se nojaa
    kotiverkon DNS:ään: konenimi ratkaistaan taustalla noin 5 minuutin
    välein, ei jokaisella pyynnöllä (hitautta ja haurautta varten), joten
    muutos näkyy viiveellä, ja kuka tahansa sama DNS voi periaatteessa
    vastata väärin.
  - **Ei aliverkkotukea** (esim. `192.168.10.0/24`) — vain yksittäisiä
    laitteita voi listata. Tämä on tietoinen rajaus: aliverkon luottaminen
    tekisi koko kotiverkosta yhden kirjoitusvirheen päässä olevan asian.
  - `X-Forwarded-For`-otsikkoon ei luoteta missään muodossa eikä Fastifyn
    `trustProxy`-asetusta oteta käyttöön — asiakkaan osoite tulee aina
    suoraan socketista, ei asiakkaan lähettämästä otsikosta.

## Moduulit

| Kortti | Lähde | Päivitysväli |
|---|---|---|
| Lukujärjestys | Wilma (`@wilm-ai/wilma-client`, naulattu 1.4.2) | 20 min, ei öisin |
| Wilma-viestit | sama | sama |
| Hoitoajat | Päikky (oma asiakas, ks. `docs/paikky-rajapinta.md`) | 30 min, ei öisin |
| Päikky-viestit | sama | sama |
| Sää | Open-Meteo (sijainti postinumerosta, niputettu aineisto) | 20 min |
| Pörssisähkö | porssisahko.net | 20 min |
| Kuukausikeskiarvot | Elering (Nord Pool FI) | kerran vrk |
| Kalenteri | Google Calendarin ICS-syöte | 15 min |
| Muistilista | oma SQLite | — |
| Kouluhälytykset | lukujärjestys + omat asetukset | kellosykli, 20 s |

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

### Kouluhälytykset

Yläpalkin kellokuvake avaa hälytysten hallinnan. Hälytys ajoitetaan joko
**suhteessa aamun tapahtumaan** ("35 min ennen ensimmäistä tuntia") tai
**kiinteään kellonaikaan**. Suhteellinen laukaisuhetki lasketaan päivän
ensimmäisestä oppitunnista, joten se seuraa lukujärjestystä itsestään eikä
vaadi säätöä kun tunnit vaihtuvat.

Suhteellisen hälytyksen ankkuri on joko **koulun alku** tai **aamupala**, ja
ankkuri valitaan **viikonpäiväkohtaisesti**: sama hälytys voi maanantaina
seurata aamupalaa ja tiistaina koulun alkua. Aamupalan alkuaika on yksi
yhteinen asetus (oletus 08:00, Asetukset → Aamupala) — ei hälytys- eikä
lapsikohtainen, koska perhe syö yhdessä.

Viikonpäivät valitaan jokaiselle hälytykselle erikseen, ja jos lapsia on
useampi, hälytyksen voi sitoa yhteen lapseen tai jättää seuraamaan sitä lasta
jonka koulu alkaa aikaisimmin.

Hälytyksiä voi olla useita samalle aamulle — herätys, pukeutuminen, lähtö.
Jokaisella on oma selite, ääni, äänenvoimakkuus ja toistojen määrä. Paneeli
näyttää myös **milloin hälytys oikeasti soi** ("soi klo 7.55"), koska pelkkä
"35 min ennen" on vaikea suhteuttaa.

Suhteellinen hälytys **ei soi tunnittomina päivinä** — viikonloppuina eikä
lomilla. Tämä koskee myös aamupala-ankkuria: aamupala on koulupäivän osa, joten
lomalla sitä ei herätetä syömään. Kiinteä kellonaika on tästä tahallisesti
riippumaton — se ei seuraa lukujärjestystä lainkaan, joten pelkkä
viikonpäivävalinta ratkaisee.

Hälytys ei soi jälkikäteen: sivun lataus keskellä päivää ei laukaise aamun
hälytyksiä, ja sama hälytys soi kerran päivässä myös kioskiselaimen
uudelleenkäynnistyksen yli.

Jos hälytykseltä puuttuvat viikonpäivät kokonaan, se **ei jää näyttämään
toimivalta** — sekä listassa että lomakkeessa lukee että hälytys ei koskaan
laukea. Sama periaate kuin puuttuvalla äänitiedostolla ja poistetulla lapsella.

**Ääni ja näkyvä ilmoitus ovat toisistaan riippumattomia.** Ilmoitus täyttää
ruudun isolla kuittauspainikkeella ja näkyy kirkkaana myös yötilassa — aamu on
juuri se hetki jolloin hälytys on tärkein. Näin hälytys toimii vaikka ääni
olisi estetty.

Sisäänrakennettuja ääniä on kolme (kellon kilahdus, nouseva sarja, toistuva
piippaus) ja ne tuotetaan selaimessa Web Audio -rajapinnalla, ei
äänitiedostoina — ei uusia riippuvuuksia eikä binäärejä repoon, ja ääni toimii
ilman verkkoa. Jokaisen vieressä on kuuntelupainike.

**Oman äänitiedoston voi myös valita.** Pudota mp3-, wav-, ogg-, m4a- tai
aac-tiedosto palvelimen `data/sounds/`-kansioon (luodaan automaattisesti jos
sitä ei ole) — tiedostonimessä saa olla ääkköset ja välilyönnit. Palvelin
listaa kansion sisällön hälytyspaneelin pudotusvalikkoon "Omat
äänitiedostot" -ryhmään, kun paneeli avataan. **Latausta käyttöliittymästä ei
ole** — tiedosto pitää siirtää kansioon esim. verkkolevyjaon tai USB-muistin
kautta, koska kioskiselaimesta ei voi kätevästi valita tiedostoa eikä
latauskäsittely kannata sen kustannuksella.

Jos hälytys viittaa äänitiedostoon jota ei enää löydy (poistettu, nimetty
uudelleen), **hälytys ei jää hiljaiseksi** — se soittaa sisäänrakennetun
oletusäänen sen sijaan, ja tilanne näkyy selvänä varoituksena sekä
hälytyksen soidessa että hälytysten hallintapaneelissa.

Selain vaimentaa äänen kunnes sivulla on tehty jokin ele, eikä kukaan koske
näyttöön aamuyöllä. Siksi molemmat asennusskriptit käynnistävät selaimen
`--autoplay-policy=no-user-gesture-required` -lipulla. Jos ääni jää silti
tulematta, syy on todennäköisesti siellä.

### Sään sijainti postinumerolla

Sään paikkakunta annetaan **postinumerona** — asennuksen yhteydessä ja
asetuspaneelista. Palvelin muuntaa sen paikannimeksi ja koordinaateiksi
**mukana tulevasta aineistosta** (3608 suomalaista postinumeroa, 133 kt).
Verkkoa ei tarvita eikä käytetä.

Niputus on mitattu valinta eikä mukavuusratkaisu. Vuoden aikana käyttöön
otetuista seitsemästä suomalaisesta postinumerosta zippopotam.us tunsi yhden ja
Nominatim ei yhtäkään: verkkohaku ei siis toisi tuoreutta, vain uuden
vikapisteen laitteeseen jonka on määrä toimia vuosia ilman että kukaan koskee
siihen. Open-Meteon oma geokoodaus on tähän kelvoton — `name=43500` palauttaa
Tortosan Espanjasta.

Muunnos tehdään palvelimella, ei asentimissa. Muuten sama logiikka olisi
kirjoitettava sekä PowerShellillä että bashilla, ja juuri se kaksinkertaisuus
johti siihen että Päikky puuttui Linux-asentimesta kokonaan. Asentimet kysyvät
pelkän postinumeron.

**Etusijajärjestys:**

```
asetukset (tietokanta)  >  WEATHER_POSTAL_CODE  >  WEATHER_LAT/LON/PLACE  >  oletus (Karstula)
```

Asetus voittaa `.env`:n, koska `.env` luetaan vain käynnistyksessä — asetuksista
vaihdettu postinumero vaihtaa paikkakunnan heti, ilman uudelleenkäynnistystä.
Sijainti luetaan siis jokaisella haulla eikä moduulin latautuessa. Koordinaatit
ovat yhä listan alapäässä: olemassa oleva `WEATHER_LAT`/`WEATHER_LON`/
`WEATHER_PLACE` -asennus toimii päivityksen jälkeen ennallaan.

**Tuntematon postinumero ei pudota sijaintia oletukseen.** Kirjoitusvirheellinen
numero säilyttää edellisen kelvollisen sijainnin ja kirjaa varoituksen lokiin
(`warn`, siis oletustasolla näkyvä). Muuten sääkortti alkaisi näyttää väärän
paikkakunnan säätä ilman että mikään kertoo miksi. Sama varoitus ei toistu
jokaisella 20 minuutin haulla, vain kun numero muuttuu.

Asetuspaneeli näyttää numeroa kirjoitettaessa mitä paikkaa se tarkoittaa:

```
GET /api/postal-code/:code  →  { code, place, latitude, longitude }  |  404
```

Aineisto rakennetaan käsin `skriptit/rakenna-postinumerot.mjs`-skriptillä;
loppukäyttäjä ei aja sitä koskaan. Se on `server/src/data/postinumerot.json`, ja
julkaisukoonti **kieltäytyy tuottamasta pakettia jos tiedosto puuttuu**
(`skriptit/tee-julkaisu.mjs`) — muuten kehityksessä kaikki toimisi mutta
tuotannossa jokainen postinumero olisi "ei löydy".

Ahvenanmaan nimet tulevat Tilastokeskuksen suomenkielisestä nimikentästä, joten
`22100` on aineistossa "Maarianhamina" eikä postin käyttämä "Mariehamn".
Suomenkielisessä käyttöliittymässä valinta on perusteltu, mutta se on tietoinen
valinta eikä aineiston virhe.

#### Aineiston alkuperä ja lisenssi

Postinumeroaineisto: GeoNames (https://www.geonames.org/), lisenssi CC BY 4.0
(https://creativecommons.org/licenses/by/4.0/). Ahvenanmaan postinumeroalueiden
keskipisteet: Tilastokeskus, Paavo-postinumeroalueittainen avoin tieto, lisenssi
CC BY 4.0. Aineistoja on muokattu: mukaan on otettu vain postinumero, paikannimi
ja koordinaatit.

Kaksi lähdettä siksi, ettei kumpikaan yksin riitä: GeoNamesista **puuttuu koko
Ahvenanmaa** (22xxx), ja Paavo antaa aluenimiä ("Karstula Keskus") eikä
postitoimipaikkoja. Paavoa käytetään siis vain paikkaamaan GeoNamesin aukko.

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
