# Näytön käyttö kosketuksella

Korttien käytös, eleet ja niiden perustelut. Yleiskuva on
[README](../README.md):ssä.

Kaikki vuorovaikutus on suunniteltu sormella käytettäväksi parin metrin
katseluetäisyydeltä: kosketuskohteet ovat vähintään 44×44 pikseliä.

## Lukujärjestyksen päivä ja otsikko

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

## Lukujärjestyksen selaus

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

## Wilma-viestit

Viestin napauttaminen avaa sen kokonaisuudessaan: lähettäjä, aihe, aika ja koko
teksti. Lista jakautuu välilehtiin **Lukematta** ja **Luetut**.

Luettu-tila on **infonäytön oma kirjanpito** (`message_reads`-taulu), ei Wilman:
viesti on luettu kun se on avattu tällä näytöllä. Wilma ei kerro omaa tilaansa
lainkaan (ks. [`wilma.md`](wilma.md)), joten tämä on ainoa tapa jaotella
viestit ilman kirjaston haarauttamista. Puhelimella luettu viesti näkyy
taulussa siis lukemattomana.
Rajoitus on tietoinen ja käyttäjän hyväksymä; se mainitaan viestin
avausnäkymässä, ei kortissa, koska seinäkortilla tila on kallista.

Tila leimataan vastaukseen **pyynnön yhteydessä** eikä kirjoiteta providerin
välimuistiin: merkintä näkyy heti napautuksesta eikä jää odottamaan seuraavaa
Wilma-hakua, eikä paikallinen kirjanpito sekoitu Wilmasta tulleeseen dataan.
Kortti merkitsee viestin luetuksi optimistisesti ja peruu merkinnän jos tallennus
epäonnistuu.

## Kouluhälytykset

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
jonka koulu alkaa aikaisimmin. Hälytyksiä voi olla useita samalle aamulle —
herätys, pukeutuminen, lähtö. Jokaisella on oma selite, ääni, äänenvoimakkuus
ja toistojen määrä. Paneeli näyttää myös **milloin hälytys oikeasti soi** ("soi
klo 7.55"), koska pelkkä "35 min ennen" on vaikea suhteuttaa.

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
piippaus), kukin kuuntelupainikkeineen. Ne tuotetaan selaimessa Web Audio
-rajapinnalla eikä äänitiedostoina — ei uusia riippuvuuksia eikä binäärejä
repoon, ja ääni toimii ilman verkkoa.

**Oman äänitiedoston voi myös valita.** Pudota mp3-, wav-, ogg-, m4a- tai
aac-tiedosto palvelimen `data/sounds/`-kansioon (luodaan automaattisesti) —
ääkköset ja välilyönnit nimessä ovat sallittuja. Palvelin listaa kansion
sisällön hälytyspaneelin pudotusvalikkoon paneelia avattaessa. **Latausta
käyttöliittymästä ei ole**: tiedosto pitää siirtää kansioon esim.
verkkolevyjaon tai USB-muistin kautta, koska kioskiselaimesta ei voi kätevästi
valita tiedostoa eikä latauskäsittely kannata sen kustannuksella.

Jos hälytys viittaa äänitiedostoon jota ei enää löydy, **hälytys ei jää
hiljaiseksi** — se soittaa sisäänrakennetun oletusäänen, ja tilanne näkyy
varoituksena sekä hälytyksen soidessa että hallintapaneelissa.

Selain vaimentaa äänen kunnes sivulla on tehty jokin ele, eikä kukaan koske
näyttöön aamuyöllä. Siksi molemmat asennusskriptit käynnistävät selaimen
`--autoplay-policy=no-user-gesture-required` -lipulla. Jos ääni jää silti
tulematta, syy on todennäköisesti siellä.

## Sään tuntinäkymä

Minkä tahansa ennustepäivän napauttaminen avaa sen päivän 24 tuntia:
lämpötila, tuntuu kuin, sade ja sateen todennäköisyys, tuuli ja säätila.
Kuluvan päivän kohdalla nykyinen tunti korostetaan ja menneet himmennetään.
Näkymä sulkeutuu painikkeesta, Esc-näppäimestä ja taustaa napauttamalla.

## Kalenterin monipäiväiset tapahtumat

Useamman päivän yli jatkuva tapahtuma näkyy **jokaisena päivänä jota se koskee**,
ja pilleri kertoo monesko päivä on menossa ("3/8"). Aiemmin tapahtuma kiinnittyi
vain alkupäiväänsä ja katosi lopuilta päiviltä.

Koko päivän tapahtuman `DTEND` on iCalendarissa **eksklusiivinen**: 24.–26.7.
kestävä tapahtuma on merkitty päättymään 27.7. Tämä on varmistettu oikeasta
syötteestä, ja `node-ical` antaa loppuhetken valmiiksi paikallisena keskiyönä,
joten kesä- ja talviajan siirtymät hoituvat kirjaston puolella eikä päiviä
lasketa käsin. Yhden tapahtuman laajennus on rajattu 60 vuorokauteen, jottei
virheellinen syöte voi kasvattaa sitä hallitsemattomasti.

## Pörssisähkön kuvaaja

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

## Paneelien asettelu

Asetuksista avautuu **muokkaustila**, jossa paneeleita voi raahata ja muuttaa
niiden kokoa oikean alakulman kahvasta. Asettelu tallennetaan palvelimelle,
joten se säilyy kioskiselaimen uudelleenkäynnistyksen yli.

Muokkaus on tarkoituksella oma tilansa eikä aina päällä: seinänäytöllä
vahinkoraahaus pöytää pyyhkiessä olisi kohtuuton haitta. Muokkaustilassa
korttien oma vuorovaikutus on lukittu, joten paneelin siirtäminen ei voi
samalla vaihtaa lukujärjestyksen päivää tai merkitä muistiinpanoa tehdyksi.

Paneelin voi pudottaa toisen **päälle mistä kohtaa tahansa** — kohde tunnistetaan
sormen alla olevasta ruudusta, ei raahatun paneelin kulmasta, jottei kosketuksen
epätarkkuus hylkäisi siirtoa.

**Samankokoiset paneelit vaihtavat paikkaa keskenään. Eri kokoiset eivät.**
Tämä on tietoinen rajoitus: oletusasettelu täyttää koko ruudukon, joten eri
kokoiselle paneelille ei ole tilaa mihin mennä. Kiertotie on yksi kosketus:
kutista jompaakumpaa ensin, jolloin syntyy aidosti vapaata tilaa. Vaihtoehto
olisi ollut kokonainen tiivistysalgoritmi, jonka turvallisuustodistus on paljon
heikompi — nykyisessä mallissa molemmat paneelit siirtyvät toistensa **jo
ennestään kelvollisille** paikoille, joten mikään ei voi mennä päällekkäin tai
ruudukon ulkopuolelle. Hylätty siirto kertoo aina syyn.

Ruudukko on 6 saraketta × 8 riviä. Paneelin **pienin koko on 2×2 solua** — sitä
pienempänä kortti leikkaisi sisältönsä piiloon otsikkoa ja
"vanhentunut"-merkkiä myöten, jolloin rikkinäistä lähdettä ei enää huomaisi.
Palvelin torjuu liian pienet asettelut myös rajapinnassa.

Puhelinnäkymä ei käytä gridiä lainkaan vaan pinoaa kortit yhteen sarakkeeseen
muistilista ensin, joten oma asettelu ei voi rikkoa muistilistan käyttöä
puhelimella.
