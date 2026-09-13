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

## Käyttörajoitukset

Automaattiseen hakuun tarvitaan tuetun yhtiön olemassa olevat asiointitunnukset ja oikean kohteen valinta. Osoite yksin ei riitä henkilökohtaisen aikataulun lukemiseen. Sovellus ei tee tilauksia, muuta tyhjennysvälejä tai hyväksy uusia asiointiehtoja käyttäjän puolesta. Manuaaliset aikataulut säilyvät varatilana. Niiden toistoväli ei huomioi pyhäpäiväsiirtoja automaattisesti.

Uusi yhtiö merkitään automaattisesti tuetuksi vasta sen julkisen asioinnin yhteensopivuuden tarkistamisen ja sovittimen testien jälkeen. Samannäköinen verkkopalvelu tai Vingo-tuotenimi ei yksin riitä.
