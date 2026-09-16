# Jätehuollon lähteet

Tarkistettu 13.9.2026. Kuntaluettelo on palveluntarjoajan ehdotus, ei osoitekohtainen tyhjennyskalenteri. Kiinteistön kuljettaja voi riippua jätelajista, kuljetusjärjestelmästä ja omasta sopimuksesta. Sovellus ei päättele tyhjennyspäiviä paikkakunnasta.

## Kunnat ja yhtiöt

Lähde: [Suomen Kiertovoima KIVO, jäsenistö](https://www.kivo.fi/tietoa-meista/jasenisto). Paikallinen hakemisto sisältää sivun 33 kuntien jätelaitosta ja niiden 262 yksilöllistä kuntanimeä sekä erillisen muun yhtiön valinnan. Päällekkäiset jäsenkunnat säilytetään: esimerkiksi Sastamala on sekä Loimi-Hämeen että Pirkanmaan luettelossa. Hakemisto ei väitä kattavansa kaikkia Suomen yksityisiä kuljettajia eikä kaikkia kuntia. Muu yhtiö / oma aikataulu mahdollistaa manuaalisen käytön kaikkialla.

Kunnan valinta ehdottaa yhtiötä. Se ei todista, että yhtiö tyhjentää juuri kyseisen kiinteistön kaikkia astioita. Yhtiön voi valita itse. Yhtiö, jonka adapter on manual, on hakemistossa mukana mutta automaattista aikatauluhakua ei vielä tueta. Sen omasta verkkopalvelusta tarkistetut päivät voi syöttää käsin.

## Automaattisen haun julkisesti tarkistetut palvelut

| Yhtiö | Virallinen linkkilähde | Asioinnin perusosoite |
| --- | --- | --- |
| Sammakkokangas | [Sammakkokangas](https://www.sammakkokangas.fi/) | https://asiointi.sammakkokangas.fi/sammakkokangas |
| Puhas | [Asiakaspalvelu](https://www.puhas.fi/asiointi/asiakaspalvelu.html) | https://www.asiointipuhas.fi/puhas |
| Lakeuden Etappi | [Tilattavat palvelut ja tuotteet](https://www.etappi.com/palvelut/tilattavat-palvelut-ja-tuotteet/) | https://omaetappi.com/etappi |

Kaikkien kolmen julkisesta selainohjelmasta tarkistettiin sama Vingo Asioinnin rajapintasopimus. Perusosoitteen alla olevat julkiset tiedostot ovat js/sahas/login.js, js/sahas/application.js, js/sahas/tabs/service-list.js ja js/sahas/windows/collection-schedule-window.js. Ne käyttävät kirjautumista j_acegi_security_check?target=2 kentillä j_username ja j_password, asiakashakua secure/get_customer_datas.do, palveluhakua secure/get_services_by_customer_numbers.do ja aikatauluhakua get_collection_schedule.do. Aikataulun asiakastunniste tulee valitun palvelun id.ASTAsnro-kentästä.

Tarkistus tehtiin julkisilla GET-pyynnöillä ilman asiakastunnuksia tai kirjautumisyrityksiä. Yhteensopiva julkinen selainohjelma ei yksin takaa jokaisen asiakastilin toimintaa; oikean kiinteistön onnistunut haku varmistuu vasta käyttäjän omilla tunnuksilla. Palvelut eivät ole dokumentoituja vakaita julkisia API-rajapintoja, joten muutokset voivat vaatia sovittimen päivityksen.

## Kirjautumisten rajoittaminen

Asiointitunnus on sama jolla huoltaja itse asioi, ja liian monta hylättyä kirjautumista lukitsee sen. Siksi vain yhtiön hylkäämä kirjautuminen (HTTP 401 tai kirjautumisvastauksen `response != OK`) pysäyttää haun ja kehottaa tarkistamaan tunnukset. Huoltosivu (HTTP 200 + `text/html`), suojamuurin 403, muu HTTP-virhe ja katkennut verkko ovat palveluhäiriöitä: ne eivät koskaan merkitse tunnuksia hylätyiksi eivätkä koskaan kehota tarkistamaan niitä.

Hylkäyksen jälkeen `blocked` pysäyttää automaattisen haun kokonaan, ja kiinteistöhaku sallii yhden yrityksen puolen tunnin välein. Kiinteistöhaku on tarkoituksella myös ainoa tapa purkaa lukitustila ilman tunnusten syöttämistä uudelleen: onnistunut haku nollaa sekä `blocked`in että providerin katkaisijan. Yritysten väli tallennetaan kantaan (`waste.login-attempt`), joten palvelimen uudelleenkäynnistys ei anna uutta yritystä.

Mitatut luvut (server/test/waste-lockout.ts) väärillä tunnuksilla: 60 kertaa painettu "Hae kiinteistöt" tuottaa 2 kirjautumista tunnissa, tunnin automaattihaku 1, ja kuusi käynnistystä 1,4 sekunnissa yhden. Yhtiön huoltokatkossa käsin haettaessa raja on yksi yritys minuutissa — häiriötä ei jäähdytetä, koska tili ei ole vaarassa eikä toipumisen tietä saa sulkea.

Tunnukset salataan levylle avaimella, joka on omassa tiedostossaan tietokannan vieressä (`data/infonaytto.db.waste-key`). Jos avain katoaa tai vaihtuu, tallennettuja tunnuksia ei voi purkaa; asetusnäkymä kertoo sen erikseen (`keyMissing`) eikä väitä tunnusten olevan tallessa.

## Käyttörajoitukset

Automaattiseen hakuun tarvitaan tuetun yhtiön olemassa olevat asiointitunnukset ja oikean kohteen valinta. Osoite yksin ei riitä henkilökohtaisen aikataulun lukemiseen. Sovellus ei tee tilauksia, muuta tyhjennysvälejä tai hyväksy uusia asiointiehtoja käyttäjän puolesta. Manuaaliset aikataulut säilyvät varatilana. Niiden toistoväli ei huomioi pyhäpäiväsiirtoja automaattisesti.

Uusi yhtiö merkitään automaattisesti tuetuksi vasta sen julkisen asioinnin yhteensopivuuden tarkistamisen ja sovittimen testien jälkeen. Samannäköinen verkkopalvelu tai Vingo-tuotenimi ei yksin riitä.
