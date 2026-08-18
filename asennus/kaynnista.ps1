<#
.SYNOPSIS
    Käynnistin JULKAISUPAKETILLE (asenna.ps1:n asentama kopio, niputettu Node).
    Kehityskopion vastine on kaynnista-kioski.ps1 — käytä sitä jos ajat
    projektia `git clone` + `npm install` -kopiosta.

.DESCRIPTION
    Sama tehtävä kuin kaynnista-kioski.ps1:llä (odota palvelinta, avaa
    kioskiselain vasta kun se vastaa), mutta kahdella lisäyksellä jotka
    julkaisupaketti tarvitsee eikä kehityskopio:

      1. Palvelimen polut (node\node.exe, server\, .env) pääteltään aina
         TÄMÄN tiedoston sijainnista (`<asennusjuuri>\asennus\kaynnista.ps1`)
         — ei PATHin node.exeä eikä suhteellista ..\.env-polkua. Tämä pitää
         paikkansa vain jos pakettirakennetta (ks. asenna.ps1:n yläkommentti)
         ei ole muutettu.
      2. Tämä tiedosto osaa myös KÄYNNISTÄÄ palvelimen jos se ei jo ole
         käynnissä — sekä työpöydän pikakuvake että ajastettu tehtävä
         "Infonaytto-naytto" käynnistävät selaimen tämän kautta, eikä
         kumpikaan saa olettaa että "Infonaytto-palvelin"-tehtävä ehti jo
         käynnistää sen. asenna.ps1 käyttää samaa käynnistyslogiikkaa
         `-VainPalvelin`-lipulla asennuksen lopuksi tehtävässä
         tarkistuksessa, jottei sama "käynnistä jos ei käynnissä" -logiikka
         asuisi kahdessa paikassa.

.PARAMETER Portti
    Palvelimen portti. Oletus 4173.

.PARAMETER Edge
    Polku selaimen suoritettavaan tiedostoon. Jätä tyhjäksi niin skripti
    etsii sen itse tavanomaisista asennuspoluista.

.PARAMETER OdotusSekunnit
    Kuinka kauan palvelinta odotetaan enintään ennen selaimen avaamista.
    Oletus 300 s.

.PARAMETER VainPalvelin
    Käynnistää (tarvittaessa) vain taustapalvelimen eikä avaa selainta
    lainkaan. Tätä käyttää ajastettu tehtävä "Infonaytto-palvelin" — ei
    tarkoitettu käsin ajettavaksi, mutta ei siitä haittaakaan ole.

.PARAMETER VainFunktiot
    Sisäinen lippu: lataa tästä tiedostosta vain funktiot, älä suorita
    mitään. Käytetään ainoastaan automaattitestauksessa (esim.
    `. .\kaynnista.ps1 -VainFunktiot` ja sen jälkeen funktioiden kutsuminen
    suoraan) — ei tarkoitettu tuotantokäyttöön.
#>
[CmdletBinding()]
param(
    [int]$Portti = 4173,
    [string]$Edge = '',
    [int]$OdotusSekunnit = 300,
    [switch]$VainPalvelin,
    [switch]$VainFunktiot
)

$ErrorActionPreference = 'Stop'

# --- Pakettirakenteesta pääteltävät polut ------------------------------------
# asennus\kaynnista.ps1 -> asennusjuuri on yksi taso ylöspäin. Sama päättely
# kuin asenna.ps1:ssä (ks. sen yläkommentti "SITOVA PAKETTIRAKENNE").
$asennusJuuri = Split-Path -Parent $PSScriptRoot
$nodeExe = Join-Path $asennusJuuri 'node\node.exe'
$serverHakemisto = Join-Path $asennusJuuri 'server'
$envPolku = Join-Path $asennusJuuri '.env'

# --- Funktiot -----------------------------------------------------------------

# Sama etsintälogiikka kuin asenna.ps1:n Get-Edgepolku-funktiossa — pieni ja
# vakaa (kaksi tavanomaista asennuspolkua), joten kahtena kopiona pitäminen on
# tarkoituksellista eikä laiskuutta: kumpikin tiedosto tarvitsee sen itsenäisesti
# eikä niitä voi turvallisesti jakaa ilman kolmatta tiedostoa (ks. asenna.ps1:n
# kommentti muuttujien nimitörmäyksestä, jos tätä joskus yritetään dot-sourcata).
function Get-EdgePolku {
    $ehdokkaat = @(
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
    )
    return ($ehdokkaat | Where-Object { Test-Path $_ } | Select-Object -First 1)
}

# Kysyy /api/health-osoitteelta kunnes se vastaa 200:lla tai aika loppuu.
# Sama logiikka kuin kaynnista-kioski.ps1:ssä, mutta funktioksi eristettynä
# jotta sekä "onko jo käynnissä" -pikatarkistus että pitkä odotus voivat
# käyttää samaa koodia, ja jotta se on testattavissa erikseen (ks. VainFunktiot).
function Wait-PalvelinTerveys {
    param(
        [int]$Portti,
        [int]$OdotusSekunnit = 300
    )
    $osoite = "http://localhost:$Portti/api/health"
    $maaraaika = (Get-Date).AddSeconds($OdotusSekunnit)
    while ((Get-Date) -lt $maaraaika) {
        try {
            $vastaus = Invoke-WebRequest -Uri $osoite -UseBasicParsing -TimeoutSec 5
            if ($vastaus.StatusCode -eq 200) { return $true }
        } catch {
            # Palvelin ei ole vielä pystyssä — odotettua käynnistyksen aikana.
        }
        Start-Sleep -Seconds 2
    }
    return $false
}

# Käynnistää palvelimen taustalle piilotettuna (ei konsoli-ikkunaa jäämään
# ruudulle). Prosessi jää elämään vaikka tämä skripti (ja sen mahdollinen
# powershell-emo, esim. ajastetun tehtävän käynnistämä) päättyy heti perään —
# Start-Process ilman -Wait irrottaa lapsiprosessin normaalisti.
function Start-PalvelinTaustalle {
    param(
        [string]$NodeExe,
        [string]$ServerHakemisto,
        [string]$EnvPolku
    )
    Start-Process -FilePath $NodeExe `
        -ArgumentList "--env-file-if-exists=`"$EnvPolku`"", 'src\index.ts' `
        -WorkingDirectory $ServerHakemisto `
        -WindowStyle Hidden
}

if ($VainFunktiot) { return }

# --- Suoritus -------------------------------------------------------------

# Pikatarkistus: jos palvelin vastaa jo (esim. "Infonaytto-palvelin"-tehtävä
# ehti ensin, tai palvelin oli jo käynnissä), ei käynnistetä toista
# node-prosessia samaan porttiin — se joka tapauksessa kaatuisi heti
# (portti varattu), mutta turha yritys on siisti välttää.
$jokoKaynnissa = Wait-PalvelinTerveys -Portti $Portti -OdotusSekunnit 2
if (-not $jokoKaynnissa) {
    Start-PalvelinTaustalle -NodeExe $nodeExe -ServerHakemisto $serverHakemisto -EnvPolku $envPolku
}

if ($VainPalvelin) {
    # Tehtävä "Infonaytto-palvelin" käyttää tätä lippua eikä tarvitse enempää:
    # palvelin on nyt käynnistetty (tai oli jo), selainta ei avata.
    return
}

# Selain avataan myös silloin kun odotus ei tuottanut tulosta: tyhjä ruutu ei
# auta ketään, ja Edge näyttää edes jotain mistä vian voi päätellä. Palvelin
# käynnistyy omalla RestartCount-asetuksellaan (ks. asenna.ps1), joten sivun
# päivittäminen voi riittää korjaukseksi.
$vastasi = Wait-PalvelinTerveys -Portti $Portti -OdotusSekunnit $OdotusSekunnit
if (-not $vastasi) {
    Write-Warning "Palvelin ei vastannut $OdotusSekunnit sekunnissa. Avataan selain silti."
}

if (-not $Edge) {
    $Edge = Get-EdgePolku
    if (-not $Edge) { throw 'Microsoft Edgeä ei löytynyt.' }
}

$argumentit = @(
    '--kiosk', "http://localhost:$Portti"
    '--edge-kiosk-type=fullscreen'
    '--no-first-run'
    # Ilman tätä selain vaimentaa äänen kunnes sivulla on tehty jokin ele.
    # Kouluhälytys soi aamulla eikä kukaan ole koskenut näyttöön yöllä.
    '--autoplay-policy=no-user-gesture-required'
    '--disable-features=TranslateUI'
    '--disable-pinch'
    '--overscroll-history-navigation=0'
)

Start-Process -FilePath $Edge -ArgumentList $argumentit
