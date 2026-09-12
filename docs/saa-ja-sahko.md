# Sää ja sähkö — sijainti, aineistot ja muunnokset

Mistä sääkortin sijainti tulee ja mistä sähkön kuukausikeskiarvot, sekä miksi.
Yleiskuva on [README](../README.md):ssä.

## Sään sijainti postinumerolla

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

### Aineiston alkuperä ja lisenssi

Postinumeroaineisto: GeoNames (https://www.geonames.org/), lisenssi CC BY 4.0
(https://creativecommons.org/licenses/by/4.0/). Ahvenanmaan postinumeroalueiden
keskipisteet: Tilastokeskus, Paavo-postinumeroalueittainen avoin tieto, lisenssi
CC BY 4.0. Aineistoja on muokattu: mukaan on otettu vain postinumero, paikannimi
ja koordinaatit.

Kaksi lähdettä siksi, ettei kumpikaan yksin riitä: GeoNamesista **puuttuu koko
Ahvenanmaa** (22xxx), ja Paavo antaa aluenimiä ("Karstula Keskus") eikä
postitoimipaikkoja. Paavoa käytetään siis vain paikkaamaan GeoNamesin aukko.

## Kuukausikeskiarvot tulevat eri lähteestä kuin vuorokausihinnat

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
