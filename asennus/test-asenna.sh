#!/usr/bin/env bash
#
# Linux-asentimen regressiot: vain oma tilapäishakemisto, ei oikeita
# systemd-yksiköitä, prosesseja eikä käyttäjän .env-tiedostoa. Lataa
# asenna.sh:sta pelkät funktiot (--vain-funktiot), joten mitään ei asenneta
# eikä pääkäyttäjän oikeuksia tarvita.
#
#   bash asennus/test-asenna.sh
#
# Ajetaan myös Windowsilla Git Bashissa (ks. skriptit/test-asennus.mjs):
# kehityskone on Windows, eivätkä Linux-asentimen testit saa jäädä ajamatta
# pelkästään siksi.
#
# Vaatii Noden PATHista: .env luetaan samalla jäsentimellä (node:util
# parseEnv) jota palvelin käyttää -- juuri sen täsmääminen on testin ydin.

set -euo pipefail

# shellcheck source=./asenna.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/asenna.sh" --vain-funktiot

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
    echo "VIRHE: node ei ole PATHissa -- .env-jäsennystä ei voi testata ilman sitä." >&2
    exit 1
fi

LAPI=0
ok() {
    LAPI=$((LAPI + 1))
    echo "OK: $1"
}
kaadu() {
    echo "TESTI EPÄONNISTUI: $1" >&2
    exit 1
}
# Käytetään muodossa:  [[ ehto ]] && ok "nimi" || kaadu "nimi"
# (suora `[[ ehto ]]` yksinään lopettaisi ajon set -e:n takia kertomatta mikä
# testi kaatui.)

odota_virhe() {
    # odota_virhe NIMI KOMENTO... -- testi menee läpi vain jos komento epäonnistuu.
    local nimi="$1"
    shift
    if "$@" >/dev/null 2>&1; then
        kaadu "$nimi (odotettiin virhettä, komento onnistui)"
    fi
    ok "$nimi"
}

TESTIJUURI="$(mktemp -d "${TMPDIR:-/tmp}/infonaytto-asennustesti-XXXXXXXX")"
siivoa() {
    # Vain tämän ajon luoma, täsmällisesti rajattu hakemisto poistetaan.
    case "$(basename "$TESTIJUURI")" in
        infonaytto-asennustesti-*) rm -rf -- "$TESTIJUURI" ;;
        *) echo "Testihakemiston poiston turvaraja petti: $TESTIJUURI" >&2 ;;
    esac
}
trap siivoa EXIT

kirjoita_tiedosto() {
    local polku="$1" sisalto="${2:-fixture}"
    mkdir -p "$(dirname "$polku")"
    printf '%s' "$sisalto" > "$polku"
}

tee_testipaketti() {
    local juuri="$1" tiedosto
    for tiedosto in server/src/index.ts server/package.json asennus/kaynnista.sh \
                    asennus/asenna.sh web/dist/index.html VERSIO.txt LUEMINUT.txt \
                    node_modules/fixture/index.js node/bin/node; do
        kirjoita_tiedosto "$juuri/$tiedosto"
    done
}

# --- Lainausmerkit: arvo säilyy Noden omalla jäsentimellä --------------------
# Tämä on se vika joka oikeasti puri: lainausmerkitön arvo katkesi #-merkin
# kohdalta ja loppuosa katosi äänettömästi.

# Mukana %s ja %%: jos jokin printf ottaisi arvon muotoilumerkkijonoksi
# (printf "KEY=$arvo\n"), ne katoaisivat tai söisivät seuraavan argumentin --
# sama hiljainen vikaluokka kuin #-katkaisu.
ENV_TESTI="$TESTIJUURI/lainaukset.env"
for arvo in 'salasana#välilyönti äö' 'C:\new\record' "yksi'kaksi" 'kaksi"kolme' 'a'"'"'b`c' 'risuaita # keskellä' 'sala%s#123' '100%% varma' '$HOME ja `id`' ''; do
    kirjoita_tiedosto "$ENV_TESTI" "VALUE=$(muotoile_env_arvo "$arvo")"
    lataa_env "$ENV_TESTI" "$NODE_BIN"
    luettu="${OLEMASSA[VALUE]-PUUTTUU}"
    [[ "$luettu" == "$arvo" ]] \
        && ok "Lainattu arvo säilyy Noden parseEnv-lukijalla: '${arvo//[^ -~]/?}'" \
        || kaadu "Lainattu arvo muuttui: annettiin '$arvo', luettiin '$luettu'"
done

odota_virhe "Rivinvaihto estetään ennen kirjoittamista" muotoile_env_arvo $'eka\ntoka'
odota_virhe "Kaikki kolme lainausmerkkiä estetään" muotoile_env_arvo 'a'"'"'b"c`d'
[[ "$(muotoile_env_arvo 'C:\new\record')" != '"'* ]] \
    && ok 'Kenoviiva-n ei mene "-lainausmerkkeihin (Node tulkitsisi sen rivinvaihdoksi)' \
    || kaadu 'Kenoviiva-n ei mene "-lainausmerkkeihin'

# --- Olemassa olevan .env:n lukeminen ---------------------------------------

kirjoita_tiedosto "$ENV_TESTI" "$(printf '# kommentti\nexport PORT=4173 # perässä\nWILMA_PASSWORD='"'"'rivi1\nrivi2'"'"'\nPAIKKY_PASSWORD=\n')"
lataa_env "$ENV_TESTI" "$NODE_BIN"
[[ "${OLEMASSA[PORT]}" == "4173" && "${OLEMASSA[WILMA_PASSWORD]}" == $'rivi1\nrivi2' && -v OLEMASSA[PAIKKY_PASSWORD] && -z "${OLEMASSA[PAIKKY_PASSWORD]}" ]] \
    && ok 'Vanhan .env:n kommentit, export, tyhjä ja moniriviarvo luetaan kuten palvelimessa' \
    || kaadu 'Vanhan .env:n lukeminen poikkeaa palvelimen jäsentimestä'

lataa_env "$TESTIJUURI/ei-ole.env" "$NODE_BIN"
[[ "${#OLEMASSA[@]}" -eq 0 ]] \
    && ok 'Puuttuva .env luetaan tyhjänä eikä kaada asenninta' \
    || kaadu 'Puuttuva .env ei tuottanut tyhjää tulosta'

# Vioittunutta .env:iä ei voi tunnistaa jäsennysvirheestä -- parseEnv ei valita
# mistään. Ainoa mittari on löytyykö sieltä yhtään mallin tuntemaa avainta.
for roska in '' '# pelkkiä kommentteja' 'sekalaista roskaa ilman yhtäsuuruusmerkkiä' 'MUU_OHJELMA=1'; do
    kirjoita_tiedosto "$TESTIJUURI/roska.env" "$roska"
    lataa_env "$TESTIJUURI/roska.env" "$NODE_BIN"
    [[ "$(tunnettuja_avaimia)" -eq 0 ]] \
        && ok "Vioittunut .env tunnistetaan tunnettujen avainten puutteesta: '${roska:0:24}'" \
        || kaadu "Vioittunut .env meni läpi ehjänä: '$roska'"
done
kirjoita_tiedosto "$TESTIJUURI/roska.env" 'PORT=4173'
lataa_env "$TESTIJUURI/roska.env" "$NODE_BIN"
[[ "$(tunnettuja_avaimia)" -eq 1 ]] \
    && ok 'Yksikin tunnettu avain riittää: ehjää .env:iä ei väitetä vioittuneeksi' \
    || kaadu 'Ehjä .env tulkittiin vioittuneeksi'

# --- Puuttuvien avainten tunnistus ------------------------------------------

# Rakennetaan ennen Päikkyä asennetun kaltainen .env: PAIKKY_* puuttuu, muut
# ovat tallessa (osa tyhjinä). Tyhjä arvo EI ole puuttuva avain.
ASETUKSET=()
for avain in "${MALLI_AVAIMET[@]}"; do ASETUKSET["$avain"]=""; done
ASETUKSET[PORT]=4173
KAIKKI_AVAIMET=("${MALLI_AVAIMET[@]}")
VANHA_MALLI=()
for avain in "${KAIKKI_AVAIMET[@]}"; do
    [[ "$avain" == PAIKKY_* ]] || VANHA_MALLI+=("$avain")
done
MALLI_AVAIMET=("${VANHA_MALLI[@]}")
VANHA_ENV="$(uusi_env_sisalto)"
MALLI_AVAIMET=("${KAIKKI_AVAIMET[@]}")
kirjoita_tiedosto "$TESTIJUURI/vanha.env" "$VANHA_ENV"
lataa_env "$TESTIJUURI/vanha.env" "$NODE_BIN"
[[ "$(puuttuvat_avaimet | tr '\n' ' ')" == "PAIKKY_BASE_URL PAIKKY_USERNAME PAIKKY_PASSWORD " ]] \
    && ok 'Päivitys tunnistaa vain oikeasti puuttuvat avaimet (tyhjä arvo ei ole puuttuva)' \
    || kaadu "Puuttuvat avaimet väärin: $(puuttuvat_avaimet | tr '\n' ' ')"

lataa_env "$ENV_TESTI" "$NODE_BIN"
[[ -z "$(tuntemattomat_avaimet)" ]] \
    && ok 'Mallin tuntemat avaimet eivät päädy tuntemattomien listaan' \
    || kaadu 'Mallin avain tulkittiin tuntemattomaksi'
OLEMASSA[OMA_LISAYS]=1
[[ "$(tuntemattomat_avaimet)" == "OMA_LISAYS" ]] \
    && ok 'Käsin lisätty tuntematon avain huomataan ennen .env:n korvaamista' \
    || kaadu 'Tuntematonta avainta ei huomattu'

# --- Sään postinumero korvaa koordinaatit -----------------------------------

sisaltaa WEATHER_POSTAL_CODE "${MALLI_AVAIMET[@]}" \
    && ok 'Sään sijainti kysytään postinumerona' \
    || kaadu 'WEATHER_POSTAL_CODE puuttuu asetusmallista'
if sisaltaa WEATHER_LAT "${MALLI_AVAIMET[@]}" || sisaltaa WEATHER_LON "${MALLI_AVAIMET[@]}" \
   || sisaltaa WEATHER_PLACE "${MALLI_AVAIMET[@]}"; then
    kaadu 'Malli kysyy yhä koordinaatteja -- uuteen asennukseen ei saa kirjoittaa WEATHER_LAT/LON/PLACEa'
fi
ok 'Koordinaattiavaimia ei kysytä eikä kirjoiteta uuteen asennukseen'
[[ "${MALLI_TYYPPI[WEATHER_POSTAL_CODE]}" == "postinumero" && "${MALLI_OLETUS[WEATHER_POSTAL_CODE]}" == "43500" ]] \
    && ok 'Postinumero tarkistetaan postinumerona ja oletus on 43500' \
    || kaadu "Postinumeron tyyppi tai oletus on väärä: ${MALLI_TYYPPI[WEATHER_POSTAL_CODE]} / ${MALLI_OLETUS[WEATHER_POSTAL_CODE]}"

# Tuotantoasennuksen kaltainen .env: kaikki muu on jo paikallaan ja vanhat
# koordinaattiavaimet ovat mukana, vain postinumero puuttuu. Tämä on se tapaus
# joka päivityksessä oikeasti tulee vastaan.
ASETUKSET=()
for avain in "${MALLI_AVAIMET[@]}"; do ASETUKSET["$avain"]="${MALLI_OLETUS[$avain]}"; done
KAIKKI_AVAIMET=("${MALLI_AVAIMET[@]}")
VANHA_MALLI=()
for avain in "${KAIKKI_AVAIMET[@]}"; do
    [[ "$avain" == WEATHER_POSTAL_CODE ]] || VANHA_MALLI+=("$avain")
done
MALLI_AVAIMET=("${VANHA_MALLI[@]}")
VANHA_SAA_ENV="$(uusi_env_sisalto)"
MALLI_AVAIMET=("${KAIKKI_AVAIMET[@]}")
SAA_ENV="$TESTIJUURI/vanha-saa.env"
kirjoita_tiedosto "$SAA_ENV" "$VANHA_SAA_ENV"
printf '\n# --- Sää ---\nWEATHER_LAT=62.86667\nWEATHER_LON=24.78333\nWEATHER_PLACE=Karstula\n' >> "$SAA_ENV"
chmod 600 "$SAA_ENV"
lataa_env "$SAA_ENV" "$NODE_BIN"
[[ "$(puuttuvat_avaimet | tr '\n' ' ')" == "WEATHER_POSTAL_CODE " ]] \
    && ok 'Päivitys kysyy vanhasta asennuksesta vain postinumeron' \
    || kaadu "Päivitys kysyisi väärät avaimet: $(puuttuvat_avaimet | tr '\n' ' ')"

SAA_ENNEN_KOKO="$(wc -c < "$SAA_ENV")"
SAA_ENNEN_TAVUT="$(cksum < "$SAA_ENV")"
SAA_ENNEN_OIKEUDET="$(ls -l "$SAA_ENV" | cut -c1-10)"
ASETUKSET[WEATHER_POSTAL_CODE]=43500
lisaa_env_tiedostoon "$SAA_ENV" "$(env_lisays_sisalto WEATHER_POSTAL_CODE)"
[[ "$(head -c "$SAA_ENNEN_KOKO" "$SAA_ENV" | cksum)" == "$SAA_ENNEN_TAVUT" \
   && "$(ls -l "$SAA_ENV" | cut -c1-10)" == "$SAA_ENNEN_OIKEUDET" ]] \
    && ok 'Postinumeron lisäys ei muuta vanhoja tavuja eikä oikeuksia' \
    || kaadu 'Postinumeron lisäys muutti vanhaa .env-sisältöä tai oikeuksia'
lataa_env "$SAA_ENV" "$NODE_BIN"
[[ "${OLEMASSA[WEATHER_LAT]}" == "62.86667" && "${OLEMASSA[WEATHER_LON]}" == "24.78333" \
   && "${OLEMASSA[WEATHER_PLACE]}" == "Karstula" && "${OLEMASSA[WEATHER_POSTAL_CODE]}" == "43500" ]] \
    && ok 'Vanhat koordinaattiavaimet säilyvät palvelimen varareittinä postinumeron rinnalla' \
    || kaadu 'Päivitys hukkasi vanhat koordinaattiavaimet'

# Uudelleenmäärittely kirjoittaa .env:n uusiksi, jolloin koordinaatit katoavat.
# Siitä on varoitettava: vanhentuneet avaimet EIVÄT saa hiljentyä tuntemattomien
# listalta, vaikka mallista_puuttuvat_avaimet ne hyväksyykin. Eri kysymys, eri
# vastaus.
[[ "$(tuntemattomat_avaimet | tr '\n' ' ')" == "WEATHER_LAT WEATHER_LON WEATHER_PLACE " ]] \
    && ok 'Uudelleenmäärittely varoittaa katoavista koordinaattiavaimista' \
    || kaadu "Katoavista koordinaattiavaimista ei varoiteta: $(tuntemattomat_avaimet | tr '\n' ' ')"

# --- Malli vs. .env.example (kehityspuun tarkistus) -------------------------

ESIMERKKI="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.env.example"
[[ -z "$(mallista_puuttuvat_avaimet "$ESIMERKKI")" ]] \
    && ok '.env.examplen avaimet ovat kaikki asetusmallissa' \
    || kaadu "Asetusmallista puuttuu .env.examplen avaimia: $(mallista_puuttuvat_avaimet "$ESIMERKKI" | tr '\n' ' ')"
[[ -z "$(mallista_puuttuvat_avaimet "$TESTIJUURI/ei-ole.example")" ]] \
    && ok 'Julkaisupaketissa (ei .env.exampleä) tarkistus ei väitä mitään' \
    || kaadu 'Puuttuva .env.example tuotti väitteen'
kirjoita_tiedosto "$TESTIJUURI/vieras.example" "$(printf 'PORT=1\nUUSI_AVAIN=2\nexport TOINEN_UUSI = 3\n')"
[[ "$(mallista_puuttuvat_avaimet "$TESTIJUURI/vieras.example" | tr '\n' ' ')" == "TOINEN_UUSI UUSI_AVAIN " ]] \
    && ok 'Mallista puuttuva .env.example-avain huomataan' \
    || kaadu 'Mallista puuttuvaa .env.example-avainta ei huomattu'

# --- .env-sisällön muodostus ------------------------------------------------

ASETUKSET=()
for avain in "${MALLI_AVAIMET[@]}"; do ASETUKSET["$avain"]="${MALLI_OLETUS[$avain]}"; done
ASETUKSET[WILMA_PASSWORD]='sala#sana ja "lainaus"'
kirjoita_tiedosto "$TESTIJUURI/uusi.env" "$(uusi_env_sisalto)"
lataa_env "$TESTIJUURI/uusi.env" "$NODE_BIN"
[[ -z "$(puuttuvat_avaimet)" && "${OLEMASSA[WILMA_PASSWORD]}" == 'sala#sana ja "lainaus"' && "${OLEMASSA[PORT]}" == "4173" ]] \
    && ok 'Uusi .env sisältää kaikki mallin avaimet ja säilyttää hankalan salasanan' \
    || kaadu 'Uusi .env ei kestänyt kirjoitus-lukukierrosta'

LISAYS="$(env_lisays_sisalto PAIKKY_BASE_URL PAIKKY_USERNAME PAIKKY_PASSWORD)"
[[ "$(grep -c '^PAIKKY_' <<<"$LISAYS")" -eq 3 && "$(grep -c '^[A-Z]' <<<"$LISAYS")" -eq 3 ]] \
    && ok 'Päivityksen lisäysosaan tulee vain pyydetyt avaimet' \
    || kaadu 'Päivityksen lisäysosa sisältää vääriä avaimia'

# Olemassa oleva .env säilyy tavulleen ja oikeuksineen kun avaimia lisätään.
PAIVITETTAVA="$TESTIJUURI/paivitettava.env"
kirjoita_tiedosto "$PAIVITETTAVA" "$(printf '# oma kommentti\nPORT=4173\n')"
chmod 600 "$PAIVITETTAVA"
ENNEN_TAVUT="$(cksum < "$PAIVITETTAVA")"
ENNEN_KOKO="$(wc -c < "$PAIVITETTAVA")"
ENNEN_OIKEUDET="$(ls -l "$PAIVITETTAVA" | cut -c1-10)"
lisaa_env_tiedostoon "$PAIVITETTAVA" "$LISAYS"
[[ "$(head -c "$ENNEN_KOKO" "$PAIVITETTAVA" | cksum)" == "$ENNEN_TAVUT" ]] \
    && ok 'Puuttuvien avainten lisäys ei muuta vanhoja tavuja' \
    || kaadu 'Puuttuvien avainten lisäys muutti vanhaa sisältöä'
[[ "$(ls -l "$PAIVITETTAVA" | cut -c1-10)" == "$ENNEN_OIKEUDET" ]] \
    && ok 'Puuttuvien avainten lisäys ei muuta tiedoston oikeuksia' \
    || kaadu 'Puuttuvien avainten lisäys muutti tiedoston oikeuksia'
lataa_env "$PAIVITETTAVA" "$NODE_BIN"
[[ "${OLEMASSA[PORT]}" == "4173" && -v OLEMASSA[PAIKKY_PASSWORD] ]] \
    && ok 'Päivitetty .env on yhä ehjä ja sisältää sekä vanhat että lisätyt avaimet' \
    || kaadu 'Päivitetty .env ei jäsenny oikein'

# --- Arvojen tarkistukset ---------------------------------------------------

portti_kelpaa 4173 && portti_kelpaa 1 && portti_kelpaa 65535 \
    && ok 'Kelvolliset portit hyväksytään' \
    || kaadu 'Kelvollinen portti hylättiin'
if portti_kelpaa 0 || portti_kelpaa 65536 || portti_kelpaa abc || portti_kelpaa '' \
   || portti_kelpaa 99999999999999999999999999; then
    kaadu 'Kelvoton portti hyväksyttiin (ylivuoto?)'
fi
ok 'Kelvottomat portit hylätään ilman kokonaislukuylivuotoa'
desimaali_kelpaa 62.86667 && desimaali_kelpaa -3 && ! desimaali_kelpaa 62,86667 && ! desimaali_kelpaa x \
    && ok 'Desimaaliluku vaaditaan pisteellä (JS:n Number() lukee sen)' \
    || kaadu 'Desimaalitarkistus ei toimi'
postinumero_kelpaa 43500 && postinumero_kelpaa 00100 \
    && ok 'Viisinumeroinen postinumero hyväksytään (myös etunollilla)' \
    || kaadu 'Kelvollinen postinumero hylättiin'
# Asennin EI tunne postinumeroaineistoa: 99999 kelpaa muodoltaan, ja
# tuntemattomasta numerosta kertominen jää palvelimelle.
postinumero_kelpaa 99999 \
    && ok 'Asennin ei väitä tuntevansa postinumeroaineistoa (muoto riittää)' \
    || kaadu 'Asennin hylkäsi muodoltaan kelvollisen postinumeron'
for EI_KELPAA in 4350 435000 4350a ' 43500' '43500 ' '43 00' '435o0' '' $'43500\n43501'; do
    if postinumero_kelpaa "$EI_KELPAA"; then
        kaadu "Kelvoton postinumero hyväksyttiin: '$EI_KELPAA'"
    fi
done
ok 'Kelvoton postinumero hylätään (väärä pituus, kirjaimet, välilyönnit, rivinvaihto)'
url_kelpaa '' && url_kelpaa https://karstula.paikky.fi && ! url_kelpaa karstula.paikky.fi \
    && ok 'Tyhjä osoite kelpaa (= pois käytöstä), muu vaatii http(s)://' \
    || kaadu 'Osoitetarkistus ei toimi'

# --- Kysymysten rajaus ja riippuvuudet --------------------------------------

# Korvataan yksittäinen kysymys, jotta ketjun logiikka voidaan testata ilman
# että mitään luetaan päätteeltä.
KYSYTYT=()
VASTAUS_STUB=""
kysy_asetus() {
    KYSYTYT+=("$1")
    ASETUKSET["$1"]="$VASTAUS_STUB"
}
ASETUKSET=()
ASETUKSET[WILMA_PASSWORD]='säilyy'
kysy_asetukset PAIKKY_BASE_URL PAIKKY_USERNAME PAIKKY_PASSWORD
[[ "${KYSYTYT[*]}" == "PAIKKY_BASE_URL" && "${ASETUKSET[WILMA_PASSWORD]}" == "säilyy" \
   && -v ASETUKSET[PAIKKY_PASSWORD] && -z "${ASETUKSET[PAIKKY_PASSWORD]}" ]] \
    && ok 'Ilman Päikyn osoitetta tunnusta ei kysytä, mutta avain kirjoitetaan tyhjänä' \
    || kaadu "Riippuvuusehto ei toimi: kysyttiin '${KYSYTYT[*]}'"

KYSYTYT=()
ASETUKSET=()
VASTAUS_STUB="https://karstula.paikky.fi"
kysy_asetukset PAIKKY_BASE_URL PAIKKY_USERNAME PAIKKY_PASSWORD
[[ "${KYSYTYT[*]}" == "PAIKKY_BASE_URL PAIKKY_USERNAME PAIKKY_PASSWORD" ]] \
    && ok 'Kun Päikyn osoite annetaan, tunnus ja salasana kysytään samalla kertaa' \
    || kaadu "Päikyn tunnuksia ei kysytty: '${KYSYTYT[*]}'"
unset -f kysy_asetus

# --- Peilaava kopiointi -----------------------------------------------------

if sisaltaa data "${PAKETIN_OSAT[@]}" || sisaltaa .env "${PAKETIN_OSAT[@]}"; then
    kaadu 'PAKETIN_OSAT sisältää data/ tai .env -- peilaus tuhoaisi ne'
fi
ok 'PAKETIN_OSAT ei sisällä data/- eikä .env-tiedostoa (peilaus ei voi koskea niihin)'

# Suojaus sitä vastaan että peilaus joskus kirjoitetaan uusiksi rsyncin varaan:
# yksi lippu (--delete-excluded) veisi data/:n ja .env:n, eikä rsync ole edes
# taattu Debianin minimiasennuksessa (Priority: standard).
ASENNIN="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/asenna.sh"
if grep -nE '^[[:space:]]*[^#[:space:]].*(rsync|--delete-excluded)' "$ASENNIN"; then
    kaadu 'asenna.sh kutsuu rsynciä tai käyttää --delete-excludedia -- tarkista tarkistukset ja poissulut'
fi
ok 'Peilaus ei nojaa rsynciin (ei taattu jakeluissa) eikä --delete-excludediin'
RM_RIVEJA=0
while IFS= read -r rivi; do
    RM_RIVEJA=$((RM_RIVEJA + 1))
    [[ "$rivi" == *'${osa'* ]] \
        || kaadu "rm -rf koskee muuhun kuin yksittäiseen paketin osaan: $rivi"
done < <(grep -nE '^[[:space:]]*rm -rf' "$ASENNIN")
[[ "$RM_RIVEJA" -ge 1 ]] \
    && ok "rm -rf kohdistuu aina yhteen paketin osaan, ei koko kohdehakemistoon ($RM_RIVEJA kohtaa)" \
    || kaadu 'Peilauksen rm -rf -riviä ei löytynyt -- tarkistus ei enää tarkista mitään'

LAHDE="$TESTIJUURI/paketti"
KOHDE="$TESTIJUURI/kohde"
tee_testipaketti "$LAHDE"
tee_testipaketti "$KOHDE"
kirjoita_tiedosto "$KOHDE/.env" '# säilytä tämä täsmälleen'
chmod 600 "$KOHDE/.env"
kirjoita_tiedosto "$KOHDE/data/infonaytto.db" 'perheen tietokanta'
kirjoita_tiedosto "$KOHDE/data/infonaytto-ennen-viestilahteita.db" 'paluuversio'
kirjoita_tiedosto "$KOHDE/data/logs/palvelin.log" 'lokia'
kirjoita_tiedosto "$KOHDE/server/src/poistunut.ts" 'vanha koodi'
kirjoita_tiedosto "$KOHDE/VERSIO.txt" 'vanha versio'
kirjoita_tiedosto "$LAHDE/.env" 'EI SAA KORVATA'
kirjoita_tiedosto "$LAHDE/data/infonaytto.db" 'EI SAA KORVATA'
kirjoita_tiedosto "$LAHDE/VERSIO.txt" 'uusi versio'
kirjoita_tiedosto "$LAHDE/node_modules/fixture/data/uusi.json" 'riippuvuuden data'
ENV_ENNEN="$(cksum < "$KOHDE/.env")"
ENV_OIKEUDET="$(ls -l "$KOHDE/.env" | cut -c1-10)"

peilaa_paketti "$LAHDE" "$KOHDE"

[[ ! -e "$KOHDE/server/src/poistunut.ts" ]] \
    && ok 'Peilaus poistaa uudesta versiosta poistuneet ohjelmatiedostot' \
    || kaadu 'Poistunut ohjelmatiedosto jäi kohteeseen'
[[ "$(cat "$KOHDE/VERSIO.txt")" == 'uusi versio' ]] \
    && ok 'Peilaus korvaa ohjelmatiedostot uuden paketin versioilla' \
    || kaadu 'Ohjelmatiedostoa ei korvattu'
[[ -f "$KOHDE/node_modules/fixture/data/uusi.json" ]] \
    && ok 'Riippuvuuksien data-nimiset kansiot kopioidaan (vain juuren data/ on suojattu)' \
    || kaadu 'Riippuvuuden data-kansio jäi kopioimatta'
[[ "$(cksum < "$KOHDE/.env")" == "$ENV_ENNEN" && "$(ls -l "$KOHDE/.env" | cut -c1-10)" == "$ENV_OIKEUDET" ]] \
    && ok 'Peilaus säilyttää .env:n tavut ja oikeudet' \
    || kaadu '.env muuttui peilauksessa'
[[ "$(cat "$KOHDE/data/infonaytto.db")" == 'perheen tietokanta' \
   && "$(cat "$KOHDE/data/infonaytto-ennen-viestilahteita.db")" == 'paluuversio' \
   && -f "$KOHDE/data/logs/palvelin.log" ]] \
    && ok 'Peilaus säilyttää data/-kansion, paluutietokannan ja lokit' \
    || kaadu 'data/-kansio kärsi peilauksessa'

[[ ! -e "$KOHDE/$(basename "$LAHDE")" ]] \
    && ok 'Peilaus ei luo lähdehakemistoa kohteen sisään (päivitys ei jää hiljaa tekemättä)' \
    || kaadu 'Peilaus loi kohteeseen alihakemiston lähteen nimellä -- vanha versio jäisi käyttöön'

# Peilaus saa poistaa VAIN paketin osat. Kohteen muut tiedostot -- käyttäjän
# omat, data/ ja .env -- eivät ole listalla eivätkä saa kadota.
kirjoita_tiedosto "$KOHDE/oma-muistiinpano.txt" 'käyttäjän oma tiedosto'
kirjoita_tiedosto "$KOHDE/data/omat-aanet/herätys.wav" 'hälytysääni'
peilaa_paketti "$LAHDE" "$KOHDE"
[[ -f "$KOHDE/oma-muistiinpano.txt" && -f "$KOHDE/data/omat-aanet/herätys.wav" && -f "$KOHDE/.env" ]] \
    && ok 'Peilaus ei poista mitään paketin osien ulkopuolelta' \
    || kaadu 'Peilaus poisti kohteesta tiedostoja jotka eivät kuulu pakettiin'

odota_virhe 'Samaan hakemistoon peilaaminen estetään' peilaa_paketti "$LAHDE" "$LAHDE"
odota_virhe 'Lähteen alihakemistoon peilaaminen estetään' peilaa_paketti "$LAHDE" "$LAHDE/sisalla"
odota_virhe 'Lähteen ylähakemistoon peilaaminen estetään' peilaa_paketti "$LAHDE" "$TESTIJUURI"
odota_virhe 'Juureen peilaaminen estetään' peilaa_paketti "$LAHDE" /
odota_virhe 'Suhteellista kohdetta ei hyväksytä' peilaa_paketti "$LAHDE" kohde

# Pahin tapaus: paketti puretaan asennushakemiston SISÄÄN ja asennin
# osoitetaan samaan hakemistoon. Ilman sisäkkäisyystarkistusta peilaus poistaisi
# lähdepaketin alta kesken kopioinnin: server/src jäisi tyhjäksi, asennus
# rikkoutuisi eikä paluureittiä olisi.
SISAKKAIN="$TESTIJUURI/sisakkain"
tee_testipaketti "$SISAKKAIN"
kirjoita_tiedosto "$SISAKKAIN/.env" 'tunnukset'
kirjoita_tiedosto "$SISAKKAIN/data/infonaytto.db" 'perheen tietokanta'
tee_testipaketti "$SISAKKAIN/uusi-paketti"
odota_virhe 'Asennushakemiston sisään purettu paketti ei kelpaa lähteeksi' \
    peilaa_paketti "$SISAKKAIN/uusi-paketti" "$SISAKKAIN"
[[ -f "$SISAKKAIN/uusi-paketti/server/src/index.ts" && -f "$SISAKKAIN/server/src/index.ts" \
   && -f "$SISAKKAIN/asennus/kaynnista.sh" && "$(cat "$SISAKKAIN/data/infonaytto.db")" == 'perheen tietokanta' ]] \
    && ok 'Sisäkkäisen peilauksen torjunta säilytti sekä lähdepaketin että asennuksen' \
    || kaadu 'Sisäkkäinen peilaus ehti tuhota lähdepaketin tai asennuksen'

# Sama hakemisto ".."-polun kautta annettuna. Pelkkä merkkijonovertailu ei
# huomaisi tätä, ja peilaus poistaisi paketin osat oman lähteensä alta.
odota_virhe '".."-polun kautta annettu lähde = kohde tunnistetaan samaksi' \
    peilaa_paketti "$LAHDE" "$KOHDE/../paketti"
[[ -f "$LAHDE/server/src/index.ts" && -f "$LAHDE/node/bin/node" ]] \
    && ok '".."-polun torjunta säilytti lähdepaketin' \
    || kaadu '".."-polku pääsi tuhoamaan lähdepaketin'

# Symlinkin kautta annettu lähde on sama hakemisto kuin kohde. Windowsin Git
# Bash ei osaa luoda symlinkkejä ilman kehittäjätilaa; Linuxissa tämä ajetaan.
if ln -s "$LAHDE" "$TESTIJUURI/linkki" 2>/dev/null && [[ -L "$TESTIJUURI/linkki" ]]; then
    odota_virhe 'Symlinkin kautta annettu lähde tunnistetaan samaksi kuin kohde' \
        peilaa_paketti "$TESTIJUURI/linkki" "$LAHDE"
    odota_virhe 'Linkitettyä kohdetta ei hyväksytä' peilaa_paketti "$LAHDE" "$TESTIJUURI/linkki"
    [[ -f "$LAHDE/server/src/index.ts" ]] \
        && ok 'Symlinkkitorjunta säilytti lähdepaketin' \
        || kaadu 'Symlinkin kautta ehdittiin tuhota lähdepaketti'
    rm -f "$TESTIJUURI/linkki"
else
    echo "OHITETTU: symlinkkitestit -- tämä alusta ei luo symlinkkejä (ajetaan Linuxissa)"
fi

VIERAS="$TESTIJUURI/vieras"
kirjoita_tiedosto "$VIERAS/.env" 'toinen projekti'
kirjoita_tiedosto "$VIERAS/data/muistio.txt" 'ei infonäyttö'
odota_virhe 'Pelkkä .env ja data eivät oikeuta peilausta' peilaa_paketti "$LAHDE" "$VIERAS"
[[ -f "$VIERAS/.env" && -f "$VIERAS/data/muistio.txt" ]] \
    && ok 'Estetty peilaus ei ehtinyt poistaa mitään vieraasta hakemistosta' \
    || kaadu 'Estetty peilaus ehti tuhota tiedostoja'

kirjoita_tiedosto "$KOHDE/.git" 'kehityskopio'
odota_virhe 'Kehityskopioon ei peilata' peilaa_paketti "$LAHDE" "$KOHDE"
rm -f "$KOHDE/.git"

rm -f "$LAHDE/web/dist/index.html"
odota_virhe 'Vajaasta paketista ei peilata (kohde jäisi rikki)' peilaa_paketti "$LAHDE" "$KOHDE"
[[ -f "$KOHDE/server/src/index.ts" && -f "$KOHDE/.env" ]] \
    && ok 'Vajaan paketin torjunta ei poistanut kohteesta mitään' \
    || kaadu 'Vajaan paketin torjunta ehti tuhota kohteen'

echo ""
echo "Linux-asentimen testit läpi: $LAPI"
