# Tietoturva

Kaikki tietoturvaratkaisut ja niiden perustelut. Asennusohjeissa
([`asennus/KAYTTOONOTTO.md`](../asennus/KAYTTOONOTTO.md),
[`asennus/KAYTTOONOTTO-LINUX.md`](../asennus/KAYTTOONOTTO-LINUX.md)) on vain se,
mitä laitteella pitää tehdä.

- Tunnukset vain `.env`-tiedostossa, joka on `.gitignore`ssa. `.env.example` on
  malli ja **menee gittiin** — siihen ei kirjoiteta oikeita arvoja. Nimet ovat
  hämäävän lähellä toisiaan, joten tämä on helppo sekoittaa.
- Wilma- ja **Päikky-datan** lukureitit vastaavat vain **localhostista** —
  kotiverkon puhelin näkee sään ja muistilistan, ei lasten koulu- eikä
  varhaiskasvatustietoja. Puhelimessa kortilla lukee "Vain infonäytöllä" eikä
  se jää pyörimään ikuiseen "Haetaan…"-tilaan. Todennettu oikealla datalla:
  lähiverkon vastauksesta ei löydy lapsen nimeä, oppilasnumeroa, oppiainetta
  eikä opettajan nimeä.
- **Päikyn läsnäolotieto on erikseen harkittava.** Kortti näyttää "paikalla
  klo 8:00 alkaen", kun lapsi on kirjattu sisään. Se on alaikäisen
  sijaintitieto, ja seinänäyttö on yhteisessä tilassa, jossa käy vieraita —
  toisin kuin Wilma-viesti, jonka näkee vasta napauttamalla, tämä rivi on
  esillä ilman mitään elettä. Verkkopuolen suoja (edellinen kohta) ei kosketa
  tätä lainkaan: se säätelee kuka verkossa, ei kuka huoneessa. Varausajat
  ("varattu 8:00–16:10") ovat tavallista aikataulua; toteutunut läsnäolo ei.
- Sama koskee viestejä: viestien sisällön voi piilottaa asetuksista, jolloin
  kortilla näkyy vain lähettäjä ja otsikko.
- Salasanoja, evästeitä eikä viestien sisältöjä kirjoiteta lokiin.
- Wilman ja Päikyn salasanat ovat `.env`-tiedostossa **selväkielisenä**. Se on
  tietoinen kompromissi. Asennusskriptit rajaavat tiedoston oikeudet asentavaan
  käyttäjään, mikä ei poista riskiä mutta estää koneen muita käyttäjätilejä
  lukemasta sitä.

## Kaksi PIN-koodia

Puhelimessa yläpalkin lukkokuvake avaa syöttökentän; koodi jää selaimen
muistiin, ja sen voi unohtaa dialogista tai asetuksista. Molemmat koodit menevät
samaan kenttään — palvelin päättää tason ja kertoo sen näytöllä.

| Koodi | Antaa | Ei anna |
|---|---|---|
| `EDIT_PIN` | Muistilista, asetukset, hälytykset | Lasten Wilma- ja Päikky-tiedot |
| `FULL_PIN` | Kaiken, myös lasten tiedot | — |

PIN ei ole sidottu verkko-osoitteeseen, joten se toimii silloinkin kun
puhelimen IP:tä ei tiedä tai DHCP vaihtaa sen — juuri se tilanne johon
`TRUSTED_HOSTS` ei taivu.

**`FULL_PIN` on vähintään kuusi merkkiä.** Lyhyempää ei oteta käyttöön
lainkaan: taso jää pois päältä ja loki kertoo miksi. Pelkkä varoitus jättäisi
heikon suojan voimaan hiljaa, ja käyttäjä luulisi suojanneensa lasten tiedot.
`EDIT_PIN`-koodille ei vastaavaa rajaa — se avaa vain ostoslistan ja asetukset,
eli eri panokset ja eri vaatimus. Tyhjä arvo tarkoittaa että kyseinen taso ei
ole käytössä, eikä käyttöliittymä tarjoa sitä.

Arvausrajoitin: viisi väärää yritystä lukitsee lähteen 15 minuutiksi, ja
lukituksen aikana myös oikea koodi torjutaan. Kuusimerkkisen koodin läpikäynti
kestäisi vuosikymmeniä. Rajoitinta kuluttaa **vain aito väärä arvaus** —
puuttuva otsikko tai oikea koodi väärällä tasolla ei koskaan. Ilman tätä
erottelua tavallisen muokkauskoodin käyttäjä olisi lukinnut itsensä ulos
muutamassa minuutissa, koska sama otsikko lähtee jokaisessa taustapollauksessa.

Rehellinen varauma: koodi jää selaimen muistiin kunnes se erikseen unohdetaan,
eikä sitä ole sidottu laitteeseen. Jos puhelin katoaa, ainoa keino perua sen
pääsy on vaihtaa koodi — mikä katkaisee kaikki laitteet kerralla.

## Luotetut laitteet (`TRUSTED_HOSTS`)

`.env`-tiedostoon voi listata pilkulla erotettuna IP-osoitteita ja/tai
konenimiä (esim. oma puhelin), jotka saavat täsmälleen samat oikeudet kuin
näyttölaite itse: näkevät Wilma-datan, voivat merkitä viestin luetuksi ja
muokata muistilistaa ja asetuksia ilman PIN-koodia. Tyhjä tai asettamaton
`TRUSTED_HOSTS` vastaa täsmälleen nykyistä käytöstä.

Lista on **tarkoituksella vain `.env`:ssä**, ei asetusnäkymässä eikä
rajapinnassa: jos sitä voisi muokata rajapinnan kautta, kuka tahansa
muokkausoikeuden saanut laite voisi lisätä itsensä siihen ja ohittaa koko
rajauksen. Muutos vaatii siis tiedostojärjestelmäpääsyn ja palvelimen
uudelleenkäynnistyksen.

Laitelista ja `FULL_PIN` ovat eri työkaluja samaan tarpeeseen: lista on sidottu
osoitteeseen ja toimii ilman että kukaan syöttää mitään, koodi taas toimii
miltä tahansa laitteelta mutta jää selaimen muistiin.

Rehellinen varauma: tämä ei ole vahva todennus, vaan verkko-osoitteen
luottamista.

- **DHCP voi antaa saman IP:n toiselle laitteelle myöhemmin** — reitittimeltä
  kannattaa varata luotetulle laitteelle kiinteä IP, muuten luottamus voi ajan
  myötä siirtyä täysin toiselle laitteelle huomaamatta.
- **Konenimeen luottaminen on heikompaa kuin osoitteeseen**, koska se nojaa
  kotiverkon DNS:ään: konenimi ratkaistaan taustalla noin 5 minuutin välein,
  ei jokaisella pyynnöllä (hitautta ja haurautta varten), joten muutos näkyy
  viiveellä, ja kuka tahansa sama DNS voi periaatteessa vastata väärin.
- **Ei aliverkkotukea** (esim. `192.168.10.0/24`) — vain yksittäisiä laitteita
  voi listata. Tämä on tietoinen rajaus: aliverkon luottaminen tekisi koko
  kotiverkosta yhden kirjoitusvirheen päässä olevan asian.
- `X-Forwarded-For`-otsikkoon ei luoteta missään muodossa eikä Fastifyn
  `trustProxy`-asetusta oteta käyttöön — asiakkaan osoite tulee aina suoraan
  socketista, ei asiakkaan lähettämästä otsikosta.

## Kioskista poistuminen

Selain ei voi purkaa omaa kioskitilaansa (JavaScript ei pääse siihen käsiksi),
joten poistuminen on palvelimen toteuttama: pidä sormea yläpalkin
**päivämäärätekstin perässä noin 3 sekuntia**, jolloin avautuu vahvistusdialogi,
joka kysyy `FULL_PIN`:n. Oikean koodin jälkeen palvelin sulkee kioskiselaimen ja
työpöytä jää näkyviin. Alustakohtaiset komennot ja kioskin takaisinkäynnistys
ovat asennusohjeissa.

Alue on näkymätön eikä siinä ole visuaalista vihjettä — tarkoituksella, jottei
se erotu vahingossa kenellekään. Se ei ole ruudun nurkassa, koska nurkkaan
osutaan helposti pöytää pyyhittäessä tai näyttöä siirrettäessä, ja pitkä
painallus valittiin yhden napautuksen sijaan samasta syystä.

Miksi juuri `FULL_PIN`: kioskista poistuminen antaa pääsyn koko työpöydälle ja
sitä kautta `.env`-tiedoston salasanoihin selväkielisenä, ei vain muistilistan
ja asetusten muokkaukseen. Jos `FULL_PIN`:iä ei ole asetettu (tai se on alle
kuusi merkkiä), painike ei tee mitään — ominaisuus on tällöin kokonaan pois
käytöstä. Pyyntö hyväksytään vain näyttölaitteelta itseltään, ei etänä
`TRUSTED_HOSTS`-laitteelta eikä `FULL_PIN`:llä varustetulta puhelimelta.
