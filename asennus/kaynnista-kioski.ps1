<#
.SYNOPSIS
    Odottaa infonäytön palvelinta ja avaa sitten kioskiselaimen.

.DESCRIPTION
    Ajastettu tehtävä käynnisti aiemmin selaimen kiinteän 20 sekunnin viiveen
    jälkeen. Jos palvelin ei ehtinyt siinä ajassa kuunteluun — kylmäkäynnistys,
    virustarkistus, kaatumisen jälkeinen uudelleenyritys — Edge avasi oman
    virhesivunsa eikä yrittänyt uudelleen koskaan. Seinänäyttö jäi siihen
    tilaan kunnes joku huomasi.

    Se ei ole pelkkä kauneusvirhe: kun sivua ei ole ladattu, koko sovellusta ei
    ole käynnissä, eivätkä aamun kouluhälytykset soi. Sähkökatko tai yöllinen
    Windows Update juuri ennen aamua riittää.

    Tämä käynnistin kyselee palvelimen terveystilaa kunnes se vastaa, ja avaa
    selaimen vasta sitten. Linux-puolen asennus tekee saman curl-silmukalla.

.PARAMETER Portti
    Palvelimen portti. Oletus 4173.

.PARAMETER Edge
    Polku selaimen suoritettavaan tiedostoon.

.PARAMETER OdotusSekunnit
    Kuinka kauan palvelinta odotetaan enintään. Oletus 300 s.
#>
[CmdletBinding()]
param(
    [int]$Portti = 4173,
    [Parameter(Mandatory = $true)][string]$Edge,
    [int]$OdotusSekunnit = 300
)

$ErrorActionPreference = 'Stop'

$osoite = "http://localhost:$Portti/api/health"
$maaraaika = (Get-Date).AddSeconds($OdotusSekunnit)
$vastasi = $false

while ((Get-Date) -lt $maaraaika) {
    try {
        $vastaus = Invoke-WebRequest -Uri $osoite -UseBasicParsing -TimeoutSec 5
        if ($vastaus.StatusCode -eq 200) { $vastasi = $true; break }
    } catch {
        # Palvelin ei ole vielä pystyssä. Tämä on odotettua käynnistyksen
        # aikana, joten ei kohuta siitä — silmukka jatkaa.
    }
    Start-Sleep -Seconds 2
}

# Selain avataan myös silloin kun odotus ei tuottanut tulosta: tyhjä ruutu ei
# auta ketään, ja Edge näyttää edes jotain mistä vian voi päätellä. Palvelin
# käynnistyy omalla RestartCount-asetuksellaan, joten sivun päivittäminen voi
# riittää korjaukseksi.
if (-not $vastasi) {
    Write-Warning "Palvelin ei vastannut $OdotusSekunnit sekunnissa. Avataan selain silti."
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
