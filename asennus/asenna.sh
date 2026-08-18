#!/usr/bin/env bash
#
# Asentaa Infonäytön puretusta JULKAISUPAKETISTA -- tämä on tarkoitettu
# tavalliseen käyttöönottoon: paketti sisältää oman Node-ajonsa, eikä
# kohdekoneella tarvitse olla Nodea, npm:ää eikä git-yhteyttä mihinkään.
#
# (Vertailun vuoksi: asenna-kioski.sh on KEHITYSKOPIOLLE, joka on haettu
# git clonella ja jossa riippuvuudet on asennettu npm:llä -- eri tapaus,
# eri skripti. Tämä skripti EI vaadi npm:ää eikä kutsu sitä missään.)
#
# Skripti kysyy kaikki tarvittavat asetukset interaktiivisesti (Enter =
# oletusarvo), kirjoittaa .env-tiedoston oikeuksin 600, tarjoaa
# automaattikäynnistyksen (systemd-palvelu + kioskiselain) ja lopuksi
# todentaa että palvelin oikeasti vastaa ennen kuin ilmoittaa onnistumisesta.
#
# Aja pääkäyttäjänä puretun paketin "asennus"-kansiosta:
#
#   sudo ./asenna.sh
#
# Purku (automaattikäynnistys pois -- EI poista .env:iä, data/-kansiota
# eikä asennushakemistoa):
#
#   sudo ./asenna.sh --poista
#
# Ks. KAYTTOONOTTO-LINUX.md.

set -euo pipefail

# --- CLI-valitsimet -------------------------------------------------------

POISTA=0
KAYTTAJA=""
KOHDE_ARG=""

tulosta_kaytto() {
    cat <<USAGE
Käyttö: $0 [--poista] [--kayttaja=nimi] [--kohde=polku]

  --poista          Poistaa automaattikäynnistyksen (systemd-palvelu,
                     autologin, kioskiselaimen käynnistys, virranhallinnan
                     esto). EI poista .env-tiedostoa, data/-kansiota eikä
                     asennushakemistoa.
  --kayttaja=nimi   Käyttäjä, jonka istuntoon ja oikeuksin palvelin ja kioski
                     asennetaan. Oletuksena \$SUDO_USER.
  --kohde=polku     Asennushakemisto. Kysytään interaktiivisesti jos
                     puuttuu (--poista: oletus on paketin oma sijainti).
USAGE
}

for arg in "$@"; do
    case "$arg" in
        --poista) POISTA=1 ;;
        --kayttaja=*) KAYTTAJA="${arg#--kayttaja=}" ;;
        --kohde=*) KOHDE_ARG="${arg#--kohde=}" ;;
        -h|--help) tulosta_kaytto; exit 0 ;;
        *)
            echo "Tuntematon valitsin: $arg" >&2
            tulosta_kaytto >&2
            exit 1
            ;;
    esac
done

# --- Perustarkistukset -----------------------------------------------------

if [[ "$(id -u)" -ne 0 ]]; then
    echo "Aja tämä skripti pääkäyttäjänä: sudo $0 $*" >&2
    exit 1
fi

if ! command -v curl &>/dev/null; then
    echo "PUUTTUU: curl ei ole asennettu. Asenna: sudo apt install curl" >&2
    echo "  (asennus todentaa palvelimen curlilla, eikä voi jatkaa ilman sitä)" >&2
    exit 1
fi

PAKETTI_JUURI="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -z "$KAYTTAJA" ]]; then
    KAYTTAJA="${SUDO_USER:-}"
fi
if [[ -z "$KAYTTAJA" || "$KAYTTAJA" == "root" ]]; then
    echo "En pystynyt päättelemään käyttäjää, jonka istuntoon ja oikeuksin asennetaan." >&2
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
# Ei oleteta että käyttäjän ensisijainen ryhmä on samanniminen -- kysytään
# oikea ryhmä sen sijaan että arvattaisiin "$KAYTTAJA:$KAYTTAJA".
KAYTTAJAN_RYHMA="$(id -gn "$KAYTTAJA")"

PALVELIN_YKSIKKO="infonaytto.service"
PALVELIN_YKSIKKO_POLKU="/etc/systemd/system/$PALVELIN_YKSIKKO"
AUTOLOGIN_TIEDOSTO="/etc/lightdm/lightdm.conf.d/50-infonaytto-autologin.conf"
AUTOSTART_MERKKI="# Hallitaan: asenna.sh -- älä muokkaa käsin, muutokset katoavat seuraavalla ajolla."

# --- Apufunktiot: kysymykset ------------------------------------------------

kysy() {
    # kysy MUUTTUJA "kysymys" ["oletus"]
    local __var="$1" __kysymys="$2" __oletus="${3:-}" __prompt __vastaus
    if [[ -n "$__oletus" ]]; then
        __prompt="$__kysymys [$__oletus]: "
    else
        __prompt="$__kysymys: "
    fi
    read -r -p "$__prompt" __vastaus || true
    [[ -z "$__vastaus" ]] && __vastaus="$__oletus"
    printf -v "$__var" '%s' "$__vastaus"
}

kysy_numero() {
    local __var="$1" __kysymys="$2" __oletus="$3" __vastaus
    while true; do
        read -r -p "$__kysymys [$__oletus]: " __vastaus || true
        [[ -z "$__vastaus" ]] && __vastaus="$__oletus"
        if [[ "$__vastaus" =~ ^-?[0-9]+([.][0-9]+)?$ ]]; then
            printf -v "$__var" '%s' "$__vastaus"
            return 0
        fi
        echo "  Anna kelvollinen luku (esim. 62.86667)." >&2
    done
}

kysy_url() {
    # Sallii tyhjän (= ominaisuus pois käytöstä), vaatii http(s):// jos annettu.
    local __var="$1" __kysymys="$2" __oletus="$3" __vastaus
    while true; do
        read -r -p "$__kysymys [$__oletus]: " __vastaus || true
        [[ -z "$__vastaus" ]] && __vastaus="$__oletus"
        if [[ -z "$__vastaus" || "$__vastaus" =~ ^https?:// ]]; then
            printf -v "$__var" '%s' "$__vastaus"
            return 0
        fi
        echo "  Osoitteen pitää alkaa http:// tai https://. Jätä tyhjäksi ohittaaksesi." >&2
    done
}

kysy_salattu() {
    # kysy_salattu MUUTTUJA "kysymys" "nykyinen_arvo"
    # Ei koskaan kaiuta ruudulle. Enter = säilytä nykyinen (tai tyhjä jos ei
    # ollut), '-' = tyhjennä nimenomaisesti.
    local __var="$1" __kysymys="$2" __nykyinen="${3:-}" __tila __vastaus
    if [[ -n "$__nykyinen" ]]; then
        __tila="Enter = säilytä nykyinen, '-' = tyhjennä"
    else
        __tila="Enter = jätä tyhjäksi"
    fi
    read -r -s -p "$__kysymys ($__tila): " __vastaus || true
    echo
    if [[ -z "$__vastaus" ]]; then
        printf -v "$__var" '%s' "$__nykyinen"
    elif [[ "$__vastaus" == "-" ]]; then
        printf -v "$__var" '%s' ""
    else
        printf -v "$__var" '%s' "$__vastaus"
    fi
}

kysy_kylla() {
    # kysy_kylla "kysymys" [oletus: 1=kyllä, 0=ei] -- paluuarvo 0=kyllä, 1=ei
    local __kysymys="$1" __oletus="${2:-0}" __vihje __vastaus
    if [[ "$__oletus" -eq 1 ]]; then __vihje="K/e"; else __vihje="k/E"; fi
    read -r -p "$__kysymys ($__vihje): " __vastaus || true
    __vastaus="$(printf '%s' "$__vastaus" | tr '[:upper:]' '[:lower:]')"
    if [[ -z "$__vastaus" ]]; then
        [[ "$__oletus" -eq 1 ]] && return 0 || return 1
    fi
    case "$__vastaus" in
        k|kylla|kyllä|y|yes) return 0 ;;
        *) return 1 ;;
    esac
}

lue_env_arvo() {
    # lue_env_arvo AVAIN TIEDOSTO -- ei shell-evaluointia, koska arvossa voi
    # olla mitä tahansa merkkejä (Wilma-salasana).
    local avain="$1" tiedosto="$2"
    [[ -f "$tiedosto" ]] || return 0
    grep -E "^${avain}=" "$tiedosto" 2>/dev/null | tail -n1 | cut -d'=' -f2- || true
}

portti_on_varattu() {
    local portti="$1"
    (exec 3<>"/dev/tcp/127.0.0.1/$portti") 2>/dev/null
}

# --- Purku -------------------------------------------------------------

if [[ "$POISTA" -eq 1 ]]; then
    KOHDE="${KOHDE_ARG:-$PAKETTI_JUURI}"
    echo "Puretaan Infonäytön automaattikäynnistys (kohde: $KOHDE)..."

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
    echo "Huom: asennushakemistoa ($KOHDE), .env-tiedostoa eikä data/-kansiota EI poistettu."
    echo "Poista ne itse käsin jos et tarvitse niitä enää, esim.: rm -rf \"$KOHDE\""
    echo ""
    echo "lightdm-näyttöpalvelinta ei käynnistetty uudelleen tässä istunnossa, joten muutos"
    echo "näkyy täysin vasta seuraavan uudelleenkäynnistyksen jälkeen (tai:"
    echo "sudo systemctl restart lightdm -- tämä sulkee mahdollisen auki olevan kioskin heti)."
    exit 0
fi

# --- Asennushakemisto --------------------------------------------------

echo "Infonäytön asennus (julkaisupaketti)"
echo "===================================="
echo ""
echo "Paketti purettuna: $PAKETTI_JUURI"
echo ""

kysy KOHDE "Asennushakemisto" "${KOHDE_ARG:-$PAKETTI_JUURI}"
case "$KOHDE" in
    /*) ;;
    *) KOHDE="$(pwd)/$KOHDE" ;;
esac
# Poista mahdollinen loppukauttaviiva vertailua varten (paitsi juuri "/").
KOHDE="${KOHDE%/}"
[[ -z "$KOHDE" ]] && KOHDE="/"

if [[ "$KOHDE" != "$PAKETTI_JUURI" ]]; then
    if [[ -d "$KOHDE" ]] && [[ -n "$(ls -A "$KOHDE" 2>/dev/null)" ]]; then
        TUNNISTETTU_ASENNUS=0
        if [[ -f "$KOHDE/.env" || -d "$KOHDE/data" || -f "$KOHDE/VERSIO.txt" || -d "$KOHDE/server" ]]; then
            TUNNISTETTU_ASENNUS=1
        fi
        if [[ "$TUNNISTETTU_ASENNUS" -eq 0 ]]; then
            echo "VAROITUS: kohdehakemisto $KOHDE ei ole tyhjä eikä näytä aiemmalta Infonäyttö-asennukselta."
            if ! kysy_kylla "Jatketaanko silti? Tämä voi korvata siellä nimillä server/, web/, node/, node_modules/, asennus/, VERSIO.txt olevia tiedostoja." 0; then
                echo "Keskeytetty."
                exit 1
            fi
        fi
    fi

    echo "Kopioidaan paketti kohteeseen $KOHDE (data/ ja .env säilytetään koskemattomina jos löytyvät)..."
    mkdir -p "$KOHDE"
    for osa in node server web node_modules asennus VERSIO.txt; do
        LAHDE="$PAKETTI_JUURI/$osa"
        [[ -e "$LAHDE" ]] || continue
        rm -rf -- "${KOHDE:?}/${osa:?}"
        cp -a -- "$LAHDE" "$KOHDE/$osa"
    done
    echo "Kopioitu. Alkuperäisen purkukansion ($PAKETTI_JUURI) voi nyt poistaa käsin, jos et tarvitse sitä enää."
else
    echo "Asennetaan paikalleen, ei kopioida."
fi

JUURI="$KOHDE"
DATA_POLKU="$JUURI/data"
ENV_POLKU="$JUURI/.env"
NODE_BIN="$JUURI/node/bin/node"
KAYNNISTYS_POLKU="$JUURI/asennus/kaynnista.sh"

if [[ ! -f "$NODE_BIN" ]]; then
    echo "VIRHE: niputettua Nodea ei löydy polusta $NODE_BIN." >&2
    echo "  Tarkista että purit KOKO julkaisupaketin, et vain 'asennus'-kansiota." >&2
    exit 1
fi
if [[ ! -f "$KAYNNISTYS_POLKU" ]]; then
    echo "VIRHE: käynnistysskriptiä ei löydy polusta $KAYNNISTYS_POLKU." >&2
    exit 1
fi
chmod +x "$NODE_BIN" "$KAYNNISTYS_POLKU"

# --- Olemassa oleva asennus: säilytys ja oletusarvot --------------------

UUDELLEENASENNUS=0
if [[ -f "$ENV_POLKU" || -d "$DATA_POLKU" ]]; then
    echo ""
    echo "Kohteessa $JUURI on jo asennus:"
    [[ -f "$ENV_POLKU" ]] && echo "  - .env löytyi -- alla olevat oletusarvot ovat nykyiset asetuksesi, Enter säilyttää ne."
    [[ -d "$DATA_POLKU" ]] && echo "  - data/ löytyi (tietokanta, muistilista, hälytysäänet, lokit) -- SÄILYTETÄÄN aina, ei kosketa."
    if ! kysy_kylla "Jatketaanko päivitysasennuksena?" 1; then
        echo "Keskeytetty."
        exit 0
    fi
    UUDELLEENASENNUS=1
fi

OLETUS_PORTTI="$(lue_env_arvo PORT "$ENV_POLKU")"; OLETUS_PORTTI="${OLETUS_PORTTI:-4173}"
OLETUS_LOG_LEVEL="$(lue_env_arvo LOG_LEVEL "$ENV_POLKU")"; OLETUS_LOG_LEVEL="${OLETUS_LOG_LEVEL:-warn}"
OLETUS_LAT="$(lue_env_arvo WEATHER_LAT "$ENV_POLKU")"; OLETUS_LAT="${OLETUS_LAT:-62.86667}"
OLETUS_LON="$(lue_env_arvo WEATHER_LON "$ENV_POLKU")"; OLETUS_LON="${OLETUS_LON:-24.78333}"
OLETUS_PAIKKA="$(lue_env_arvo WEATHER_PLACE "$ENV_POLKU")"; OLETUS_PAIKKA="${OLETUS_PAIKKA:-Karstula}"
OLETUS_WILMA_URL="$(lue_env_arvo WILMA_BASE_URL "$ENV_POLKU")"
OLETUS_WILMA_USER="$(lue_env_arvo WILMA_USERNAME "$ENV_POLKU")"
OLETUS_WILMA_PASS="$(lue_env_arvo WILMA_PASSWORD "$ENV_POLKU")"
OLETUS_ICS="$(lue_env_arvo CALENDAR_ICS_URL "$ENV_POLKU")"
OLETUS_EDIT_PIN="$(lue_env_arvo EDIT_PIN "$ENV_POLKU")"
OLETUS_FULL_PIN="$(lue_env_arvo FULL_PIN "$ENV_POLKU")"
OLETUS_TRUSTED="$(lue_env_arvo TRUSTED_HOSTS "$ENV_POLKU")"

# --- Kysymykset ----------------------------------------------------------

echo ""
echo "--- Palvelin ---"
while true; do
    kysy PORTTI "Portti (PORT)" "$OLETUS_PORTTI"
    if ! [[ "$PORTTI" =~ ^[0-9]+$ ]] || (( PORTTI < 1 || PORTTI > 65535 )); then
        echo "  Anna kelvollinen portti (1-65535)." >&2
        continue
    fi
    if portti_on_varattu "$PORTTI"; then
        echo "  VAROITUS: portti $PORTTI näyttää olevan jo käytössä."
        if kysy_kylla "  Käytetäänkö silti? (esim. tämän saman asennuksen käynnissä oleva vanha prosessi)" 0; then
            break
        fi
        continue
    fi
    break
done

while true; do
    kysy LOG_LEVEL "Lokitaso (warn/error/debug)" "$OLETUS_LOG_LEVEL"
    case "$LOG_LEVEL" in
        warn|error|debug) break ;;
        *) echo "  Anna warn, error tai debug." >&2 ;;
    esac
done

echo ""
echo "--- Sää ---"
kysy_numero WEATHER_LAT "Leveysaste (WEATHER_LAT)" "$OLETUS_LAT"
kysy_numero WEATHER_LON "Pituusaste (WEATHER_LON)" "$OLETUS_LON"
kysy WEATHER_PLACE "Paikkakunnan nimi näytölle (WEATHER_PLACE)" "$OLETUS_PAIKKA"

echo ""
echo "--- Wilma (jätä osoite tyhjäksi jos ei käytössä) ---"
kysy_url WILMA_BASE_URL "Wilman osoite, esim. https://koulu.inschool.fi (WILMA_BASE_URL)" "$OLETUS_WILMA_URL"
kysy WILMA_USERNAME "Wilma-tunnus (WILMA_USERNAME)" "$OLETUS_WILMA_USER"
kysy_salattu WILMA_PASSWORD "Wilma-salasana (WILMA_PASSWORD)" "$OLETUS_WILMA_PASS"

echo ""
echo "--- Perhekalenteri ---"
kysy_url CALENDAR_ICS_URL "Kalenterin ICS-osoite (CALENDAR_ICS_URL)" "$OLETUS_ICS"

echo ""
echo "--- Puhelimen muokkausoikeus ---"
kysy_salattu EDIT_PIN "EDIT_PIN (muistilista, asetukset, hälytykset -- ei Wilma-tietoja)" "$OLETUS_EDIT_PIN"
while true; do
    kysy_salattu FULL_PIN "FULL_PIN (myös lasten Wilma-tiedot, vähintään 6 merkkiä)" "$OLETUS_FULL_PIN"
    if [[ -z "$FULL_PIN" || "${#FULL_PIN}" -ge 6 ]]; then
        break
    fi
    echo "  Alle 6 merkkiä -- FULL_PIN EI OTA KÄYTTÖÖN näin lyhyenä, taso jää kokonaan pois päältä." >&2
    echo "  Anna vähintään 6 merkkiä, tai jätä tyhjäksi / '-' poistaaksesi tason käytöstä." >&2
done

kysy TRUSTED_HOSTS "Luotetut laitteet, pilkulla erotettuna (TRUSTED_HOSTS, esim. 192.168.10.50)" "$OLETUS_TRUSTED"

# --- data/ ja .env ---------------------------------------------------------

echo ""
echo "Kirjoitetaan asetukset..."

mkdir -p "$DATA_POLKU"
chown -R "$KAYTTAJA:$KAYTTAJAN_RYHMA" "$DATA_POLKU"

# Tiedosto luodaan ensin TYHJÄNÄ oikeilla oikeuksilla (install -m 600) ja
# vasta sitten kirjoitetaan sisältö -- ei koskaan kirjoiteta ensin ja
# tiukenneta oikeuksia perään, koska siinä välissä tiedosto olisi
# maailmanluettava ja sisältää Wilma-salasanan selväkielisenä.
install -m 600 -o "$KAYTTAJA" -g "$KAYTTAJAN_RYHMA" /dev/null "$ENV_POLKU"
cat > "$ENV_POLKU" <<EOF
# Luotu asenna.sh:lla $(date '+%Y-%m-%d %H:%M') -- voit muokata käsin tämän
# jälkeen. EI mene gittiin. Sisältää Wilma-salasanan selväkielisenä.

PORT=$PORTTI
LOG_LEVEL=$LOG_LEVEL

WEATHER_LAT=$WEATHER_LAT
WEATHER_LON=$WEATHER_LON
WEATHER_PLACE=$WEATHER_PLACE

WILMA_BASE_URL=$WILMA_BASE_URL
WILMA_USERNAME=$WILMA_USERNAME
WILMA_PASSWORD=$WILMA_PASSWORD

CALENDAR_ICS_URL=$CALENDAR_ICS_URL

EDIT_PIN=$EDIT_PIN
FULL_PIN=$FULL_PIN

TRUSTED_HOSTS=$TRUSTED_HOSTS
EOF
echo ".env kirjoitettu ($ENV_POLKU, oikeudet 600, omistaja $KAYTTAJA)."

# --- Automaattikäynnistys -------------------------------------------------

echo ""
AUTOSTART_VALITTU=0
SYSTEMD_KAYTOSSA=1
if [[ ! -d /run/systemd/system ]]; then
    echo "PUUTTUU: systemd ei ole käytössä tällä koneella (ei löydy /run/systemd/system)."
    echo "  Automaattikäynnistystä ja kioskiselainta ei voida asentaa tällä koneella."
    echo "  Palvelin käynnistetään silti käsin todennusta varten: $KAYNNISTYS_POLKU"
    SYSTEMD_KAYTOSSA=0
elif kysy_kylla "Otetaanko automaattikäynnistys käyttöön (taustapalvelin systemd-palveluna + kioskiselain)?" 1; then
    AUTOSTART_VALITTU=1

    echo "Asennetaan taustapalvelin systemd-yksikkönä..."
    PALVELIN_YKSIKKO_SISALTO="$(cat <<EOF
[Unit]
Description=Infonäytön taustapalvelin (julkaisupaketti)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$KAYTTAJA
WorkingDirectory="$JUURI/server"
ExecStart="$KAYNNISTYS_POLKU"
Restart=always
RestartSec=5
StartLimitIntervalSec=0
StandardOutput=journal
StandardError=journal
NoNewPrivileges=true
ProtectSystem=strict
PrivateTmp=true
ReadWritePaths="$DATA_POLKU"

[Install]
WantedBy=multi-user.target
EOF
    )"
    printf '%s\n' "$PALVELIN_YKSIKKO_SISALTO" > "$PALVELIN_YKSIKKO_POLKU"
    systemctl daemon-reload
    systemctl enable --now "$PALVELIN_YKSIKKO"
    echo "Palvelu käynnissä ja käynnistyy jatkossa automaattisesti: $PALVELIN_YKSIKKO"

    echo ""
    echo "Tarkistetaan kioskiselaimen edellytykset..."
    KIOSKI_OK=1
    CHROMIUM=""
    for ehdokas in chromium chromium-browser; do
        if command -v "$ehdokas" &>/dev/null; then
            CHROMIUM="$(command -v "$ehdokas")"
            break
        fi
    done
    if [[ -z "$CHROMIUM" ]]; then
        echo "  PUUTTUU: Chromiumia ei löydy (sudo apt install chromium) -- kioskiselainta ei asenneta, vain taustapalvelin."
        KIOSKI_OK=0
    fi
    if ! command -v lightdm &>/dev/null && [[ ! -x /usr/sbin/lightdm ]]; then
        echo "  PUUTTUU: lightdm ei ole asennettu (sudo apt install lightdm openbox) -- kioskiselainta ei asenneta."
        KIOSKI_OK=0
    fi
    if ! command -v openbox &>/dev/null; then
        echo "  PUUTTUU: openbox ei ole asennettu (sudo apt install openbox) -- kioskiselainta ei asenneta."
        KIOSKI_OK=0
    fi

    if [[ "$KIOSKI_OK" -eq 1 ]]; then
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
        printf '%s\n' "$AUTOLOGIN_SISALTO" > "$AUTOLOGIN_TIEDOSTO"
        echo "Kirjoitettu: $AUTOLOGIN_TIEDOSTO"
        echo "Huom: joissain jakeluversioissa lightdm vaatii käyttäjän lisäämistä erilliseen"
        echo "'autologin'-ryhmään -- ks. KAYTTOONOTTO-LINUX.md jos näyttö jää kirjautumisruutuun."

        echo "Kirjoitetaan kioskiselaimen käynnistys..."
        OPENBOX_KANSIO="$KAYTTAJAN_KOTI/.config/openbox"
        AUTOSTART_POLKU="$OPENBOX_KANSIO/autostart"
        CHROMIUM_PROFIILI="$KAYTTAJAN_KOTI/.config/infonaytto-chromium"
        mkdir -p "$OPENBOX_KANSIO"

        AUTOSTART_SISALTO="$(cat <<'AUTOSTART_EOF'
#!/bin/sh
__MERKKI__

# Ei näytönsäästäjää eikä näytön sammutusta.
xset s off
xset s noblank
xset -dpms

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

# --autoplay-policy: ilman tätä selain vaimentaa äänen kunnes sivulla on
# tehty jokin ele, ja kouluhälytys soi aamulla ilman että kukaan on koskenut
# näyttöön yöllä.
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
            echo "  VAROITUS: $AUTOSTART_POLKU on jo olemassa muttei näytä tämän skriptin luomalta." >&2
            echo "    Ei ylikirjoiteta -- yhdistä käsin tai poista tiedosto ja aja skripti uudelleen." >&2
        else
            printf '%s\n' "$AUTOSTART_SISALTO" > "$AUTOSTART_POLKU"
            chmod +x "$AUTOSTART_POLKU"
            chown "$KAYTTAJA:$KAYTTAJAN_RYHMA" "$AUTOSTART_POLKU" "$OPENBOX_KANSIO"
            echo "Kirjoitettu: $AUTOSTART_POLKU"
        fi

        echo "Estetään lepotila ja horrostila kokonaan."
        systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
    else
        echo "  Kioskiselainta ei asennettu puuttuvien riippuvuuksien takia -- taustapalvelin on silti käytössä."
    fi
else
    echo "Automaattikäynnistystä ei asennettu. Käynnistä palvelin käsin: $KAYNNISTYS_POLKU"
fi

# --- Todennus: käynnistetään ja kysellään /api/health ---------------------

echo ""
echo "Todennetaan asennus..."
KAYNNISSA_TILAPAISESTI=0
TESTILOKI="/tmp/infonaytto-asenna-testi.log"
if [[ "$AUTOSTART_VALITTU" -eq 1 && "$SYSTEMD_KAYTOSSA" -eq 1 ]]; then
    : # palvelu käynnistettiin jo yllä systemdin kautta
else
    KAYNNISTYS_KOMENTO="$(printf '%q' "$KAYNNISTYS_POLKU")"
    su -s /bin/bash -c "$KAYNNISTYS_KOMENTO" "$KAYTTAJA" >"$TESTILOKI" 2>&1 &
    TESTI_PID=$!
    KAYNNISSA_TILAPAISESTI=1
fi

printf 'Odotetaan palvelinta'
ONNISTUI=0
for _ in $(seq 1 30); do
    if curl -fsS -m 2 "http://127.0.0.1:$PORTTI/api/health" >/dev/null 2>&1; then
        ONNISTUI=1
        break
    fi
    printf '.'
    sleep 2
done
echo ""

if [[ "$ONNISTUI" -eq 1 ]]; then
    echo "OK: palvelin vastaa osoitteessa http://127.0.0.1:$PORTTI/api/health"
else
    echo "VIRHE: palvelin EI vastannut 60 sekunnissa. Asennusta EI voida vahvistaa toimivaksi." >&2
    if [[ "$KAYNNISSA_TILAPAISESTI" -eq 1 ]]; then
        echo "  Katso loki: $TESTILOKI" >&2
    else
        echo "  Katso loki: journalctl -u $PALVELIN_YKSIKKO -e" >&2
    fi
    echo "  Katso myös: $DATA_POLKU/logs/" >&2
fi

# --- Wilma-yhteystesti (yksi yritys, ei silmukkaa) -------------------------

if [[ "$ONNISTUI" -eq 1 && -n "$WILMA_BASE_URL" && -n "$WILMA_USERNAME" && -n "$WILMA_PASSWORD" ]]; then
    echo ""
    if kysy_kylla "Testataanko Wilma-yhteys nyt (yksi kirjautumisyritys)?" 1; then
        WILMA_TESTI_TIEDOSTO="/tmp/infonaytto-wilma-testi.json"
        VASTAUS_KOODI="$(curl -sS -o "$WILMA_TESTI_TIEDOSTO" -w '%{http_code}' -m 30 \
            -X POST "http://127.0.0.1:$PORTTI/api/providers/wilma/test" || echo "000")"
        case "$VASTAUS_KOODI" in
            200) echo "Wilma-yhteys OK." ;;
            000) echo "VIRHE: yhteyttä palvelimeen ei saatu Wilma-testiä varten." >&2 ;;
            *)
                echo "Wilma-yhteystesti ei onnistunut (HTTP $VASTAUS_KOODI):"
                cat "$WILMA_TESTI_TIEDOSTO" 2>/dev/null
                echo ""
                ;;
        esac
        rm -f "$WILMA_TESTI_TIEDOSTO"
    fi
fi

if [[ "$KAYNNISSA_TILAPAISESTI" -eq 1 ]]; then
    kill "$TESTI_PID" 2>/dev/null || true
    wait "$TESTI_PID" 2>/dev/null || true
    rm -f "$TESTILOKI"
fi

# --- Yhteenveto -------------------------------------------------------------

LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"

echo ""
echo "===================================="
if [[ "$ONNISTUI" -eq 1 ]]; then
    echo "Asennus valmis ja todennettu toimivaksi."
else
    echo "Asennus KESKEN: palvelin ei vastannut todennuksessa. Katso virheet yllä."
fi
echo "===================================="
echo ""
echo "Asennushakemisto: $JUURI"
echo "Portti:           $PORTTI"
if [[ -n "$LAN_IP" ]]; then
    echo "Puhelimella:      http://$LAN_IP:$PORTTI  (sää ja muistilista -- ei lasten Wilma-tietoja)"
else
    echo "Puhelimella:      http://<tämän koneen LAN-IP>:$PORTTI"
fi
echo ""
if [[ "$AUTOSTART_VALITTU" -eq 1 && "$SYSTEMD_KAYTOSSA" -eq 1 ]]; then
    echo "Käynnistys/pysäytys käsin:"
    echo "  sudo systemctl stop $PALVELIN_YKSIKKO"
    echo "  sudo systemctl start $PALVELIN_YKSIKKO"
    echo "  journalctl -u $PALVELIN_YKSIKKO -f"
    echo ""
    echo "Käynnistä kone uudelleen (sudo reboot) ja tarkista että kioski palaa itsestään."
else
    echo "Käynnistys käsin (jää etualalle, Ctrl+C pysäyttää):"
    echo "  $KAYNNISTYS_POLKU"
fi
echo ""
echo "Poista automaattikäynnistys: sudo \"$JUURI/asennus/asenna.sh\" --poista --kohde=\"$JUURI\""
echo "(.env ja data/-kansio säilyvät -- poista ne käsin jos et tarvitse niitä enää.)"

if [[ "$ONNISTUI" -ne 1 ]]; then
    exit 1
fi
