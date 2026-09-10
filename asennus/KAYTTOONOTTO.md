# Käyttöönotto Surface Pro 4:llä

Kaksi tapaa asentaa, riippuen siitä mitä sinulla on kädessä:

- **Julkaisupaketista** (suositeltu) — valmis zip-paketti, jossa Node on jo
  mukana. Ei vaadi Node.js-asennusta eikä `npm`-komentoja koneelle lainkaan.
  Ks. [Tapa 1](#tapa-1-julkaisupaketista-suositeltu).
- **Kehityskopiosta** — `git clone` + `npm install`, koneelle asennettu Node.
  Tarkoitettu kehitykseen, ei tavalliseen käyttöönottoon. Ks.
  [Tapa 2](#tapa-2-kehityskopiosta).

Molemmissa tavoissa yhteiset osat (laiteriski, tietoturva, ylläpito) ovat
dokumentin lopussa.

## Tapa 1: Julkaisupaketista (suositeltu)

1. Pura julkaisupaketti (zip) haluamaasi väliaikaiseen kansioon — asennushakemiston
   voi valita erikseen seuraavassa vaiheessa, joten purkupaikalla ei ole väliä.
2. Aja **järjestelmänvalvojana**, puretun paketin `asennus`-kansiosta:

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
   | Sään leveys- ja pituusaste, paikkakunta | Karstula |
   | Wilman osoite, käyttäjätunnus, salasana | tyhjä = Wilma pois käytöstä |
   | Päikyn kuntaosoite, käyttäjätunnus, salasana | tyhjä = Päikky pois käytöstä |
   | Kalenterin ICS-osoite | tyhjä = kalenteri pois käytöstä |
   | `EDIT_PIN` | tyhjä = ei käytössä |
   | `FULL_PIN` (vähintään 6 merkkiä) | tyhjä = ei käytössä |
   | `TRUSTED_HOSTS` | tyhjä = ei luotettuja laitteita |
   | Otetaanko automaattikäynnistys käyttöön | kyllä |

   Jokainen uusi arvo validoidaan heti kysyttäessä (porttinumero, osoitteet ovat
   kelvollisia URL-muotoja, `FULL_PIN` on riittävän pitkä tai tyhjä) — virheen
   sattuessa skripti kertoo mikä on vialla ja kysyy uudelleen, eikä jatka
   virheellisellä arvolla. Portin vapautuminen tarkistetaan myös vanhan palvelimen
   pysäyttämisen jälkeen. Salasanat ja PIN-koodit eivät koskaan näy ruudulla
   eivätkä päädy lokiin. Kaikki kysymykset ja lopullinen vahvistus tehdään ennen
   ohjelmien pysäyttämistä tai tiedostojen muuttamista. Vahvistuksen oletus on ei.

   Jos annat eri asennushakemiston kuin mistä paketti on purettu, skripti
   kopioi koko paketin sinne (`robocopy`). Jos kohteessa on jo aiempi asennus
   (päivitys), **`data`-kansio säilyy aina koskemattomana** — tietokanta,
   muistilista, hälytysäänet ja lokit eivät katoa. Olemassa oleva `.env`
   säilyy päivityksessä nykyisine käyttöoikeuksineen. Skripti kysyy vain mallista
   puuttuvat asetukset, esimerkiksi Päikyn tiedot, ja lisää ne tiedoston loppuun.
   Tyhjäksi jätetty olemassa oleva asetus säilyy tyhjänä. Asetukset voi myös
   määrittää kokonaan uudestaan valitsemalla erikseen **U** päivitystavan kysymyksessä.

4. Skripti luo **työpöydän pikakuvakkeen** ("Infonäyttö (kioski)"), joka
   käynnistää sekä palvelimen (jos se ei jo ole käynnissä) että kioskiselaimen
   yhdellä kaksoisnapsautuksella — eikä jätä mitään ikkunaa roikkumaan ruudulle.
   Jos otit automaattikäynnistyksen käyttöön, sama tapahtuu myös
   kirjautumisen yhteydessä (ajastetut tehtävät `Infonaytto-palvelin` ja
   `Infonaytto-naytto`).

5. Lopuksi skripti **käynnistää palvelimen ja odottaa että se vastaa**
   ennen kuin asennus julistetaan onnistuneeksi. Jos palvelin ei vastaa,
   skripti sanoo sen selvästi eikä väitä asennusta valmiiksi — tarkista
   silloin `<asennushakemisto>\data\logs\`.

6. Palvelimen vastatessa myös kioskiselain käynnistetään uudella versiolla.
   Jos annoit Wilman tunnukset, skripti kysyy etukäteen luvan **Wilma-yhteyden testiin**,
   joka tehdään asennuksen lopuksi (tasan yksi yritys, ei silmukkaa — ks. alempana
   "Tilin lukituksen esto"). Väärä salasana kannattaa löytää nyt, ei aamulla
   seinältä.

7. Skripti tulostaa lopuksi asennushakemiston, portin, osoitteen jolla
   näyttöön pääsee puhelimella, komennon palvelimen käsin käynnistämiseen, ja
   komennon asennuksen purkuun.

### Vielä käsin

Sama kummassakin asennustavassa — ks. [Vielä käsin tehtävät asiat](#vielä-käsin-tehtävät-asiat)
alempana.

### Purku ja päivitys

```powershell
powershell -ExecutionPolicy Bypass -File .\asenna.ps1 -Poista
```

Poistaa ajastetut tehtävät ja työpöydän pikakuvakkeen. **Ei koskaan** `.env`-
tiedostoa eikä `data`-kansiota — poista ne itse (tai koko asennushakemisto)
jos et enää tarvitse niitä.

Version päivitys on **tuettu tapaus**: pura uusi paketti **erilliseen kansioon**,
aja sen oma `asenna.ps1` ja anna aiempi pysyvä asennushakemisto kohteeksi. Valitse
oletus **P** säilyttääksesi asetukset. Älä pura uutta versiota vanhan päälle:
erillisestä paketista tehty peilaus poistaa myös uudesta versiosta poistuneet
ohjelmatiedostot. Kohteen ylimääräiset tiedostot poistuvat, joten säilytä omat
tiedostot `data`-kansiossa tai asennushakemiston ulkopuolella.

`data`-kansio (myös paluutietokanta) ja `.env` säilyvät. `.env`:n nykyisiä tavuja
tai käyttöoikeuksia ei muuteta; vain puuttuvat asetukset lisätään loppuun UTF-8:na.
Edellinen palvelin ja sen porttiin osoittava kioskiselain pysäytetään ennen
kopiointia. Asennus keskeytetään virheeseen, jos uusi palvelin ei vastaa.

Olemassa olevien ajastettujen tehtävien käyttäjä, liipaisimet ja asetukset
säilyvät; käynnistyskomento päivitetään tarvittaessa. Käytöstä poistetut tehtävät
jäävät pois käytöstä, eikä osittaisesta tehtäväparista poistettua tehtävää luoda
automaattisesti uudestaan. Jos tehtävää ei ole tai se on pois käytöstä, palvelin
tai selain käynnistetään nyt asentajan istunnossa. Kun käytetään toisen käyttäjän
olemassa olevaa ajastusta, tämän pitää olla kirjautuneena koneelle.

Peilaus hyväksyy tyhjän kohdekansion tai tunnistetun Infonäytön julkaisupaketin.
Se estää aseman juuren, kehityskopion, sisäkkäiset lähde- ja kohdehakemistot sekä
symboliset linkit ja junctionit. Jos kohde ei läpäise tarkistusta, mitään ei
kopioida eikä poisteta.

## Tapa 2: Kehityskopiosta

Tarkoitettu kehitykseen (`git clone` + `npm install`), ei tavalliseen
käyttöönottoon — käytä Tapaa 1 jos sinulla on valmis julkaisupaketti.

### 1. Esivalmistelut

Asenna **Node.js 24 tai uudempi** ([nodejs.org](https://nodejs.org)). Tarkista:

```powershell
node --version    # v24.x tai uudempi
```

### 2. Projektin asennus

```powershell
cd G:\Atorcom\VS_code_projektit\Infonäyttö
npm install
copy .env.example .env
notepad .env      # täytä Wilma-tunnukset ja kalenterin ICS-osoite
npm run build
```

Jos `npm` ei käynnisty vaan PowerShell valittaa skriptien suorittamisesta, salli
se ensin:

```powershell
Set-ExecutionPolicy -ExecutionPolicy Unrestricted
```

#### Mitä `.env`-tiedostoon

| Muuttuja | Mistä saa |
|---|---|
| `WILMA_BASE_URL` | Koulun Wilma-osoite, esim. `https://karstulakyyjarvi.inschool.fi` |
| `WILMA_USERNAME`, `WILMA_PASSWORD` | Huoltajatunnukset |
| `CALENDAR_ICS_URL` | Google Calendar → kalenterin asetukset → **Salainen osoite iCal-muodossa** |
| `WEATHER_LAT`, `WEATHER_LON`, `WEATHER_PLACE` | Oletuksena Karstula |
| `EDIT_PIN` | Vapaavalintainen. Antaa puhelimelle oikeuden muokata muistilistaa, asetuksia ja hälytyksiä — **ei** lasten Wilma-tietoja. |
| `FULL_PIN` | Vapaavalintainen, **vähintään 6 merkkiä**. Antaa puhelimelle täydet oikeudet, myös lasten Wilma-tiedot. Lyhyempää ei oteta käyttöön lainkaan. |
| `TRUSTED_HOSTS` | Vapaavalintainen. Pilkulla erotettu lista IP-osoitteita tai konenimiä, jotka saavat täydet oikeudet ilman koodia. |

`.env` ei mene gitiin. Wilma-salasana on selväkielisenä levyllä — se on tietoinen
kompromissi, ks. **Tietoturva** alla.

### 3. Kokeile ensin käsin

```powershell
npm start
```

Avaa selaimessa `http://localhost:4173`. Tarkista että kortit täyttyvät.
Jos jokin kortti näyttää virhettä, katso `data\logs\`.

Vianetsintään yksityiskohtaisempi loki:

```powershell
$env:LOG_LEVEL = "debug"; npm start
```

### 4. Automaattikäynnistys ja kioskitila

Aja **järjestelmänvalvojana**:

```powershell
cd G:\Atorcom\VS_code_projektit\Infonäyttö\asennus
powershell -ExecutionPolicy Bypass -File .\asenna-kioski.ps1
```

Skripti luo kaksi ajastettua tehtävää (palvelin + kioskiselain), estää näytön
sammumisen ja lepotilan, ja poistaa näytönsäästäjän.

Selainta ei käynnistetä suoraan vaan `kaynnista-kioski.ps1`-käynnistimen kautta,
joka **odottaa palvelimen vastaavan** ennen kuin avaa sivun. Kiinteä viive ei
riitä: jos palvelin on hidas käynnistymään — kylmäkäynnistys, virustarkistus,
kaatumisen jälkeinen uudelleenyritys — Edge avaisi oman virhesivunsa eikä
yrittäisi uudelleen koskaan. Sivun jäädessä lataamatta koko sovellus on pois
päältä, myös aamun kouluhälytykset. Yöllinen Windows Update tai lyhyt sähkökatko
riittäisi siihen.

Purku: `.\asenna-kioski.ps1 -Poista`

### Vielä käsin tehtävät asiat

Sama kummassakin asennustavassa:

1. **Automaattikirjautuminen**: `netplwiz` → poista rasti *"Käyttäjän on annettava
   käyttäjänimi ja salasana"*. Ilman tätä ajastetut tehtävät eivät käynnisty
   sähkökatkon jälkeen ennen kuin joku kirjautuu.

   Jos rastia ei näy `netplwiz`-ikkunassa lainkaan, Windows piilottaa sen
   salasanattoman kirjautumisen takia. Näytä se rekisteristä: `Win + R` →
   `regedit` → avaa
   `HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\PasswordLess\Device`
   → muuta arvon `DevicePasswordLessBuildVersion` tiedoksi `2` sijaan `0` →
   käynnistä kone uudelleen. Rasti ilmestyy sen jälkeen.

2. **Windows Update → aktiiviset tunnit** mahdollisimman laajaksi, ettei kone
   käynnisty uudelleen kesken päivän.
3. **Kokeile**: käynnistä kone uudelleen ja katso että näyttö palaa itsestään.

### Kioskista poistuminen

Selain ei voi purkaa omaa kioskitilaansa (JavaScript ei pääse siihen käsiksi),
joten poistuminen tapahtuu aina jommallakummalla näistä:

- **Kosketuksella, ilman näppäimistöä**: pidä sormea painettuna yläpalkin
  **päivämäärätekstin perässä noin 3 sekuntia** (ei ruudun nurkassa — se
  on tarkoituksella jätetty pois, koska nurkkaan osutaan helposti vahingossa
  pöytää pyyhittäessä tai näyttöä siirrettäessä). Alue on näkymätön eikä
  siinä ole mitään visuaalista vihjettä — tarkoituksella, jottei se erotu
  vahingossa kenellekään. Pitkä painallus valittiin yhden napautuksen sijaan
  siksi ettei se laukea vahingossa ruutua pyyhittäessä tai siihen
  nojattaessa. Painallus avaa vahvistusdialogin, joka kysyy **täysien
  oikeuksien koodin (`FULL_PIN`)** — `EDIT_PIN` ei riitä, koska kioskista
  poistuminen antaa pääsyn koko työpöydälle ja sitä kautta myös `.env`-
  tiedoston Wilma-salasanaan selväkielisenä, ei vain muistilistan/asetusten
  muokkaukseen. Jos `FULL_PIN`:iä ei ole asetettu (tai se on alle 6 merkkiä,
  ks. taulukko yllä), painike ei tee mitään — ominaisuus on tällöin
  kokonaan pois käytöstä. Oikean koodin jälkeen palvelin sulkee Edgen
  (`msedge.exe`-prosessin) ja työpöytä jää näkyviin.
- **Näppäimistöllä** (jos kytkettynä): `Ctrl+Alt+Del` tai `Alt+F4`.

**Käynnistä kioski takaisin** jommallakummalla tavalla:

1. **Käynnistä laite uudelleen.** Ajastetut tehtävät (`Infonaytto-palvelin`,
   `Infonaytto-naytto`) käynnistyvät automaattisesti kirjautumisen
   yhteydessä — tämä on varmin tapa.
2. **Ilman uudelleenkäynnistystä**: avaa Tehtävien ajastin
   (`Win + R` → `taskschd.msc`), etsi tehtävä **`Infonaytto-naytto`** ja
   valitse **Suorita**. Tämä avaa selaimen uudelleen — taustapalvelin ei
   sammunut, vain selain suljettiin, joten sen ei tarvitse odottaa
   uudelleenkäynnistystä.

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
  joten tietoturvapäivitysten saanti on epävarmaa.

Tämä on **tietoisesti hyväksytty riski**: laite on jo olemassa, joten kokeilu on
halpa. Siksi backend on tarkoituksella tavallinen Node-prosessi ilman
Windows-riippuvuuksia — jos Surface pettää tai halutaan siirtyä kestävämpään
laitteeseen, sama koodi ajetaan Raspberry Pi:llä sellaisenaan ja Surface (tai
mikä tahansa näyttö) jää pelkäksi selaimeksi. Vain tämän kansion skriptit ovat
Windows-kohtaisia.

## Tietoturva

- Wilma-datan lukureitit vastaavat vain **localhostista**. Kotiverkon puhelin
  näkee sään, sähkön, kalenterin ja muistilistan — ei lasten koulutietoja.
- Muokkaus muualta kuin näyttölaitteelta vaatii PIN-koodin, joka syötetään
  yläpalkin lukkokuvakkeesta. `EDIT_PIN` antaa muokkausoikeuden mutta **ei**
  lasten Wilma-tietoja; `FULL_PIN` (väh. 6 merkkiä) antaa nekin. Vaihtoehtona
  laite voidaan lisätä `TRUSTED_HOSTS`-listalle, jolloin koodia ei tarvita.
  Tarkemmin: README, kohta **Tietoturva**.
- **Kioskista poistuminen** (ks. yllä) vaatii nimenomaan `FULL_PIN`:n —
  `EDIT_PIN` ei riitä, ja pyyntö hyväksytään vain näyttölaitteelta itseltään,
  ei etänä TRUSTED_HOSTS-laitteelta tai FULL_PIN:llä varustetulta puhelimelta.
  Jos `FULL_PIN`:iä ei ole otettu käyttöön, ominaisuus on kokonaan pois
  käytöstä eikä pelkkä painallus päivämäärän kohdalla avaa mitään.
- Näyttö on yhteisessä tilassa: viestien sisällön voi piilottaa asetuksista,
  jolloin näkyy vain lähettäjä ja otsikko.
- **Tilin lukituksen esto**: kolme peräkkäistä epäonnistunutta Wilma-kirjautumista
  pysäyttää yritykset kokonaan. Jos vaihdat Wilma-salasanan, päivitä se `.env`-
  tiedostoon ja käynnistä palvelin uudelleen — muuten Wilma-kortti jää
  virhetilaan (mikä on tarkoitus, ei vika). Asennusskripti (`asenna.ps1`) tarjoaa
  yhteyden testausta asennuksen lopuksi juuri tästä syystä — se käyttää samaa
  "Testaa yhteys" -rajapintaa kuin asetusnäkymä eikä koskaan silmukoi
  yrityksiä, jottei se itse voi laukaista tätä lukitusta.
- Salasanoja, evästeitä eikä viestien sisältöjä kirjoiteta lokiin.
- **`.env`-tiedoston oikeudet** rajataan asentavaan käyttäjään (molemmat
  asennusskriptit tekevät tämän `.env`:lle — julkaisupaketin `asenna.ps1`
  `icacls`-komennoin, poistaen periytyvät oikeudet). Tiedosto sisältää Wilma-
  tilin salasanan selväkielisenä (ks. README:n Tietoturva-kohta) — tämä ei
  poista riskiä, mutta estää muita samalla koneella olevia käyttäjätilejä
  lukemasta sitä.

## Ylläpito

Wilma-integraatio nojaa epäviralliseen kirjastoon, joka lukee Wilman
HTML-sivuja. Koulun Wilma-päivitys voi rikkoa sen ilman varoitusta. Siksi
kirjaston versio on naulattu tarkkaan (`@wilm-ai/wilma-client@1.4.2`).

Kun kortti lakkaa toimimasta:

1. Katso `data\logs\` — etsi rivi `wilma_empty_parse`. Se tarkoittaa että sivu
   haettiin onnistuneesti mutta siitä ei saatu irti mitään, eli rakenne muuttui.
2. Aja `LOG_LEVEL=debug` ja katso `data\snapshots\` — siellä on raaka HTML.
3. Tarkista onko kirjastosta uudempi versio, lue sen muutosloki, nosta versio ja
   aja `npm test`. (Julkaisupaketin käyttäjä: tämä vaatii kehityskopion —
   päivitys tulee uuden julkaisupaketin mukana.)

Näyttö jatkaa sillä välin viimeisimmän onnistuneen datan näyttämistä
vanhentuneena, joten aamun lukujärjestys ei katoa heti.
