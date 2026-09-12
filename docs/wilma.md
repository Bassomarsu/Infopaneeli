# Wilma — kysely, katkaisija ja todennetut havainnot

Wilma-integraation ratkaisut ja niiden perustelut. Yleiskuva on
[README](../README.md):ssä.

## Tilin lukituksen esto

Wilman kirjautumisvirheet ovat *fataaleja*: kolmen peräkkäisen jälkeen
katkaisija menee kiinni eikä uusia yrityksiä tehdä välittömästi. Väärällä
salasanalla silmukassa hakkaaminen olisi nopein tapa lukita koko perheen
Wilma-tili. Tämä on testattu (`npm test`).

Katkaisija ei jää kiinni pysyvästi uudelleenkäynnistykseen asti — seinänäyttöä
ei valvo kukaan, joten lukossa pysyminen tarkoittaisi kuollutta korttia
päiväkausiksi. Sen sijaan se **jäähtyy**: 30 minuutin kuluttua tehdään yksi
koeyritys, ja jos sekin epäonnistuu, jäähdytys kaksinkertaistuu (60 min,
120 min, …) 4 tunnin kattoon asti. Onnistunut koeyritys nollaa katkaisijan
täysin — laskurit, jäähdytyksen ja tilan.

Myös kirjautumisen verkkovirhe ja uudelleenohjaussilmukka lasketaan
kirjautumisvirheeksi. Näin tyhjä istuntovälimuisti ei aiheuta uutta
kirjautumiskierrosta jokaisella tavallisella hakuvuorolla koko katkon ajan.

Rajoitus koskee **hakukierroksia**, ei yksittäisiä HTTP-pyyntöjä: yksi kierros
voi sisältää oppilaslistan kirjautumisen ja erillisen kirjautumisen kullekin
lapselle, ja kirjasto voi lisäksi uusia kirjautumisen sisäisesti.

Jäähdytys ja Wilman hiljaiset tunnit (23–05) eivät kertaannu: hiljaisiin
tunteihin osuva koeyritys odottaa vain seuraavaa aktiivista kierrosta, kuten
mikä tahansa muukin haku — jäähdytyksen laskuri ei ala uudelleen sen takia.

## Testaa yhteys — manuaalinen ohitus

Neljän tunnin jäähdytys on pitkä aika katsoa kuollutta korttia silloin kun syy
on jo korjattu (salasana vaihdettu takaisin, verkko palannut). Asetusten
**Wilma-yhteys → Testaa yhteys** ohittaa jäähdytyksen, pudottaa vanhan istunnon
ja yrittää heti uudella kirjautumisella. Onnistuminen nollaa katkaisijan
täysin; epäonnistuminen säilyttää automaattisen katkaisijan laskurit ja
jäähdytyksen. Jos automaattinen hakuvuoro osuu manuaalitestin ajalle, haku
siirtyy seuraavaan vuoroon.

> **Järjestys on: korjaa `.env` → käynnistä palvelin uudelleen → vasta sitten
> Testaa yhteys.** `.env` luetaan vain prosessin käynnistyessä (`--env-file`,
> ks. `server/package.json`), joten ajossa oleva palvelin käyttää yhä
> käynnistyshetken salasanaa. Muuten testi yrittäisi samalla vanhalla
> salasanalla ja kuluttaisi yhden yrityksen turhaan.

Painike vaatii `EDIT_PIN`in, ei `FULL_PIN`iä: se ei paljasta Wilma-dataa, vain
sen onnistuiko haku. **Rajoitin on palvelimella**, ei käyttöliittymässä —
selainpuolinen esto katoaisi sivun päivityksellä. Se koskee Wilma-tiliä
kokonaisuutena, ei yhtä laitetta kerrallaan.

Rajat ovat **5 min per yritys** ja **12 yritystä vuorokaudessa**. Pelkkä viiden
minuutin väli sallisi 288 yritystä vuorokaudessa, ja kosketusnäyttö on koko
perheen ulottuvilla — vuorokausikatto on se, mikä estää napista tulemasta
hakkausvektoria. 12 riittää silti tunnin yhtäjaksoiseen vianetsintään.

## Istunnon uusiminen

Yksittäinen haun HTTP-virhe ei pudota istuntoa. Kahden peräkkäisen
epäonnistumisen jälkeen istunto uusitaan kerran saman häiriöjakson aikana, joten
pitkittyvä häiriö ei aiheuta kirjautumista jokaisella kierroksella. Onnistunut
haku nollaa laskurin.

Yli 90 minuutin tauko hakuyrityksissä pudottaa istunnon ennen seuraavaa hakua.
Tämä kattaa yön hiljaiset tunnit myös silloin, kun illalla luotu istunto ei
ehtinyt palauttaa tietoja ennen yötä. Aikakatkaisun jälkeen valmistuva vanha
kirjautuminen ei saa korvata uuden kierroksen istuntoa. Uusimisen syy kirjataan
lokiin, ja virheen sisempi syy (esimerkiksi `redirect count exceeded`) näytetään
kortissa pelkän `fetch failed` -tekstin lisäksi.

## Wilman kysely on niukkaa

- Kuluva viikko haetaan yhdellä kutsulla per lapsi. Seuraavaa viikkoa kysytään
  vain jos kuluvassa ei ole mitään tämän päivän jälkeen, ja silloinkin
  korkeintaan kuuden tunnin välein — muuten viikonloput ja kesäloma tarkoittaisivat
  turhaa kutsua joka 20. minuutti viikkokausia.
- Viestin lähettäjä ja luettu-tila eivät ole listauksessa lainkaan, vaan vain
  viestin omissa tiedoissa. Ne haetaan kerran per viesti ja kannetaan eteenpäin;
  vielä lukemattomat tarkistetaan uudelleen korkeintaan tunnin välein ja
  korkeintaan kolme per kierros.

## Mitä oikeasta Wilmasta on todennettu (7.8.2026)

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

## Luettu-tilaa ei ole saatavilla — todennettu, ei arvattu

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

**Migraatio ottaa varmuuskopion.** Ensimmäisellä käynnistyksellä vanha yhden
lähteen taulu muunnetaan uuteen muotoon, ja sitä ennen kanta kopioidaan
tiedostoon `data/infonaytto-ennen-viestilahteita.db`. Kopio on olemassa yhtä
tarkoitusta varten: **vanhaan julkaisuun palataan palauttamalla se**. Vanha
koodi ei osaa lukea uutta taulua, ja koska `data/` säilyy julkaisupaketin
päivityksessä, ilman kopiota rollback tarkoittaisi palvelinta joka ei käynnisty
lainkaan. Migraatio on idempotentti eikä kopioi mitään, jos muunnosta ei tarvita.

"Merkitse kaikki luetuiksi" merkitsee valitun lähteen **kaikki** lukemattomat,
ei vain listalla näkyviä — siksi painike kertoo lukumäärän. Teko on
peruuttamaton: kumoamisreittiä ei ole.

## Ylläpito: kun Wilma-kortti lakkaa toimimasta

Wilma-integraatio nojaa epäviralliseen kirjastoon, joka lukee Wilman
HTML-sivuja. Koulun Wilma-päivitys voi rikkoa sen ilman varoitusta. Siksi
kirjaston versio on naulattu tarkkaan (`@wilm-ai/wilma-client@1.4.2`).

1. Etsi lokista rivi `wilma_empty_parse`. Se tarkoittaa että sivu haettiin
   onnistuneesti mutta siitä ei saatu irti mitään, eli rakenne muuttui.
2. Aja `LOG_LEVEL=debug` ja katso `data/snapshots/` — siellä on raaka HTML.
3. Tarkista onko kirjastosta uudempi versio, lue sen muutosloki, nosta versio,
   aja `npm test` ja `npm run test:smoke`, ja kokoa uusi julkaisupaketti.

Näyttö jatkaa sillä välin viimeisimmän onnistuneen datan näyttämistä
vanhentuneena, joten aamun lukujärjestys ei katoa heti. Laitteella olevaa
asennusta ei siis tarvitse korjata kiireellä — korjaus tulee uuden
julkaisupaketin mukana.
