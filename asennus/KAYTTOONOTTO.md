# Käyttöönotto Surface Pro 4:llä (Windows)

Kaksi asennustapaa:

- **[Tapa 1: julkaisupaketista](#tapa-1-julkaisupaketista)** (suositeltu) —
  valmis zip-paketti, jossa Node on mukana. Kohdekoneelle ei asenneta Node.js:ää
  eikä ajeta `npm`-komentoja lainkaan.
- **[Tapa 2: kehityskopiosta](#tapa-2-kehityskopiosta)** — `git clone` +
  `npm install`. Tarkoitettu kehitykseen, ei tavalliseen käyttöönottoon.

Molemmille yhteiset osat — käsin tehtävät asiat, kioskista poistuminen,
vianetsintä, tietoturva ja **laiteriski** — ovat asennustapojen jälkeen.

Linuxille on oma ohjeensa: [`KAYTTOONOTTO-LINUX.md`](KAYTTOONOTTO-LINUX.md).

## Tapa 1: Julkaisupaketista

1. Pura zip väliaikaiseen kansioon. Asennushakemisto valitaan erikseen, joten
   purkupaikalla ei ole väliä.

2. Aja **järjestelmänvalvojana** puretun paketin `asennus`-kansiosta:

   ```powershell
   cd <purkukansio>\asennus
   powershell -ExecutionPolicy Bypass -File .\asenna.ps1
   ```

3. Skripti kysyy kaiken tarvittavan järjestyksessä:

   | Kysytään | Oletus |
   |---|---|
   | Asennushakemisto | puretun paketin oma sijainti (ei kopioida) |
   | Portti | 4173 |
   | Lokitaso (warn/error/debug) | warn |
   | Postinumero säätietoja varten | 43500 |
   | Wilman osoite, käyttäjätunnus, salasana | tyhjä = Wilma pois käytöstä |
   | Päikyn kuntaosoite, käyttäjätunnus, salasana | tyhjä = Päikky pois käytöstä |
   | Kalenterin ICS-osoite | tyhjä = kalenteri pois käytöstä |
   | `EDIT_PIN` | tyhjä = ei käytössä |
   | `FULL_PIN` (vähintään 6 merkkiä) | tyhjä = ei käytössä |
   | `TRUSTED_HOSTS` | tyhjä = ei luotettuja laitteita |
   | Otetaanko automaattikäynnistys käyttöön | kyllä |

   > **Päikyn salasana kannattaa saada kerralla oikein.** Päikky-tili lukkiutuu
   > epäonnistuneista kirjautumisista, ja sama tunnus on huoltajan omassa
   > puhelimessa — väärä salasana täällä kaataa siis muutakin kuin näytön.
   > Sama koskee Wilmaa (ks. [Tietoturva](#tietoturva)).

   Jokainen arvo validoidaan heti kysyttäessä: portti, postinumero (viisi
   numeroa), osoitteiden URL-muoto ja `FULL_PIN`:n pituus. Virheestä skripti
   kertoo mikä on vialla ja kysyy uudelleen. Salasanat ja PIN-koodit eivät näy
   ruudulla eivätkä päädy lokiin. Kaikki kysymykset ja lopullinen vahvistus
   tehdään ennen kuin mitään pysäytetään tai muutetaan; vahvistuksen oletus on
   **ei**.

   Skripti kirjoittaa `.env`-arvot lainausmerkeissä, joten risuaidat ja
   välilyönnit salasanoissa menevät perille. **Säilytä lainausmerkit** jos
   muokkaat tiedostoa myöhemmin käsin: Node katkaisee lainausmerkittömän arvon
   risuaidan (`#`) kohdalta äänettömästi.

   Jos annat eri asennushakemiston kuin mistä paketti on purettu, skripti
   kopioi koko paketin sinne (`robocopy`).

4. Skripti luo **työpöydän pikakuvakkeen** ("Infonäyttö (kioski)"), joka
   käynnistää yhdellä kaksoisnapsautuksella sekä palvelimen (jos se ei jo ole
   käynnissä) että kioskiselaimen — eikä jätä ikkunaa roikkumaan ruudulle. Jos
   otit automaattikäynnistyksen käyttöön, sama tapahtuu myös kirjautumisen
   yhteydessä (ajastetut tehtävät `Infonaytto-palvelin` ja `Infonaytto-naytto`).

5. Lopuksi skripti **käynnistää palvelimen ja odottaa että se vastaa** ennen
   kuin julistaa asennuksen onnistuneeksi. Jos palvelin ei vastaa, skripti sanoo
   sen selvästi eikä väitä asennusta valmiiksi — tarkista silloin
   `<asennushakemisto>\data\logs\`.

6. Palvelimen vastatessa kioskiselain käynnistetään uudella versiolla. Jos
   annoit Wilman tunnukset, skripti kysyi etukäteen luvan **Wilma-yhteyden
   testiin**, joka tehdään nyt: tasan yksi yritys, ei silmukkaa. Väärä salasana
   kannattaa löytää nyt, ei aamulla seinältä.

7. Skripti tulostaa asennushakemiston, portin, osoitteen jolla näyttöön pääsee
   puhelimella, komennon palvelimen käsin käynnistämiseen ja komennon asennuksen
   purkuun.

Tee vielä [käsin tehtävät asiat](#vielä-käsin-tehtävät-asiat).

### Päivitys uuteen versioon

Päivitys on **tuettu tapaus**: pura uusi paketti **erilliseen kansioon**, aja
sen oma `asenna.ps1` ja anna aiempi pysyvä asennushakemisto kohteeksi. Valitse
päivitystavan kysymyksessä oletus **P** säilyttääksesi asetukset, tai **U** jos
haluat antaa kaikki asetukset uudestaan.

Älä pura uutta versiota vanhan päälle: peilaus tehdään erillisestä paketista,
ja se poistaa kohteesta myös uudesta versiosta poistuneet ohjelmatiedostot.
Säilytä omat tiedostot `data`-kansiossa tai asennushakemiston ulkopuolella.

Mitä säilyy:

- **`data`-kansio aina koskemattomana** — tietokanta, muistilista,
  hälytysäänet, lokit ja migraation paluutietokanta.
- **Olemassa oleva `.env`** nykyisine tavuineen ja käyttöoikeuksineen. Skripti
  kysyy vain puuttuvat asetukset (esim. Päikyn tiedot tai sään postinumero) ja
  lisää ne tiedoston loppuun. Tyhjäksi jätetty asetus säilyy tyhjänä.
- **Vanhat `WEATHER_LAT`, `WEATHER_LON` ja `WEATHER_PLACE`** — palvelin käyttää
  niitä varareittinä, jos postinumerosta ei löydy sijaintia. Uuteen asennukseen
  niitä ei kirjoiteta lainkaan. Valinta **U** kirjoittaa `.env`:n kokonaan
  uusiksi ja pudottaa ne; skripti varoittaa tästä ennen vahvistusta.
- **Ajastettujen tehtävien käyttäjä, liipaisimet ja asetukset**;
  käynnistyskomento päivitetään tarvittaessa. Käytöstä poistettu tehtävä jää
  pois käytöstä, eikä poistettua tehtäväparin puolikasta luoda uudestaan —
  silloin palvelin tai selain käynnistetään asentajan istunnossa. Toisen
  käyttäjän ajastusta käytettäessä tämän pitää olla kirjautuneena.

Edellinen palvelin ja sen porttiin osoittava kioskiselain pysäytetään ennen
kopiointia, ja portin vapautuminen tarkistetaan. Asennus keskeytetään
virheeseen, jos uusi palvelin ei vastaa.

Peilaus hyväksyy kohteeksi vain tyhjän kansion tai tunnistetun Infonäytön
julkaisupaketin; se estää aseman juuren, kehityskopion, sisäkkäiset hakemistot
sekä symboliset linkit ja junctionit. Jos kohde ei läpäise tarkistusta, mitään
ei kopioida eikä poisteta.

### Asennuksen purku

```powershell
powershell -ExecutionPolicy Bypass -File .\asenna.ps1 -Poista
```

Poistaa ajastetut tehtävät ja työpöydän pikakuvakkeen. **Ei koskaan**
`.env`-tiedostoa eikä `data`-kansiota — poista ne itse (tai koko
asennushakemisto) jos et enää tarvitse niitä.

## Tapa 2: Kehityskopiosta

Käytä Tapaa 1 jos sinulla on valmis julkaisupaketti.

### 1. Node.js

Asenna **Node.js 24 tai uudempi** ([nodejs.org](https://nodejs.org)):

```powershell
node --version    # v24.x tai uudempi
```

### 2. Projektin asennus

```powershell
cd G:\Atorcom\VS_code_projektit\Infonäyttö
npm install
copy .env.example .env
notepad .env
npm run build
```

Jos PowerShell valittaa skriptien suorittamisesta:

```powershell
Set-ExecutionPolicy -ExecutionPolicy Unrestricted
```

#### Mitä `.env`-tiedostoon

`.env.example`n omat kommentit kertovat jokaisesta avaimesta tarkemmin — lue ne
tiedostosta. Vähintään nämä kannattaa täyttää:

| Muuttuja | Mistä saa |
|---|---|
| `WILMA_BASE_URL` | Koulun Wilma-osoite, esim. `https://karstulakyyjarvi.inschool.fi` |
| `WILMA_USERNAME`, `WILMA_PASSWORD` | Huoltajatunnukset |
| `PAIKKY_BASE_URL`, `PAIKKY_USERNAME`, `PAIKKY_PASSWORD` | Kunnan Päikky-osoite ja huoltajan tunnukset. Tyhjä = Päikkyä ei oteta käyttöön lainkaan |
| `CALENDAR_ICS_URL` | Google Calendar → kalenterin asetukset → **Salainen osoite iCal-muodossa** |
| `WEATHER_POSTAL_CODE` | Sään sijainnin postinumero, esim. `43500`. Palvelin päättelee siitä koordinaatit ja paikkakunnan nimen |
| `EDIT_PIN`, `FULL_PIN` | Vapaavalintaiset, ks. [Tietoturva](#tietoturva) |

> **Käytä lainausmerkkejä salasanoissa:** kirjoita `WILMA_PASSWORD=<salasana>`
> aina muodossa `WILMA_PASSWORD="<salasana>"`. Node katkaisee lainausmerkittömän
> arvon risuaidan (`#`) kohdalta äänettömästi, ja palvelin yrittää kirjautua
> katkelmalla. Lainausmerkit ovat turvalliset myös silloin kun niitä ei tarvita.

`.env` ei mene gitiin. Wilman ja Päikyn salasanat ovat siinä selväkielisenä —
ks. [Tietoturva](#tietoturva).

### 3. Kokeile ensin käsin

```powershell
npm start
```

Avaa `http://localhost:4173` ja tarkista että kortit täyttyvät. Jos jokin kortti
näyttää virhettä, katso `data\logs\`.

### 4. Automaattikäynnistys ja kioskitila

Aja **järjestelmänvalvojana**:

```powershell
cd G:\Atorcom\VS_code_projektit\Infonäyttö\asennus
powershell -ExecutionPolicy Bypass -File .\asenna-kioski.ps1
```

Skripti luo kaksi ajastettua tehtävää (palvelin + kioskiselain), estää näytön
sammumisen ja lepotilan ja poistaa näytönsäästäjän. Purku:
`.\asenna-kioski.ps1 -Poista`

Selainta ei käynnistetä suoraan vaan `kaynnista-kioski.ps1`-käynnistimen kautta,
joka **odottaa palvelimen vastaavan** ennen kuin avaa sivun. Kiinteä viive ei
riitä: jos palvelin on hidas käynnistymään — kylmäkäynnistys, virustarkistus,
kaatumisen jälkeinen uudelleenyritys — Edge avaisi oman virhesivunsa eikä
yrittäisi uudelleen koskaan. Sivun jäädessä lataamatta koko sovellus on pois
päältä, myös aamun kouluhälytykset. Yöllinen Windows Update tai lyhyt sähkökatko
riittäisi siihen.

Tee vielä [käsin tehtävät asiat](#vielä-käsin-tehtävät-asiat).

## Vielä käsin tehtävät asiat

Sama kummassakin asennustavassa.

1. **Automaattikirjautuminen**: `netplwiz` → poista rasti *"Käyttäjän on annettava
   käyttäjänimi ja salasana"*. Ilman tätä ajastetut tehtävät eivät käynnisty
   sähkökatkon jälkeen ennen kuin joku kirjautuu.

   Jos rastia ei näy `netplwiz`-ikkunassa lainkaan, Windows piilottaa sen
   salasanattoman kirjautumisen takia. Näytä se rekisteristä: `Win + R` →
   `regedit` → avaa
   `HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\PasswordLess\Device`
   → muuta arvon `DevicePasswordLessBuildVersion` tiedoksi `2` sijaan `0` →
   käynnistä kone uudelleen.

2. **Windows Update → aktiiviset tunnit** mahdollisimman laajaksi, ettei kone
   käynnisty uudelleen kesken päivän.

3. **Kokeile**: käynnistä kone uudelleen ja katso että näyttö palaa itsestään.

## Kioskista poistuminen

Selain ei voi purkaa omaa kioskitilaansa, joten poistuminen tapahtuu
jommallakummalla näistä:

- **Kosketuksella, ilman näppäimistöä**: pidä sormea painettuna yläpalkin
  **päivämäärätekstin perässä noin 3 sekuntia** ja anna avautuvaan dialogiin
  **`FULL_PIN`** (`EDIT_PIN` ei riitä). Oikean koodin jälkeen palvelin sulkee
  Edgen (`msedge.exe`) ja työpöytä jää näkyviin. Jos `FULL_PIN`:iä ei ole
  asetettu tai se on alle 6 merkkiä, painike ei tee mitään — ominaisuus on
  silloin kokonaan pois käytöstä.
- **Näppäimistöllä** (jos kytkettynä): `Ctrl+Alt+Del` tai `Alt+F4`.

Painallusalue on näkymätön eikä siinä ole visuaalista vihjettä, eikä se ole
ruudun nurkassa — nurkkaan osutaan helposti pöytää pyyhittäessä.

**Käynnistä kioski takaisin** jommallakummalla tavalla:

1. **Käynnistä laite uudelleen.** Ajastetut tehtävät (`Infonaytto-palvelin`,
   `Infonaytto-naytto`) käynnistyvät kirjautumisen yhteydessä — varmin tapa.
2. **Ilman uudelleenkäynnistystä**: avaa Tehtävien ajastin (`Win + R` →
   `taskschd.msc`), etsi tehtävä **`Infonaytto-naytto`** ja valitse **Suorita**.
   Taustapalvelin ei sammunut, vain selain suljettiin.

## Vianetsintä

Lokit ovat kansiossa `<asennushakemisto>\data\logs\`. Tarkempi loki saadaan
lokitasolla `debug` (kysytään asennuksessa; kehityskopiossa
`$env:LOG_LEVEL = "debug"; npm start`). Silloin rikkoutuneen Wilma-vastauksen
raaka HTML tallentuu kansioon `data\snapshots\`.

**Jos Wilma-kortti lakkaa toimimasta**, etsi lokista rivi `wilma_empty_parse`:
sivu haettiin onnistuneesti mutta siitä ei saatu irti mitään, eli koulun Wilman
rakenne on muuttunut. Näyttö jatkaa sillä välin viimeisimmän onnistuneen datan
näyttämistä vanhentuneena, joten aamun lukujärjestys ei katoa heti. Korjaus
tulee uuden julkaisupaketin mukana. Kirjaston ylläpito ja Wilman katkaisijan
perustelut: [`docs/wilma.md`](../docs/wilma.md).

## Tietoturva

- Wilman ja Päikyn datan lukureitit vastaavat vain **localhostista**. Kotiverkon
  puhelin näkee sään, sähkön, kalenterin ja muistilistan — ei lasten koulu- eikä
  varhaiskasvatustietoja.
- Muokkaus muualta kuin näyttölaitteelta vaatii PIN-koodin, joka syötetään
  yläpalkin lukkokuvakkeesta. `EDIT_PIN` antaa muokkausoikeuden mutta **ei**
  lasten tietoja; `FULL_PIN` (väh. 6 merkkiä) antaa nekin. Vaihtoehtona laite
  voidaan lisätä `TRUSTED_HOSTS`-listalle, jolloin koodia ei tarvita.
- **Kioskista poistuminen** vaatii nimenomaan `FULL_PIN`:n, ja pyyntö
  hyväksytään vain näyttölaitteelta itseltään — ei etänä TRUSTED_HOSTS-laitteelta
  eikä FULL_PIN:llä varustetulta puhelimelta. Syy: kioskista poistuminen antaa
  pääsyn koko työpöydälle ja sitä kautta `.env`:n salasanoihin.
- Näyttö on yhteisessä tilassa: viestien sisällön voi piilottaa asetuksista,
  jolloin näkyy vain lähettäjä ja otsikko.
- **Tilin lukituksen esto**: kolme peräkkäistä epäonnistunutta Wilma-kirjautumista
  pysäyttää yritykset (Päikyssä kaksi). Jos vaihdat salasanan, päivitä se
  `.env`-tiedostoon ja **käynnistä palvelin uudelleen** — `.env` luetaan vain
  käynnistyksessä, joten muuten kortti jää virhetilaan (mikä on tarkoitus, ei
  vika). Asennusskripti tarjoaa yhteyden testausta juuri tästä syystä: se
  käyttää samaa "Testaa yhteys" -rajapintaa kuin asetusnäkymä eikä koskaan
  silmukoi yrityksiä, jottei se itse voi laukaista lukitusta.
- Salasanoja, evästeitä eikä viestien sisältöjä kirjoiteta lokiin.
- **`.env`-tiedoston oikeudet** rajataan asentavaan käyttäjään (julkaisupaketin
  `asenna.ps1` tekee sen `icacls`-komennoin, poistaen periytyvät oikeudet).
  Tiedosto sisältää Wilman ja Päikyn salasanat selväkielisenä — tämä ei poista
  riskiä, mutta estää muita samalla koneella olevia käyttäjätilejä lukemasta
  sitä.

Perustelut ja tarkemmat rajat: [`docs/tietoturva.md`](../docs/tietoturva.md).

## Laiteriski — lue tämä

Surface Pro 4 on vuoden 2015 laite, eikä sitä ole suunniteltu jatkuvaan
seinäkäyttöön. Kolme tunnettua ongelmaa osuu juuri tähän käyttötapaan:

- **Näytön välkkymisvika ("flickergate")** on Microsoftin tunnustama
  laitteistovika tässä mallissa, ja ilmainen vaihto-ohjelma on päättynyt.
- **Akun turpoaminen** on laajasti dokumentoitu SP4:ssä ja kiihtyy nimenomaan
  jatkuvasta latauksesta ja lämmöstä. Turpoava akku työntää kuorta auki. Tarkista
  laite silmämääräisesti muutaman kuukauden välein: jos kuori tai näyttö alkaa
  irrota reunoista, ota laite pois käytöstä heti.
- **Windows 11 ei ole virallisesti tuettu** SP4:n 6. sukupolven suorittimella,
  joten tietoturvapäivitysten saanti on epävarmaa. Vaihtoehto tähän on
  [`KAYTTOONOTTO-LINUX.md`](KAYTTOONOTTO-LINUX.md).

Tämä on **tietoisesti hyväksytty riski**: laite on jo olemassa, joten kokeilu on
halpa. Siksi backend on tarkoituksella tavallinen Node-prosessi ilman
Windows-riippuvuuksia — jos Surface pettää tai halutaan siirtyä kestävämpään
laitteeseen, sama koodi ajetaan Raspberry Pi:llä sellaisenaan ja Surface (tai
mikä tahansa näyttö) jää pelkäksi selaimeksi. Vain tämän kansion skriptit ovat
Windows-kohtaisia.
