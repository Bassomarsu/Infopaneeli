# Käyttöönotto Surface Pro 4:llä

## 1. Esivalmistelut

Asenna **Node.js 24 tai uudempi** ([nodejs.org](https://nodejs.org)). Tarkista:

```powershell
node --version    # v24.x tai uudempi
```

## 2. Projektin asennus

```powershell
cd G:\Atorcom\VS_code_projektit\Infonäyttö
npm install
copy .env.example .env
notepad .env      # täytä Wilma-tunnukset ja kalenterin ICS-osoite
npm run build
```

### Mitä `.env`-tiedostoon

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

## 3. Kokeile ensin käsin

```powershell
npm start
```

Avaa selaimessa `http://localhost:4173`. Tarkista että kortit täyttyvät.
Jos jokin kortti näyttää virhettä, katso `data\logs\`.

Vianetsintään yksityiskohtaisempi loki:

```powershell
$env:LOG_LEVEL = "debug"; npm start
```

## 4. Automaattikäynnistys ja kioskitila

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

### Vielä käsin

1. **Automaattikirjautuminen**: `netplwiz` → poista rasti *"Käyttäjän on annettava
   käyttäjänimi ja salasana"*. Ilman tätä ajastetut tehtävät eivät käynnisty
   sähkökatkon jälkeen ennen kuin joku kirjautuu.
2. **Windows Update → aktiiviset tunnit** mahdollisimman laajaksi, ettei kone
   käynnisty uudelleen kesken päivän.
3. **Kokeile**: käynnistä kone uudelleen ja katso että näyttö palaa itsestään.

Kioskitilasta pääsee pois `Ctrl+Alt+Del` tai `Alt+F4`.

## 5. Laiteriski — lue tämä

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

## 6. Tietoturva

- Wilma-datan lukureitit vastaavat vain **localhostista**. Kotiverkon puhelin
  näkee sään, sähkön, kalenterin ja muistilistan — ei lasten koulutietoja.
- Muokkaus muualta kuin näyttölaitteelta vaatii PIN-koodin, joka syötetään
  yläpalkin lukkokuvakkeesta. `EDIT_PIN` antaa muokkausoikeuden mutta **ei**
  lasten Wilma-tietoja; `FULL_PIN` (väh. 6 merkkiä) antaa nekin. Vaihtoehtona
  laite voidaan lisätä `TRUSTED_HOSTS`-listalle, jolloin koodia ei tarvita.
  Tarkemmin: README, kohta **Tietoturva**.
- Näyttö on yhteisessä tilassa: viestien sisällön voi piilottaa asetuksista,
  jolloin näkyy vain lähettäjä ja otsikko.
- **Tilin lukituksen esto**: kolme peräkkäistä epäonnistunutta Wilma-kirjautumista
  pysäyttää yritykset kokonaan. Jos vaihdat Wilma-salasanan, päivitä se `.env`-
  tiedostoon ja käynnistä palvelin uudelleen — muuten Wilma-kortti jää
  virhetilaan (mikä on tarkoitus, ei vika).
- Salasanoja, evästeitä eikä viestien sisältöjä kirjoiteta lokiin.

## 7. Ylläpito

Wilma-integraatio nojaa epäviralliseen kirjastoon, joka lukee Wilman
HTML-sivuja. Koulun Wilma-päivitys voi rikkoa sen ilman varoitusta. Siksi
kirjaston versio on naulattu tarkkaan (`@wilm-ai/wilma-client@1.4.2`).

Kun kortti lakkaa toimimasta:

1. Katso `data\logs\` — etsi rivi `wilma_empty_parse`. Se tarkoittaa että sivu
   haettiin onnistuneesti mutta siitä ei saatu irti mitään, eli rakenne muuttui.
2. Aja `LOG_LEVEL=debug` ja katso `data\snapshots\` — siellä on raaka HTML.
3. Tarkista onko kirjastosta uudempi versio, lue sen muutosloki, nosta versio ja
   aja `npm test`.

Näyttö jatkaa sillä välin viimeisimmän onnistuneen datan näyttämistä
vanhentuneena, joten aamun lukujärjestys ei katoa heti.
