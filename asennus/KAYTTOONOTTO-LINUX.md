# Käyttöönotto Linuxilla (Surface Pro 4)

Tämä on **vaihtoehto** [Windows-ohjeelle](KAYTTOONOTTO.md), ei sen korvaaja.
Syy vaihtoehtoon on kirjattu Windows-ohjeen laiteriskiosioon: Surface Pro 4:n
6. sukupolven Intel-suoritin ei ole Windows 11:n tuettujen laitteiden
listalla, joten tietoturvapäivitysten saanti on epävarmaa. Backend on
tarkoituksella tavallinen Node-prosessi ilman Windows-riippuvuuksia juuri
tätä varten — se siirtyy Linuxille ilman koodimuutoksia.

## 0. Distro-valinta

**Suositus: Debian stable** (tätä kirjoittaessa *bookworm*).

Perustelu: kioskikoneelle harvat, ennakoitavat päivitykset ja pitkä tuki ovat
tärkeämpiä kuin uusin ohjelmisto. Debian stable ei riko käyttöliittymää
puolivuosittaisella isolla versionostolla, toisin kuin esim. Ubuntun
väliversiot.

Haittapuoli: Debian stablen ydin on liian vanha Surface Pro 4:n
kosketusnäytölle eikä sisällä Surface-ajureita lainkaan. Tämän ratkaisee
**linux-surface**-projektin oma pakettivarasto (kohta 2), joka tarjoaa
paikatun ytimen Debianille erikseen — Debianin oma pakethallinta ja
päivityssykli säilyy, vain ydin tulee toisesta lähteestä.

## 1. Esivalmistelut

Asenna Debian stable tavalliseen tapaan (esim. netinst-ISO). Valitse
asennuksessa **työpöytäympäristöksi "ei mitään" tai vain "standard system
utilities"** — kioski asentaa itse vain sen minkä tarvitsee (kohta 5), ei
täyttä työpöytää.

```bash
sudo apt update
sudo apt install curl sudo
```

## 2. linux-surface-ydin

Tämä on **käyttöjärjestelmätason toimenpide, joka tehdään käsin ennen**
`asenna-kioski.sh`-skriptin ajamista — skripti ei asenna ydintä itse, koska
väärä ydin voi jättää koneen käynnistymättä eikä se ole turvallista
automatisoida ilman paikan päällä olevaa ihmistä.

```bash
# Lisää linux-surfacen pakettivarasto ja allekirjoitusavain
curl -fsSL https://raw.githubusercontent.com/linux-surface/linux-surface/master/pkg/keys/surface.asc \
    | sudo gpg --dearmor -o /etc/apt/trusted.gpg.d/linux-surface.gpg
echo "deb [signed-by=/etc/apt/trusted.gpg.d/linux-surface.gpg] https://pkg.surfacelinux.com/debian release main" \
    | sudo tee /etc/apt/sources.list.d/linux-surface.list

sudo apt update
sudo apt install linux-image-surface linux-headers-surface iptsd
```

`iptsd` on **kosketusnäytön oma palvelu** (IPTS-ajuri tuottaa raakadatan,
iptsd tulkitsee sen kosketustapahtumiksi) — ilman sitä ydin on paikattu mutta
ruutu ei silti reagoi kosketukseen.

### Secure Boot

Surface Pro 4:n UEFI on nirso Secure Bootin suhteen linux-surface-ytimen
kanssa. Kaksi vaihtoehtoa:

1. **Poista Secure Boot käytöstä** UEFI-asetuksista (yksinkertaisin, ja
   riittävä kioskikoneelle joka on jo fyysisesti valvotussa tilassa
   keittiössä).
2. **Lisää linux-surfacen allekirjoitusavain** UEFI:in (Machine Owner Key),
   jos Secure Boot halutaan säilyttää. Ks. ajantasaiset ohjeet
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

Kaksi tapaa, valitse toinen — älä sekoita molempia samalla koneella (kumpikin
kirjoittaa samat tiedostot: `infonaytto.service`,
`/etc/lightdm/lightdm.conf.d/50-infonaytto-autologin.conf`,
`~/.config/openbox/autostart`).

### 4A. Julkaisupaketti (suositus tavalliseen käyttöön)

Ei vaadi Nodea, npm:ää eikä git-yhteyttä kohdekoneelle — paketti sisältää
oman Node-ajonsa (`node/bin/node`) ja käännetyn käyttöliittymän valmiina.

```bash
# Pura julkaisupaketti esim. kotikansioon, sitten:
cd infonaytto-julkaisu/asennus     # kansion nimi riippuu paketista
sudo ./asenna.sh
```

Skripti kysyy interaktiivisesti kaiken tarvittavan (asennushakemisto,
portti, sään koordinaatit, Wilma-tunnukset ja -salasana, kalenterin
ICS-osoite, PIN-koodit, luotetut laitteet), kirjoittaa `.env`-tiedoston
oikeuksin 600, tarjoaa automaattikäynnistyksen (systemd-palvelu +
lightdm/openbox-kioski, sama malli kuin `asenna-kioski.sh`:ssä alla) ja
**todentaa asennuksen** käynnistämällä palvelimen ja kyselemällä
`/api/health`-osoitetta ennen kuin ilmoittaa onnistumisesta. Lopuksi se
tarjoaa yhden Wilma-yhteystestin.

Uudelleenajo (`sudo ./asenna.sh` uudestaan samaan kohteeseen) on normaali
tapa päivittää asetuksia tai paketti — se säilyttää aina `data/`-kansion
(tietokanta, muistilista, hälytysäänet, lokit) ja käyttää olemassa olevan
`.env`:n arvoja oletuksina, joten Enterillä läpi pääsee tuhoamatta mitään.

Purku: `sudo ./asenna.sh --poista` (ks. skriptin oma ohje: `--help`).

### 4B. Kehityskopio (git clone + npm)

Tälle on oma skriptinsä, `asenna-kioski.sh` (kohta 5) — vaatii Node.js 24:n
kohdekoneelle (kohta 3) ja npm:n riippuvuuksien asentamiseen.

```bash
git clone <projektin-osoite> ~/infonaytto   # tai kopioi tiedostot muutoin
cd ~/infonaytto
npm ci
cp .env.example .env
nano .env         # täytä Wilma-tunnukset ja kalenterin ICS-osoite
npm run build
```

`.env`-sisältö on sama riippumatta käyttöjärjestelmästä, ks.
[Windows-ohjeen taulukko](KAYTTOONOTTO.md#mitä-env-tiedostoon).

#### Kokeile ensin käsin

```bash
npm start
```

Avaa selaimessa `http://localhost:4173` (voi olla toiselta koneelta samassa
verkossa, palvelin ei ole vielä rajattu localhostiin tässä vaiheessa). Jos
jokin kortti näyttää virhettä, katso `data/logs/`.

## 5. Kioski käyttöön (kehityskopiolle, kohta 4B)

Jos asensit julkaisupaketilla (kohta 4A), `asenna.sh` kysyi tämän jo eikä
tätä kohtaa tarvitse tehdä erikseen.

```bash
sudo apt install lightdm openbox chromium unclutter
cd ~/infonaytto/asennus
sudo ./asenna-kioski.sh
```

`unclutter` on valinnainen (piilottaa hiiren osoittimen kosketuskäytössä) —
skripti toimii ilmankin, mutta asenna se jos et halua osoittimen jäävän
näkyviin.

Skripti tarkistaa esiehdot (Node-versio, käännetty käyttöliittymä, `.env`,
Chromium, lightdm, openbox, curl) ja kertoo selkeästi jos jokin puuttuu, ennen
kuin mitään asennetaan.

Skripti tekee:

1. **`infonaytto.service`** — systemd-järjestelmäpalvelu, joka käynnistää
   taustapalvelimen koneen mukana ja uudelleenkäynnistää sen aina jos se
   kaatuu (`Restart=always`, ei ylärajaa uudelleenyrityksille — laite on
   seinällä eikä sitä käydä käynnistämässä käsin). Kovennettu
   `ProtectSystem=strict`+`ReadWritePaths=…/data`: palvelin saa kirjoittaa
   vain omaan `data`-kansioonsa, ei mihinkään muualle levylle.
2. **Automaattikirjautuminen lightdm:llä** valitulle käyttäjälle, oletus
   istuntona `openbox`.
3. **`~/.config/openbox/autostart`** kyseiselle käyttäjälle: sammuttaa
   näytönsäästäjän ja DPMS:n (`xset`), odottaa taustapalvelinta enintään
   kaksi minuuttia ja avaa Chromiumin kioskitilassa osoitteeseen
   `http://localhost:4173`.
4. **Virranhallinnan eston**: `systemctl mask sleep.target suspend.target
   hibernate.target hybrid-sleep.target` — kone ei mene lepotilaan eikä
   horrostilaan riippumatta siitä mikä sen yrittäisi laukaista.

Purku: `sudo ./asenna-kioski.sh --poista` (pysäyttää ja poistaa palvelun ja
automaattikirjautumisen, palauttaa virranhallinnan; ei kosketa käännettyä
koodia eikä `.env`-tiedostoon).

### Kioskista poistuminen

Sama ominaisuus kuin Windows-ohjeessa (kioskitilasta poistuminen yläpalkin
päivämäärän perässä olevasta näkymättömästä painikkeesta) — palvelin
toteuttaa sen molemmilla alustoilla samalla tavalla, vain se MITÄ suljetaan
on eri:

- **Kosketuksella**: pidä sormea painettuna yläpalkin **päivämäärätekstin
  perässä noin 3 sekuntia** (näkymätön alue, ei visuaalista vihjettä — ei
  ruudun nurkassa, koska nurkkaan osutaan helposti vahingossa pöytää
  pyyhittäessä tai näyttöä siirrettäessä). Pitkä painallus valittiin yhden
  napautuksen sijaan siksi ettei ele laukea vahingossa. Kysyy täysien
  oikeuksien koodin (`FULL_PIN`) — `EDIT_PIN` ei riitä, ja jos `FULL_PIN`
  ei ole käytössä (tyhjä tai alle 6 merkkiä), painike ei tee mitään.
  Oikean koodin jälkeen palvelin sulkee Chromium-prosessin
  (`pkill -f infonaytto-chromium` — täsmää kiinteään profiilikansioon,
  ks. kohdan 5 autostart-skripti) ja jättää openbox-työpöydän näkyviin.

**Käynnistä kioski takaisin:**

1. `sudo reboot` — varmin tapa: autologin ja openbox-autostart palauttavat
   kaiken automaattisesti.
2. Ilman uudelleenkäynnistystä (vaatii näppäimistön tai SSH-yhteyden):
   `sudo systemctl restart lightdm` — sulkee koko graafisen istunnon
   hetkeksi ja avaa sen uudelleen, mikä käynnistää Chromiumin taas
   (sama komento kuin kohdan 7 vianetsinnässä).

### Miksi lightdm eikä pelkkä systemd-palvelu selaimelle

Kioskiselain tarvitsee graafisen istunnon (X-palvelimen, näyttöoikeudet),
eikä sitä siksi voi käynnistää tavallisena system-palveluna ilman kirjautunutta
istuntoa. Vaihtoehtoja pohdittiin kaksi:

- **getty-autologin + `.bash_profile` + `startx`** — toimii, mutta jokainen
  osa (VT-vaihto, X:n käynnistys, kaatumisen jälkeinen uudelleenyritys) pitää
  rakentaa ja testata itse.
- **lightdm + openbox** *(valittu)* — lightdm on jo itsessään kypsä,
  systemd-hallittu palvelu, joka hoitaa X:n elinkaaren, VT-vaihdot ja
  uudelleenyritykset kaatumisen jälkeen valmiiksi. openbox on kevyin
  mahdollinen ikkunanhallinta Chromiumin taustalle, ei paneelia eikä
  koristeita. Vähemmän itse ylläpidettävää logiikkaa.

### Virranhallinta: X11 vs. Wayland

Tämän skriptin kioski käyttää **X11:ää** (lightdm+openbox), koska se on
tällä hetkellä kypsempi yhdistelmä linux-surface-ytimen kanssa ja koska
näytön DPMS/näytönsäästäjän esto `xset s off; xset s noblank; xset -dpms`
on suoraviivainen ja hyvin dokumentoitu.

**Waylandilla** vastaava kioski rakennettaisiin
[**cage**](https://github.com/cage-kiosk/cage)-kioskikompositorilla, joka on
suunniteltu juuri tähän: yksi sovellus koko ruudulla, ei ikkunanhallintaa.
Pääpiirteet, jos vaihdat myöhemmin:

```bash
sudo apt install cage
cage -- chromium --kiosk http://localhost:4173
```

- `xset`-komennot eivät toimi Waylandilla — DPMS-esto tehdään joko
  `cage`-prosessin ympärille rakennetulla `wlopm`-tyyppisellä työkalulla tai
  jättämällä se pois, koska monet Wayland-kompositorit eivät itse toteuta
  näytön sammutusta ilman erillistä idle-daemonia (esim. `swayidle`) — jota
  ei tässä asenneta, joten ei myöskään sammuteta.
- Konsolin (tekstitason) näytönsammutus (`consoleblank`) on Waylandilla
  relevantimpi kuin X11:llä, koska osa ajasta ruutu voi olla puhtaalla
  tekstikonsolilla ennen kuin cage käynnistyy. Se poistetaan käytöstä
  ytimen käynnistysparametrilla: lisää `consoleblank=0` GRUB:n
  `GRUB_CMDLINE_LINUX_DEFAULT`-riville ja aja `sudo update-grub`.
- Automaattikirjautuminen hoidetaan samalla periaatteella kuin X11:llä,
  mutta ilman lightdm:ää: `getty@tty1.service`-override
  (`ExecStart=-/sbin/agetty --autologin kayttaja --noclear %I $TERM`) ja
  käyttäjän `.bash_profile`, joka käynnistää `cage`n kirjautumisen yhteydessä.

Tämä skripti **ei toteuta** Wayland-vaihtoehtoa — vain dokumentoi sen, koska
X11+lightdm on tällä laitteistolla tällä hetkellä varmempi valinta.

Systeeminlaajuinen lepotilan/horrostilan esto
(`systemctl mask sleep.target …`) toimii identtisesti kummallakin, koska se
ei riipu näyttöpalvelimesta.

## 6. Mikä ei toimi tai on riski — lue tämä

Sama rehellisyysperiaate kuin Windows-ohjeen laiteriskiosiossa: ei
kaunistella.

- **Kamerat eivät toimi** linux-surfacen kanssa. Merkityksetöntä tässä
  käytössä (infonäyttö ei käytä kameraa).
- **Kosketusnäyttö jumiutuu lepotilasta heräämisen jälkeen** —
  tunnettu linux-surface-bugi: IPTS-moduuli korruptoituu kun Intel ME
  nukahtaa laitteen mennessä lepotilaan. Tämä infonäyttö **ei koskaan mene
  lepotilaan** (kohta 5, virranhallinnan esto), joten bugi ei pääse
  realisoitumaan käytännössä — mutta se on juuri **se syy**, miksi
  virranhallinnan pois kytkeminen on tällä laitteella pakollista, ei pelkkä
  mukavuus. Jos joku joskus poistaa maskauksen käsin testausmielessä ja kone
  nukahtaa, kosketus voi vaatia uudelleenkäynnistyksen palatakseen.
- **Marvellin Wi-Fi/Bluetooth-laiteohjelmisto** on SP4:llä ajoittain
  omituinen linux-surface-yhteisön raporttien mukaan (satunnaisia
  yhteyskatkoja). Ei ole estänyt tätä käyttötapausta (kioski tarvitsee
  vakaan verkon vain Wilma/sää/kalenteri-hakuihin 15–20 min välein, ei
  jatkuvaa striimausta), mutta jos verkko katkeilee, tarkista ensin onko
  kyseessä tunnettu firmware-ongelma ennen kuin epäilet omaa koodia.
- **linux-surface on yhteisöprojekti**, ei Microsoftin eikä minkään
  jakelun virallisesti ylläpitämä. Ytimen päivitykset tulevat omalla
  tahdillaan, voivat joskus rikkoa jonkin ominaisuuden väliaikaisesti, ja
  projektin jatkuvuus riippuu ylläpitäjien ajasta. Tämä on sama
  tietoinen riski kuin Windows-ohjeen "laite on jo olemassa, kokeilu on
  halpa" -periaate, ei uusi.

## 7. Vianetsintä

**Taustapalvelimen lokit** (kaksi paikkaa, eri tarkoitukseen):

```bash
journalctl -u infonaytto.service -f       # systemd: käynnistys, kaatumiset, exit-koodit
tail -f ~/infonaytto/data/logs/*.log      # sovelluksen oma loki: Wilma/sää/kalenteri-tilat
```

Vianetsintään yksityiskohtaisempi sovellusloki: lisää `.env`-tiedostoon
`LOG_LEVEL=debug` ja käynnistä palvelu uudelleen.

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
`/etc/lightdm/lightdm.conf.d/`-tiedostolla vai vaatiiko se käyttäjän
lisäämistä `autologin`-ryhmään (`sudo usermod -aG autologin kayttaja`) —
tämä vaihtelee jakeluversioittain, ja `asenna-kioski.sh` tulostaa tästä
muistutuksen asennuksen lopussa.

**Jos kioski avautuu mutta näyttää yhteysvirheen:** taustapalvelin ei
ehtinyt vastata kahdessa minuutissa. Kosketa ruutua koskettamalla
osoiteriviä (jos näppäimistö/hiiri kytkettynä) tai käynnistä selain
uudelleen: `sudo systemctl restart lightdm`. Tarkista samalla
`journalctl -u infonaytto.service` löytyykö käynnistysvirhettä.

## 8. Tietoturva

Samat periaatteet kuin Windows-ohjeessa:

- Wilma-datan lukureitit vastaavat vain localhostista.
- Muokkaus muualta kuin näyttölaitteelta vaatii PIN-koodin, joka syötetään
  yläpalkin lukkokuvakkeesta. `EDIT_PIN` antaa muokkausoikeuden mutta **ei**
  lasten Wilma-tietoja; `FULL_PIN` (väh. 6 merkkiä) antaa nekin. Vaihtoehtona
  laite voidaan lisätä `TRUSTED_HOSTS`-listalle, jolloin koodia ei tarvita.
  Tarkemmin: README, kohta **Tietoturva**.
- **Kioskista poistuminen** (ks. kohta 5) vaatii nimenomaan `FULL_PIN`:n —
  `EDIT_PIN` ei riitä, ja pyyntö hyväksytään vain näyttölaitteelta itseltään,
  ei etänä. Jos `FULL_PIN`:iä ei ole otettu käyttöön, ominaisuus on
  kokonaan pois käytöstä eikä pelkkä painallus päivämäärän kohdalla avaa mitään.
- Salasanoja, evästeitä eikä viestien sisältöjä kirjoiteta lokiin.
- `asenna-kioski.sh` tiukentaa `.env`-tiedoston oikeudet (`chmod 600`) joka
  ajolla eikä koskaan löysennä niitä, koska tiedostossa on Wilma-salasana
  selväkielisenä. `asenna.sh` (julkaisupaketti) luo `.env`:n suoraan oikeuksin
  600 eikä koskaan kirjoita sitä ensin väljemmillä oikeuksilla.
- Taustapalvelu on ajossa tavallisena käyttäjänä, ei roottina, ja
  `ProtectSystem=strict` rajaa sen kirjoitusoikeuden pelkkään
  `data`-kansioon.

## 9. Ylläpito

Sama kuin Windows-ohjeessa — ks.
[`KAYTTOONOTTO.md`, kohta "Ylläpito"](KAYTTOONOTTO.md#7-ylläpito). Wilma-
integraatio ei riipu käyttöjärjestelmästä.
