<#
.SYNOPSIS
    Asentaa Infonäytön JULKAISUPAKETISTA (puretusta zip-paketista, jossa Node
    on mukana). Kehityskopion vastine on asenna-kioski.ps1 — käytä sitä jos
    ajat projektia `git clone` + `npm install` -kopiosta etkä valmiista
    julkaisupaketista.

.DESCRIPTION
    Kysyy kaikki .env:n asetukset, kirjoittaa .env:n asennushakemistoon ja
    rajaa sen oikeudet asentavaan käyttäjään, ottaa automaattikäynnistyksen
    käyttöön (kysytään), luo työpöydän pikakuvakkeen joka käynnistää suoraan
    kioskitilaan, ja lopuksi käynnistää palvelimen ja todentaa että se vastaa
    ennen kuin asennus julistetaan onnistuneeksi.

    SITOVA PAKETTIRAKENNE (tämä skripti olettaa tämän eikä toimi jos se on
    toinen):

        <asennusjuuri>/
          node/node.exe    <- niputettu Node
          server/src/...   <- ajetaan suoraan .ts-tiedostoina
          server/package.json
          web/dist/...
          node_modules/
          data/            <- tämä skripti luo, SÄILYTETÄÄN AINA uudelleenajossa
          .env             <- tämä skripti luo
          asennus/asenna.ps1, kaynnista.ps1
          VERSIO.txt

    Palvelin käynnistetään aina `<asennusjuuri>\server`-työhakemistosta komennolla
    `node\node.exe --env-file-if-exists=<asennusjuuri>\.env src\index.ts` —
    .env-polku on ehdoin tahdoin ABSOLUUTTINEN eikä ..\.env, koska
    server/src/core/config.ts johtaa polut moduulin sijainnista eikä
    työhakemistosta, ja suhteellinen .env-polku olisi hauras jos joku joskus
    käynnistää palvelimen muualta.

    Aja tämä paketin omasta asennus-kansiosta, järjestelmänvalvojana:

        powershell -ExecutionPolicy Bypass -File .\asenna.ps1

    Uudelleenajo (esim. version päivitys) on TUETTU tapaus, ei poikkeus:
    data-kansio säilyy aina, ja olemassa oleva .env korvataan vain vahvistuksen
    jälkeen.

    Purku: `.\asenna.ps1 -Poista` — poistaa ajastetut tehtävät ja työpöydän
    pikakuvakkeen. Ei koskaan .env:ää eikä data-kansiota (ks. yllä) — poista ne
    itse jos et enää tarvitse niitä.

.PARAMETER Poista
    Poistaa ajastetut tehtävät ja työpöydän pikakuvakkeen asentamisen sijaan.

.PARAMETER VainFunktiot
    Sisäinen lippu: lataa tästä tiedostosta vain funktiot, älä kysy mitään
    eikä asenna mitään. Käytetään ainoastaan automaattitestauksessa
    (`. .\asenna.ps1 -VainFunktiot`) — ei tarkoitettu tuotantokäyttöön eikä
    vaadi järjestelmänvalvojan oikeuksia, koska mitään ei suoriteta.
#>
[CmdletBinding()]
param(
    [switch]$Poista,
    [switch]$VainFunktiot
)

$ErrorActionPreference = 'Stop'

$palvelinTehtava = 'Infonaytto-palvelin'
$nayttoTehtava = 'Infonaytto-naytto'
$pikakuvakeNimi = 'Infonäyttö (kioski).lnk'
$FULL_PIN_MIN_PITUUS = 6 # sama raja kuin server/src/routes/access.ts:ssä

# =============================================================================
# Funktiot — testattavissa erikseen dot-sourcemalla `-VainFunktiot`-lipulla.
# =============================================================================

function Test-Adminina {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Sama etsintälogiikka kuin kaynnista.ps1:n Get-Edgepolku-funktiossa. Kahtena
# kopiona tarkoituksella — ks. kaynnista.ps1:n kommentti.
function Get-EdgePolku {
    $ehdokkaat = @(
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
    )
    return ($ehdokkaat | Where-Object { Test-Path $_ } | Select-Object -First 1)
}

# Sama /api/health-odotuslogiikka kuin kaynnista.ps1:ssä. Kopiona tarkoituksella
# (ks. kaynnista.ps1:n kommentti muuttujien nimitörmäystä dot-sourcessa) —
# pidä nämä kaksi synkassa jos toista muutetaan.
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

function Test-PorttiNumero {
    param([string]$Arvo)
    if ($Arvo -notmatch '^\d+$') { return $false }
    $n = [int]$Arvo
    return ($n -ge 1 -and $n -le 65535)
}

# Sitova bind-testi lokaaliin osoitteeseen — ei täydellinen (joku voi varata
# portin testin ja oikean käynnistyksen välissä), mutta riittää kertomaan
# käyttäjälle heti jos portti on ilmiselvästi jo varattu sen sijaan että
# virhe tulisi vasta palvelimen käynnistysyrityksestä minuutteja myöhemmin.
function Test-PorttiVapaa {
    param([int]$Portti)
    try {
        $kuuntelija = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Portti)
        $kuuntelija.Start()
        $kuuntelija.Stop()
        return $true
    } catch {
        return $false
    }
}

function Test-UrlKelvollinen {
    param([string]$Arvo)
    if ([string]::IsNullOrWhiteSpace($Arvo)) { return $false }
    $uri = $null
    if (-not [Uri]::TryCreate($Arvo, [UriKind]::Absolute, [ref]$uri)) { return $false }
    return ($uri.Scheme -eq 'http' -or $uri.Scheme -eq 'https')
}

# Desimaaliluku pisteellä eikä pilkulla (server/src/core/config.ts lukee
# arvon JS:n Number()-funktiolla), riippumatta koneen alueasetuksesta.
function Test-DesimaaliValidi {
    param([string]$Arvo)
    $tmp = 0.0
    return [double]::TryParse($Arvo, [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$tmp)
}

# Tyhjä on aina kelvollinen (FULL_PIN-taso ei silloin käytössä). Palauttaa
# $false vain jos jotain annettiin mutta se on lyhyempi kuin vaadittu
# vähimmäispituus — sama sääntö kuin server/src/routes/access.ts:n
# FULL_PIN_MIN_LENGTH:ssä. Lyhyempää ei hyväksytä hiljaa (ks. README:n
# Tietoturva-kohta): käyttäjälle kerrotaan aina eksplisiittisesti että taso
# jää pois päältä, eikä tätä funktiota käyttävä kutsuja saa jatkaa hiljaa.
function Test-FullPinPituus {
    param([string]$Arvo)
    if ([string]::IsNullOrEmpty($Arvo)) { return $true }
    return $Arvo.Length -ge $script:FULL_PIN_MIN_PITUUS
}

function Test-AsennusHakemistoPolku {
    param([string]$Polku)
    if ([string]::IsNullOrWhiteSpace($Polku)) { return $false }
    if (-not [System.IO.Path]::IsPathRooted($Polku)) { return $false }
    try {
        [System.IO.Path]::GetFullPath($Polku) | Out-Null
        return $true
    } catch {
        return $false
    }
}

function Get-NormalisoituPolku {
    param([string]$Polku)
    return ([System.IO.Path]::GetFullPath($Polku)).TrimEnd('\').ToLowerInvariant()
}

# Yksi kehote oletusarvolla — tyhjä vastaus (pelkkä Enter) = oletus.
function Read-KysyttyArvo {
    param([string]$Kehote, [string]$Oletus = '')
    $naytettavaOletus = if ($Oletus) { " [$Oletus]" } else { '' }
    $vastaus = Read-Host -Prompt "$Kehote$naytettavaOletus"
    if ([string]::IsNullOrWhiteSpace($vastaus)) { return $Oletus }
    return $vastaus.Trim()
}

# Salasanat ja PIN-koodit: piilotettu syöttö, ei koskaan kaiuteta ruudulle
# eikä lokiin. SecureString puretaan vain hetkeksi muistiin .env-tiedoston
# kirjoittamista varten ja BSTR-puskuri nollataan heti perään.
function Read-SalainenTeksti {
    param([string]$Kehote)
    $suojattu = Read-Host -Prompt $Kehote -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($suojattu)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
}

# Rakentaa .env-tiedoston sisällön annetuista arvoista. Puhdas funktio —
# testattavissa ilman että mitään kirjoitetaan levylle.
function New-EnvTiedostoSisalto {
    param([hashtable]$Arvot)
    $rivit = [System.Collections.Generic.List[string]]::new()
    $rivit.Add('# Luotu asenna.ps1:llä ' + (Get-Date -Format 'yyyy-MM-dd HH:mm'))
    $rivit.Add('# Sisältää Wilma-salasanan selväkielisenä. Ks. KAYTTOONOTTO.md, kohta Tietoturva.')
    $rivit.Add('')
    $rivit.Add('PORT=' + $Arvot.PORT)
    $rivit.Add('LOG_LEVEL=' + $Arvot.LOG_LEVEL)
    $rivit.Add('')
    $rivit.Add('WEATHER_LAT=' + $Arvot.WEATHER_LAT)
    $rivit.Add('WEATHER_LON=' + $Arvot.WEATHER_LON)
    $rivit.Add('WEATHER_PLACE=' + $Arvot.WEATHER_PLACE)
    $rivit.Add('')
    $rivit.Add('WILMA_BASE_URL=' + $Arvot.WILMA_BASE_URL)
    $rivit.Add('WILMA_USERNAME=' + $Arvot.WILMA_USERNAME)
    $rivit.Add('WILMA_PASSWORD=' + $Arvot.WILMA_PASSWORD)
    $rivit.Add('')
    $rivit.Add('CALENDAR_ICS_URL=' + $Arvot.CALENDAR_ICS_URL)
    $rivit.Add('')
    $rivit.Add('EDIT_PIN=' + $Arvot.EDIT_PIN)
    $rivit.Add('FULL_PIN=' + $Arvot.FULL_PIN)
    $rivit.Add('')
    $rivit.Add('TRUSTED_HOSTS=' + $Arvot.TRUSTED_HOSTS)
    return ($rivit -join "`r`n") + "`r`n"
}

# Kirjoittaa .env:n UTF-8:na ilman BOMia (Noden --env-file-if-exists ei odota
# BOMia) ja rajaa sen oikeudet asentavaan käyttäjään + Administrators-ryhmään.
# .env sisältää Wilma-tilin salasanan selväkielisenä (README:n tunnistama
# riski) — tämä ei poista riskiä mutta estää muita samalla koneella olevia
# käyttäjätilejä lukemasta sitä.
function Write-EnvTiedosto {
    param([string]$Polku, [string]$Sisalto)
    $enkoodaus = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText($Polku, $Sisalto, $enkoodaus)
    Protect-EnvTiedosto -Polku $Polku
}

function Protect-EnvTiedosto {
    param([string]$Polku)
    $identiteetti = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    # Administrators-ryhmän SID on kielialueesta riippumaton (nimi vaihtelee
    # suomenkielisellä Windowsilla) — käytetään sitä eikä ryhmän nimeä.
    $adminSid = 'S-1-5-32-544'

    icacls $Polku /inheritance:r | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "icacls /inheritance:r epäonnistui tiedostolle $Polku" }
    icacls $Polku /grant:r "${identiteetti}:F" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "icacls /grant epäonnistui käyttäjälle $identiteetti tiedostolle $Polku" }
    icacls $Polku /grant:r "*${adminSid}:F" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "icacls /grant epäonnistui Administrators-ryhmälle tiedostolle $Polku" }
}

# Työpöydän pikakuvake joka käynnistää suoraan kioskitilaan (palvelin mukaan
# lukien, jos se ei jo ole käynnissä — ks. kaynnista.ps1). -WindowStyle Hidden
# powershellin omalle ikkunalle + WindowStyle 7 (minimoitu) pikakuvakkeelle
# itselleen: kumpikaan ei saa jättää ikkunaa roikkumaan ruudulle.
function New-KioskiPikakuvake {
    param(
        [string]$Polku,
        [string]$KaynnistinPolku,
        [string]$EdgePolku,
        [int]$Portti
    )
    $shell = New-Object -ComObject WScript.Shell
    $pikakuvake = $shell.CreateShortcut($Polku)
    $pikakuvake.TargetPath = (Get-Command powershell.exe).Source
    $pikakuvake.Arguments = "-ExecutionPolicy Bypass -NonInteractive -WindowStyle Hidden -File `"$KaynnistinPolku`" -Portti $Portti -Edge `"$EdgePolku`""
    $pikakuvake.WorkingDirectory = Split-Path -Parent $KaynnistinPolku
    $pikakuvake.IconLocation = "$EdgePolku,0"
    $pikakuvake.WindowStyle = 7
    $pikakuvake.Description = 'Käynnistää Infonäytön kioskitilassa'
    $pikakuvake.Save()
}

# Etsii ja pysäyttää tämän asennuksen node.exe-palvelinprosessin komentorivin
# perusteella. Stop-ScheduledTask ei riitä tähän: "Infonaytto-palvelin"-tehtävä
# käynnistää powershell.exen, joka käynnistää node.exen ja palaa heti — Task
# Scheduler seuraa vain sitä suoraan käynnistämäänsä powershell-prosessia, joka
# on tuossa vaiheessa jo päättynyt, ei irrotettua node-lapsiprosessia.
# Täsmää vain komentorivin SISÄLTÄMÄÄN palvelimen absoluuttiseen työhakemistoon
# — ei kaikkiin node.exe-prosesseihin koneella, jottei tämä voisi vahingossa
# sammuttaa jotain muuta samalla koneella ajettavaa Node-sovellusta.
function Stop-VanhaPalvelin {
    param([string]$ServerHakemisto)
    $prosessit = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine.Contains($ServerHakemisto) })
    foreach ($p in $prosessit) {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
    return $prosessit.Count
}

if ($VainFunktiot) { return }

# =============================================================================
# Suoritus
# =============================================================================

if (-not (Test-Adminina)) {
    Write-Error 'Aja tämä skripti järjestelmänvalvojana (Run as administrator).'
}

if ($Poista) {
    foreach ($nimi in @($palvelinTehtava, $nayttoTehtava)) {
        $olemassa = Get-ScheduledTask -TaskName $nimi -ErrorAction SilentlyContinue
        if ($olemassa) {
            Unregister-ScheduledTask -TaskName $nimi -Confirm:$false
            Write-Output "Poistettu ajastettu tehtävä: $nimi"
        } else {
            Write-Output "Tehtävää ei ollut: $nimi"
        }
    }

    # Ajastettujen tehtävien poisto ei pysäytä jo käynnissä olevaa palvelinta
    # (sama syy kuin Stop-VanhaPalvelin-funktion kommentissa: Task Scheduler
    # seuraa vain powershell-käynnistintä, ei irrotettua node-lapsiprosessia).
    # $PSScriptRoot on tässä <asennusjuuri>\asennus, koska -Poista ajetaan
    # oikean asennuksen omasta asennus-kansiosta.
    $poistettavaJuuri = Split-Path -Parent $PSScriptRoot
    $pysaytettyja = Stop-VanhaPalvelin -ServerHakemisto (Join-Path $poistettavaJuuri 'server')
    if ($pysaytettyja -gt 0) {
        Write-Output "Pysäytetty palvelinprosessi ($pysaytettyja kpl)."
    }

    $pikakuvakePolku = Join-Path ([Environment]::GetFolderPath('Desktop')) $pikakuvakeNimi
    if (Test-Path $pikakuvakePolku) {
        Remove-Item $pikakuvakePolku -Force
        Write-Output "Poistettu työpöydän pikakuvake: $pikakuvakePolku"
    } else {
        Write-Output 'Työpöydän pikakuvaketta ei ollut.'
    }

    Write-Output ''
    Write-Output 'Valmis. .env ja data-kansio säilytettiin koskemattomina — poista ne itse'
    Write-Output 'jos et enää tarvitse niitä (samoin koko asennushakemisto). Virranhallinnan'
    Write-Output 'asetuksia ei muutettu.'
    return
}

Write-Output 'Infonäytön asennus (julkaisupaketti)'
Write-Output '===================================='
Write-Output ''

# --- Asennushakemisto --------------------------------------------------------
# Paketti ajetaan täältä (asennus\asenna.ps1 sijainti), mutta pysyvä
# asennuspaikka voi olla eri kansio.
$paketinJuuri = Split-Path -Parent $PSScriptRoot

Write-Output "Paketti on purettuna: $paketinJuuri"
Write-Output 'Anna pysyvä asennushakemisto, tai paina Enter asentaaksesi tähän samaan paikkaan.'
$asennusJuuri = $null
do {
    $syote = Read-KysyttyArvo -Kehote 'Asennushakemisto' -Oletus $paketinJuuri
    if (-not (Test-AsennusHakemistoPolku $syote)) {
        Write-Host 'Anna kelvollinen, täysi polku (esim. C:\Infonaytto).' -ForegroundColor Yellow
        continue
    }
    $asennusJuuri = ([System.IO.Path]::GetFullPath($syote)).TrimEnd('\')
    break
} while ($true)

$eriKohde = (Get-NormalisoituPolku $asennusJuuri) -ne (Get-NormalisoituPolku $paketinJuuri)
$onPaivitys = Test-Path (Join-Path $asennusJuuri 'server\src\index.ts')

if ($onPaivitys) {
    Write-Output ''
    Write-Output "Kohteessa $asennusJuuri on jo asennus — tämä on PÄIVITYS."
    Write-Output 'data-kansio (tietokanta, muistilista, hälytysäänet, lokit) säilyy koskemattomana.'
    $vanhaServerHakemisto = Join-Path $asennusJuuri 'server'
    $pysaytettyja = Stop-VanhaPalvelin -ServerHakemisto $vanhaServerHakemisto
    if ($pysaytettyja -gt 0) {
        Write-Output "Pysäytettiin edellinen palvelinprosessi ($pysaytettyja kpl) ennen päivitystä."
        Start-Sleep -Seconds 2
    }
}

if ($eriKohde) {
    if (-not (Test-Path $asennusJuuri)) {
        New-Item -ItemType Directory -Path $asennusJuuri -Force | Out-Null
    }
    Write-Output "Kopioidaan paketti kohteeseen $asennusJuuri ..."
    # /XD data ja /XF .env: tuoreessa paketissa näitä ei pitäisi olla, mutta
    # jos jostain syystä on, kohteen omia (data = perheen data, .env = juuri
    # kysytyt asetukset kirjoitetaan kohta) ei koskaan haluta korvata tuoduilla.
    # /R:2 /W:2: robocopyn oletus (miljoona uusintaa 30 s välein) voisi jäädä
    # roikkumaan pitkäksi aikaa jos jokin tiedosto on lukossa — asennus ei saa
    # jäädä jumiin siihen, virhe kerrotaan selvästi sen sijaan.
    robocopy $paketinJuuri $asennusJuuri /E /XD data /XF .env /NFL /NDL /NJH /NJS /NP /R:2 /W:2 | Out-Null
    if ($LASTEXITCODE -ge 8) {
        throw "Paketin kopiointi epäonnistui (robocopy-koodi $LASTEXITCODE). Kohde: $asennusJuuri"
    }
    Write-Output 'Kopiointi valmis.'
}

$nodeExe = Join-Path $asennusJuuri 'node\node.exe'
$serverHakemisto = Join-Path $asennusJuuri 'server'
$envPolku = Join-Path $asennusJuuri '.env'
$dataHakemisto = Join-Path $asennusJuuri 'data'
$kaynnistinPolku = Join-Path $asennusJuuri 'asennus\kaynnista.ps1'

if (-not (Test-Path $nodeExe)) {
    throw "Niputettua Nodea ei löydy polusta $nodeExe. Paketti on virheellinen tai vaurioitunut."
}
if (-not (Test-Path (Join-Path $serverHakemisto 'src\index.ts'))) {
    throw "Palvelinta ei löydy kohteesta $serverHakemisto. Paketti on virheellinen tai vaurioitunut."
}
if (-not (Test-Path $kaynnistinPolku)) {
    throw "Käynnistintä ei löydy polusta $kaynnistinPolku."
}
if (-not (Test-Path (Join-Path $asennusJuuri 'web\dist\index.html'))) {
    Write-Warning 'Käyttöliittymää ei löydy paketista (web\dist\index.html puuttuu) — paketti voi olla vaurioitunut.'
}

$edgePolku = Get-EdgePolku
if (-not $edgePolku) {
    throw 'Microsoft Edgeä ei löytynyt tavanomaisista asennuspoluista. Asenna Edge ja aja skripti uudelleen.'
}

# --- Kysytään .env:n asetukset ------------------------------------------------
Write-Output ''
Write-Output '--- Asetukset ---'
Write-Output '(Enter = oletusarvo hakasulkeissa. Wilma-salasana ja PIN-koodit eivät näy ruudulla.)'
Write-Output ''

$portti = 0
do {
    $porttiSyote = Read-KysyttyArvo -Kehote 'Portti' -Oletus '4173'
    if (-not (Test-PorttiNumero $porttiSyote)) {
        Write-Host 'Anna kokonaisluku väliltä 1-65535.' -ForegroundColor Yellow
        continue
    }
    $ehdokas = [int]$porttiSyote
    if (-not (Test-PorttiVapaa $ehdokas)) {
        Write-Host "Portti $ehdokas on jo käytössä. Valitse toinen, tai vapauta se ja yritä uudelleen." -ForegroundColor Yellow
        continue
    }
    $portti = $ehdokas
    break
} while ($true)

$logLevel = ''
do {
    $logLevel = Read-KysyttyArvo -Kehote 'Lokitaso (warn/error/debug)' -Oletus 'warn'
    if (@('warn', 'error', 'debug') -notcontains $logLevel) {
        Write-Host 'Anna warn, error tai debug.' -ForegroundColor Yellow
        continue
    }
    break
} while ($true)

$weatherLat = ''
do {
    $weatherLat = Read-KysyttyArvo -Kehote 'Sään leveysaste (WEATHER_LAT)' -Oletus '62.86667'
    if (-not (Test-DesimaaliValidi $weatherLat)) {
        Write-Host 'Anna desimaaliluku pisteellä, esim. 62.86667.' -ForegroundColor Yellow
        continue
    }
    break
} while ($true)

$weatherLon = ''
do {
    $weatherLon = Read-KysyttyArvo -Kehote 'Sään pituusaste (WEATHER_LON)' -Oletus '24.78333'
    if (-not (Test-DesimaaliValidi $weatherLon)) {
        Write-Host 'Anna desimaaliluku pisteellä, esim. 24.78333.' -ForegroundColor Yellow
        continue
    }
    break
} while ($true)

$weatherPlace = Read-KysyttyArvo -Kehote 'Paikkakunnan nimi säätiedoille (WEATHER_PLACE)' -Oletus 'Karstula'

$wilmaBaseUrl = ''
do {
    $wilmaBaseUrl = Read-KysyttyArvo -Kehote 'Wilman osoite, esim. https://koulu.inschool.fi (tyhjä = Wilma pois käytöstä)' -Oletus ''
    if ($wilmaBaseUrl -and -not (Test-UrlKelvollinen $wilmaBaseUrl)) {
        Write-Host 'Anna kelvollinen http(s)-osoite, tai jätä tyhjäksi.' -ForegroundColor Yellow
        continue
    }
    break
} while ($true)

$wilmaUsername = ''
$wilmaPassword = ''
if ($wilmaBaseUrl) {
    $wilmaUsername = Read-KysyttyArvo -Kehote 'Wilman käyttäjätunnus (huoltaja)' -Oletus ''
    $wilmaPassword = Read-SalainenTeksti -Kehote 'Wilman salasana'
}

$calendarIcsUrl = ''
do {
    $calendarIcsUrl = Read-KysyttyArvo -Kehote 'Kalenterin ICS-osoite (Google Calendar, tyhjä = pois käytöstä)' -Oletus ''
    if ($calendarIcsUrl -and -not (Test-UrlKelvollinen $calendarIcsUrl)) {
        Write-Host 'Anna kelvollinen http(s)-osoite, tai jätä tyhjäksi.' -ForegroundColor Yellow
        continue
    }
    break
} while ($true)

Write-Output ''
Write-Output 'EDIT_PIN antaa muistilistan/asetusten/hälytysten muokkauksen puhelimesta (ei Wilma-tietoja).'
$editPin = Read-SalainenTeksti -Kehote 'EDIT_PIN (tyhjä = ei käytössä)'

Write-Output ''
Write-Output "FULL_PIN antaa myös lasten Wilma-tiedot puhelimesta. Vähintään $FULL_PIN_MIN_PITUUS merkkiä,"
Write-Output 'lyhyempi EI ota tasoa käyttöön lainkaan.'
$fullPin = ''
do {
    $fullPin = Read-SalainenTeksti -Kehote 'FULL_PIN (tyhjä = ei käytössä)'
    if (-not (Test-FullPinPituus $fullPin)) {
        Write-Host "Tämä on alle $FULL_PIN_MIN_PITUUS merkkiä — FULL_PIN EI tulisi käyttöön. Anna vähintään $FULL_PIN_MIN_PITUUS merkkiä tai jätä tyhjäksi." -ForegroundColor Yellow
        continue
    }
    break
} while ($true)

$trustedHosts = Read-KysyttyArvo -Kehote 'Luotetut laitteet, pilkulla erotettuna (esim. 192.168.10.50,puhelin.local, tyhjä = ei mitään)' -Oletus ''

# --- Yhteenveto ja vahvistus --------------------------------------------------
Write-Output ''
Write-Output '--- Yhteenveto ---'
Write-Output "Asennushakemisto : $asennusJuuri"
Write-Output "Portti           : $portti"
Write-Output "Lokitaso         : $logLevel"
Write-Output "Sää              : $weatherPlace ($weatherLat, $weatherLon)"
Write-Output "Wilma            : $(if ($wilmaBaseUrl) { "$wilmaBaseUrl (tunnus: $wilmaUsername, salasana annettu)" } else { 'ei käytössä' })"
Write-Output "Kalenteri        : $(if ($calendarIcsUrl) { 'ICS-osoite annettu' } else { 'ei käytössä' })"
Write-Output "EDIT_PIN         : $(if ($editPin) { "annettu ($($editPin.Length) merkkiä)" } else { 'ei käytössä' })"
Write-Output "FULL_PIN         : $(if ($fullPin) { "annettu ($($fullPin.Length) merkkiä)" } else { 'ei käytössä' })"
Write-Output "TRUSTED_HOSTS    : $(if ($trustedHosts) { $trustedHosts } else { '(ei mitään)' })"
Write-Output ''

if (Test-Path $envPolku) {
    Write-Host ".env on jo olemassa: $envPolku" -ForegroundColor Yellow
    Write-Host 'Se korvataan juuri annetuilla arvoilla. data-kansio säilyy aina koskemattomana.' -ForegroundColor Yellow
    $vahvistus = Read-Host 'Jatketaanko ja korvataan .env? (k/E)'
} else {
    $vahvistus = Read-Host 'Kirjoitetaanko .env näillä arvoilla? (K/e)'
}
if ($vahvistus -match '^[eE]') {
    Write-Output 'Asennus keskeytetty. Mitään ei muutettu.'
    return
}

$envArvot = @{
    PORT              = $portti
    LOG_LEVEL         = $logLevel
    WEATHER_LAT       = $weatherLat
    WEATHER_LON       = $weatherLon
    WEATHER_PLACE     = $weatherPlace
    WILMA_BASE_URL    = $wilmaBaseUrl
    WILMA_USERNAME    = $wilmaUsername
    WILMA_PASSWORD    = $wilmaPassword
    CALENDAR_ICS_URL  = $calendarIcsUrl
    EDIT_PIN          = $editPin
    FULL_PIN          = $fullPin
    TRUSTED_HOSTS     = $trustedHosts
}
Write-EnvTiedosto -Polku $envPolku -Sisalto (New-EnvTiedostoSisalto -Arvot $envArvot)
Write-Output "Kirjoitettu: $envPolku (oikeudet rajattu käyttäjälle $env:USERNAME)"

if (-not (Test-Path $dataHakemisto)) {
    New-Item -ItemType Directory -Path $dataHakemisto -Force | Out-Null
    Write-Output "Luotu: $dataHakemisto"
} else {
    Write-Output "data-kansio säilytetty koskemattomana: $dataHakemisto"
}

# --- Automaattikäynnistys -----------------------------------------------------
Write-Output ''
$autostartVastaus = Read-Host 'Otetaanko automaattikäynnistys käyttöön kirjautumisen yhteydessä? (K/e)'
$autostart = ($autostartVastaus -notmatch '^[eE]')

if ($autostart) {
    # Palvelintehtävä käynnistää kaynnista.ps1:n `-VainPalvelin`-lipulla:
    # sama "käynnistä jos ei jo käynnissä" -logiikka kuin näyttötehtävälläkin,
    # ei kahta paikkaa ylläpidettävänä. -File-muotoinen argumentti on sama,
    # todeksi havaittu kuvio kuin dev-version kaynnista-kioski.ps1:ssä käyttää
    # näyttötehtävälle — vältetään hauraampi -Command-muotoinen komentorivi.
    $palvelinToiminto = New-ScheduledTaskAction `
        -Execute 'powershell.exe' `
        -Argument "-ExecutionPolicy Bypass -NonInteractive -WindowStyle Hidden -File `"$kaynnistinPolku`" -Portti $portti -VainPalvelin"
    $palvelinLiipaisin = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $asetukset = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -RestartCount 5 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -MultipleInstances IgnoreNew

    Register-ScheduledTask `
        -TaskName $palvelinTehtava `
        -Action $palvelinToiminto `
        -Trigger $palvelinLiipaisin `
        -Settings $asetukset `
        -Description 'Infonäytön taustapalvelin (julkaisupaketti)' `
        -Force | Out-Null
    Write-Output "Luotu ajastettu tehtävä: $palvelinTehtava"

    $nayttoToiminto = New-ScheduledTaskAction `
        -Execute 'powershell.exe' `
        -Argument "-ExecutionPolicy Bypass -NonInteractive -WindowStyle Hidden -File `"$kaynnistinPolku`" -Portti $portti -Edge `"$edgePolku`""
    $nayttoLiipaisin = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $nayttoLiipaisin.Delay = 'PT5S' # lyhyt viive riittää, koska kaynnista.ps1 odottaa palvelinta itse

    Register-ScheduledTask `
        -TaskName $nayttoTehtava `
        -Action $nayttoToiminto `
        -Trigger $nayttoLiipaisin `
        -Settings $asetukset `
        -Description 'Infonäytön kioskiselain (julkaisupaketti)' `
        -Force | Out-Null
    Write-Output "Luotu ajastettu tehtävä: $nayttoTehtava"
} else {
    Write-Output 'Automaattikäynnistystä ei otettu käyttöön. Aja tämä skripti uudelleen ottaaksesi sen käyttöön myöhemmin.'
}

# --- Työpöydän pikakuvake (aina, riippumatta automaattikäynnistysvalinnasta) -
$pikakuvakePolku = Join-Path ([Environment]::GetFolderPath('Desktop')) $pikakuvakeNimi
New-KioskiPikakuvake -Polku $pikakuvakePolku -KaynnistinPolku $kaynnistinPolku -EdgePolku $edgePolku -Portti $portti
Write-Output "Luotu työpöydän pikakuvake: $pikakuvakePolku"

# --- Virranhallinta ------------------------------------------------------------
powercfg /change monitor-timeout-ac 0
powercfg /change monitor-timeout-dc 0
powercfg /change standby-timeout-ac 0
powercfg /change standby-timeout-dc 0
powercfg /change hibernate-timeout-ac 0
powercfg /change hibernate-timeout-dc 0
Set-ItemProperty -Path 'HKCU:\Control Panel\Desktop' -Name 'ScreenSaveActive' -Value '0'
Write-Output 'Virranhallinta: näyttö ja lepotila eivät sammu, näytönsäästäjä pois.'

# --- Todennus: käynnistä palvelin ja odota että se vastaa ---------------------
Write-Output ''
Write-Output 'Käynnistetään palvelin todennusta varten...'
& powershell.exe -ExecutionPolicy Bypass -NonInteractive -File $kaynnistinPolku -Portti $portti -VainPalvelin
$terve = Wait-PalvelinTerveys -Portti $portti -OdotusSekunnit 90

if ($terve) {
    Write-Host "Palvelin vastaa: http://localhost:$portti" -ForegroundColor Green
} else {
    Write-Host "VIRHE: palvelin ei vastannut 90 sekunnissa. ASENNUS EI OLE VALMIS." -ForegroundColor Red
    Write-Host "Tarkista loki: $dataHakemisto\logs\ ja yritä käynnistää käsin:" -ForegroundColor Red
    Write-Host "  `"$nodeExe`" --env-file-if-exists=`"$envPolku`" src\index.ts   (työhakemistona $serverHakemisto)" -ForegroundColor Red
}

# --- Wilma-yhteyden testaus (valinnainen, tasan yksi yritys) ------------------
if ($terve -and $wilmaBaseUrl -and $wilmaUsername -and $wilmaPassword) {
    Write-Output ''
    $testaaVastaus = Read-Host 'Testataanko Wilma-yhteys nyt? Väärä salasana on parempi löytää nyt kuin aamulla seinältä. Tasan yksi yritys. (K/e)'
    if ($testaaVastaus -notmatch '^[eE]') {
        try {
            $vastaus = Invoke-WebRequest -Uri "http://localhost:$portti/api/providers/wilma/test" -Method Post -UseBasicParsing -TimeoutSec 30
            if ($vastaus.StatusCode -eq 200) {
                Write-Host 'Wilma-yhteys toimii.' -ForegroundColor Green
            }
        } catch {
            $koodi = $null
            if ($_.Exception.Response) { $koodi = [int]$_.Exception.Response.StatusCode }
            switch ($koodi) {
                502 { Write-Host "Wilma-kirjautuminen epäonnistui — tarkista käyttäjätunnus ja salasana: $envPolku" -ForegroundColor Red }
                429 { Write-Host 'Yhteystestiä ei voitu tehdä juuri nyt (rajoitin). Yritä myöhemmin Asetukset -> Wilma-yhteys -> Testaa yhteys.' -ForegroundColor Yellow }
                409 { Write-Host 'Yhteystesti on jo käynnissä. Yritä hetken kuluttua.' -ForegroundColor Yellow }
                default { Write-Host "Wilma-yhteystesti epäonnistui: $($_.Exception.Message)" -ForegroundColor Red }
            }
        }
    }
} elseif ($terve -and $wilmaBaseUrl) {
    Write-Host 'Wilma-osoite annettiin mutta käyttäjätunnus tai salasana puuttuu — Wilma-yhteystestiä ei tarjota.' -ForegroundColor Yellow
}

# --- Yhteenveto ----------------------------------------------------------------
$lanIp = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.InterfaceAlias -notmatch 'Loopback' -and $_.IPAddress -notlike '169.254.*' } |
    Select-Object -First 1).IPAddress

Write-Output ''
Write-Output '--- Valmis ---'
Write-Output "Asennushakemisto : $asennusJuuri"
Write-Output "Portti           : $portti"
Write-Output "Näyttölaitteella : http://localhost:$portti"
if ($lanIp) {
    Write-Output "Puhelimella (kotiverkosta, ei Wilma-tietoja) : http://${lanIp}:$portti"
} else {
    Write-Output 'Puhelimen osoitetta ei saatu selvitettyä automaattisesti — katso koneen IP komennolla ipconfig.'
}
Write-Output "Automaattikäynnistys : $(if ($autostart) { 'käytössä' } else { 'ei käytössä' })"
Write-Output "Työpöydän pikakuvake : $pikakuvakePolku"
Write-Output ''
Write-Output 'Käynnistä palvelin käsin tarvittaessa:'
Write-Output "  `"$nodeExe`" --env-file-if-exists=`"$envPolku`" src\index.ts   (työhakemistona $serverHakemisto)"
Write-Output ''
Write-Output 'Poista asennus (säilyttää aina .env:n ja data-kansion):'
Write-Output "  powershell -ExecutionPolicy Bypass -File `"$asennusJuuri\asennus\asenna.ps1`" -Poista"
Write-Output ''
Write-Output 'Vielä käsin tehtävät asiat (ks. KAYTTOONOTTO.md):'
Write-Output '  1. Automaattikirjautuminen: netplwiz -> poista rasti "Käyttäjän on annettava...".'
Write-Output '  2. Windows Update -aktiiviset tunnit niin laajaksi kuin sallitaan.'
Write-Output '  3. Testaa: käynnistä kone uudelleen ja varmista että näyttö palaa itsestään.'
