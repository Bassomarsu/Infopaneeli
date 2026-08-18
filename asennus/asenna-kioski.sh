#!/usr/bin/env bash
#
# Ottaa Infonäytön käyttöön Linux-kioskina:
#   - taustapalvelin systemd-järjestelmäpalveluna (käynnistyy koneen mukana,
#     nousee automaattisesti kaatumisen jälkeen)
#   - Chromium kioskitilassa automaattikirjautuvassa lightdm+openbox-istunnossa
#   - virranhallinta pois käytöstä (lepotila, horrostila, näytön DPMS)
#
# Tämä skripti on KEHITYSKOPIOLLE (git clone + npm ci + npm run build) -- jos
# olet ottamassa käyttöön puretusta JULKAISUPAKETISTA, jossa Node on jo
# mukana eikä npm:ää tarvita, käytä sen sijaan asenna.sh:ta (kysyy myös
# Wilma-tunnukset ym. asetukset interaktiivisesti ja todentaa asennuksen).
#
# Aja pääkäyttäjänä projektin "asennus"-kansiosta:
#
#   sudo ./asenna-kioski.sh
#
# Purku (pysäyttää ja poistaa palvelut, palauttaa virranhallinnan):
#
#   sudo ./asenna-kioski.sh --poista
#
# Ks. KAYTTOONOTTO-LINUX.md käyttöohjeineen, distro-suosituksineen ja
# tunnetuin rajoituksin (mm. linux-surface-ydin Surface Pro 4:llä).

set -euo pipefail

# --- Asetukset ----------------------------------------------------------

PORTTI="${INFONAYTTO_PORTTI:-4173}"
PALVELIN_YKSIKKO="infonaytto.service"
PALVELIN_YKSIKKO_POLKU="/etc/systemd/system/$PALVELIN_YKSIKKO"
AUTOLOGIN_TIEDOSTO="/etc/lightdm/lightdm.conf.d/50-infonaytto-autologin.conf"
AUTOSTART_MERKKI="# Hallitaan: asenna-kioski.sh -- älä muokkaa käsin, muutokset katoavat seuraavalla ajolla."

POISTA=0
KAYTTAJA=""

tulosta_kaytto() {
    cat <<USAGE
Käyttö: $0 [--poista] [--kayttaja=nimi] [--portti=4173]

  --poista          Pysäyttää ja poistaa palvelut, palauttaa virranhallinnan.
                     Ei koske näytön DPMS-asetuksia, jotka ovat osa kioski-
                     selaimen omaa käynnistystiedostoa ja häviävät sen mukana.
  --kayttaja=nimi   Käyttäjä, jonka istuntoon kioski asennetaan. Oletuksena
                     päätellään \$SUDO_USER-muuttujasta (eli tavallinen
                     "sudo $0" riittää, kunhan et ole kirjautunut suoraan
                     root-käyttäjänä).
  --portti=4173     Portti, jossa taustapalvelin kuuntelee.
USAGE
}

for arg in "$@"; do
    case "$arg" in
        --poista) POISTA=1 ;;
        --kayttaja=*) KAYTTAJA="${arg#--kayttaja=}" ;;
        --portti=*) PORTTI="${arg#--portti=}" ;;
        -h|--help) tulosta_kaytto; exit 0 ;;
        *)
            echo "Tuntematon valitsin: $arg" >&2
            tulosta_kaytto >&2
            exit 1
            ;;
    esac
done

# --- Perustarkistukset ---------------------------------------------------

if [[ "$(id -u)" -ne 0 ]]; then
    echo "Aja tämä skripti pääkäyttäjänä: sudo $0 $*" >&2
    exit 1
fi

PROJEKTI_JUURI="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -z "$KAYTTAJA" ]]; then
    KAYTTAJA="${SUDO_USER:-}"
fi
if [[ -z "$KAYTTAJA" || "$KAYTTAJA" == "root" ]]; then
    echo "En pystynyt päättelemään käyttäjää, jonka istuntoon kioski asennetaan." >&2
    echo "Aja skripti 'sudo'-komennolla tavallisena käyttäjänä, tai anna se erikseen:" >&2
    echo "  sudo $0 --kayttaja=nimi" >&2
    exit 1
fi
if ! id "$KAYTTAJA" &>/dev/null; then
    echo "Käyttäjää '$KAYTTAJA' ei ole olemassa." >&2
    exit 1
fi
KAYTTAJAN_KOTI="$(getent passwd "$KAYTTAJA" | cut -d: -f6)"
if [[ -z "$KAYTTAJAN_KOTI" || ! -d "$KAYTTAJAN_KOTI" ]]; then
    echo "Käyttäjän '$KAYTTAJA' kotikansiota ei löytynyt." >&2
    exit 1
fi

# --- Purku ----------------------------------------------------------------

if [[ "$POISTA" -eq 1 ]]; then
    echo "Puretaan Infonäytön kioskiasennus..."

    if systemctl list-unit-files "$PALVELIN_YKSIKKO" &>/dev/null && [[ -f "$PALVELIN_YKSIKKO_POLKU" ]]; then
        systemctl disable --now "$PALVELIN_YKSIKKO" 2>/dev/null || true
        rm -f "$PALVELIN_YKSIKKO_POLKU"
        systemctl daemon-reload
        echo "Poistettu palvelu: $PALVELIN_YKSIKKO"
    else
        echo "Palvelua ei ollut: $PALVELIN_YKSIKKO"
    fi

    if [[ -f "$AUTOLOGIN_TIEDOSTO" ]]; then
        rm -f "$AUTOLOGIN_TIEDOSTO"
        echo "Poistettu automaattikirjautuminen: $AUTOLOGIN_TIEDOSTO"
    else
        echo "Automaattikirjautumista ei ollut asetettu."
    fi

    AUTOSTART_POLKU="$KAYTTAJAN_KOTI/.config/openbox/autostart"
    if [[ -f "$AUTOSTART_POLKU" ]] && grep -qF "$AUTOSTART_MERKKI" "$AUTOSTART_POLKU"; then
        rm -f "$AUTOSTART_POLKU"
        echo "Poistettu kioskiselaimen käynnistystiedosto: $AUTOSTART_POLKU"
    elif [[ -f "$AUTOSTART_POLKU" ]]; then
        echo "VAROITUS: $AUTOSTART_POLKU on olemassa muttei näytä tämän skriptin luomalta -- ei poisteta." >&2
    else
        echo "Kioskiselaimen käynnistystiedostoa ei ollut."
    fi

    systemctl unmask sleep.target suspend.target hibernate.target hybrid-sleep.target 2>/dev/null || true
    echo "Virranhallinta (lepotila, horrostila) palautettu."

    echo ""
    echo "Valmis. lightdm-näyttöpalvelinta ei käynnistetty uudelleen tässä istunnossa,"
    echo "joten muutos näkyy täysin vasta seuraavan uudelleenkäynnistyksen jälkeen"
    echo "(tai: sudo systemctl restart lightdm -- tämä sulkee mahdollisen auki olevan kioskin heti)."
    exit 0
fi

# --- Esiehdot ---------------------------------------------------------------

echo "Tarkistetaan esiehdot..."
VIRHEITA=0

NODE_BIN=""
if ! NODE_BIN="$(command -v node)"; then
    echo "PUUTTUU: Node.js ei löydy PATH:ista. Asenna Node 24 tai uudempi (NodeSource-varasto" >&2
    echo "         tai nvm) -- ks. KAYTTOONOTTO-LINUX.md. Debianin apt-paketti on liian vanha." >&2
    VIRHEITA=1
else
    NODE_MAJOR="$(node -e 'console.log(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
    if [[ "$NODE_MAJOR" -lt 24 ]]; then
        echo "PUUTTUU: Node on versiota $(node -v 2>/dev/null || echo '?'), tarvitaan >=24." >&2
        echo "         Debianin apt-paketti on tähän liian vanha -- ks. KAYTTOONOTTO-LINUX.md." >&2
        VIRHEITA=1
    fi
fi

PALVELIN_TIEDOSTO="$PROJEKTI_JUURI/server/src/index.ts"
if [[ ! -f "$PALVELIN_TIEDOSTO" ]]; then
    echo "PUUTTUU: palvelinta ei löydy polusta $PALVELIN_TIEDOSTO." >&2
    echo "         Aja skripti projektin 'asennus'-kansiosta." >&2
    VIRHEITA=1
fi

if [[ ! -d "$PROJEKTI_JUURI/node_modules" ]]; then
    echo "PUUTTUU: riippuvuuksia ei ole asennettu. Aja ensin: npm ci" >&2
    VIRHEITA=1
fi

if [[ ! -f "$PROJEKTI_JUURI/web/dist/index.html" ]]; then
    echo "VAROITUS: käyttöliittymää ei ole käännetty. Aja 'npm run build' ennen kuin näyttö avataan." >&2
fi

if [[ ! -f "$PROJEKTI_JUURI/.env" ]]; then
    echo "VAROITUS: .env puuttuu -- Wilma ja kalenteri eivät toimi ennen kuin se on täytetty." >&2
fi

CHROMIUM=""
for ehdokas in chromium chromium-browser; do
    if command -v "$ehdokas" &>/dev/null; then
        CHROMIUM="$(command -v "$ehdokas")"
        break
    fi
done
if [[ -z "$CHROMIUM" ]]; then
    echo "PUUTTUU: Chromiumia ei löydy. Asenna: sudo apt install chromium" >&2
    VIRHEITA=1
fi

if ! command -v lightdm &>/dev/null && [[ ! -x /usr/sbin/lightdm ]]; then
    echo "PUUTTUU: lightdm ei ole asennettu. Asenna: sudo apt install lightdm openbox" >&2
    VIRHEITA=1
fi
if ! command -v openbox &>/dev/null; then
    echo "PUUTTUU: openbox ei ole asennettu. Asenna: sudo apt install openbox" >&2
    VIRHEITA=1
fi
if ! command -v curl &>/dev/null; then
    echo "PUUTTUU: curl ei ole asennettu. Asenna: sudo apt install curl" >&2
    VIRHEITA=1
fi

if [[ "$VIRHEITA" -ne 0 ]]; then
    echo "" >&2
    echo "Esiehdot eivät täyty -- keskeytetään ennen kuin mitään asennetaan." >&2
    exit 1
fi

# Ydin- ja kosketusnäyttötarkistus on pelkkä varoitus, ei este: skriptiä pitää
# voida ajaa myös ennen linux-surface-ytimen asennusta, esim. taustapalvelinta
# testatessa muulla laitteistolla.
KAYNNISSA_YDIN="$(uname -r)"
if [[ "$KAYNNISSA_YDIN" != *surface* ]]; then
    echo ""
    echo "VAROITUS: käynnissä oleva ydin ($KAYNNISSA_YDIN) ei vaikuta linux-surface-ytimeltä."
    echo "  Surface Pro 4:n kosketusnäyttö ei toimi ilman sitä. Ks. KAYTTOONOTTO-LINUX.md,"
    echo "  kohta \"linux-surface-ydin\"."
elif ! systemctl is-active --quiet iptsd 2>/dev/null; then
    echo ""
    echo "VAROITUS: linux-surface-ydin on käytössä, mutta iptsd-palvelu ei ole päällä."
    echo "  Kosketusnäyttö ei toimi ilman sitä:"
    echo "    sudo apt install iptsd && sudo systemctl enable --now iptsd"
fi

echo "Esiehdot kunnossa."

# --- Taustapalvelin systemd-yksikkönä ---------------------------------------

echo ""
echo "Asennetaan taustapalvelin..."

PALVELIN_YKSIKKO_SISALTO="$(cat <<EOF
[Unit]
Description=Infonäytön taustapalvelin
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$KAYTTAJA
WorkingDirectory=$PROJEKTI_JUURI/server
ExecStart=$NODE_BIN --env-file-if-exists=../.env src/index.ts
Restart=always
RestartSec=5
StartLimitIntervalSec=0
StandardOutput=journal
StandardError=journal
NoNewPrivileges=true
ProtectSystem=strict
PrivateTmp=true
ReadWritePaths=$PROJEKTI_JUURI/data

[Install]
WantedBy=multi-user.target
EOF
)"

if [[ ! -f "$PALVELIN_YKSIKKO_POLKU" ]] || [[ "$(cat "$PALVELIN_YKSIKKO_POLKU")" != "$PALVELIN_YKSIKKO_SISALTO" ]]; then
    printf '%s\n' "$PALVELIN_YKSIKKO_SISALTO" > "$PALVELIN_YKSIKKO_POLKU"
    systemctl daemon-reload
    echo "Kirjoitettu: $PALVELIN_YKSIKKO_POLKU"
else
    echo "Palvelutiedosto oli jo ajan tasalla."
fi

mkdir -p "$PROJEKTI_JUURI/data"
chown "$KAYTTAJA:$KAYTTAJA" "$PROJEKTI_JUURI/data"

# .env sisältää Wilma-salasanan selväkielisenä -- tiukennetaan oikeudet joka
# ajolla, ei koskaan löysennetä.
if [[ -f "$PROJEKTI_JUURI/.env" ]]; then
    chmod 600 "$PROJEKTI_JUURI/.env"
    chown "$KAYTTAJA:$KAYTTAJA" "$PROJEKTI_JUURI/.env"
fi

systemctl enable --now "$PALVELIN_YKSIKKO"
echo "Palvelu käynnissä ja käynnistyy jatkossa automaattisesti."

# --- Automaattikirjautuminen (lightdm) --------------------------------------
# Kioskiselain tarvitsee graafisen istunnon, joten se ei voi olla tavallinen
# system-palvelu ilman istuntoa. lightdm hoitaa X-palvelimen ja istunnon
# elinkaaren (uudelleenyritykset, VT-vaihdot) valmiiksi ja on jo itsessään
# systemd-palvelu -- sen sijaan että hallittaisiin getty-autologin + startx
# käsin, mikä on hauraampi ja vaatisi oman virhepalautuslogiikan.

echo ""
echo "Asetetaan automaattikirjautuminen (lightdm)..."

AUTOLOGIN_SISALTO="$(cat <<EOF
[Seat:*]
autologin-user=$KAYTTAJA
autologin-user-timeout=0
autologin-session=openbox
user-session=openbox
EOF
)"

mkdir -p "$(dirname "$AUTOLOGIN_TIEDOSTO")"
if [[ ! -f "$AUTOLOGIN_TIEDOSTO" ]] || [[ "$(cat "$AUTOLOGIN_TIEDOSTO")" != "$AUTOLOGIN_SISALTO" ]]; then
    printf '%s\n' "$AUTOLOGIN_SISALTO" > "$AUTOLOGIN_TIEDOSTO"
    echo "Kirjoitettu: $AUTOLOGIN_TIEDOSTO"
else
    echo "Automaattikirjautuminen oli jo asetettu."
fi
echo "Huom: joissain jakeluversioissa lightdm vaatii käyttäjän lisäämistä erilliseen"
echo "'autologin'-ryhmään. Jos näyttö jää kirjautumisruutuun uudelleenkäynnistyksen"
echo "jälkeen, tarkista tämä KAYTTOONOTTO-LINUX.md:n vianetsintäosiosta."

# --- Kioskiselaimen käynnistys (openbox autostart) --------------------------
# openbox on tarkoituksella ilman paneelia/ikkunanreunoja -- pelkkä
# ikkunanhallinta jota Chromiumin kioskitila tarvitsee taustalle. Odotetaan
# taustapalvelinta ennen selaimen avaamista, mutta ei jäädä jumiin jos se ei
# ehdi vastata: Chromium avautuu joka tapauksessa, ja sivun saa päivitettyä
# koskettamalla ruutua uudelleen jos ensimmäinen lataus epäonnistui.

echo ""
echo "Kirjoitetaan kioskiselaimen käynnistys..."

OPENBOX_KANSIO="$KAYTTAJAN_KOTI/.config/openbox"
AUTOSTART_POLKU="$OPENBOX_KANSIO/autostart"
CHROMIUM_PROFIILI="$KAYTTAJAN_KOTI/.config/infonaytto-chromium"
mkdir -p "$OPENBOX_KANSIO"

AUTOSTART_SISALTO="$(cat <<'AUTOSTART_EOF'
#!/bin/sh
__MERKKI__

# Ei näytönsäästäjää eikä näytön sammutusta. Surface Pro 4:llä tämä on myös
# kosketusnäytön toimivuuden edellytys, ks. KAYTTOONOTTO-LINUX.md.
xset s off
xset s noblank
xset -dpms

# Piilota hiiren osoitin kosketuskäytössä, jos unclutter on asennettu.
if command -v unclutter >/dev/null 2>&1; then
    unclutter -idle 0.5 -root &
fi

# Odota taustapalvelinta enintään kaksi minuuttia.
YRITYKSIA=0
while [ "$YRITYKSIA" -lt 60 ]; do
    if curl -fs -o /dev/null "http://localhost:__PORTTI__"; then
        break
    fi
    YRITYKSIA=$((YRITYKSIA + 1))
    sleep 2
done

# --autoplay-policy: ilman tätä selain vaimentaa äänen kunnes sivulla on tehty
# jokin ele. Kouluhälytys soi aamulla eikä kukaan ole koskenut näyttöön yöllä,
# joten ilman lippua hälytys jäisi hiljaiseksi juuri silloin kun sitä tarvitaan.
exec __CHROMIUM__ \
    --kiosk "http://localhost:__PORTTI__" \
    --user-data-dir="__PROFIILI__" \
    --noerrdialogs \
    --disable-infobars \
    --disable-session-crashed-bubble \
    --no-first-run \
    --autoplay-policy=no-user-gesture-required \
    --disable-features=TranslateUI \
    --overscroll-history-navigation=0 \
    --check-for-update-interval=31536000
AUTOSTART_EOF
)"
AUTOSTART_SISALTO="${AUTOSTART_SISALTO//__MERKKI__/$AUTOSTART_MERKKI}"
AUTOSTART_SISALTO="${AUTOSTART_SISALTO//__PORTTI__/$PORTTI}"
AUTOSTART_SISALTO="${AUTOSTART_SISALTO//__CHROMIUM__/$CHROMIUM}"
AUTOSTART_SISALTO="${AUTOSTART_SISALTO//__PROFIILI__/$CHROMIUM_PROFIILI}"

if [[ -f "$AUTOSTART_POLKU" ]] && ! grep -qF "$AUTOSTART_MERKKI" "$AUTOSTART_POLKU"; then
    echo "VAROITUS: $AUTOSTART_POLKU on jo olemassa muttei näytä tämän skriptin luomalta." >&2
    echo "  Ei ylikirjoiteta -- yhdistä sisältö käsin tai poista tiedosto ja aja skripti uudelleen." >&2
else
    printf '%s\n' "$AUTOSTART_SISALTO" > "$AUTOSTART_POLKU"
    chmod +x "$AUTOSTART_POLKU"
    chown "$KAYTTAJA:$KAYTTAJA" "$AUTOSTART_POLKU" "$OPENBOX_KANSIO"
    echo "Kirjoitettu: $AUTOSTART_POLKU"
fi

# --- Virranhallinta ----------------------------------------------------------
# Maskaus estää lepotilan ja horrostilan kokonaan riippumatta siitä mikä
# työpöytäympäristö tai idle-ajastin niitä yrittäisi laukaista -- luotettavampi
# kuin pelkkä desktop-ympäristön asetus. Näytön DPMS/näytönsäästäjä hoidetaan
# yllä olevassa openbox-autostartissa (X11-kohtainen). Jos joskus vaihdetaan
# Waylandiin (esim. cage-kioskikompositori), xset-komennot eivät toimi
# sellaisenaan -- ks. KAYTTOONOTTO-LINUX.md, kohta "Wayland".

echo ""
echo "Virranhallinta: estetään lepotila ja horrostila kokonaan."
systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
echo "Näytön DPMS ja näytönsäästäjä on jo pois käytöstä kioskiselaimen käynnistyksessä."

# --- Valmis -------------------------------------------------------------

echo ""
echo "Valmis. Vielä huomioitavaa:"
echo "  1. Jos käytät linux-surface-ydintä ilman sen allekirjoitusta, tarkista"
echo "     UEFI:n Secure Boot -asetus -- ks. KAYTTOONOTTO-LINUX.md."
echo "  2. Käynnistä kone uudelleen ja varmista että kioski palaa itsestään:"
echo "     sudo reboot"
echo "  3. Kioskitilasta pääsee pois esim. Alt+F4:llä, jos näppäimistö on kytkettynä."
