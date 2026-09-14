# Käyttöönotto Linuxilla (Surface Pro 4)

Tämä on **vaihtoehto** [Windows-ohjeelle](KAYTTOONOTTO.md), ei sen korvaaja.
Syy: Surface Pro 4:n 6. sukupolven Intel-suoritin ei ole Windows 11:n tuettujen
laitteiden listalla, joten tietoturvapäivitysten saanti on epävarmaa. Backend on
tarkoituksella tavallinen Node-prosessi ilman Windows-riippuvuuksia juuri tätä
varten — se siirtyy Linuxille ilman koodimuutoksia.

## 0. Distro-valinta

**Suositus: Debian stable** (tätä kirjoittaessa *bookworm*). Kioskikoneelle
harvat, ennakoitavat päivitykset ja pitkä tuki ovat tärkeämpiä kuin uusin
ohjelmisto: Debian stable ei riko käyttöliittymää puolivuosittaisella isolla
versionostolla, toisin kuin esim. Ubuntun väliversiot.

Haittapuoli: Debian stablen ydin on liian vanha Surface Pro 4:n
kosketusnäytölle eikä sisällä Surface-ajureita lainkaan. Tämän ratkaisee
**linux-surface**-projektin oma pakettivarasto (kohta 2), joka tarjoaa paikatun
ytimen Debianille erikseen — Debianin oma pakettihallinta ja päivityssykli
säilyvät, vain ydin tulee toisesta lähteestä.

## 1. Esivalmistelut

Asenna Debian stable tavalliseen tapaan (esim. netinst-ISO). Valitse
asennuksessa **työpöytäympäristöksi "ei mitään" tai vain "standard system
utilities"** — kioski asentaa itse vain sen minkä tarvitsee (kohta 5), ei täyttä
työpöytää.

```bash
sudo apt update
sudo apt install curl sudo
```

## 2. linux-surface-ydin

Tämä on **käyttöjärjestelmätason toimenpide, joka tehdään käsin ennen**
`asenna-kioski.sh`-skriptin ajamista — skripti ei asenna ydintä itse, koska
väärä ydin voi jättää koneen käynnistymättä eikä se ole turvallista automatisoida
ilman paikan päällä olevaa ihmistä.

```bash
# Lisää linux-surfacen pakettivarasto ja allekirjoitusavain
curl -fsSL https://raw.githubusercontent.com/linux-surface/linux-surface/master/pkg/keys/surface.asc \
    | sudo gpg --dearmor -o /etc/apt/trusted.gpg.d/linux-surface.gpg
echo "deb [signed-by=/etc/apt/trusted.gpg.d/linux-surface.gpg] https://pkg.surfacelinux.com/debian release main" \
    | sudo tee /etc/apt/sources.list.d/linux-surface.list

sudo apt update
sudo apt install linux-image-surface linux-headers-surface iptsd
```

`iptsd` on **kosketusnäytön oma palvelu** (IPTS-ajuri tuottaa raakadatan, iptsd
tulkitsee sen kosketustapahtumiksi) — ilman sitä ydin on paikattu mutta ruutu ei
silti reagoi kosketukseen.

### Secure Boot

Surface Pro 4:n UEFI on nirso Secure Bootin suhteen linux-surface-ytimen
kanssa. Kaksi vaihtoehtoa:

1. **Poista Secure Boot käytöstä** UEFI-asetuksista — yksinkertaisin, ja
   riittävä kioskikoneelle joka on jo fyysisesti valvotussa tilassa.
2. **Lisää linux-surfacen allekirjoitusavain** UEFI:in (Machine Owner Key), jos
   Secure Boot halutaan säilyttää. Ks. ajantasaiset ohjeet
   [linux-surface-wikistä](https://github.com/linux-surface/linux-surface/wiki/Installation-and-Setup) —
   vaihe muuttuu käyttöjärjestelmäversioittain, eikä sitä toisteta tässä.

Käynnistä uudelleen ja tarkista että uusi ydin on käytössä:

```bash
uname -r    # pitäisi sisältää "surface"
systemctl status iptsd
```

`asenna-kioski.sh` tarkistaa saman automaattisesti ja varoittaa jos ydin tai
`iptsd` puuttuu, mutta ei estä asennusta sen takia — taustapalvelin toimii
kosketuksesta riippumatta.

## 3. Node.js 24

Tarvitaan vain kehityskopiolle (kohta 4B); julkaisupaketissa Node on mukana.

```bash
node --version    # v24.x tai uudempi
```

Debian stablen `apt install nodejs` antaa **liian vanhan** version — projekti
vaatii Node ≥ 24:n natiivin TypeScript-tuen ja sisäänrakennetun
`node:sqlite`-moduulin takia. Käytä NodeSourcen varastoa:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo bash -
sudo apt install nodejs
```

Vaihtoehtoisesti `nvm`, jos haluat pystyttää useamman version rinnakkain.

## 4. Projektin asennus

Kaksi tapaa, valitse toinen — **älä sekoita molempia samalla koneella**, koska
kumpikin kirjoittaa samat tiedostot: `infonaytto.service`,
`/etc/lightdm/lightdm.conf.d/50-infonaytto-autologin.conf` ja
`~/.config/openbox/autostart`.

### 4A. Julkaisupaketti (suositus tavalliseen käyttöön)

Ei vaadi Nodea, npm:ää eikä git-yhteyttä kohdekoneelle — paketti sisältää oman
Node-ajonsa (`node/bin/node`) ja käännetyn käyttöliittymän valmiina.

```bash
# Pura julkaisupaketti esim. kotikansioon, sitten:
cd infonaytto-julkaisu/asennus     # kansion nimi riippuu paketista
sudo ./asenna.sh
```

Skripti kysyy interaktiivisesti kaiken tarvittavan (asennushakemisto, portti,
sään postinumero, Wilma- ja Päikky-tunnukset, kalenterin ICS-osoite, PIN-koodit,
luotetut laitteet), kirjoittaa `.env`-tiedoston oikeuksin 600, tarjoaa
automaattikäynnistyksen (systemd-palvelu + lightdm/openbox-kioski, sama malli
kuin `asenna-kioski.sh`:ssä alla) ja **todentaa asennuksen** käynnistämällä
palvelimen ja kyselemällä `/api/health`-osoitetta ennen kuin ilmoittaa
onnistumisesta. Lopuksi se tarjoaa yhden Wilma-yhteystestin.

> **Päikyn salasana kannattaa saada kerralla oikein.** Päikky-tili lukkiutuu
> epäonnistuneista kirjautumisista, ja sama tunnus on huoltajan omassa
> puhelimessa — väärä salasana täällä kaataa siis muutakin kuin näytön. Sama
> koskee Wilmaa (ks. kohta 8).

**Päivitys** on sama komento samaan kohteeseen (`sudo ./asenna.sh`). Se
säilyttää aina `data/`-kansion (tietokanta, muistilista, hälytysäänet, lokit) ja
käyttää olemassa olevan `.env`:n arvoja oletuksina, joten Enterillä pääsee läpi
tuhoamatta mitään. Vain puuttuvat asetukset kysytään ja lisätään tiedoston
loppuun koskematta vanhoihin riveihin tai oikeuksiin. Vanhat `WEATHER_LAT`,
`WEATHER_LON` ja `WEATHER_PLACE` säilyvät siis sellaisinaan — palvelin käyttää
niitä varareittinä jos postinumerosta ei löydy sijaintia — eikä uuteen
asennukseen niitä kirjoiteta lainkaan.

Jos vastaat päivityskysymykseen *ei* ja annat asetukset uudestaan, `.env`
kirjoitetaan kokonaan uusiksi ja vanhat koordinaatit katoavat; skripti luettelee
katoavat avaimet ennen vahvistusta.

Purku: `sudo ./asenna.sh --poista` (ks. skriptin oma ohje: `--help`).

### 4B. Kehityskopio (git clone + npm)

Tälle on oma skriptinsä, `asenna-kioski.sh` (kohta 5). Vaatii Node.js 24:n
(kohta 3) ja npm:n riippuvuuksien asentamiseen.

```bash
git clone <projektin-osoite> ~/infonaytto   # tai kopioi tiedostot muutoin
cd ~/infonaytto
npm ci
cp .env.example .env
nano .env
npm run build
```

`.env`-sisältö on sama riippumatta käyttöjärjestelmästä: tiedoston omat
kommentit kertovat jokaisesta avaimesta, ja tiiviimpi listaus on
[Windows-ohjeen taulukossa](KAYTTOONOTTO.md#mitä-env-tiedostoon).

> **Käytä lainausmerkkejä salasanoissa:** kirjoita `WILMA_PASSWORD=<salasana>`
> aina muodossa `WILMA_PASSWORD="<salasana>"`. Node katkaisee lainausmerkittömän
> arvon risuaidan (`#`) kohdalta äänettömästi, ja palvelin yrittää kirjautua
> katkelmalla. Lainausmerkit ovat turvalliset myös silloin kun niitä ei tarvita.

Kokeile ensin käsin:

```bash
npm start
```

Avaa `http://localhost:4173` (voi olla toiselta koneelta samassa verkossa,
palvelin ei ole vielä rajattu localhostiin tässä vaiheessa). Jos jokin kortti
näyttää virhettä, katso `data/logs/`.

## 5. Kioski käyttöön (kehityskopiolle, kohta 4B)

Jos asensit julkaisupaketilla (kohta 4A), `asenna.sh` kysyi tämän jo.

```bash
sudo apt install lightdm openbox chromium unclutter
cd ~/infonaytto/asennus
sudo ./asenna-kioski.sh
```

`unclutter` on valinnainen (piilottaa hiiren osoittimen kosketuskäytössä).

Skripti tarkistaa esiehdot (Node-versio, käännetty käyttöliittymä, `.env`,
Chromium, lightdm, openbox, curl) ja kertoo selkeästi jos jokin puuttuu, ennen
kuin mitään asennetaan. Sitten se tekee:

1. **`infonaytto.service`** — systemd-järjestelmäpalvelu, joka käynnistää
   taustapalvelimen koneen mukana ja uudelleenkäynnistää sen aina jos se kaatuu
   (`Restart=always`, ei ylärajaa uudelleenyrityksille — laite on seinällä eikä
   sitä käydä käynnistämässä käsin). Kovennettu
   `ProtectSystem=strict` + `ReadWritePaths=…/data`: palvelin saa kirjoittaa
   vain omaan `data`-kansioonsa.
2. **Automaattikirjautuminen lightdm:llä** valitulle käyttäjälle, oletusistunto
   `openbox`.
3. **`~/.config/openbox/autostart`** kyseiselle käyttäjälle: sammuttaa
   näytönsäästäjän ja DPMS:n (`xset`), odottaa taustapalvelinta enintään kaksi
   minuuttia ja avaa Chromiumin kioskitilassa osoitteeseen
   `http://localhost:4173`.
4. **Virranhallinnan eston**: `systemctl mask sleep.target suspend.target
   hibernate.target hybrid-sleep.target` — kone ei mene lepotilaan eikä
   horrostilaan riippumatta siitä mikä sen yrittäisi laukaista. Tämä ei ole
   mukavuusasia, ks. kohta 6.

Purku: `sudo ./asenna-kioski.sh --poista` (pysäyttää ja poistaa palvelun ja
automaattikirjautumisen, palauttaa virranhallinnan; ei kosketa käännettyyn
koodiin eikä `.env`-tiedostoon).

### Kioskista poistuminen

Pidä sormea painettuna yläpalkin **päivämäärätekstin perässä noin 3 sekuntia**
ja anna avautuvaan dialogiin **`FULL_PIN`** (`EDIT_PIN` ei riitä). Oikean koodin
jälkeen palvelin sulkee Chromiumin (`pkill -f infonaytto-chromium` — täsmää
kiinteään profiilikansioon, ks. kohdan 5 autostart-skripti) ja jättää
openbox-työpöydän näkyviin. Jos `FULL_PIN` ei ole käytössä (tyhjä tai alle 6
merkkiä), painike ei tee mitään.

Painallusalue on näkymätön eikä siinä ole visuaalista vihjettä, eikä se ole
ruudun nurkassa — nurkkaan osutaan helposti pöytää pyyhittäessä.

**Käynnistä kioski takaisin:**

1. `sudo reboot` — varmin tapa: autologin ja openbox-autostart palauttavat
   kaiken automaattisesti.
2. Ilman uudelleenkäynnistystä (vaatii näppäimistön tai SSH-yhteyden):
   `sudo systemctl restart lightdm` — sulkee graafisen istunnon hetkeksi ja avaa
   sen uudelleen, mikä käynnistää Chromiumin taas.

### Miksi lightdm eikä pelkkä systemd-palvelu selaimelle

Kioskiselain tarvitsee graafisen istunnon (X-palvelimen, näyttöoikeudet), eikä
sitä siksi voi käynnistää tavallisena system-palveluna ilman kirjautunutta
istuntoa. Vaihtoehtoja oli kaksi:

- **getty-autologin + `.bash_profile` + `startx`** — toimii, mutta jokainen osa
  (VT-vaihto, X:n käynnistys, kaatumisen jälkeinen uudelleenyritys) pitää
  rakentaa ja testata itse.
- **lightdm + openbox** *(valittu)* — lightdm on kypsä, systemd-hallittu
  palvelu, joka hoitaa X:n elinkaaren, VT-vaihdot ja uudelleenyritykset
  valmiiksi. openbox on kevyin mahdollinen ikkunanhallinta Chromiumin taustalle.
  Vähemmän itse ylläpidettävää logiikkaa.

### Virranhallinta: X11 vs. Wayland

Kioski käyttää **X11:tä** (lightdm+openbox), koska se on kypsempi yhdistelmä
linux-surface-ytimen kanssa ja koska näytön DPMS/näytönsäästäjän esto
`xset s off; xset s noblank; xset -dpms` on suoraviivainen ja hyvin
dokumentoitu. Skripti **ei toteuta** Wayland-vaihtoehtoa — se vain dokumentoidaan
tässä siltä varalta että vaihdat myöhemmin.

**Waylandilla** kioski rakennettaisiin
[**cage**](https://github.com/cage-kiosk/cage)-kompositorilla, joka on
suunniteltu juuri tähän: yksi sovellus koko ruudulla, ei ikkunanhallintaa.

```bash
sudo apt install cage
cage -- chromium --kiosk http://localhost:4173
```

- `xset`-komennot eivät toimi Waylandilla. DPMS-esto tehdään `wlopm`-tyyppisellä
  työkalulla tai jätetään pois, koska monet Wayland-kompositorit eivät itse
  sammuta näyttöä ilman erillistä idle-daemonia (esim. `swayidle`) — jota tässä
  ei asenneta.
- Konsolin näytönsammutus (`consoleblank`) on Waylandilla relevantimpi kuin
  X11:llä, koska ruutu voi olla puhtaalla tekstikonsolilla ennen kuin cage
  käynnistyy. Lisää `consoleblank=0` GRUB:n
  `GRUB_CMDLINE_LINUX_DEFAULT`-riville ja aja `sudo update-grub`.
- Automaattikirjautuminen ilman lightdm:ää: `getty@tty1.service`-override
  (`ExecStart=-/sbin/agetty --autologin kayttaja --noclear %I $TERM`) ja
  käyttäjän `.bash_profile`, joka käynnistää `cage`n.

Lepotilan ja horrostilan esto (`systemctl mask sleep.target …`) toimii
identtisesti kummallakin, koska se ei riipu näyttöpalvelimesta.

## 6. Mikä ei toimi tai on riski — lue tämä

Sama rehellisyysperiaate kuin Windows-ohjeen laiteriskiosiossa: ei kaunistella.

- **Kamerat eivät toimi** linux-surfacen kanssa. Merkityksetöntä tässä käytössä
  (infonäyttö ei käytä kameraa).
- **Kosketusnäyttö jumiutuu lepotilasta heräämisen jälkeen** — tunnettu
  linux-surface-bugi: IPTS-moduuli korruptoituu kun Intel ME nukahtaa laitteen
  mennessä lepotilaan. Tämä infonäyttö **ei koskaan mene lepotilaan** (kohta 5),
  joten bugi ei pääse realisoitumaan — mutta se on juuri **se syy**, miksi
  virranhallinnan pois kytkeminen on tällä laitteella pakollista. Jos joku
  poistaa maskauksen käsin ja kone nukahtaa, kosketus voi vaatia
  uudelleenkäynnistyksen palatakseen.
- **Marvellin Wi-Fi/Bluetooth-laiteohjelmisto** on SP4:llä ajoittain omituinen
  linux-surface-yhteisön raporttien mukaan (satunnaisia yhteyskatkoja). Ei ole
  estänyt tätä käyttöä, koska haut tehdään 15–20 minuutin välein eikä mitään
  striimata. Jos verkko katkeilee, tarkista onko kyseessä tunnettu
  firmware-ongelma ennen kuin epäilet omaa koodia.
- **linux-surface on yhteisöprojekti**, ei Microsoftin eikä minkään jakelun
  virallisesti ylläpitämä. Ytimen päivitykset tulevat omalla tahdillaan, voivat
  rikkoa jonkin ominaisuuden väliaikaisesti, ja projektin jatkuvuus riippuu
  ylläpitäjien ajasta. Sama tietoinen riski kuin Windows-ohjeen "laite on jo
  olemassa, kokeilu on halpa" -periaate, ei uusi.

## 7. Vianetsintä

**Lokit** (kaksi paikkaa, eri tarkoitukseen):

```bash
journalctl -u infonaytto.service -f       # systemd: käynnistys, kaatumiset, exit-koodit
tail -f ~/infonaytto/data/logs/*.log      # sovelluksen oma loki: Wilma/sää/kalenteri-tilat
```

Tarkempi sovellusloki: lisää `.env`-tiedostoon `LOG_LEVEL=debug` ja käynnistä
palvelu uudelleen. Silloin rikkoutuneen Wilma-vastauksen raaka HTML tallentuu
kansioon `data/snapshots/`.

**Palveluiden uudelleenkäynnistys:**

```bash
sudo systemctl restart infonaytto.service   # vain taustapalvelin
sudo systemctl restart lightdm              # koko kioski-istunto (sulkee näytön hetkeksi)
```

**Jos kosketus ei toimi:**

1. `uname -r` — sisältääkö "surface"? Jos ei, ydin ei ole vaihtunut
   (uudelleenkäynnistys unohtui, tai GRUB käynnistää oletusytimen — tarkista
   `grep menuentry /boot/grub/grub.cfg`).
2. `systemctl status iptsd` — onko palvelu käynnissä ja ilman virheitä?
3. `dmesg | grep -i ipts` — näkyykö laitteen tunnistus käynnistyslokissa?
4. Jos kone on ollut lepotilassa (ei pitäisi tapahtua, ks. kohta 6): käynnistä
   uudelleen.

**Jos näyttö jää kirjautumisruutuun eikä kioski avaudu automaattisesti:**
tarkista tukeeko asennettu lightdm-versio automaattikirjautumista suoraan
`/etc/lightdm/lightdm.conf.d/`-tiedostolla vai vaatiiko se käyttäjän lisäämistä
`autologin`-ryhmään (`sudo usermod -aG autologin kayttaja`) — tämä vaihtelee
jakeluversioittain, ja `asenna-kioski.sh` tulostaa tästä muistutuksen asennuksen
lopussa.

**Jos kioski avautuu mutta näyttää yhteysvirheen:** taustapalvelin ei ehtinyt
vastata kahdessa minuutissa. Käynnistä selain uudelleen
(`sudo systemctl restart lightdm`) ja tarkista samalla
`journalctl -u infonaytto.service` löytyykö käynnistysvirhettä.

**Jos Wilma-kortti lakkaa toimimasta**, etsi sovelluslokista rivi
`wilma_empty_parse`: sivu haettiin onnistuneesti mutta siitä ei saatu irti
mitään, eli koulun Wilman rakenne on muuttunut. Näyttö jatkaa sillä välin
viimeisimmän onnistuneen datan näyttämistä vanhentuneena, joten aamun
lukujärjestys ei katoa heti. Korjaus tulee uuden julkaisupaketin mukana.
Kirjaston ylläpito ja Wilman katkaisijan perustelut:
[`docs/wilma.md`](../docs/wilma.md).

## 8. Tietoturva

Alustariippumattomat periaatteet ja niiden perustelut ovat tiedostossa
[`docs/tietoturva.md`](../docs/tietoturva.md). Lyhyesti:

- Wilman ja Päikyn datan lukureitit vastaavat vain **localhostista**. Kotiverkon
  puhelin näkee sään, sähkön, kalenterin ja muistilistan — ei lasten tietoja.
- Muokkaus muualta kuin näyttölaitteelta vaatii PIN-koodin yläpalkin
  lukkokuvakkeesta. `EDIT_PIN` antaa muokkausoikeuden mutta **ei** lasten
  tietoja; `FULL_PIN` (väh. 6 merkkiä) antaa nekin. Vaihtoehtona laite voidaan
  lisätä `TRUSTED_HOSTS`-listalle, jolloin koodia ei tarvita.
- **Kioskista poistuminen** (kohta 5) vaatii nimenomaan `FULL_PIN`:n, ja pyyntö
  hyväksytään vain näyttölaitteelta itseltään, ei etänä. Syy: poistuminen antaa
  pääsyn koko työpöydälle ja sitä kautta `.env`:n salasanoihin.
- **Tilin lukituksen esto**: kolme peräkkäistä epäonnistunutta
  Wilma-kirjautumista pysäyttää yritykset (Päikyssä kaksi). Jos vaihdat
  salasanan, päivitä se `.env`-tiedostoon ja käynnistä palvelu uudelleen —
  `.env` luetaan vain käynnistyksessä.
- Salasanoja, evästeitä eikä viestien sisältöjä kirjoiteta lokiin.

Linux-kohtaista:

- `asenna-kioski.sh` tiukentaa `.env`-tiedoston oikeudet (`chmod 600`) joka
  ajolla eikä koskaan löysennä niitä, koska tiedostossa on salasanat
  selväkielisenä. `asenna.sh` luo `.env`:n suoraan oikeuksin 600 eikä koskaan
  kirjoita sitä ensin väljemmillä oikeuksilla.
- Taustapalvelu on ajossa tavallisena käyttäjänä, ei roottina, ja
  `ProtectSystem=strict` rajaa sen kirjoitusoikeuden pelkkään `data`-kansioon.

## Widgettien asetukset

Kortin otsikon hammasratas avaa sen omat asetukset. Yläpalkin asetuksissa
valitaan näkyvät paneelit, asettelu ja yötila. Katso
[widgettien asetukset ja uutisten lukeminen](../docs/widget-settings.md).
