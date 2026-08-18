#!/usr/bin/env bash
#
# Käynnistää Infonäytön taustapalvelimen käsin, niputetulla Node-versiolla.
# Tätä samaa skriptiä käyttää myös infonaytto.service-systemd-yksikkö
# (ks. asenna.sh) -- jos haluat käynnistää palvelimen itse ilman systemdiä
# (esim. testataksesi jotain), aja tämä suoraan:
#
#   ./kaynnista.sh
#
# Palvelin jää käymään etualalla (Ctrl+C pysäyttää). Lokit tulevat myös
# konsoliin LOG_LEVEL=debug-tilassa; muuten ks. data/logs/.
#
# HUOM: tämä EI ole sama kuin asennus/asenna-kioski.sh, joka on
# kehityskopiolle (git clone + npm) -- tämä skripti kuuluu puretulle
# julkaisupaketille, jossa Node on jo mukana eikä npm:ää tarvita.

set -euo pipefail

JUURI="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="$JUURI/node/bin/node"
PALVELIN_TIEDOSTO="$JUURI/server/src/index.ts"
ENV_POLKU="$JUURI/.env"

if [[ ! -x "$NODE_BIN" ]]; then
    echo "VIRHE: niputettua Nodea ei löydy tai se ei ole ajokelpoinen: $NODE_BIN" >&2
    echo "  Tarkista että olet purkanut koko julkaisupaketin, äläkä vain 'asennus'-kansiota." >&2
    exit 1
fi
if [[ ! -f "$PALVELIN_TIEDOSTO" ]]; then
    echo "VIRHE: palvelinta ei löydy polusta: $PALVELIN_TIEDOSTO" >&2
    exit 1
fi

# --env-file-if-exists: käynnistys ei kaadu vaikka .env puuttuisi (esim.
# ensimmäistä kertaa asenna.sh:n sisältä ennen kuin .env on vielä kirjoitettu).
cd "$JUURI/server"
exec "$NODE_BIN" "--env-file-if-exists=$ENV_POLKU" "$PALVELIN_TIEDOSTO"
