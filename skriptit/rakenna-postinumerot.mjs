/**
 * Rakentaa suomalaisten postinumeroiden hakutaulun sään sijaintia varten.
 *
 * Kaksi lahdetta, koska kumpikaan ei yksin riita:
 *   - GeoNames FI (CC BY 4.0): 3576 postinumeroa nimineen ja koordinaatteineen,
 *     mutta AHVENANMAA PUUTTUU kokonaan (22xxx). Todennettu: 22100 ei loydy.
 *   - Tilastokeskuksen Paavo (CC BY 4.0): kattaa Ahvenanmaan, mutta antaa
 *     aluenimia ("Karstula Keskus") eika postitoimipaikkoja, joten sita
 *     kaytetaan VAIN paikkaamaan GeoNamesin aukko -- seka kertomaan MILLA
 *     postinumerolla on oikea maantieteellinen alue (ks. sovellaKorjauslista).
 *
 * Ahvenanmaan nimet tulevat Paavon SUOMENKIELISESTA nimikentasta, joten
 * 22100 on taulussa "Maarianhamina" eika postin kayttama "Mariehamn". Kaytto-
 * liittyma on suomenkielinen, joten se on tassa oikea valinta -- mutta se on
 * tietoinen valinta eika aineiston virhe, ja kannattaa muistaa jos joku
 * ihmettelee miksi haku nayttaa eri nimen kuin postin oma hakupalvelu.
 *
 * Ajetaan kasin kun aineisto halutaan paivittaa -- postinumerot muuttuvat noin
 * 0,2 % vuodessa. Loppukayttaja ei aja tata koskaan.
 *
 * --- Attribuutio (CC BY 4.0 edellyttaa) ---------------------------------
 * Postinumeroaineisto: GeoNames (https://www.geonames.org/), lisenssi CC BY 4.0
 * (https://creativecommons.org/licenses/by/4.0/). Ahvenanmaan postinumeroalueiden
 * keskipisteet: Tilastokeskus, Paavo-postinumeroalueittainen avoin tieto, lisenssi
 * CC BY 4.0. Aineistoja on muokattu: mukaan on otettu vain postinumero, paikannimi
 * ja koordinaatit.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const OUT = process.argv[2];
if (!OUT) {
  console.error("kaytto: node rakenna-postinumerot.mjs <ulostulo.json>");
  process.exit(2);
}

const GEONAMES_ZIP = "https://download.geonames.org/export/zip/FI.zip";
const PAAVO_WFS_PERUSTA =
  "https://geo.stat.fi/geoserver/postialue/wfs?service=WFS&version=2.0.0&request=GetFeature" +
  "&typeName=postialue:pno_2026&outputFormat=application/json&srsName=EPSG:4326";

/** Ahvenanmaa: geometria mukana, koska naista lasketaan keskipisteet. */
const PAAVO_WFS_AHVENANMAA =
  PAAVO_WFS_PERUSTA + "&CQL_FILTER=" + encodeURIComponent("posti_alue LIKE '22%'");

/**
 * Koko maa, mutta VAIN tunnukset: `propertyName=posti_alue` jattaa geometrian
 * pois, jolloin kaikki 3018 aluetta mahtuu yhteen 0,5 MB:n vastaukseen.
 * Geometrialla sama haku olisi kymmenia megatavuja eika sita tarvita -- tasta
 * halutaan vain tieto siita, KENELLA on oma postinumeroalue.
 */
const PAAVO_WFS_ALUETUNNUKSET =
  PAAVO_WFS_PERUSTA + "&propertyName=" + encodeURIComponent("posti_alue");

/**
 * --- MIKSI NIMETTY LISTA EIKA SAANTO ------------------------------------
 *
 * Tassa oli aiemmin automaattinen heuristiikka ("jos koodilla ei ole omaa
 * Paavo-aluetta ja se on yli 50 km samannimisten mediaanista, siirra se").
 * Se hylattiin. Syy kannattaa lukea ennen kuin joku rakentaa sen uudestaan.
 *
 * Aineisto mitattiin lapikotaisin Postin PCF-tiedostoa ja Paavon koko maan
 * geometriaa vasten. Rikkinaisia rivia on kymmenen, ja jokainen niista karkaa
 * eri ehdosta: 97999 ON Paavossa, 60110:n poikkeama on alle 50 km, 00002 ei
 * ole PL-koodi. Saanto joka nappaisi ne kaikki nappaisi myos oikeita rivia --
 * 93900 Kuusamo on 33 km samannimisistaan ja OIKEIN, koska se on Oulangan
 * kansallispuisto isossa kunnassa. Sama koskee 95540 Torniota (32 km).
 *
 * Toinen syy: saanto korjaa hiljaa. Automaatti siirtaa rivin jonka se sattuu
 * nappaamaan ilman etta kukaan on katsonut sita, ja tassa projektissa
 * hiljainen automaattinen korjaus on samaa sukua kuin hiljainen virhe. Lista
 * voi kantaa TODISTEEN -- minka toisen paikkakunnan alueelle rivin piste
 * osuu -- ja se on yksittainen tarkistettava fakta eika kynnysarvo.
 *
 * --- Mika on "virhe": SIIRTYMA, ei polygonietaisyys ----------------------
 * Naita kahta suuretta ei saa sekoittaa, ja ne on sekoitettu tassa jo kerran:
 *
 *   SIIRTYMA        = kuinka kaukana rivi on siita missa sen pitaisi olla.
 *                     Tama on VIRHEEN MITTA, koska juuri taman verran sää
 *                     naytetaan vaarasta paikasta.
 *   POLYGONIETAISYYS = kuinka kaukana piste on viitealueen ulkopuolella
 *                     (nolla jos sisalla). Tama on vain TUNNISTIN.
 *
 * Ratkaiseva esimerkki on 60110 Seinajoki: sen polygonietaisyys on 0,0 km,
 * koska Seinajoki nieli Peraseinajoen kuntaliitoksessa 2009 ja vaara piste on
 * yha oikean kunnan sisalla. Yksikaan kuntarajoihin nojaava mittari ei loyda
 * sita. Siirtyma on 30,2 km.
 *
 * --- Tunnistimia tarvitaan kaksi ----------------------------------------
 * Kumpikaan yksin ei loyda kaikkea:
 *
 *   1. PL-KOODI OMAN KUNTANSA ULKOPUOLELLA. PL-koodi (PCF-tyyppi 2) on
 *      pelkka noutopiste, joten sen kuuluu olla oman kaupunkinsa kunnassa.
 *      Mitattu: 561 PL-koodista 9 on kuntansa ulkopuolella, ja niissa on
 *      puhdas raja -- 229,05 / 46,25 / 5,97 / 5,85 / 2,60 km ja sitten
 *      1,51 / 0,90 / 0,43 / 0,20 km. Alle 2 km on yleistyskohinaa
 *      (kuntaraja ja postinumeroalueen reuna eivat osu tarkalleen yhteen),
 *      yli 2 km on aito virhe. Kaannosgeokoodaus vahvistaa kaikki viisi:
 *      00101 -> Pieksamaki, 86301 -> Haapajarvi, 87101 -> Kontiomaki,
 *      65301 -> Alskat/Mustasaari, 33101 -> Lentola/Kangasala.
 *
 *   2. OMA ALUE MUTTA PISTE KAUKANA SEN ULKOPUOLELLA. Tama loytaa 97999:n,
 *      jota tunnistin 1 ei nae (se ei ole PL-koodi). Puskuri on 20 km eika
 *      2 km: koko aineiston toiseksi suurin poikkeama tassa on 13,9 km ja
 *      loput ovat alle 7 km:n yleistyskohinaa, joten 20 km on kokonaan
 *      kohinan ylapuolella. 97999 on 155,7 km.
 *
 * --- MIKSI PERUSKOODISAANTO xxx00 EI KELPAA -----------------------------
 * Harkittiin saantoa "PL-koodin kuuluu sijaita piirinsa peruskoodin xxx00
 * kohdalla". Se on houkutteleva koska silla on maaritelty oikea vastaus --
 * mutta mittaus kumoaa sen kahdesti:
 *
 *   a) 47 PL-koodin peruskoodi on ERINIMINEN, eli eri paikkakunta. Saanto
 *      siirtaisi 21661 NAUVON Paraisille (39 km), 99831 SAARISELAN Ivaloon
 *      (36 km) ja 33881 LEMPAALAN Tampereelle (18 km). Ne ovat oikeita
 *      rivia; xxx00 on vain piirin paakoodi, ei PL-koodin kotipaikka.
 *
 *   b) Samannimisillakaan ei ole kynnysta johon tarttua: 469 parista 380 on
 *      yli 1 km, 255 yli 2 km ja 110 yli 5 km peruskoodistaan. Jakauma on
 *      tasainen. Ja 10-11 km:n kohdalla ovat Vantaan (01601...01671) ja
 *      Helsingin (00701...00791) PL-rypaat, jotka istuvat KAIKKI tasmalleen
 *      kaupunkinsa yhteisessa PL-pisteessa -- se on GeoNamesin tarkoituksellinen
 *      tapa, ei virhe, ja saanto siirtaisi ne pois oikealta paikaltaan.
 *
 * --- Lahteet ja lisenssit ------------------------------------------------
 * Postin PCF-tiedostoa kaytettiin OSOITTAMAAN mitka rivit ovat rikki ja mitka
 * koodit ovat olemassa, muttei kertomaan mita niiden tilalle tulee. Mitaan
 * PCF:sta johdettua koordinaattia tai nimea ei ole tassa aineistossa. Syy on
 * lisenssi: PCF:n kayttoehdot sallivat edelleenluovutuksen vain silla ehdolla
 * etta vastaanottajalle toimitetaan "aina myos ajantasainen palvelukuvaus ja
 * kayttoehdot". Se on jatkuva velvoite jota vuosia koskematon laite ei voi
 * tayttaa, ja Posti voi muuttaa ehtoja yksipuolisesti -- toisin kuin
 * CC BY 4.0, joka on peruuttamaton.
 *
 * Lista saa vanhentua vain aanekkaasti: koonti kaatuu jos rivin nykyinen
 * koordinaatti ei ole se jonka lista odottaa (ks. sovellaKorjauslista), ja
 * eheystesti kaatuu molempiin suuntiin -- seka puuttuvasta etta turhasta
 * merkinnasta (ks. server/test/postal-code-integrity.ts).
 */

/** Mista korvaava koordinaatti lasketaan. GeoNames + Paavo, molemmat CC BY 4.0. */
const KORVAUS_NIMIRYHMAN_MEDIAANI = "samannimisten GeoNames-koodien mediaani (vain ne joilla on oma Paavo-alue)";

/**
 * Rivit jotka korjataan. `ennen` on se koordinaatti jonka lahteessa PITAA
 * olla; jos se on muuttunut, koonti kaatuu eika arvaa.
 *
 * `siirtymaKm` on virheen mitta (kuinka kauas saa naytettaisiin).
 * `todiste` kertoo miten se tiedetaan vaaraksi.
 */
const KORJATTAVAT = [
  {
    pn: "00101", nimi: "Helsinki", ennen: [62.1569, 27.1979], siirtymaKm: 252.0,
    tunnistin: "PL-koodi 229,05 km oman kuntansa (Helsinki) ulkopuolella",
    todiste: "käännösgeokoodaus: Pieksämäki. Piste on 0,13 km rivistä 76101 Pieksämäki — NNN01-kuvio",
  },
  {
    pn: "00002", nimi: "Helsinki", ennen: [61.0806, 24.2737], siirtymaKm: 104.0,
    tunnistin: "yritystunnus (PCF-tyyppi 3) 95,6 km oman kuntansa (Helsinki) ulkopuolella",
    todiste: "piste on alueella 14530 Leteensuo, Hämeenlinnan Parolan tienoilla",
  },
  {
    pn: "86301", nimi: "Oulainen", ennen: [63.7587, 25.3452], siirtymaKm: 62.2,
    tunnistin: "PL-koodi 46,25 km oman kuntansa (Oulainen) ulkopuolella",
    todiste: "käännösgeokoodaus: Haapajärvi. Piste on 1,49 km rivistä 85801 Haapajärvi — sama NNN01-kuvio kuin 00101",
  },
  {
    pn: "87101", nimi: "Kajaani", ennen: [64.3592, 28.1485], siirtymaKm: 26.9,
    tunnistin: "PL-koodi 5,97 km oman kuntansa (Kajaani) ulkopuolella",
    todiste: "käännösgeokoodaus: Kontiomäki (Paltamo). Piste on alueella 88470 Kontiomäki",
  },
  {
    pn: "65301", nimi: "Vaasa", ennen: [63.23, 21.5249], siirtymaKm: 15.1,
    tunnistin: "PL-koodi 5,85 km oman kuntansa (Vaasa) ulkopuolella",
    todiste: "käännösgeokoodaus: Alskat, Mustasaari — eri kunta kuin rivin nimi sanoo",
  },
  {
    pn: "33101", nimi: "Tampere", ennen: [61.4795, 23.9886], siirtymaKm: 11.1,
    tunnistin: "PL-koodi 2,60 km oman kuntansa (Tampere) ulkopuolella",
    todiste: "käännösgeokoodaus: Lentola, Kangasala. Piste on alueella 36220 Suorama",
  },
  {
    pn: "60110", nimi: "Seinäjoki", ennen: [62.5424, 23.1452], siirtymaKm: 30.2,
    tunnistin:
      "EI KUMPIKAAN TUNNISTIN — tämä rivi on listalla käsin todennettuna. Sen " +
      "polygonietäisyys on 0,0 km, koska Seinäjoki nieli Peräseinäjoen " +
      "kuntaliitoksessa 2009, eikä se ole PL-koodi vaan PCF-tyyppi 1 eli " +
      "tavallinen asuinpostinumero. Yksikään kuntarajoihin nojaava mittari ei löydä sitä.",
    todiste:
      "piste on alueen 61100 Peräseinäjoki Keskus sisällä, 3,5 km Peräseinäjoen omasta " +
      "rivistä. Naapurit 60100, 60120 ja 60150 ovat kaikki omien alueidensa sisällä " +
      "28-32 km päässä tästä pisteestä.",
  },
];

/**
 * Rivit jotka poistetaan.
 *
 * --- MIKSI VAIN YKSI, VAIKKA LAKKAUTETTUJA ON 24 -----------------------
 * Aineistossa on 24 koodia joita Posti ei enaa tunne. Ensimmainen versio
 * poisti ne kaikki. Se oli vaarin, ja syy on mitattu:
 *
 *   niista 16:lla KOORDINAATTI ON TODENNETUSTI OIKEIN (0,0-4,8 km omasta
 *   postinumeroalueestaan Paavossa), 7:lla ei ole mitaan viitetta kumpaankaan
 *   suuntaan, ja VAIN YHDELLA -- 97999 -- se on vaarin (155,6 km).
 *
 * Poisto olisi siis 23 tapauksessa vienyt haun joka olisi palauttanut OIKEAN
 * paikkakunnan saan. Se on tassa projektissa vaarin pain: vikahierarkia on
 *
 *   vaara tieto ilman merkintaa  >  vanhentunut mutta oikea tieto  >  puuttuva tieto
 *
 * Lakkautettu koodi jonka koordinaatti on oikea ei nayta vaaraa saata. Se on
 * vain koodi jota Posti ei enaa myonna -- ja jos joku on kayttanyt sita
 * vuosia, han saisi poiston jalkeen "tuntematon postinumero" siita hyvasta.
 * Ne pidetaan, ja ne kirjataan VANHENTUNEET_KOODIT-listalle nakyviin.
 *
 * 97999 poistetaan koska sen koordinaatti on MYOS vaarin: 155,6 km omasta
 * Paavo-alueestaan, kun koko aineiston toiseksi suurin poikkeama samalla
 * mittarilla on 13,9 km. Lahteet ovat siita eri mielta (Paavo: Konges,
 * Kittila; GeoNames: Rovaniemi, 165 km erillaan) eika Posti tunne koodia,
 * joten oikeaa vastausta ei ole olemassa. Korjaaminen tarkoittaisi
 * koordinaatin keksimista lakkautetulle koodille.
 *
 * Tarkistettu erikseen: numerokuviosta ei ole luokitteluun. Aineistossa on 15
 * koodia jotka paattyvat 99x:aan, ja 11 niista on taysin kelvollisia (00990
 * Aurinkolahti, 99990 Nuorgam, 99999 Korvatunturi, ...). Oikea luokka on
 * "ei Postin PCF-tiedostossa", ei "xxx999".
 */
const POISTETTAVAT = [
  {
    pn: "97999", nimi: "Rovaniemi", ennen: [66.6529, 25.9803],
    syy:
      "Posti ei tunne koodia, JA koordinaatti on väärin: 155,6 km omasta Paavo-alueestaan " +
      "(aineiston toiseksi suurin poikkeama samalla mittarilla on 13,9 km). Tilastokeskus on " +
      "sanonut yksitoista vuotta alueen olevan Köngäs Kittilässä, GeoNames sanoo Rovaniemi, ja " +
      "ne ovat 165 km erillään. Koko 979xx-lohko on Posion kyliä. Oikeaa vastausta ei ole, " +
      "koska koodia ei ole — korjaaminen tarkoittaisi koordinaatin keksimistä.",
  },
];

/**
 * Yläraja poistoille.
 *
 * POISTETTAVAT on kasin kirjoitettu lista ja jokainen rivi tarkistetaan
 * lahdetta vasten (ks. sovellaKorjauslista), joten koonti EI voi poistaa
 * satoja rivia vahingossa -- se ei hae Postin tiedostoa lainkaan. Tama raja
 * on siis puolustus tulevaa muutosta vastaan: jos joku myohemmin automatisoi
 * listan jostain lahteesta, vaillinainen lataus nakyisi poistoaaltona, ja
 * silloin kyse on lahdevirheesta eika aineiston siivouksesta.
 */
const POISTOJEN_YLARAJA = 50;

/**
 * Koodit jotka Posti on lakkauttanut mutta jotka PIDETAAN aineistossa.
 *
 * Nama eivat ole virheita vaan vanhentunutta mutta OIKEAA tietoa: kunkin
 * koordinaatti osoittaa sinne minne rivin nimi sanoo. Haku palauttaa niille
 * oikean paikkakunnan saan. Ainoa mika niissa on "vaarin" on se, ettei Posti
 * enaa myonna koodia -- ja se ei ole syy viedä hakua kaytosta silta joka on
 * kayttanyt sita vuosia.
 *
 * Miksi tama lista on olemassa vaikka mitaan ei tehda: ilman sita eheystesti
 * kaatuisi naihin joka ajolla ("Posti ei tunne koodia"), ja ilman perustelua
 * seuraava lukija poistaisi ne. `paavo2026` kertoo tunteeko Tilastokeskus
 * alueen yha -- kahdeksan kohdalla tuntee, eli Posti ja Tilastokeskus ovat
 * naista eri mielta.
 */
const VANHENTUNEET_KOODIT = [
  { pn: "02290", nimi: "Espoo", paavo2026: false, koordinaatti: "0,0 km alueestaan (Paavo 2015)" },
  { pn: "07601", nimi: "Myrskylä", paavo2026: false, koordinaatti: "ei viitettä" },
  { pn: "14330", nimi: "Kaloinen", paavo2026: false, koordinaatti: "0,0 km alueestaan (Paavo 2015)" },
  { pn: "14370", nimi: "Lukana", paavo2026: false, koordinaatti: "0,0 km alueestaan (Paavo 2015)" },
  { pn: "15250", nimi: "Lahti", paavo2026: false, koordinaatti: "ei viitettä" },
  { pn: "15251", nimi: "Lahti", paavo2026: false, koordinaatti: "ei viitettä" },
  { pn: "15551", nimi: "Nastola", paavo2026: false, koordinaatti: "ei viitettä" },
  { pn: "15561", nimi: "Nastola", paavo2026: false, koordinaatti: "ei viitettä" },
  { pn: "17530", nimi: "Arrakoski", paavo2026: true, koordinaatti: "0,0 km alueestaan (Paavo 2026)" },
  { pn: "21520", nimi: "Naskarla", paavo2026: false, koordinaatti: "0,0 km alueestaan (Paavo 2015)" },
  { pn: "33380", nimi: "Pitkäniemi", paavo2026: false, koordinaatti: "0,0 km alueestaan (Paavo 2015)" },
  { pn: "44770", nimi: "Valkeisjärvi", paavo2026: true, koordinaatti: "0,3 km alueestaan (Paavo 2026)" },
  { pn: "60280", nimi: "Seinäjoki", paavo2026: true, koordinaatti: "0,0 km alueestaan (Paavo 2026)" },
  { pn: "66999", nimi: "Vaasa", paavo2026: true, koordinaatti: "0,0 km alueestaan (Paavo 2026)" },
  { pn: "68999", nimi: "Kokkola", paavo2026: true, koordinaatti: "0,0 km alueestaan (Paavo 2026)" },
  { pn: "73860", nimi: "Pykälikkö", paavo2026: false, koordinaatti: "0,4 km alueestaan (Paavo 2015)" },
  { pn: "83915", nimi: "Vihtasuo", paavo2026: true, koordinaatti: "4,8 km alueestaan (Paavo 2026)" },
  { pn: "88820", nimi: "Katerma", paavo2026: false, koordinaatti: "0,6 km alueestaan (Paavo 2015)" },
  { pn: "90461", nimi: "Oulunsalo", paavo2026: false, koordinaatti: "ei viitettä" },
  { pn: "97430", nimi: "Taapajärvi", paavo2026: false, koordinaatti: "3,1 km alueestaan (Paavo 2015)" },
  { pn: "97770", nimi: "Petäjäjärvi", paavo2026: false, koordinaatti: "0,1 km alueestaan (Paavo 2015)" },
  { pn: "98999", nimi: "Kemijärvi", paavo2026: false, koordinaatti: "ei viitettä" },
  { pn: "99885", nimi: "Lemmenjoki", paavo2026: true, koordinaatti: "0,0 km alueestaan (Paavo 2026)" },
];

/**
 * Tunnetut puutteet: voimassa olevia koodeja joita ei voi lisata, koska
 * sallituista lahteista ei loydy koordinaattia. Kirjattu jotta seuraava ei
 * tee samaa selvitysta alusta.
 */
const TUNNETUT_PUUTTEET = [
  {
    pn: "60250", nimi: "SEINÄJOKI",
    syy:
      "PCF-tyyppi 1, voimassa 20.3.2023 alkaen, mutta koordinaattia ei ole missään sallitussa " +
      "lähteessä: Paavossa ei ole aluetta (tarkistettu pno_2026) eikä GeoNamesissa riviä. " +
      "22110:n peruste ei toimi tähän: se sai 22100:n koordinaatin koska Maarianhaminan kunta " +
      "on 8,1 km laaja ja siinä on YKSI postinumeroalue, joten virhe on korkeintaan kunnan " +
      "kokoinen. Seinäjoen kunta on 96,8 km laaja ja siinä on 26 aluetta — juuri siellä " +
      "jouduttiin siirtämään 60110:tä 30 km. \"Sama postitoimipaikka kuin 60100\" ei rajaa " +
      "sijaintia lainkaan, joten lisääminen olisi arvaus. Puuttuva rivi antaa käyttäjälle " +
      "\"tuntematon postinumero\", mikä on rehellisempi kuin arvattu koordinaatti.",
  },
];

/**
 * Rivit jotka lisataan: voimassa olevia postinumeroita jotka puuttuvat
 * kummastakin lahteesta. Puuttuva rivi on lievempi vika kuin vaara
 * koordinaatti -- kayttaja saa "tuntematon postinumero" eika vaaraa saata --
 * mutta se on silti vika.
 *
 * PCF:sta otetaan VAIN tieto siita etta koodi on olemassa. Koordinaatti ja
 * nimi tulevat CC BY 4.0 -lahteista.
 */
const LISATTAVAT = [
  {
    pn: "22110",
    kopioiKoodilta: "22100",
    peruste:
      "Posti ilmoittaa 22110:n ja 22100:n postitoimipaikaksi saman (MARIEHAMN) ja " +
      "kunnaksi Maarianhaminan. Maarianhaminan kunta on mitattuna 8,1 km laaja ja " +
      "siina on tasmalleen YKSI postinumeroalue Paavossa, joten 22100:n koordinaatti " +
      "on ainoa piste koko kunnassa ja virhe on korkeintaan kunnan kokoinen. Nimi ja " +
      "koordinaatti tulevat Paavosta (CC BY 4.0) kuten muillakin 22xxx-riveilla.",
  },
  // 60250 SEINAJOKI (PCF-tyyppi 1, voimassa 20.3.2023) JATETTIIN LISAAMATTA.
  // Sama peruste ei toimi: Seinajoen kunta on 96,8 km laaja ja siina on 26
  // postinumeroaluetta, joten "sama postitoimipaikka kuin 60100" ei rajaa
  // sijaintia lainkaan. Juuri tassa kunnassa jouduttiin siirtamaan 60110:ta
  // 30 km, mika osoittaa ettei kunta riita paikannukseen. Arvaus olisi
  // huonompi kuin puuttuva rivi.
];

/**
 * Tunnetut ja hyvaksytyt poikkeamat: naita EI korjata, mutta ne eivat saa
 * kadota nakyvista. Ilman tata merkintaa eheystesti kaatuisi niihin ilman
 * selitysta, tai joku "loytaisi" ne uudestaan kolmen vuoden paasta.
 */
const HYVAKSYTYT_POIKKEAMAT = [
  {
    pn: "99999", nimi: "Korvatunturi", etaisyysKm: 166.2,
    syy:
      "EI OLE VIRHE, vaan kahden viranomaislähteen erimielisyys: Posti ilmoittaa " +
      "kunnaksi Rovaniemen, Paavo sijoittaa alueen Savukoskelle (742). GeoNamesin " +
      "piste on Korvatunturilla eli maantieteellisesti oikein. Postin kuntamerkintä " +
      "on hallinnollinen erikoisuus, samaa lajia kuin se että kaikki " +
      "vastauslähetyskoodit kirjataan Helsinkiin. Kuntapohjainen tarkistus ilmoittaa " +
      "tästä joka ajolla, joten se on kirjattava tähän.",
  },
  {
    pn: "70006", nimi: "Vastauslähetys", etaisyysKm: 310.7,
    syy:
      "VÄÄRÄ HÄLYTYS, ei virhe. Koodi on voimassa (PCF-tyyppi 5) ja sen koordinaatti " +
      "on Kuopiossa, mikä täsmää 70xxx-piirin kanssa. Se 310,7 km mitattiin Postin " +
      "KUNTAKENTTÄÄ vastaan, joka kirjaa kaikki vastauslähetyskoodit (00006, 20006, " +
      "33006, 70006) hallinnollisesti Helsinkiin keskitetyn käsittelyn takia — kenttä " +
      "ei kerro sijaintia. Rivi jätetään ennalleen. Nimi \"Vastauslähetys\" ei tosin " +
      "ole paikannimi, joten rivi on sääkortilla kummallinen; se on eri kysymys eikä " +
      "peruste siirtää koordinaattia.",
  },
];

/**
 * Poistaa hakemistopuun. EI fs.rmSync.
 *
 * fs.rmSync EI POISTA MITAAN taman koneen projektilevylla: se palaa
 * virheettomasti ja jattaa tiedostot paikalleen. Vika on hiljainen, joten
 * aiempi versio jatti jokaisesta ajosta purkuhakemiston roikkumaan temppiin
 * ilman etta mikaan kertoi siita. unlinkSync ja rmdirSync toimivat.
 */
function poistaPuu(kohde) {
  let tiedot;
  try {
    tiedot = fs.statSync(kohde);
  } catch {
    return;
  }
  if (tiedot.isDirectory()) {
    for (const nimi of fs.readdirSync(kohde)) poistaPuu(path.join(kohde, nimi));
    fs.rmdirSync(kohde);
    return;
  }
  fs.unlinkSync(kohde);
}

/**
 * Purku `tar`illa eika kasin kirjoitetulla zip-jasentimella. Ensimmainen
 * versio jasensi zipin itse ja luki hiljaa roskaa: 36 rivia 3576:n sijaan ja
 * nolla kelvollista postinumeroa. Tama on rakennusskripti, ei tuotantokoodia,
 * joten ulkoinen purkaja on oikea valinta -- bsdtar on Windows 10:sta lahtien
 * ja kaikissa Linux-jakeluissa.
 */
async function lataaGeoNames() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "geonames-"));
  const zipPolku = path.join(tmp, "FI.zip");

  try {
    const res = await fetch(GEONAMES_ZIP);
    if (!res.ok) throw new Error(`GeoNames HTTP ${res.status}`);
    fs.writeFileSync(zipPolku, Buffer.from(await res.arrayBuffer()));

    const tar = process.platform === "win32"
      ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
      : "tar";
    const purku = spawnSync(tar, ["-xf", zipPolku, "-C", tmp, "FI.txt"], { stdio: "inherit" });
    if (purku.status !== 0) throw new Error(`purku epäonnistui (koodi ${purku.status})`);

    const txt = fs.readFileSync(path.join(tmp, "FI.txt"), "utf8");

    const taulu = {};
    let rivit = 0;
    for (const rivi of txt.split("\n")) {
      if (!rivi.trim()) continue;
      rivit += 1;
      // Sarkainerotettu: maa, postinumero, paikka, ..., lat(9), lon(10)
      const s = rivi.split("\t");
      const pn = s[1];
      const nimi = s[2];
      const lat = Number(s[9]);
      const lon = Number(s[10]);
      if (!/^\d{5}$/.test(pn) || !nimi || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      // Ensimmainen esiintyma voittaa: aineistossa on muutama duplikaatti.
      if (!(pn in taulu)) taulu[pn] = [nimi, Number(lat.toFixed(4)), Number(lon.toFixed(4))];
    }
    return { taulu, rivit };
  } finally {
    // finally, koska kaatunut lataus ei saa jattaa purkuhakemistoa roikkumaan.
    poistaPuu(tmp);
  }
}

/** Monikulmion pinta-ala ja painopiste tasokoordinaatteina (riittaa saan tarkkuudella). */
function rengas(koords) {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = koords.length - 1; i < koords.length; j = i, i += 1) {
    const [x1, y1] = koords[j];
    const [x2, y2] = koords[i];
    const risti = x1 * y2 - x2 * y1;
    a += risti;
    cx += (x1 + x2) * risti;
    cy += (y1 + y2) * risti;
  }
  a /= 2;
  if (a === 0) return null;
  return { ala: Math.abs(a), x: cx / (6 * a), y: cy / (6 * a) };
}

/** Pinta-alapainotettu keskipiste: monisaarinen alue ei saa painottua pikkuluodoille. */
function keskipiste(geom) {
  const polygonit = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
  let ala = 0;
  let x = 0;
  let y = 0;
  for (const poly of polygonit) {
    const r = rengas(poly[0]); // ulkorengas; reiat jatetaan huomiotta
    if (!r) continue;
    ala += r.ala;
    x += r.x * r.ala;
    y += r.y * r.ala;
  }
  return ala === 0 ? null : { lon: x / ala, lat: y / ala };
}

async function lataaAhvenanmaa() {
  const res = await fetch(PAAVO_WFS_AHVENANMAA);
  if (!res.ok) throw new Error(`Paavo HTTP ${res.status}`);
  const json = await res.json();
  const taulu = {};
  for (const f of json.features ?? []) {
    const pn = f.properties?.posti_alue;
    const nimi = f.properties?.nimi;
    if (!/^\d{5}$/.test(pn ?? "") || !nimi || !f.geometry) continue;
    const kp = keskipiste(f.geometry);
    if (!kp) continue;
    taulu[pn] = [String(nimi).trim(), Number(kp.lat.toFixed(4)), Number(kp.lon.toFixed(4))];
  }
  return taulu;
}

/**
 * Ne postinumerot joilla on oikea maantieteellinen alue Tilastokeskuksen
 * Paavossa. Paluuarvo on pelkka joukko tunnuksia -- keskipisteita EI haeta
 * eika kayteta, ks. korjaaHarhautuneet.
 */
async function lataaPaavonAluetunnukset() {
  const res = await fetch(PAAVO_WFS_ALUETUNNUKSET);
  if (!res.ok) throw new Error(`Paavo HTTP ${res.status}`);
  const json = await res.json();
  // WFS voi katkaista vastauksen palvelimen omaan ylarajaan. Katkaisu ei nakyisi
  // mitenkaan itsestaan, mutta se tekisi puuttuvista alueista "postilokeroita"
  // ja saisi saannon siirtelemaan taysin oikeita rivia. Siksi tarkistetaan.
  if (json.numberMatched !== json.numberReturned) {
    throw new Error(`Paavo katkaisi vastauksen: ${json.numberReturned}/${json.numberMatched}`);
  }
  const tunnukset = new Set();
  for (const f of json.features ?? []) {
    const pn = f.properties?.posti_alue;
    if (/^\d{5}$/.test(pn ?? "")) tunnukset.add(pn);
  }
  if (tunnukset.size < 2500) throw new Error(`Paavosta tuli vain ${tunnukset.size} aluetta — odotettu ~3000`);
  return tunnukset;
}

/** Pisteiden etaisyys kilometreina (haversine; pallo-oletus riittaa tahan). */
function etaisyysKm(a, b) {
  const R = 6371;
  const rad = Math.PI / 180;
  const dlat = (b[0] - a[0]) * rad;
  const dlon = (b[1] - a[1]) * rad;
  const h = Math.sin(dlat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dlon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function mediaani(luvut) {
  const s = [...luvut].sort((a, b) => a - b);
  const k = s.length >> 1;
  return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2;
}

/**
 * Soveltaa nimetyn korjauslistan. Ei heuristiikkaa -- ks. KORJATTAVAT-lohkon
 * yllaoleva perustelu siita miksi lista eika saanto.
 *
 * Kaatuu jos lahde on muuttunut: jos rivin nykyinen koordinaatti ei ole se
 * jonka lista odottaa (`ennen`), emme tieda onko GeoNames korjannut rivin vai
 * siirtanyt sita muualle -- ja kumpikin tapaus vaatii ihmisen katseen. Hiljainen
 * ylikirjoitus veisi juuri sen tiedon.
 */
function sovellaKorjauslista(taulu, paavonAlueet) {
  if (POISTETTAVAT.length > POISTOJEN_YLARAJA) {
    throw new Error(
      `Poistettavia on ${POISTETTAVAT.length}, yläraja on ${POISTOJEN_YLARAJA}. Tämän kokoluokan ` +
      `poisto ei ole aineiston siivousta vaan merkki lähdevirheestä — tarkista mistä lista on peräisin.`,
    );
  }
  const virheet = [];
  const tehdyt = [];
  const poistetut = [];
  const poikkeamat = [];
  const vanhentuneet = [];

  /** Samannimisten, oman Paavo-alueen omaavien koodien mediaanipiste. */
  function nimiryhmanMediaani(nimi) {
    const jasenet = Object.entries(taulu).filter(([pn, r]) => r[0] === nimi && paavonAlueet.has(pn));
    if (jasenet.length === 0) return null;
    return {
      koko: jasenet.length,
      piste: [
        Number(mediaani(jasenet.map(([, r]) => r[1])).toFixed(4)),
        Number(mediaani(jasenet.map(([, r]) => r[2])).toFixed(4)),
      ],
    };
  }

  /** Rivin on oltava olemassa ja tasmalleen siina missa lista sanoo. */
  function tarkistaLahde(k, mita) {
    const rivi = taulu[k.pn];
    if (!rivi) {
      virheet.push(`${k.pn} (${mita}): riviä ei ole enää lähteessä — merkintä on vanhentunut, poista se listalta`);
      return null;
    }
    if (rivi[0] !== k.nimi) {
      virheet.push(`${k.pn} (${mita}): paikannimi on "${rivi[0]}", lista odottaa "${k.nimi}"`);
      return null;
    }
    if (rivi[1] !== k.ennen[0] || rivi[2] !== k.ennen[1]) {
      virheet.push(
        `${k.pn} (${mita}): lähteen koordinaatti on ${rivi[1]}/${rivi[2]}, lista odottaa ${k.ennen[0]}/${k.ennen[1]}. ` +
        `GeoNames on muuttanut riviä — tarkista käsin onko korjaus yhä tarpeen ennen kuin päivität listan.`,
      );
      return null;
    }
    return rivi;
  }

  for (const k of KORJATTAVAT) {
    if (!tarkistaLahde(k, "korjattava")) continue;
    const m = nimiryhmanMediaani(k.nimi);
    if (!m) {
      virheet.push(`${k.pn}: nimiryhmälle "${k.nimi}" ei löydy yhtään Paavo-tuettua koodia, korvaavaa ei voi laskea`);
      continue;
    }
    const siirtyma = etaisyysKm(k.ennen, m.piste);
    taulu[k.pn] = [k.nimi, m.piste[0], m.piste[1]];
    tehdyt.push({ ...k, jalkeen: m.piste, vertailuryhmanKoko: m.koko, siirtymaKm: Number(siirtyma.toFixed(1)) });
  }

  for (const k of POISTETTAVAT) {
    if (!tarkistaLahde(k, "poistettava")) continue;
    delete taulu[k.pn];
    poistetut.push(k);
  }

  for (const k of HYVAKSYTYT_POIKKEAMAT) {
    // Naita ei kosketa, mutta rivin on oltava olemassa: jos se katoaa, merkinta
    // on kuollutta koodia ja se pitaa poistaa listalta.
    if (!(k.pn in taulu)) {
      virheet.push(`${k.pn} (hyväksytty poikkeama): riviä ei ole enää aineistossa — poista merkintä listalta`);
      continue;
    }
    poikkeamat.push(k);
  }

  for (const k of VANHENTUNEET_KOODIT) {
    // Naitakaan ei kosketa. Sama vaatimus: jos rivi katoaa lahteesta, merkinta
    // on turha ja se pitaa poistaa listalta.
    if (!(k.pn in taulu)) {
      virheet.push(`${k.pn} (vanhentunut koodi): riviä ei ole enää aineistossa — poista merkintä listalta`);
      continue;
    }
    vanhentuneet.push({ ...k, koordinaattiNyt: [taulu[k.pn][1], taulu[k.pn][2]] });
  }

  if (virheet.length > 0) {
    throw new Error(
      ["Korjauslista ei vastaa lähdeaineistoa:", ...virheet.map((v) => `  - ${v}`), "",
        "Lista on skriptit/rakenna-postinumerot.mjs:ssä. Älä päivitä sitä sokeasti:",
        "tarkista ensin osuuko rivin piste yhä vieraan postinumeroalueen sisälle."].join("\n"),
    );
  }
  return { tehdyt, poistetut, poikkeamat, vanhentuneet };
}

/**
 * Lisaa puuttuvat rivit. Ajetaan VASTA Ahvenanmaan paikkauksen jalkeen, koska
 * lahderivi (22100) tulee sielta.
 *
 * Kopioi koordinaatin ja nimen olemassa olevalta riviltä. PCF:sta on kaytetty
 * vain tieto siita etta koodi on olemassa -- ei nimea eika koordinaattia.
 */
function lisaaPuuttuvat(taulu) {
  const lisatyt = [];
  const virheet = [];
  for (const k of LISATTAVAT) {
    if (k.pn in taulu) {
      virheet.push(`${k.pn} (lisättävä): rivi on jo aineistossa — lähde on lisännyt sen, poista merkintä listalta`);
      continue;
    }
    const lahde = taulu[k.kopioiKoodilta];
    if (!lahde) {
      virheet.push(`${k.pn} (lisättävä): lähderiviä ${k.kopioiKoodilta} ei ole aineistossa, koordinaattia ei voi kopioida`);
      continue;
    }
    taulu[k.pn] = [lahde[0], lahde[1], lahde[2]];
    lisatyt.push({ ...k, nimi: lahde[0], koordinaatti: [lahde[1], lahde[2]] });
  }
  if (virheet.length > 0) {
    throw new Error(["Lisäyslista ei vastaa lähdeaineistoa:", ...virheet.map((v) => `  - ${v}`)].join("\n"));
  }
  return lisatyt;
}

const { taulu: geo, rivit } = await lataaGeoNames();
console.log(`GeoNames: ${rivit} riviä, ${Object.keys(geo).length} kelvollista postinumeroa`);

const paavonAlueet = await lataaPaavonAluetunnukset();
const ilmanAluetta = Object.keys(geo).filter((pn) => !paavonAlueet.has(pn)).length;
console.log(`Paavo (koko maa): ${paavonAlueet.size} postinumeroaluetta`);
console.log(`  GeoNames-koodeja joilla ei ole omaa aluetta: ${ilmanAluetta} (postilokeroita yms.)`);

// Korjaus tehdaan ENNEN Ahvenanmaan paikkausta. 22xxx tulee kokonaan Paavosta
// eika yksikaan listan rivi ole 22xxx:ssa -- mutta jarjestys tekee sen
// nakyvaksi eika jata sita paattelyn varaan.
const { tehdyt, poistetut, poikkeamat, vanhentuneet } = sovellaKorjauslista(geo, paavonAlueet);

console.log(`\n--- Korjatut rivit: ${tehdyt.length} kpl -------------------------------`);
console.log(`    (virheen mitta on SIIRTYMÄ: kuinka kauas sää näytettäisiin)`);
for (const k of tehdyt) {
  console.log(
    `  ${k.pn} ${k.nimi}\n` +
    `      ennen     : ${k.ennen[0]} / ${k.ennen[1]}\n` +
    `      jälkeen   : ${k.jalkeen[0]} / ${k.jalkeen[1]}   (siirtymä ${k.siirtymaKm} km)\n` +
    `      tunnistin : ${k.tunnistin}\n` +
    `      todiste   : ${k.todiste}\n` +
    `      korvaus   : ${KORVAUS_NIMIRYHMAN_MEDIAANI}, ${k.vertailuryhmanKoko} koodia`,
  );
}

console.log(`\n--- Poistetut rivit: ${poistetut.length} kpl (yläraja ${POISTOJEN_YLARAJA}) ---`);
for (const k of poistetut) {
  console.log(`  ${k.pn} ${k.nimi.padEnd(16)} (oli ${k.ennen[0]} / ${k.ennen[1]})\n      syy : ${k.syy}`);
}

console.log(`\n--- Vanhentuneet mutta SÄILYTETYT: ${vanhentuneet.length} kpl -------------`);
console.log(`    Posti ei enää myönnä näitä koodeja, mutta koordinaatti osoittaa oikeaan`);
console.log(`    paikkaan, joten haku palauttaa oikean sään. Poisto veisi toimivan haun.`);
for (const k of vanhentuneet) {
  console.log(
    `  ${k.pn} ${k.nimi.padEnd(16)} ${k.koordinaattiNyt[0]} / ${k.koordinaattiNyt[1]}  ` +
    `Paavo 2026: ${k.paavo2026 ? "tuntee yhä" : "ei tunne"}  —  ${k.koordinaatti}`,
  );
}

console.log(`\n--- Tunnetut puutteet: ${TUNNETUT_PUUTTEET.length} kpl (voimassa, mutta ei lisättävissä) ---`);
for (const k of TUNNETUT_PUUTTEET) console.log(`  ${k.pn} ${k.nimi}\n      syy : ${k.syy}`);

console.log(`\n--- Tunnetut ja hyväksytyt poikkeamat: ${poikkeamat.length} kpl (EI korjata) -----`);
for (const k of poikkeamat) {
  console.log(`  ${k.pn} ${k.nimi}  ${k.etaisyysKm} km\n      syy : ${k.syy}`);
}

const ahvenanmaa = await lataaAhvenanmaa();
console.log(`\nPaavo (22xxx, geometrialla): ${Object.keys(ahvenanmaa).length} aluetta`);

let lisatty = 0;
for (const [pn, arvo] of Object.entries(ahvenanmaa)) {
  if (pn in geo) continue; // GeoNames voittaa: sen nimet ovat postitoimipaikkoja
  geo[pn] = arvo;
  lisatty += 1;
}
console.log(`Ahvenanmaalta lisätty ${lisatty} postinumeroa joita GeoNamesissa ei ollut`);

// Vasta tassa: lisayslista kopioi koordinaatin olemassa olevalta rivilta, ja
// 22110:n lahderivi 22100 syntyi juuri edella Ahvenanmaan paikkauksessa.
const lisatytRivit = lisaaPuuttuvat(geo);
console.log(`\n--- Lisätyt rivit: ${lisatytRivit.length} kpl (voimassa, mutta puuttuivat molemmista lähteistä) ---`);
for (const k of lisatytRivit) {
  console.log(
    `  ${k.pn} ${k.nimi}  ${k.koordinaatti[0]} / ${k.koordinaatti[1]}  (kopioitu riviltä ${k.kopioiKoodilta})\n` +
    `      peruste : ${k.peruste}`,
  );
}

const jarjestetty = Object.fromEntries(Object.keys(geo).sort().map((k) => [k, geo[k]]));
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(jarjestetty));

/**
 * Korjausloki AINEISTON VIERESSA, ei vain koonnin tulosteessa.
 *
 * Tuloste katoaa kun terminaali suljetaan, ja korjattu rivi nayttaa sen
 * jalkeen tismalleen samalta kuin alkuperainen. Se olisi hiljainen korjaus,
 * yhta paha kuin hiljainen virhe. Loki kertoo mika rivi on muutettu, mista
 * mihin ja milla saannolla, ja se kulkee aineiston mukana laitteelle asti.
 *
 * Oma tiedosto eika avain postinumerot.jsoniin: se taulu on
 * `Record<postinumero, [nimi, lat, lon]>` ja palvelin jasentaa sen joka
 * kaynnistyksessa (ks. server/src/core/postal-codes.ts). Ylimaarainen avain
 * sotkisi muodon ja `postalTableSize()`-laskennan. Palvelin ei lue tata
 * tiedostoa lainkaan -- sen lukevat ihminen ja eheystesti
 * (server/test/postal-code-integrity.ts).
 */
const LOKI = path.join(path.dirname(OUT), "postinumerot-korjaukset.json");
fs.writeFileSync(LOKI, `${JSON.stringify({
  aineisto: path.basename(OUT),
  koottu: new Date().toISOString().slice(0, 10),
  menetelma:
    "Nimetty korjauslista, ei heuristiikkaa. Perustelu sille miksi lista eikä sääntö " +
    "on skriptit/rakenna-postinumerot.mjs:n KORJATTAVAT-lohkon yllä.",
  virheenMitta:
    "siirtymaKm = SIIRTYMÄ eli kuinka kaukana rivi oli siitä missä sen pitäisi olla. " +
    "Tämä on virheen mitta, koska juuri sen verran sää näytettäisiin väärästä paikasta. " +
    "Polygonietäisyys (kuinka kaukana piste on viitealueen ulkopuolella) on eri suure ja " +
    "vain TUNNISTIN — se on 0,0 km esimerkiksi 60110:lle, joka on silti 30,2 km pielessä.",
  korvaavaKoordinaatti: KORVAUS_NIMIRYHMAN_MEDIAANI,
  lahteet: {
    koordinaatitJaNimet: "GeoNames FI (CC BY 4.0) + Tilastokeskuksen Paavo (CC BY 4.0)",
    vianosoitus:
      "Postin PCF-tiedosto ja OSM-käännösgeokoodaus: käytetty vain osoittamaan mitkä rivit " +
      "ovat rikki ja mitkä koodit ovat olemassa. Mitään PCF:stä johdettua koordinaattia tai " +
      "nimeä ei ole tässä aineistossa — ks. lisenssiperustelu skriptissä.",
  },
  paavonAlueita: paavonAlueet.size,
  korjatut: tehdyt.map((k) => ({
    postinumero: k.pn,
    paikka: k.nimi,
    ennen: k.ennen,
    jalkeen: k.jalkeen,
    siirtymaKm: k.siirtymaKm,
    tunnistin: k.tunnistin,
    todiste: k.todiste,
  })),
  poistetut: poistetut.map((k) => ({
    postinumero: k.pn,
    paikka: k.nimi,
    ennen: k.ennen,
    syy: k.syy,
  })),
  poistojenYlaraja: POISTOJEN_YLARAJA,
  vanhentuneetKoodit: {
    selite:
      "Koodeja joita Posti ei enää myönnä mutta jotka SÄILYTETÄÄN. Näiden koordinaatti on " +
      "todennetusti oikea, joten haku palauttaa oikean paikkakunnan sään — poisto veisi " +
      "toimivan haun ilman että mikään virhe korjaantuisi. Mitattu: 24 lakkautetusta koodista " +
      "vain yhden (97999) koordinaatti oli väärin.",
    koodit: vanhentuneet.map((k) => ({
      postinumero: k.pn,
      paikka: k.nimi,
      koordinaatti: k.koordinaattiNyt,
      tilastokeskusTunteeYha: k.paavo2026,
      koordinaatinTarkistus: k.koordinaatti,
    })),
  },
  tunnetutPuutteet: TUNNETUT_PUUTTEET.map((k) => ({ postinumero: k.pn, paikka: k.nimi, syy: k.syy })),
  lisatyt: lisatytRivit.map((k) => ({
    postinumero: k.pn,
    paikka: k.nimi,
    koordinaatti: k.koordinaatti,
    kopioituKoodilta: k.kopioiKoodilta,
    peruste: k.peruste,
  })),
  hyvaksytytPoikkeamat: poikkeamat.map((k) => ({
    postinumero: k.pn,
    paikka: k.nimi,
    etaisyysKm: k.etaisyysKm,
    syy: k.syy,
  })),
}, null, 2)}\n`);

const koko = fs.statSync(OUT).size;
console.log(`\nkirjoitettu ${OUT}`);
console.log(`  postinumeroita : ${Object.keys(jarjestetty).length}`);
console.log(`  koko           : ${koko} tavua (${zlib.gzipSync(fs.readFileSync(OUT)).length} gzipattuna)`);
console.log(`kirjoitettu ${LOKI}`);
console.log(`  korjattuja ${tehdyt.length}, poistettuja ${poistetut.length}, lisättyjä ${lisatytRivit.length}, säilytettyjä vanhentuneita ${vanhentuneet.length}, hyväksyttyjä poikkeamia ${poikkeamat.length}`);
