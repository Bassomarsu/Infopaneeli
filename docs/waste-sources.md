# Jätehuollon lähteet

Tarkistettu 13.9.2026 (Sammakkokankaan liitäntä 14.10.2026). Kuntaluettelo on palveluntarjoajan ehdotus, ei osoitekohtainen tyhjennyskalenteri. Kiinteistön kuljettaja voi riippua jätelajista, kuljetusjärjestelmästä ja omasta sopimuksesta. Sovellus ei päättele tyhjennyspäiviä paikkakunnasta.

## Kunnat ja yhtiöt

Lähde: [Suomen Kiertovoima KIVO, jäsenistö](https://www.kivo.fi/tietoa-meista/jasenisto). Paikallinen hakemisto sisältää sivun 33 kuntien jätelaitosta ja niiden 262 yksilöllistä kuntanimeä sekä erillisen muun yhtiön valinnan. Päällekkäiset jäsenkunnat säilytetään: esimerkiksi Sastamala on sekä Loimi-Hämeen että Pirkanmaan luettelossa. Hakemisto ei väitä kattavansa kaikkia Suomen yksityisiä kuljettajia eikä kaikkia kuntia. Muu yhtiö / oma aikataulu mahdollistaa manuaalisen käytön kaikkialla.

Kunnan valinta ehdottaa yhtiötä. Se ei todista, että yhtiö tyhjentää juuri kyseisen kiinteistön kaikkia astioita. Yhtiön voi valita itse. Yhtiö, jonka adapter on manual, on hakemistossa mukana mutta automaattista aikatauluhakua ei vielä tueta. Sen omasta verkkopalvelusta tarkistetut päivät voi syöttää käsin.

## Automaattisen haun julkisesti tarkistetut palvelut

| Yhtiö | Virallinen linkkilähde | Alusta | Asioinnin perusosoite |
| --- | --- | --- | --- |
| Sammakkokangas | [Sammakkokangas](https://www.sammakkokangas.fi/) | Vingo 2.0 (`vingo2`) | https://asiointi.sammakkokangas.fi/api/customers |
| Puhas | [Asiakaspalvelu](https://www.puhas.fi/asiointi/asiakaspalvelu.html) | vanha Vingo (`vingo`) | https://www.asiointipuhas.fi/puhas |
| Lakeuden Etappi | [Tilattavat palvelut ja tuotteet](https://www.etappi.com/palvelut/tilattavat-palvelut-ja-tuotteet/) | vanha Vingo (`vingo`) | https://omaetappi.com/etappi |

### Vanha Vingo-asiointi (Puhas, Etappi)

Molempien julkisesta selainohjelmasta tarkistettiin sama Vingo Asioinnin rajapintasopimus (Sammakkokangas oli samalla alustalla 12.9.2026 asti). Perusosoitteen alla olevat julkiset tiedostot ovat js/sahas/login.js, js/sahas/application.js, js/sahas/tabs/service-list.js ja js/sahas/windows/collection-schedule-window.js. Ne käyttävät kirjautumista j_acegi_security_check?target=2 kentillä j_username ja j_password, asiakashakua secure/get_customer_datas.do, palveluhakua secure/get_services_by_customer_numbers.do ja aikatauluhakua get_collection_schedule.do. Aikataulun asiakastunniste tulee valitun palvelun id.ASTAsnro-kentästä.

Puhas ja Etappi olivat yhä vanhalla alustalla 14.10.2026. Sovitin on `server/src/integrations/waste-vingo.ts`.

Tarkistus tehtiin julkisilla GET-pyynnöillä ilman asiakastunnuksia tai kirjautumisyrityksiä. Yhteensopiva julkinen selainohjelma ei yksin takaa jokaisen asiakastilin toimintaa; oikean kiinteistön onnistunut haku varmistuu vasta käyttäjän omilla tunnuksilla. Palvelut eivät ole dokumentoituja vakaita julkisia API-rajapintoja, joten muutokset voivat vaatia sovittimen päivityksen.

### Vingo 2.0 (Sammakkokangas)

Sammakkokangas vaihtoi portaalinsa vanhasta Vingo-asioinnista uuteen React-sovellukseen 12.9.2026 mennessä. Vanha osoite `https://asiointi.sammakkokangas.fi/sammakkokangas/...` palauttaa nyt kaikkeen uuden sovelluksen HTML:n koodilla 200, joten vanha sovitin ei voi toimia sitä vasten. Uusi sovitin on `server/src/integrations/waste-vingo2.ts`, ja sen rajapinta mitattiin 14.10.2026 oikeilla tunnuksilla (yksi kirjautuminen ja GET-pyynnöt; väärillä tunnuksilla ei kokeiltu).

Ajonaikainen konfiguraatio luetaan portaalin sivulta `https://asiointi.sammakkokangas.fi/e-services/sammakkokangas/`: `REACT_APP_API_URL` = `https://asiointi.sammakkokangas.fi/api/customers` ja `REACT_APP_TENANT_ID` = `5429b74b-d22b-48b2-8c77-8d10bfd91c94`. Ne ovat `waste-companies.json`issa kentissä `apiUrl` ja `tenantId`.

| Tarkoitus | Pyyntö |
| --- | --- |
| Kirjautuminen | `POST {api}/Users/login`, otsakkeet `Content-Type: application/json;charset=utf-8`, `Accept-Language: fi-FI, fi`, `Tenant-Id`; runko `{"userName","password"}`; vastaus `{"token","expiresAt"}` (voimassa noin tunnin) |
| Kiinteistöt | `GET {api}/Customers/emptying-infos` (kentät `id`, `address.street/postalCode/postOffice`, `contractEndDate`) |
| Sopimukset ja astiat | `GET {api}/Customers/emptying-infos/{id}/contracts` (`customerId`, `position`, `name`, `nextEmptying`, `emptyingIntervals`, `endDate`) |
| Sopimuksen tiedot | `GET {api}/Customers/contracts/{customerId}/{position}` (`allEmptyings.Planned`) |

Tunnistautuneet pyynnöt kantavat otsaketta `Authorization: Vingo-e-services <token>`; portaali ei lähetä niissä `Tenant-Id`:tä, eikä sovitinkaan. Sovitin tekee vain kirjautumisen POSTin ja nämä GET-pyynnöt. Portaalin muut polut (tilaukset, keskeytykset, ehdot jne.) ovat kiellettyjä.

Tapahtumat johdetaan näin:

- Haetaan vain sopimukset, joilla `nextEmptying` ei ole null (maksurivit kuten PERUSMAKSU eivät ole astioita) ja jotka eivät ole päättyneet. Muille ei tehdä tietopyyntöä.
- Päivät ovat tulevat (tänään Helsingin aikaa tai myöhemmin) `Planned`-päivät sekä `nextEmptying`, korkeintaan 92 vuorokauden päässä ja enintään 6 per astia. `nextEmptying` otetaan aina mukaan. Päivät yhdistetään päivittäin astiaa kohden.
- `Planned`-ajat ovat UTC-hetkiä Helsingin keskiyöstä (`2026-10-26T22:00:00Z` on 27.10.2026, `2027-08-02T21:00:00Z` on 3.8.2027), ja ne muunnetaan Helsingin kalenteripäiväksi `Intl`-rajapinnalla. `nextEmptying` on vyöhykkeetön ja luetaan sellaisenaan paikalliseksi päiväksi. `Planned`-lista sisältää myös menneitä päiviä (vuodesta 2023), jotka suodatetaan pois.
- Päivää ei merkitä arvioksi (`approximate`): portaali esittää `nextEmptying`in ilman ±-merkintää ja `Planned`-päivät sopimuksen kalenterissa. Mitatuista kahdeksasta viimeisestä toteutuneesta tyhjennyksestä jokainen osui täsmälleen `Planned`-päivälle.
- Tyhjennysväli (`intervalText`) johdetaan `emptyingIntervals`ista samoin sanoin kuin vanhalla sovittimella ("4 viikon välein"); väli 0 tarkoittaa tilauksesta tyhjennettävää eikä tuota tekstiä.
- Jos `nextEmptying` eroaa `Planned`-listasta (esim. arkipyhäsiirto), `nextEmptying` on ajantasaisempi: sen ±3 vuorokauden sisällä olevat `Planned`-päivät jätetään pois, jottei samalle astialle tule kahta lähekkäistä päivää. `Planned`-aika ilman Z-merkintää tai offsetia hylätään (ei arvata paikalliseksi).
- Keskeytyksiä (`pausedFrom/To`, `locationInterruptDate`) ei ole mitattu, eikä sovitin huomioi niitä.
- Jos yhden astian tietopyyntö epäonnistuu, sen `nextEmptying` riittää varapäiväksi eikä virhe kaada muita astioita. Kelvoton päivämäärä tai rivi pilaa vain oman solunsa; kelvoton `endDate` ei pudota astiaa. Epäonnistuneista tietopyynnöistä kirjataan yksi `waste_vingo2_details_failed`-varoitus per haku.

Kiinteistön tunniste on `vingo2:<asiakasnumero>` (URL-koodattuna), esimerkiksi `vingo2:06-0001234-00`. Vanhan sovittimen tallentama `vingo:`-tunniste ei kelpaa uudelle, ja sellaisen haku antaa virheen "Valitse kohde uudelleen". Päättyneet kohteet (`contractEndDate` menneisyydessä) jätetään kiinteistöluettelosta pois.

Testin fixturet ovat `server/test/fixtures/vingo2/` (henkilötiedot vaihdettu), ja sovittimen testi on `server/test/waste-vingo2.ts`.

## Kirjautumisten rajoittaminen

Asiointitunnus on sama jolla huoltaja itse asioi, ja liian monta hylättyä kirjautumista lukitsee sen. Siksi vain yhtiön hylkäämä kirjautuminen (vanhalla alustalla HTTP 401 tai kirjautumisvastauksen `response != OK`, Vingo 2.0:ssa kirjautumisen HTTP 401 tai 400) pysäyttää haun ja kehottaa tarkistamaan tunnukset. Huoltosivu (HTTP 200 + `text/html`), suojamuurin 403, muu HTTP-virhe ja katkennut verkko ovat palveluhäiriöitä: ne eivät koskaan merkitse tunnuksia hylätyiksi eivätkä koskaan kehota tarkistamaan niitä.

Hylkäyksen jälkeen `blocked` pysäyttää automaattisen haun kokonaan, ja kiinteistöhaku sallii yhden yrityksen puolen tunnin välein. Kiinteistöhaku on tarkoituksella myös ainoa tapa purkaa lukitustila ilman tunnusten syöttämistä uudelleen: onnistunut haku nollaa sekä `blocked`in että providerin katkaisijan. Yritysten väli tallennetaan kantaan (`waste.login-attempt`), joten palvelimen uudelleenkäynnistys ei anna uutta yritystä.

Vingo 2.0:n hylätyn kirjautumisen statusta ei ole mitattu, koska väärillä tunnuksilla ei kokeilla. Sovitin lukee hylkäykseksi 400:n ja 401:n sekä muun 4xx-vastauksen (403, 404, 422, 423 jne.) kun vastaus on JSONia, lukuun ottamatta 408:aa ja 429:ää. HTML-vastaus on aina palveluhäiriö. Hylkäyksen viestissä on HTTP-status ja problem-JSONin lyhyt `title`; 400:lle lisäksi maininta, että rajapinta on voinut muuttua. Rungon muuta sisältöä, salasanaa tai tokenia ei kirjata eikä näytetä. Syy on, että se on tilin kannalta turvallisempi suunta: väärä "tunnukset hylätty" pysäyttää haun, kun taas väärä "palveluhäiriö" jatkaisi kirjautumista samoilla väärillä tunnuksilla. HTML-vastaus, 403, 429, uudelleenohjaus ja 5xx ovat palveluhäiriöitä myös kirjautumisessa. Tunnistautuneen pyynnön 401 ei ole tunnusvirhe (kirjautuminen onnistui hetkeä aiemmin): token unohdetaan ja seuraava haku kirjautuu uudelleen, enintään kaksi kirjautumista per asiakasolio. Jos hylätty token on alle 5 minuuttia vanha, vika on pysyvä eikä uutta kirjautumista yritetä (asiakasolio palauttaa palveluhäiriön, kunnes `waste-service` luo uuden). `expiresAt` luetaan UTC:ksi (vyöhykkeetön aika myös), ja jos token näyttää heti vanhentuneelta, oletetaan 15 minuutin elinikä.

Mitatut luvut (server/test/waste-lockout.ts) väärillä tunnuksilla: 60 kertaa painettu "Hae kiinteistöt" tuottaa 2 kirjautumista tunnissa, tunnin automaattihaku 1, ja kuusi käynnistystä 1,4 sekunnissa yhden. Yhtiön huoltokatkossa käsin haettaessa raja on yksi yritys minuutissa — häiriötä ei jäähdytetä, koska tili ei ole vaarassa eikä toipumisen tietä saa sulkea.

Tunnukset salataan levylle avaimella, joka on omassa tiedostossaan tietokannan vieressä (`data/infonaytto.db.waste-key`). Jos avain katoaa tai vaihtuu, tallennettuja tunnuksia ei voi purkaa; asetusnäkymä kertoo sen erikseen (`keyMissing`) eikä väitä tunnusten olevan tallessa.

## Käyttörajoitukset

Automaattiseen hakuun tarvitaan tuetun yhtiön olemassa olevat asiointitunnukset ja oikean kohteen valinta. Osoite yksin ei riitä henkilökohtaisen aikataulun lukemiseen. Sovellus ei tee tilauksia, muuta tyhjennysvälejä tai hyväksy uusia asiointiehtoja käyttäjän puolesta. Manuaaliset aikataulut säilyvät varatilana. Niiden toistoväli ei huomioi pyhäpäiväsiirtoja automaattisesti.

Uusi yhtiö merkitään automaattisesti tuetuksi vasta sen julkisen asioinnin yhteensopivuuden tarkistamisen ja sovittimen testien jälkeen. Samannäköinen verkkopalvelu tai Vingo-tuotenimi ei yksin riitä.
