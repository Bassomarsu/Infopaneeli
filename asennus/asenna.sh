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
# Skriptillä on kaksi tilaa, ja se päättelee itse kumman kohtaa (sama
# semantiikka kuin Windowsin asenna.ps1:ssä -- pidä nämä kaksi synkassa):
#
#   UUSI ASENNUS (kohteessa ei ole .env-tiedostoa)
#     Kysyy kaikki asetusmallin avaimet, kirjoittaa .env:n oikeuksin 600,
#     tarjoaa automaattikäynnistyksen (systemd-palvelu + kioskiselain) ja
#     lopuksi todentaa että palvelin oikeasti vastaa.
#
#   PÄIVITYS (kohteessa on jo .env)
#     EI kysy tunnuksia uudestaan. Olemassa oleva .env säilyy sellaisenaan
#     oikeuksineen ja omistajineen; siihen vain LISÄTÄÄN ne avaimet joita
#     mallissa on mutta tiedostosta puuttuu (esim. PAIKKY_*, jota ennen
#     Päikky-versiota asennetuissa ei ole). Ohjelmatiedostot peilataan uudesta
#     paketista niin että poistuneet tiedostot oikeasti häviävät, mutta
#     data/-kansioon ei kosketa. Systemd-yksikköä eikä kioskin
#     automaattikäynnistystä ei luoda uudelleen jos ne ovat jo käytössä.
#
# Jos kohteessa on .env, skripti kysyy silti kumpi tehdään -- oletus on
# päivitys, koska se ei hävitä mitään.
#
# SITOVA PAKETTIRAKENNE (tämä skripti olettaa tämän eikä toimi jos se on
# toinen -- ks. skriptit/tee-julkaisu.mjs):
#
#     <asennusjuuri>/
#       node/bin/node    <- niputettu Node
#       server/src/...   <- ajetaan suoraan .ts-tiedostoina
#       server/package.json
#       web/dist/...
#       node_modules/
#       data/            <- palvelin luo, SÄILYTETÄÄN AINA
#       .env             <- tämä skripti luo
#       asennus/asenna.sh, kaynnista.sh
#       VERSIO.txt, LUEMINUT.txt
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

# --- Vakiot -----------------------------------------------------------------

PALVELIN_YKSIKKO="infonaytto.service"
PALVELIN_YKSIKKO_POLKU="/etc/systemd/system/$PALVELIN_YKSIKKO"
AUTOLOGIN_TIEDOSTO="/etc/lightdm/lightdm.conf.d/50-infonaytto-autologin.conf"
AUTOSTART_MERKKI="# Hallitaan: asenna.sh -- älä muokkaa käsin, muutokset katoavat seuraavalla ajolla."
FULL_PIN_MIN_PITUUS=6 # sama raja kuin server/src/routes/access.ts:ssä

# Paketin osat, jotka päivitys korvaa. Tämä lista on tarkoituksella suljettu:
# data/ ja .env EIVÄT ole siinä, joten peilaus ei voi koskea niihin edes
# vahingossa. Ks. peilaa_paketti.
PAKETIN_OSAT=(node server web node_modules asennus VERSIO.txt LUEMINUT.txt)

# =============================================================================
# .env:n asetusmalli
# =============================================================================
# Yksi totuus siitä mitä avaimia .env:ssä on: sekä kysymykset että kirjoitettu
# tiedosto syntyvät tästä samasta listasta. Juuri tätä varten tämä on taulukko
# eikä sarja peräkkäisiä read-kutsuja: PÄIVITYS vertaa tätä listaa olemassa
# olevaan .env-tiedostoon ja kysyy vain ne avaimet joita sieltä puuttuu. Ilman
# tätä Päikky-integraation tuomat PAIKKY_*-avaimet olisivat jääneet kokonaan
# pois jokaisesta ennen Päikkyä tehdystä asennuksesta -- niin kuin kävikin,
# kunnes tämä lisättiin.
#
# KUN .env.exampleen LISÄTÄÄN AVAIN, SE ON LISÄTTÄVÄ MYÖS TÄHÄN. Skripti
# tarkistaa tämän itse jos .env.example sattuu olemaan käsillä (kehityspuu) --
# ks. mallista_puuttuvat_avaimet -- mutta julkaisupaketissa mallitiedostoa ei
# ole mukana, joten tarkistus ei voi olla ainoa turva.
#
# Kentät (malli_lisaa AVAIN TYYPPI OLETUS KEHOTE [otsikko=] [riippuu=]
# [ohje=] [vaihtoehdot=]):
#   TYYPPI       portti | valinta | desimaali | postinumero | teksti | url |
#                salaisuus | fullpin
#   otsikko      ryhmän otsikko: tulostetaan ennen ensimmäistä kysymystä ja
#                kirjoitetaan kommenttina .env-tiedostoon
#   riippuu      kysytään vain jos tällä avaimella on arvo (esim. Wilman
#                tunnus vain jos Wilman osoite annettiin)
#   ohje         rivi joka näytetään ennen kysymystä (voi toistaa)
#   vaihtoehdot  sallitut arvot välilyönnein (TYYPPI = valinta)

declare -a MALLI_AVAIMET=()
declare -A MALLI_TYYPPI=() MALLI_OLETUS=() MALLI_KEHOTE=() MALLI_OTSIKKO=()
declare -A MALLI_RIIPPUU=() MALLI_OHJE=() MALLI_VAIHTOEHDOT=()

malli_lisaa() {
    local avain="$1" tyyppi="$2" oletus="$3" kehote="$4" osa
    shift 4
    MALLI_AVAIMET+=("$avain")
    MALLI_TYYPPI["$avain"]="$tyyppi"
    MALLI_OLETUS["$avain"]="$oletus"
    MALLI_KEHOTE["$avain"]="$kehote"
    MALLI_OTSIKKO["$avain"]=""
    MALLI_RIIPPUU["$avain"]=""
    MALLI_OHJE["$avain"]=""
    MALLI_VAIHTOEHDOT["$avain"]=""
    for osa in "$@"; do
        case "$osa" in
            otsikko=*) MALLI_OTSIKKO["$avain"]="${osa#otsikko=}" ;;
            riippuu=*) MALLI_RIIPPUU["$avain"]="${osa#riippuu=}" ;;
            vaihtoehdot=*) MALLI_VAIHTOEHDOT["$avain"]="${osa#vaihtoehdot=}" ;;
            ohje=*) MALLI_OHJE["$avain"]+="${MALLI_OHJE[$avain]:+$'\n'}${osa#ohje=}" ;;
            *) echo "malli_lisaa: tuntematon kenttä '$osa' avaimelle $avain" >&2; return 1 ;;
        esac
    done
}

malli_lisaa PORT portti 4173 "Portti" \
    otsikko="Palvelin"
malli_lisaa LOG_LEVEL valinta warn "Lokitaso (warn/error/debug)" \
    vaihtoehdot="warn error debug"

malli_lisaa WEATHER_POSTAL_CODE postinumero 43500 "Postinumero säätietoja varten" \
    otsikko="Sää (Open-Meteo, ei API-avainta)" \
    ohje="Palvelin päättelee postinumerosta sekä sijainnin että näytölle" \
    ohje="tulevan paikkakunnan nimen -- koordinaatteja ei tarvitse tietää."

malli_lisaa WILMA_BASE_URL url "" "Wilman osoite, esim. https://koulu.inschool.fi (tyhjä = Wilma pois käytöstä)" \
    otsikko="Wilma"
malli_lisaa WILMA_USERNAME teksti "" "Wilman käyttäjätunnus (huoltaja)" \
    riippuu=WILMA_BASE_URL
malli_lisaa WILMA_PASSWORD salaisuus "" "Wilman salasana" \
    riippuu=WILMA_BASE_URL

malli_lisaa PAIKKY_BASE_URL url "" "Päikyn osoite (tyhjä = Päikky pois käytöstä)" \
    otsikko="Päikky (varhaiskasvatus)" \
    ohje="Kunnan oma Päikky-osoite, esim. https://karstula.paikky.fi. Sama alusta" \
    ohje="pyörii kymmenissä kunnissa, kukin omalla aliverkkotunnuksellaan."
malli_lisaa PAIKKY_USERNAME teksti "" "Päikyn käyttäjätunnus (huoltajan puhelinnumero)" \
    riippuu=PAIKKY_BASE_URL
malli_lisaa PAIKKY_PASSWORD salaisuus "" "Päikyn salasana" \
    riippuu=PAIKKY_BASE_URL \
    ohje="HUOM: Päikky-tili lukkiutuu epäonnistuneista kirjautumisista, ja sama tunnus" \
    ohje="on huoltajan omassa puhelimessa. Väärä salasana täällä kaataa siis muutakin" \
    ohje="kuin näytön -- tarkista se kerralla oikein."

malli_lisaa CALENDAR_ICS_URL url "" "Kalenterin ICS-osoite (Google Calendar, tyhjä = pois käytöstä)" \
    otsikko="Perhekalenteri"

malli_lisaa EDIT_PIN salaisuus "" "EDIT_PIN (tyhjä = ei käytössä)" \
    otsikko="Puhelimen muokkausoikeus" \
    ohje="EDIT_PIN antaa muistilistan/asetusten/hälytysten muokkauksen puhelimesta (ei Wilma-tietoja)."
malli_lisaa FULL_PIN fullpin "" "FULL_PIN (tyhjä = ei käytössä)" \
    ohje="FULL_PIN antaa myös lasten Wilma-tiedot puhelimesta. Vähintään 6 merkkiä," \
    ohje="lyhyempi EI ota tasoa käyttöön lainkaan."
malli_lisaa TRUSTED_HOSTS teksti "" "Luotetut laitteet, pilkulla erotettuna (esim. 192.168.10.50, tyhjä = ei mitään)" \
    otsikko="Luotetut laitteet"

# Avaimet joita asennin EI enää kysy eikä kirjoita, mutta jotka palvelin yhä
# lukee. WEATHER_LAT/LON/PLACE ovat WEATHER_POSTAL_CODEn varareitti: jos
# postinumeroa ei ole, palvelin käyttää näitä. Siksi päivitys ei saa poistaa
# niitä vanhasta .env:stä -- eikä päivitys poistakaan, koska se vain lisää
# puuttuvat avaimet tiedoston loppuun.
#
# Tämä lista on olemassa vain jottei .env.examplen ja mallin vertailu (ks.
# mallista_puuttuvat_avaimet) kaatuisi avaimeen joka on tarkoituksella poistettu
# mallista. Uusi asennus ei kirjoita näitä avaimia lainkaan, ja jos .env
# kirjoitetaan uusiksi, tuntemattomat_avaimet varoittaa niiden katoamisesta --
# se on eri kysymys eikä saa hiljentyä tämän listan takia.
declare -a MALLI_VANHENTUNEET=(WEATHER_LAT WEATHER_LON WEATHER_PLACE)

# =============================================================================
# Puhtaat funktiot -- testattavissa ilman asennusta (ks. test-asenna.sh)
# =============================================================================

sisaltaa() {
    # sisaltaa ETSITTAVA [ALKIO...] -- 0 jos etsittävä on listassa.
    local etsittava="$1" osa
    shift
    for osa in "$@"; do
        [[ "$osa" == "$etsittava" ]] && return 0
    done
    return 1
}

# Muotoilee arvon .env-riville. LAINAUSMERKIT EIVÄT OLE KOSMETIIKKAA: Node
# lukee .env:n --env-file-lipulla ja katkaisee lainausmerkittömän arvon
# risuaidan (#) kohdalta -- loppuosa katoaa äänettömästi. Tämä on jo purrut
# oikeassa käytössä: salasana meni perille kahdeksan merkin katkelmana
# kahdestakymmenestä, kirjautuminen epäonnistui, eikä mikään kertonut syytä.
# Sama koskee välilyöntejä.
#
# Node hyväksyy kolme lainausmerkkiä: ', ` ja ". Valitaan niistä ensimmäinen
# jota arvossa itsessään ei esiinny, koska Node ei tue kenoviivalla suojaamista
# vaan lopettaa arvon seuraavaan samaan merkkiin. Lainausmerkkien SISÄLLÄ Node
# tulkitsee lisäksi merkkiparin \n rivinvaihdoksi, joten kenoviivan sisältävää
# arvoa ei saa lainata "-merkillä.
muotoile_env_arvo() {
    local arvo="${1-}" merkki
    if [[ "$arvo" == *$'\n'* || "$arvo" == *$'\r'* ]]; then
        echo "VIRHE: arvo sisältää rivinvaihdon -- sitä ei voi kirjoittaa .env-tiedostoon turvallisesti." >&2
        return 1
    fi
    for merkki in "'" '`' '"'; do
        if [[ "$merkki" == '"' && ( "$arvo" == *'\n'* || "$arvo" == *'\r'* ) ]]; then
            continue
        fi
        if [[ "$arvo" != *"$merkki"* ]]; then
            printf '%s%s%s' "$merkki" "$arvo" "$merkki"
            return 0
        fi
    done
    echo "VIRHE: arvon lainausmerkkiyhdistelmää ei voida tallentaa .env-tiedostoon muuttumattomana. Vaihda arvoa." >&2
    return 1
}

# Lukee .env:n TÄSMÄLLEEN samalla jäsentimellä jonka palvelin saa
# --env-file-lipusta (node:util parseEnv). Ei shell-evaluointia eikä omaa
# regexiä: asennin ei saa olla eri mieltä tiedoston sisällöstä kuin palvelin,
# ja arvoissa voi olla mitä tahansa merkkejä (Wilma- ja Päikky-salasanat).
# Täyttää globaalin OLEMASSA-taulukon. Tunnukset kulkevat vain muistissa.
declare -A OLEMASSA=()
lataa_env() {
    # lataa_env TIEDOSTO NODE
    local tiedosto="$1" node_bin="$2" avain arvo
    OLEMASSA=()
    [[ -f "$tiedosto" ]] || return 0
    # NUL-erotin: se on ainoa tavu jota .env-arvossa ei voi olla.
    while IFS= read -r -d '' avain && IFS= read -r -d '' arvo; do
        OLEMASSA["$avain"]="$arvo"
    done < <("$node_bin" -e 'const fs=require("node:fs");const {parseEnv}=require("node:util");const o=parseEnv(fs.readFileSync(process.argv[1],"utf8"));let s="";for(const k of Object.keys(o)){s+=k+"\0"+o[k]+"\0";}process.stdout.write(s);' "$tiedosto")
}

# Montako mallin tuntemaa avainta ladatussa .env:ssä on. Vioittunutta tai
# vahingossa tyhjennettyä .env:iä EI voi tunnistaa jäsennysvirheestä -- tyhjä,
# pelkkiä kommentteja sisältävä ja roskainen tiedosto tuottavat kaikki saman
# tyhjän tuloksen, koska parseEnv ei valita mistään. Ainoa kelvollinen mittari
# on se, löytyykö sieltä yhtään avainta jonka asennin tuntee.
tunnettuja_avaimia() {
    local avain maara=0
    for avain in "${MALLI_AVAIMET[@]}"; do
        [[ -v OLEMASSA["$avain"] ]] && maara=$((maara + 1))
    done
    printf '%s' "$maara"
}

# Mallin avaimet joita olemassa olevassa .env:ssä ei ole. Tyhjä arvo EI ole
# puuttuva avain: tyhjä PAIKKY_PASSWORD on kelvollinen tila (Päikky ei
# käytössä), eikä sitä pidä kysyä joka päivityksellä uudestaan.
puuttuvat_avaimet() {
    local avain
    for avain in "${MALLI_AVAIMET[@]}"; do
        [[ -v OLEMASSA["$avain"] ]] || printf '%s\n' "$avain"
    done
}

# .env:n avaimet joita mallissa EI ole. Näitä ei osata kysyä eikä säilyttää
# uudelleenmäärittelyssä, joten käyttäjälle on kerrottava niistä.
tuntemattomat_avaimet() {
    local avain
    for avain in "${!OLEMASSA[@]}"; do
        sisaltaa "$avain" "${MALLI_AVAIMET[@]}" || printf '%s\n' "$avain"
    done | sort
}

# Kehityspuun tarkistus: onko .env.examplessa avaimia joita mallissa ei ole.
# Julkaisupaketissa .env.exampleä ei ole mukana, jolloin tämä palauttaa tyhjän
# eikä väitä mitään. Tämä on ainoa automaattinen turva sitä vastaan että
# asentimet ajautuvat erilleen avain kerrallaan.
#
# Vanhentuneet avaimet eivät ole tässä puute: ne saavat esiintyä
# .env.examplessa ilman että asennus kaatuu. Tarkistus etsii vain sitä yhtä
# vikaa jota varten se on olemassa: .env.exampleen lisättiin UUSI avain jota
# asennin ei osaa kysyä.
mallista_puuttuvat_avaimet() {
    local esimerkki="$1" avain
    [[ -f "$esimerkki" ]] || return 0
    # Rivinvaihto perään: ilman sitä sed jättäisi viimeisen rivin käsittelemättä
    # jos tiedosto ei pääty rivinvaihtoon -- ja juuri viimeinen rivi on se joka
    # uutta avainta lisättäessä tulee tiedoston loppuun.
    { cat "$esimerkki"; printf '\n'; } \
        | sed -nE 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=.*/\2/p' \
        | while IFS= read -r avain; do
            sisaltaa "$avain" "${MALLI_AVAIMET[@]}" "${MALLI_VANHENTUNEET[@]}" || printf '%s\n' "$avain"
        done | sort -u
}

portti_kelpaa() {
    local arvo="${1-}"
    [[ "$arvo" =~ ^[0-9]+$ ]] || return 1
    # Pituusraja ennen (( ))-vertailua: ilman sitä 26-numeroinen syöte
    # ylivuotaisi 64-bittisessä laskennassa ja voisi mennä läpi kelvollisena.
    (( ${#arvo} <= 5 )) || return 1
    (( 10#$arvo >= 1 && 10#$arvo <= 65535 ))
}

desimaali_kelpaa() {
    # Piste eikä pilkku: server/src/core/config.ts lukee arvon JS:n Number():llä.
    [[ "${1-}" =~ ^-?[0-9]+([.][0-9]+)?$ ]]
}

# Suomalainen postinumero: tasan viisi numeroa. Asennin EI tarkista onko
# postinumero olemassa -- se ei tunne postinumeroaineistoa, ja tuntemattomasta
# numerosta kertominen on palvelimen tehtävä (sillä on aineisto käsillä).
postinumero_kelpaa() {
    [[ "${1-}" =~ ^[0-9]{5}$ ]]
}

url_kelpaa() {
    # Tyhjä on kelvollinen (= ominaisuus pois käytöstä).
    [[ -z "${1-}" || "${1-}" =~ ^https?:// ]]
}

# Rakentaa .env-tiedoston sisällön ASETUKSET-taulukosta. Ei kirjoita mitään
# levylle -- testattavissa sellaisenaan.
declare -A ASETUKSET=()
uusi_env_sisalto() {
    local avain muotoiltu
    printf '# Luotu asenna.sh:lla %s -- voit muokata käsin tämän jälkeen.\n' "$(date '+%Y-%m-%d %H:%M')"
    printf '# EI mene gittiin. Sisältää Wilma- ja Päikky-salasanat selväkielisenä.\n'
    printf '#\n'
    printf '# Arvot ovat lainausmerkeissä tarkoituksella: Node katkaisee lainausmerkittömän\n'
    printf '# arvon risuaidan (#) kohdalta, ja loppuosa katoaa äänettömästi.\n'
    for avain in "${MALLI_AVAIMET[@]}"; do
        printf '\n'
        [[ -n "${MALLI_OTSIKKO[$avain]}" ]] && printf '# --- %s ---\n' "${MALLI_OTSIKKO[$avain]}"
        muotoiltu="$(muotoile_env_arvo "${ASETUKSET[$avain]:-}")" || return 1
        printf '%s=%s\n' "$avain" "$muotoiltu"
    done
}

# Päivityksessä .env:iä EI kirjoiteta uusiksi vaan puuttuvat avaimet lisätään
# loppuun. Näin käyttäjän omat kommentit, järjestys ja käsin tehdyt muutokset
# säilyvät sellaisenaan -- ja mikä tärkeintä, tiedoston oikeudet ja omistaja
# säilyvät, koska tiedostoa ei luoda uudelleen.
env_lisays_sisalto() {
    # env_lisays_sisalto AVAIN...
    local avain muotoiltu
    printf '\n# --- Lisätty päivityksessä %s (asenna.sh) ---\n' "$(date '+%Y-%m-%d %H:%M')"
    for avain in "${MALLI_AVAIMET[@]}"; do
        sisaltaa "$avain" "$@" || continue
        muotoiltu="$(muotoile_env_arvo "${ASETUKSET[$avain]:-}")" || return 1
        printf '%s=%s\n' "$avain" "$muotoiltu"
    done
}

lisaa_env_tiedostoon() {
    # lisaa_env_tiedostoon POLKU SISALTO -- ei kosketa oikeuksiin, omistajaan
    # eikä aiempaan sisältöön.
    local polku="$1" sisalto="$2"
    # Komentokorvaus syö lopun rivinvaihdot: jos tulos on tyhjä, viimeinen tavu
    # oli rivinvaihto eikä erotinta tarvita.
    if [[ -s "$polku" && -n "$(tail -c1 "$polku")" ]]; then
        printf '\n' >> "$polku"
    fi
    # Sisältö tulee komentokorvauksesta, joka on jo syönyt lopun rivinvaihdon --
    # se lisätään tässä, jottei tiedosto jää ilman päättävää rivinvaihtoa.
    printf '%s\n' "$sisalto" >> "$polku"
}

# Näyttääkö hakemisto Infonäytön asennukselta. Käytetään ennen peilaavaa
# kopiointia: peilaus poistaa kohteesta paketin osat, joten väärään
# hakemistoon osoitettuna se olisi tuhoisa.
nayttaa_asennukselta() {
    local polku="${1-}" merkki
    [[ -n "$polku" && -d "$polku" ]] || return 1
    for merkki in node/bin/node server/src/index.ts server/package.json asennus/kaynnista.sh VERSIO.txt; do
        [[ -f "$polku/$merkki" ]] || return 1
    done
    # .git = kehityskopio, ei julkaisuasennus. Sinne ei peilata.
    [[ ! -e "$polku/.git" ]]
}

# Polun kanoninen muoto: symlinkit purettuina (pwd -P), ".." ja "." purettuina,
# ilman loppukauttaviivaa. Tätä käytetään ENNEN sisäkkäisyyden vertailua, koska
# pelkkä merkkijonovertailu ei näe että /opt/infonaytto/../infonaytto tai
# symlinkin kautta annettu polku on sama tai sisäkkäinen kohteen kanssa -- ja
# sisäkkäinen peilaus tuhoaisi lähdepaketin kesken kopioinnin.
# Ei käytä realpathia: se ei ole kaikissa minimiasennuksissa, pwd -P on
# sisäänrakennettu.
normalisoi_polku() {
    local polku="${1-}" kansio perus
    [[ -n "$polku" ]] || return 1
    if [[ -d "$polku" ]]; then
        (cd -- "$polku" 2>/dev/null && pwd -P) || return 1
        return 0
    fi
    # Kohdetta ei ole vielä olemassa: normalisoidaan olemassa oleva yläkansio.
    kansio="$(dirname -- "$polku")"
    perus="$(basename -- "$polku")"
    if [[ -d "$kansio" ]]; then
        kansio="$(cd -- "$kansio" 2>/dev/null && pwd -P)" || return 1
        printf '%s' "${kansio%/}/$perus"
    else
        printf '%s' "${polku%/}"
    fi
}

on_ehja_paketti() {
    local polku="${1-}"
    nayttaa_asennukselta "$polku" || return 1
    [[ -f "$polku/web/dist/index.html" && -d "$polku/node_modules" && -f "$polku/asennus/asenna.sh" ]]
}

tarkista_peilaus() {
    local lahde="${1-}" kohde="${2-}" kielletty
    case "$lahde" in /*) ;; *) echo "VIRHE: lähde ei ole absoluuttinen polku: $lahde" >&2; return 1 ;; esac
    case "$kohde" in /*) ;; *) echo "VIRHE: kohde ei ole absoluuttinen polku: $kohde" >&2; return 1 ;; esac
    if [[ -L "$kohde" ]]; then
        echo "VIRHE: linkitettyä asennuspolkua ei hyväksytä: $kohde" >&2
        return 1
    fi
    # Kanoniset polut ENNEN vertailuja. Ilman tätä "/opt/infonaytto/uusi-paketti"
    # ja "/opt/infonaytto/." näyttäisivät eri hakemistoilta, ja sisäkkäinen
    # peilaus poistaisi lähdepaketin alta -- lopputuloksena tyhjä server/src ja
    # rikki mennyt asennus ilman paluureittiä.
    lahde="$(normalisoi_polku "$lahde")" || { echo "VIRHE: lähdepolkua ei voitu selvittää: $1" >&2; return 1; }
    kohde="$(normalisoi_polku "$kohde")" || { echo "VIRHE: kohdepolkua ei voitu selvittää: $2" >&2; return 1; }
    if ! on_ehja_paketti "$lahde"; then
        echo "VIRHE: lähde ei ole ehjä Infonäytön julkaisupaketti: $lahde" >&2
        return 1
    fi
    if [[ "$lahde" == "$kohde" ]]; then
        echo "VIRHE: lähde ja kohde ovat sama hakemisto -- peilaavaa kopiointia ei tehdä." >&2
        return 1
    fi
    if [[ "$kohde" == "$lahde"/* || "$lahde" == "$kohde"/* ]]; then
        echo "VIRHE: lähde ja kohde eivät saa olla sisäkkäisiä hakemistoja: $lahde <-> $kohde" >&2
        echo "  Pura julkaisupaketti asennushakemiston ULKOPUOLELLE (esim. /tmp) ja aja asennin sieltä." >&2
        return 1
    fi
    for kielletty in / /bin /boot /dev /etc /home /lib /opt /proc /root /run /sbin /srv /sys /tmp /usr /var "${KAYTTAJAN_KOTI:-}"; do
        if [[ -n "$kielletty" && "$kohde" == "$kielletty" ]]; then
            echo "VIRHE: hakemisto ei ole sallittu asennuskohde: $kohde" >&2
            return 1
        fi
    done
    if [[ -e "$kohde" && ! -d "$kohde" ]]; then
        echo "VIRHE: asennuskohde ei ole hakemisto: $kohde" >&2
        return 1
    fi
    if [[ -d "$kohde" && -n "$(ls -A "$kohde" 2>/dev/null)" ]] && ! nayttaa_asennukselta "$kohde"; then
        echo "VIRHE: kohde ei ole tyhjä eikä tunnistettu Infonäytön asennus; peilaus estettiin: $kohde" >&2
        echo "  Anna tyhjä hakemisto tai aiempi Infonäytön asennus. (.env ja data/ voi palauttaa" >&2
        echo "  varmuuskopiosta paikalleen vasta asennuksen jälkeen.)" >&2
        return 1
    fi
    return 0
}

# Peilaa paketin osat kohteeseen. Osa poistetaan KOKONAAN ennen kopiointia,
# eikä vain kopioida päälle: jos uusi versio on poistanut tiedoston, sen on
# oikeasti hävittävä kohteesta -- muuten vanhan version .ts-tiedostot jäisivät
# roikkumaan server/src:iin ja voisivat tulla ajetuiksi. (rsync --delete tekisi
# saman, mutta rsync ei ole vakiovaruste jokaisessa jakelussa eikä sitä voi
# olettaa kohdekoneelta; rm -rf + cp -a on coreutilsia ja aina käsillä.)
#
# data/ ja .env eivät ole PAKETIN_OSAT-listassa, joten peilaus ei kosketa
# niihin:
#   data  = perheen tietokanta, muistilista, hälytysäänet, lokit ja
#           infonaytto-ennen-viestilahteita.db (ainoa paluureitti edelliseen
#           julkaisuun). Sen tuhoaminen on peruuttamatonta.
#   .env  = tunnukset. Päivitys ei kirjoita sitä uusiksi lainkaan.
peilaa_paketti() {
    local lahde="$1" kohde="$2" osa
    tarkista_peilaus "$lahde" "$kohde" || return 1
    # Kirjoitetaan tasan niihin polkuihin jotka tarkistus hyväksyi.
    lahde="$(normalisoi_polku "$lahde")"
    kohde="$(normalisoi_polku "$kohde")"
    mkdir -p "$kohde"
    for osa in "${PAKETIN_OSAT[@]}"; do
        rm -rf -- "${kohde:?}/${osa:?}"
        [[ -e "$lahde/$osa" ]] || continue
        cp -a -- "$lahde/$osa" "$kohde/$osa"
    done
}

# =============================================================================
# Kysymykset
# =============================================================================

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

portti_on_varattu() {
    local portti="$1"
    (exec 3<>"/dev/tcp/127.0.0.1/$portti") 2>/dev/null
}

# Kysyy yhden mallin mukaisen asetuksen ja tarkistaa sen tyypin mukaan. Kysyy
# uudestaan kunnes arvo kelpaa -- nyt yhdessä paikassa, jotta uuden avaimen
# lisääminen ei tarkoita uuden silmukan kirjoittamista.
# SALLITTU_PORTTI = tämän asennuksen nykyinen portti: sitä ei ilmoiteta
# varatuksi, koska varaaja on oma käynnissä oleva palvelin.
SALLITTU_PORTTI=""
kysy_asetus() {
    local avain="$1" oletus="${2-}" tyyppi kehote vastaus
    tyyppi="${MALLI_TYYPPI[$avain]}"
    kehote="${MALLI_KEHOTE[$avain]}"
    case "$tyyppi" in
        salaisuus)
            kysy_salattu vastaus "$kehote" "$oletus"
            ;;
        fullpin)
            while true; do
                kysy_salattu vastaus "$kehote" "$oletus"
                if [[ -z "$vastaus" || "${#vastaus}" -ge "$FULL_PIN_MIN_PITUUS" ]]; then
                    break
                fi
                echo "  Alle $FULL_PIN_MIN_PITUUS merkkiä -- FULL_PIN EI OTA KÄYTTÖÖN näin lyhyenä, taso jää kokonaan pois päältä." >&2
                echo "  Anna vähintään $FULL_PIN_MIN_PITUUS merkkiä, tai jätä tyhjäksi / '-' poistaaksesi tason käytöstä." >&2
            done
            ;;
        *)
            while true; do
                kysy vastaus "$kehote" "$oletus"
                case "$tyyppi" in
                    portti)
                        if ! portti_kelpaa "$vastaus"; then
                            echo "  Anna kelvollinen portti (1-65535)." >&2
                            continue
                        fi
                        if [[ "$vastaus" != "$SALLITTU_PORTTI" ]] && portti_on_varattu "$vastaus"; then
                            echo "  VAROITUS: portti $vastaus näyttää olevan jo käytössä."
                            if ! kysy_kylla "  Käytetäänkö silti? (esim. tämän saman asennuksen käynnissä oleva vanha prosessi)" 0; then
                                continue
                            fi
                        fi
                        ;;
                    valinta)
                        # Tarkoituksellisesti lainaamaton: vaihtoehdot on
                        # välilyönnein erotettu lista.
                        # shellcheck disable=SC2086
                        if ! sisaltaa "$vastaus" ${MALLI_VAIHTOEHDOT[$avain]}; then
                            echo "  Anna yksi näistä: ${MALLI_VAIHTOEHDOT[$avain]// /, }." >&2
                            continue
                        fi
                        ;;
                    desimaali)
                        if ! desimaali_kelpaa "$vastaus"; then
                            echo "  Anna desimaaliluku pisteellä, esim. 62.86667." >&2
                            continue
                        fi
                        ;;
                    postinumero)
                        if ! postinumero_kelpaa "$vastaus"; then
                            echo "  Anna postinumero viitenä numerona, esim. 43500." >&2
                            continue
                        fi
                        ;;
                    url)
                        if ! url_kelpaa "$vastaus"; then
                            echo "  Osoitteen pitää alkaa http:// tai https://. Jätä tyhjäksi ohittaaksesi." >&2
                            continue
                        fi
                        ;;
                esac
                break
            done
            ;;
    esac
    ASETUKSET["$avain"]="$vastaus"
}

# Kysyy annetut mallin avaimet järjestyksessä. Päivitys antaa tähän vain
# puuttuvat avaimet; jo tiedossa olevat arvot ovat ASETUKSET-taulukossa, ja
# riippuu-ehdot katsovat niitä.
kysy_asetukset() {
    local avain riippuu edellinen_otsikko="" oletus
    for avain in "$@"; do
        riippuu="${MALLI_RIIPPUU[$avain]}"
        if [[ -n "$riippuu" && -z "${ASETUKSET[$riippuu]:-}" ]]; then
            # Osoitetta ei annettu, joten tunnusta ja salasanaa ei kysytä.
            # Avain kirjoitetaan silti tyhjänä -- se on kelvollinen tila.
            ASETUKSET["$avain"]=""
            continue
        fi
        if [[ -n "${MALLI_OTSIKKO[$avain]}" && "${MALLI_OTSIKKO[$avain]}" != "$edellinen_otsikko" ]]; then
            echo ""
            echo "--- ${MALLI_OTSIKKO[$avain]} ---"
            edellinen_otsikko="${MALLI_OTSIKKO[$avain]}"
        fi
        [[ -n "${MALLI_OHJE[$avain]}" ]] && printf '%s\n' "${MALLI_OHJE[$avain]}"
        if [[ -v ASETUKSET["$avain"] ]]; then
            oletus="${ASETUKSET[$avain]}"
        else
            oletus="${MALLI_OLETUS[$avain]}"
        fi
        kysy_asetus "$avain" "$oletus"
    done
}

# Testit lataavat tästä pelkät funktiot ajamatta asennusta:
#   . asenna.sh --vain-funktiot      (tai INFONAYTTO_VAIN_FUNKTIOT=1)
# Vastaa asenna.ps1:n -VainFunktiot-lippua. Ei tarkoitettu tuotantokäyttöön
# eikä vaadi pääkäyttäjän oikeuksia, koska mitään ei suoriteta.
for __arg in "$@"; do
    [[ "$__arg" == "--vain-funktiot" ]] && INFONAYTTO_VAIN_FUNKTIOT=1
done
unset __arg
if [[ -n "${INFONAYTTO_VAIN_FUNKTIOT:-}" ]]; then
    return 0 2>/dev/null || exit 0
fi

# =============================================================================
# Suoritus
# =============================================================================

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

# pwd -P: symlinkit purettuina, jotta lähteen ja kohteen sisäkkäisyys nähdään
# myös silloin kun toinen on annettu linkin kautta.
PAKETTI_JUURI="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

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

# --- Lähdepaketti ja asennushakemisto ---------------------------------------

echo "Infonäytön asennus (julkaisupaketti)"
echo "===================================="
echo ""
echo "Paketti purettuna: $PAKETTI_JUURI"
echo ""

LAHDE_NODE="$PAKETTI_JUURI/node/bin/node"
if [[ ! -f "$LAHDE_NODE" ]]; then
    echo "VIRHE: niputettua Nodea ei löydy polusta $LAHDE_NODE." >&2
    echo "  Tarkista että purit KOKO julkaisupaketin, et vain 'asennus'-kansiota." >&2
    exit 1
fi
# Nodea tarvitaan jo ennen asennusta: olemassa oleva .env luetaan sillä samalla
# jäsentimellä jota palvelin käyttää. Purku on voinut hukata suoritusoikeuden.
chmod +x "$LAHDE_NODE" 2>/dev/null || true
if [[ ! -x "$LAHDE_NODE" ]]; then
    echo "VIRHE: niputettu Node ei ole ajokelpoinen: $LAHDE_NODE" >&2
    echo "  Korjaa oikeudet (chmod +x) tai pura paketti uudelleen." >&2
    exit 1
fi

# Kehityspuussa: onko .env.examplessa avaimia joita asetusmallissa ei ole.
# Julkaisupaketissa .env.exampleä ei ole, jolloin tämä ei väitä mitään.
MALLISTA_PUUTTUU="$(mallista_puuttuvat_avaimet "$PAKETTI_JUURI/.env.example" | tr '\n' ' ')"
if [[ -n "${MALLISTA_PUUTTUU// /}" ]]; then
    echo "VIRHE: asentimen asetusmallista puuttuu .env.examplen avaimia: $MALLISTA_PUUTTUU" >&2
    echo "  Lisää ne asenna.sh:n malliin (malli_lisaa) ennen kuin jatkat." >&2
    exit 1
fi

kysy KOHDE "Asennushakemisto" "${KOHDE_ARG:-$PAKETTI_JUURI}"
case "$KOHDE" in
    /*) ;;
    *) KOHDE="$(pwd)/$KOHDE" ;;
esac
# Kanoninen muoto heti: kaikki myöhemmät polut (systemd-yksikkö, .env, data)
# johdetaan tästä, eikä sisäkkäisyysvertailu saa nähdä ".."-polkuja tai
# symlinkkejä eri hakemistoina kuin mitä ne oikeasti ovat.
KOHDE="$(normalisoi_polku "$KOHDE")" || { echo "VIRHE: hakemistopolkua ei voitu selvittää." >&2; exit 1; }
KOHDE="${KOHDE%/}"
[[ -z "$KOHDE" ]] && KOHDE="/"

JUURI="$KOHDE"
DATA_POLKU="$JUURI/data"
ENV_POLKU="$JUURI/.env"
NODE_BIN="$JUURI/node/bin/node"
KAYNNISTYS_POLKU="$JUURI/asennus/kaynnista.sh"
PEILATAAN=0
if [[ "$JUURI" != "$PAKETTI_JUURI" ]]; then
    PEILATAAN=1
    # Tarkistetaan heti, ennen yhtäkään kysymystä: jos kohde ei kelpaa, siitä
    # on parempi kuulla nyt kuin salasanojen kirjoittamisen jälkeen.
    if ! tarkista_peilaus "$PAKETTI_JUURI" "$JUURI"; then
        echo "Mitään ei muutettu." >&2
        exit 1
    fi
elif [[ ! -f "$KAYNNISTYS_POLKU" ]]; then
    echo "VIRHE: käynnistysskriptiä ei löydy polusta $KAYNNISTYS_POLKU." >&2
    exit 1
fi

# --- Tila: uusi asennus vai päivitys ----------------------------------------

# Tunnistus on .env: jos tunnukset on jo kerran annettu, kyseessä on päivitys.
# data/ yksinään ei riitä -- palvelin luo sen itse ensimmäisellä
# käynnistyksellä, myös keskeytyneen asennuksen jäljiltä.
PAIVITYS=0
ENV_OLI=0
if [[ -f "$ENV_POLKU" ]]; then
    ENV_OLI=1
    PAIVITYS=1
    echo ""
    echo "Kohteessa $JUURI on jo asennus:"
    echo "  - .env löytyi -- päivitys säilyttää sen sellaisenaan, oikeuksineen."
    [[ -d "$DATA_POLKU" ]] && echo "  - data/ löytyi (tietokanta, muistilista, hälytysäänet, lokit) -- SÄILYTETÄÄN aina, ei kosketa."
    if ! kysy_kylla "Päivitetään säilyttäen nykyiset asetukset? (ei = kysy kaikki asetukset uudestaan)" 1; then
        PAIVITYS=0
        echo "VAROITUS: nykyinen .env korvataan annetuilla asetuksilla."
    fi
    lataa_env "$ENV_POLKU" "$LAHDE_NODE"
    if [[ "$(tunnettuja_avaimia)" -eq 0 ]]; then
        # Jäsennys ei kerro tätä: tyhjä, kommenttipelkkä ja roskainen tiedosto
        # tuottavat kaikki tyhjän tuloksen. Päivitys kysyisi tällöin kaikki
        # asetukset ja lisäisi ne loppuun, jolloin vioittunut alkuosa jäisi
        # tiedostoon -- siitä on kerrottava ennen kuin mitään kirjoitetaan.
        echo "VAROITUS: $ENV_POLKU on olemassa, mutta siitä ei löydy yhtään tunnettua asetusta." >&2
        echo "  Tiedosto on tyhjä tai vioittunut. Asennin kysyy kaikki asetukset ja lisää ne" >&2
        echo "  tiedoston loppuun; vanha rikkinäinen sisältö jää yläpuolelle. Jos et halua sitä," >&2
        echo "  keskeytä (Ctrl+C), siirrä tiedosto talteen ja aja asennin uudelleen." >&2
    fi
elif [[ -d "$DATA_POLKU" ]]; then
    echo ""
    echo "Kohteessa $JUURI on data/-kansio muttei .env-tiedostoa -- tehdään uusi asennus."
    echo "data/ säilytetään koskemattomana."
fi

# Vanhat arvot pohjaksi: päivityksessä ne säilyvät sellaisenaan, ja
# uudelleenmäärittelyssä ne ovat kysymysten oletusarvoja.
for avain in "${!OLEMASSA[@]}"; do
    ASETUKSET["$avain"]="${OLEMASSA[$avain]}"
done

if [[ "$ENV_OLI" -eq 1 ]] && [[ -v OLEMASSA[PORT] ]] && ! portti_kelpaa "${OLEMASSA[PORT]}"; then
    echo "VIRHE: nykyisen .env:n PORT ei ole kelvollinen (${OLEMASSA[PORT]}). Korjaa se ennen päivitystä." >&2
    exit 1
fi
SALLITTU_PORTTI="${OLEMASSA[PORT]:-}"

if [[ "$PAIVITYS" -eq 1 ]]; then
    mapfile -t KYSYTTAVAT < <(puuttuvat_avaimet)
else
    KYSYTTAVAT=("${MALLI_AVAIMET[@]}")
    TUNTEMATTOMAT="$(tuntemattomat_avaimet | tr '\n' ' ')"
    if [[ -n "${TUNTEMATTOMAT// /}" ]]; then
        echo "VAROITUS: nykyisessä .env:ssä on avaimia joita asennin ei tunne: $TUNTEMATTOMAT" >&2
        echo "  Ne KATOAVAT jos .env kirjoitetaan uusiksi. Keskeytä (Ctrl+C) ja ota talteen jos tarvitset ne." >&2
    fi
fi

# --- Kysymykset --------------------------------------------------------------

if [[ "${#KYSYTTAVAT[@]}" -eq 0 ]]; then
    echo ""
    echo "Kaikki asetukset ovat jo .env-tiedostossa -- mitään ei kysytä."
else
    if [[ "$PAIVITYS" -eq 1 ]]; then
        echo ""
        echo "Päivitys: kysytään vain ne asetukset joita nykyisestä .env:stä puuttuu."
    fi
    kysy_asetukset "${KYSYTTAVAT[@]}"
fi

PORTTI="${ASETUKSET[PORT]:-}"
if ! portti_kelpaa "$PORTTI"; then
    echo "VIRHE: PORT ei ole kelvollinen: $PORTTI" >&2
    exit 1
fi

# --- Automaattikäynnistyksen tila (kysytään ennen muutoksia) -----------------

SYSTEMD_KAYTOSSA=1
[[ -d /run/systemd/system ]] || SYSTEMD_KAYTOSSA=0

YKSIKKO_ON=0
if [[ "$SYSTEMD_KAYTOSSA" -eq 1 && -f "$PALVELIN_YKSIKKO_POLKU" ]]; then
    if ! grep -qF "$KAYNNISTYS_POLKU" "$PALVELIN_YKSIKKO_POLKU"; then
        echo "VIRHE: $PALVELIN_YKSIKKO on jo olemassa mutta osoittaa toiseen asennukseen." >&2
        echo "  Tarkista $PALVELIN_YKSIKKO_POLKU. Mitään ei muutettu." >&2
        exit 1
    fi
    YKSIKKO_ON=1
fi

AUTOSTART=0
UUSI_YKSIKKO=0
if [[ "$SYSTEMD_KAYTOSSA" -eq 0 ]]; then
    echo ""
    echo "PUUTTUU: systemd ei ole käytössä tällä koneella (ei löydy /run/systemd/system)."
    echo "  Automaattikäynnistystä ja kioskiselainta ei voida asentaa tällä koneella."
    echo "  Palvelin käynnistetään silti käsin todennusta varten."
elif [[ "$YKSIKKO_ON" -eq 1 ]]; then
    # Automaattikäynnistys on jo käytössä: ei kysytä uudestaan eikä kahdenneta.
    AUTOSTART=1
    echo ""
    echo "Automaattikäynnistys on jo käytössä ($PALVELIN_YKSIKKO) -- ei luoda uudelleen."
elif kysy_kylla "Otetaanko automaattikäynnistys käyttöön (taustapalvelin systemd-palveluna + kioskiselain)?" 1; then
    AUTOSTART=1
    UUSI_YKSIKKO=1
fi

# --- Yhteenveto ja vahvistus -------------------------------------------------

echo ""
echo "------------------------------------"
if [[ "$PAIVITYS" -eq 1 ]]; then
    echo "Tila:              PÄIVITYS (nykyinen .env ja sen oikeudet säilyvät)"
    if [[ "${#KYSYTTAVAT[@]}" -gt 0 ]]; then
        echo "Lisättävät avaimet: ${KYSYTTAVAT[*]}"
    else
        echo "Lisättäviä avaimia: ei yhtään -- .env:iin ei kirjoiteta lainkaan"
    fi
elif [[ "$ENV_OLI" -eq 1 ]]; then
    echo "Tila:              UUDELLEENMÄÄRITTELY (nykyinen .env KORVATAAN)"
else
    echo "Tila:              UUSI ASENNUS"
fi
echo "Asennushakemisto:  $JUURI"
echo "Portti:            $PORTTI"
if [[ "$PEILATAAN" -eq 1 ]]; then
    echo "Ohjelmatiedostot:  peilataan paketista (${PAKETIN_OSAT[*]})"
    echo "                   -- kohteesta poistuneet tiedostot häviävät, data/ ja .env eivät"
else
    echo "Ohjelmatiedostot:  asennetaan paikalleen, ei kopioida"
fi
echo "data/:             säilytetään aina koskemattomana"
echo "------------------------------------"
# Päivitys ei kajoa .env:n omistajaan eikä oikeuksiin -- mutta silloin on
# kerrottava jos palvelin ei niillä oikeuksilla pääse tiedostoon käsiksi.
# Näin käy jos päivitys ajetaan eri sudo-käyttäjältä kuin alkuperäinen asennus.
if [[ "$ENV_OLI" -eq 1 ]]; then
    ENV_OMISTAJA="$(stat -c %U "$ENV_POLKU" 2>/dev/null || true)"
    if [[ -n "$ENV_OMISTAJA" && "$ENV_OMISTAJA" != "$KAYTTAJA" ]]; then
        echo "VAROITUS: .env:n omistaja on '$ENV_OMISTAJA', mutta palvelin ajetaan käyttäjänä '$KAYTTAJA'."
        echo "  Asennin EI muuta .env:n omistajaa eikä oikeuksia. Jos palvelin ei käynnisty, korjaa käsin:"
        echo "    sudo chown $KAYTTAJA:$KAYTTAJAN_RYHMA \"$ENV_POLKU\""
        echo "------------------------------------"
    fi
fi
if ! kysy_kylla "Tehdäänkö asennus?" 0; then
    echo "Keskeytetty. Mitään ei muutettu."
    exit 0
fi

# =============================================================================
# Tästä eteenpäin muutetaan tiedostoja
# =============================================================================

# --- Palvelin alas ennen tiedostojen korvaamista -----------------------------

if [[ "$YKSIKKO_ON" -eq 1 ]]; then
    echo "Pysäytetään $PALVELIN_YKSIKKO tiedostojen korvaamisen ajaksi..."
    systemctl stop "$PALVELIN_YKSIKKO" || true
fi

if [[ "$PEILATAAN" -eq 1 ]]; then
    # Portti kertoo luotettavimmin onko vanha palvelin oikeasti alhaalla --
    # myös silloin kun se on käynnistetty käsin eikä systemd tiedä siitä.
    for _ in 1 2 3; do
        portti_on_varattu "$PORTTI" || break
        sleep 1
    done
    if portti_on_varattu "$PORTTI"; then
        echo "VIRHE: portti $PORTTI on yhä käytössä -- vanha palvelin on ilmeisesti yhä käynnissä." >&2
        echo "  Pysäytä se ensin (sudo systemctl stop $PALVELIN_YKSIKKO, tai käsin käynnistetty kaynnista.sh)." >&2
        echo "  Ohjelmatiedostoja EI muutettu." >&2
        exit 1
    fi

    echo "Peilataan ohjelmatiedostot kohteeseen $JUURI (data/ ja .env säilyvät)..."
    peilaa_paketti "$PAKETTI_JUURI" "$JUURI"
    echo "Kopioitu. Alkuperäisen purkukansion ($PAKETTI_JUURI) voi nyt poistaa käsin, jos et tarvitse sitä enää."
fi

if [[ ! -f "$NODE_BIN" ]]; then
    echo "VIRHE: niputettua Nodea ei löydy polusta $NODE_BIN." >&2
    exit 1
fi
if [[ ! -f "$KAYNNISTYS_POLKU" ]]; then
    echo "VIRHE: käynnistysskriptiä ei löydy polusta $KAYNNISTYS_POLKU." >&2
    exit 1
fi
chmod +x "$NODE_BIN" "$KAYNNISTYS_POLKU"

# --- data/ ja .env ---------------------------------------------------------

mkdir -p "$DATA_POLKU"
chown -R "$KAYTTAJA:$KAYTTAJAN_RYHMA" "$DATA_POLKU"

if [[ "$PAIVITYS" -eq 1 ]]; then
    if [[ "${#KYSYTTAVAT[@]}" -gt 0 ]]; then
        LISAYS="$(env_lisays_sisalto "${KYSYTTAVAT[@]}")"
        lisaa_env_tiedostoon "$ENV_POLKU" "$LISAYS"
        echo ".env: lisättiin puuttuvat avaimet (${KYSYTTAVAT[*]}). Vanha sisältö ja oikeudet säilyivät."
    else
        echo ".env: ei muutoksia -- kaikki mallin avaimet olivat jo tallessa."
    fi
else
    # Sisältö muodostetaan kokonaan muistiin ENNEN tiedoston avaamista: jos
    # jokin arvo ei ole tallennuskelpoinen, .env ei jää puolikkaaksi.
    ENV_SISALTO="$(uusi_env_sisalto)"
    # Tiedosto luodaan ensin TYHJÄNÄ oikeilla oikeuksilla (install -m 600) ja
    # vasta sitten kirjoitetaan sisältö -- ei koskaan kirjoiteta ensin ja
    # tiukenneta oikeuksia perään, koska siinä välissä tiedosto olisi
    # maailmanluettava ja sisältää Wilma- ja Päikky-salasanat selväkielisenä.
    install -m 600 -o "$KAYTTAJA" -g "$KAYTTAJAN_RYHMA" /dev/null "$ENV_POLKU"
    printf '%s\n' "$ENV_SISALTO" > "$ENV_POLKU"
    echo ".env kirjoitettu ($ENV_POLKU, oikeudet 600, omistaja $KAYTTAJA)."
fi

# --- Automaattikäynnistys -------------------------------------------------

KIOSKI_ASENNETTU=0
if [[ "$AUTOSTART" -eq 1 ]]; then
    echo ""
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
    # Kirjoitetaan vain jos sisältö oikeasti muuttuu: turha daemon-reload ja
    # käyttäjän käsin tekemien muutosten pyyhkiminen jäävät pois.
    if [[ ! -f "$PALVELIN_YKSIKKO_POLKU" ]] || [[ "$(cat "$PALVELIN_YKSIKKO_POLKU")" != "$PALVELIN_YKSIKKO_SISALTO" ]]; then
        printf '%s\n' "$PALVELIN_YKSIKKO_SISALTO" > "$PALVELIN_YKSIKKO_POLKU"
        systemctl daemon-reload
        echo "Systemd-yksikkö kirjoitettu: $PALVELIN_YKSIKKO_POLKU"
    else
        echo "Systemd-yksikkö oli jo ajan tasalla: $PALVELIN_YKSIKKO_POLKU"
    fi
    # enable vain uudelle yksikölle: jos käyttäjä on itse poistanut palvelun
    # käytöstä, päivitys ei saa ottaa sitä takaisin käyttöön hänen selkänsä
    # takana.
    if [[ "$UUSI_YKSIKKO" -eq 1 ]]; then
        systemctl enable "$PALVELIN_YKSIKKO"
        echo "Palvelu käynnistyy jatkossa automaattisesti: $PALVELIN_YKSIKKO"
    fi

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
        AUTOLOGIN_SISALTO="$(cat <<EOF
[Seat:*]
autologin-user=$KAYTTAJA
autologin-user-timeout=0
autologin-session=openbox
user-session=openbox
EOF
        )"
        if [[ ! -f "$AUTOLOGIN_TIEDOSTO" ]] || [[ "$(cat "$AUTOLOGIN_TIEDOSTO")" != "$AUTOLOGIN_SISALTO" ]]; then
            echo "Asetetaan automaattikirjautuminen (lightdm)..."
            mkdir -p "$(dirname "$AUTOLOGIN_TIEDOSTO")"
            printf '%s\n' "$AUTOLOGIN_SISALTO" > "$AUTOLOGIN_TIEDOSTO"
            echo "Kirjoitettu: $AUTOLOGIN_TIEDOSTO"
            echo "Huom: joissain jakeluversioissa lightdm vaatii käyttäjän lisäämistä erilliseen"
            echo "'autologin'-ryhmään -- ks. KAYTTOONOTTO-LINUX.md jos näyttö jää kirjautumisruutuun."
        else
            echo "Automaattikirjautuminen oli jo asetettu: $AUTOLOGIN_TIEDOSTO"
        fi

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
        elif [[ -f "$AUTOSTART_POLKU" ]] && [[ "$(cat "$AUTOSTART_POLKU")" == "$AUTOSTART_SISALTO" ]]; then
            KIOSKI_ASENNETTU=1
            echo "Kioskiselaimen käynnistys oli jo ajan tasalla: $AUTOSTART_POLKU"
        else
            printf '%s\n' "$AUTOSTART_SISALTO" > "$AUTOSTART_POLKU"
            chmod +x "$AUTOSTART_POLKU"
            chown "$KAYTTAJA:$KAYTTAJAN_RYHMA" "$AUTOSTART_POLKU" "$OPENBOX_KANSIO"
            KIOSKI_ASENNETTU=1
            echo "Kirjoitettu: $AUTOSTART_POLKU"
        fi

        echo "Estetään lepotila ja horrostila kokonaan."
        systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target >/dev/null
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
PALVELU_KAYNNISTETTIIN=0
if [[ "$AUTOSTART" -eq 1 ]]; then
    # Käytöstä poistettua palvelua ei käynnistetä systemdin kautta: silloin
    # käyttäjä on itse päättänyt ettei sitä ajeta, ja todennus tehdään
    # tilapäisellä prosessilla.
    if [[ "$UUSI_YKSIKKO" -eq 1 ]] || systemctl is-enabled --quiet "$PALVELIN_YKSIKKO"; then
        systemctl start "$PALVELIN_YKSIKKO"
        PALVELU_KAYNNISTETTIIN=1
    fi
fi
if [[ "$PALVELU_KAYNNISTETTIIN" -eq 0 ]]; then
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

if [[ "$ONNISTUI" -eq 1 && -n "${ASETUKSET[WILMA_BASE_URL]:-}" && -n "${ASETUKSET[WILMA_USERNAME]:-}" && -n "${ASETUKSET[WILMA_PASSWORD]:-}" ]]; then
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

# --- Kioski uuteen versioon --------------------------------------------------

# Kioskiselain käynnistetään kirjautumisen yhteydessä (openboxin autostart),
# joten päivityksen jälkeen ruudulla on yhä edellisen version sivu -- eikä
# selain voi hakea uutta itsestään, koska juuri sen JS-tiedostot vaihtuivat.
if [[ "$ONNISTUI" -eq 1 && "$PAIVITYS" -eq 1 && "$KIOSKI_ASENNETTU" -eq 1 ]] \
   && systemctl is-active --quiet lightdm 2>/dev/null; then
    echo ""
    echo "Näytöllä on yhä edellisen version sivu, kunnes kioskiselain käynnistyy uudelleen."
    if kysy_kylla "Käynnistetäänkö kioskinäyttö nyt uudelleen? (sulkee graafisen istunnon -- älä tee tätä jos ajat tätä näytön omasta työpöytäpäätteestä)" 0; then
        systemctl restart lightdm
        echo "lightdm käynnistetty uudelleen -- kioski palaa automaattikirjautumisen kautta."
    else
        echo "Ohitettiin. Uusi versio tulee näkyviin seuraavassa käynnistyksessä (sudo reboot)."
    fi
fi

# --- Yhteenveto -------------------------------------------------------------

LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"

echo ""
echo "===================================="
if [[ "$ONNISTUI" -eq 1 ]]; then
    if [[ "$PAIVITYS" -eq 1 ]]; then
        echo "Päivitys valmis ja todennettu toimivaksi."
    else
        echo "Asennus valmis ja todennettu toimivaksi."
    fi
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
if [[ "$AUTOSTART" -eq 1 ]]; then
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
echo "Päivitys uuteen julkaisuun: pura uusi paketti ja aja sen asennus/asenna.sh"
echo "  sudo ./asenna.sh --kohde=\"$JUURI\"   (.env, data/ ja asetukset säilyvät)"
echo ""
echo "Poista automaattikäynnistys: sudo \"$JUURI/asennus/asenna.sh\" --poista --kohde=\"$JUURI\""
echo "(.env ja data/-kansio säilyvät -- poista ne käsin jos et tarvitse niitä enää.)"

if [[ "$ONNISTUI" -ne 1 ]]; then
    exit 1
fi
