<#
.SYNOPSIS
    Asentaa Infonäytön JULKAISUPAKETISTA (puretusta zip-paketista, jossa Node
    on mukana). Kehityskopion vastine on asenna-kioski.ps1 — käytä sitä jos
    ajat projektia `git clone` + `npm install` -kopiosta etkä valmiista
    julkaisupaketista.

.DESCRIPTION
    Skriptillä on kaksi tilaa, ja se päättelee itse kumpi on kyseessä:

      UUSI ASENNUS (kohteessa ei ole .env-tiedostoa)
        Kysyy kaikki .env:n asetukset, kirjoittaa .env:n asennushakemistoon ja
        rajaa sen oikeudet asentavaan käyttäjään, ottaa automaattikäynnistyksen
        käyttöön (kysytään), luo työpöydän pikakuvakkeen joka käynnistää suoraan
        kioskitilaan, ja lopuksi käynnistää palvelimen ja todentaa että se
        vastaa ennen kuin asennus julistetaan onnistuneeksi.

      PÄIVITYS (kohteessa on jo .env)
        EI kysy tunnuksia uudestaan. Olemassa oleva .env säilyy sellaisenaan,
        oikeuksineen; siihen vain LISÄTÄÄN ne avaimet joita mallissa on mutta
        tiedostosta puuttuu (esim. PAIKKY_*, jota ennen Päikky-versiota
        asennetuissa ei ole). Ohjelmatiedostot peilataan uudesta paketista niin
        että poistuneet tiedostot oikeasti häviävät, mutta data-kansioon ei
        kosketa. Automaattikäynnistystä ei luoda uudelleen jos se on jo
        käytössä.

    Jos kohteessa on .env, skripti kysyy silti kumpi tehdään — oletus on
    päivitys, koska se ei hävitä mitään.

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
    data-kansio säilyy aina — siellä on tietokanta (muistilista, asetukset,
    hälytykset, viestien luettu-tila) ja infonaytto-ennen-viestilahteita.db,
    joka on ainoa paluureitti edelliseen julkaisuun. Olemassa oleva .env
    korvataan vain uudessa asennuksessa, ja siihenkin vasta vahvistuksen
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
    $n = 0
    if (-not [int]::TryParse($Arvo, [ref]$n)) { return $false }
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

# Suomalainen postinumero: tasan viisi numeroa. Asennin EI tarkista onko
# postinumero olemassa — se ei tunne postinumeroaineistoa, ja tuntemattomasta
# numerosta kertominen on palvelimen tehtävä (sillä on aineisto käsillä).
#
# \A ja \z eivätkä ^ ja $: .NETin $ hyväksyy perässä rivinvaihdon, jolloin
# "43500`n" menisi läpi. [0-9] eikä \d: \d täsmää .NETissä myös muiden
# kirjoitusjärjestelmien numeroihin, eikä niistä muodostu postinumeroa.
function Test-PostinumeroValidi {
    param([string]$Arvo)
    return $Arvo -cmatch '\A[0-9]{5}\z'
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
# FULL_PIN_MIN_LENGTH:ssä. Lyhyempää ei hyväksytä hiljaa (ks. docs/tietoturva.md,
# "Kaksi PIN-koodia"): käyttäjälle kerrotaan aina eksplisiittisesti että taso
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

# =============================================================================
# .env:n asetusmalli
# =============================================================================
# Yksi totuus siitä mitä avaimia .env:ssä on: sekä kysymykset että kirjoitettu
# tiedosto syntyvät tästä samasta listasta. Juuri tätä varten tämä on taulukko
# eikä sarja peräkkäisiä Read-Host-kutsuja: PÄIVITYS vertaa tätä listaa
# olemassa olevaan .env-tiedostoon ja kysyy vain ne avaimet joita sieltä
# puuttuu. Ilman tätä Päikky-integraation tuomat PAIKKY_*-avaimet olisivat
# jääneet kokonaan pois jokaisesta ennen Päikkyä tehdystä asennuksesta.
#
# KUN .env.exampleen LISÄTÄÄN AVAIN, SE ON LISÄTTÄVÄ MYÖS TÄHÄN. Skripti
# tarkistaa tämän itse jos .env.example sattuu olemaan käsillä (kehityspuu) —
# ks. Get-MallistaPuuttuvatAvaimet — mutta julkaisupaketissa mallitiedostoa ei
# ole mukana, joten tarkistus ei voi olla ainoa turva.
#
# Kentät:
#   Avain        .env-avaimen nimi
#   Otsikko      ryhmän otsikko, tulostetaan ennen ensimmäistä kysymystä ja
#                kirjoitetaan kommenttina .env-tiedostoon
#   Ohje         rivit jotka näytetään ennen kysymystä
#   Kehote       kysymysteksti
#   Oletus       Enterin arvo uudessa asennuksessa
#   Tyyppi       portti | valinta | desimaali | postinumero | teksti | url |
#                salaisuus | fullpin
#   Vaihtoehdot  sallitut arvot (Tyyppi = valinta)
#   Riippuu      kysytään vain jos tällä avaimella on arvo (esim. Wilman
#                tunnus vain jos Wilman osoite annettiin)
$script:AsetusMalli = @(
    @{ Avain = 'PORT'
       Otsikko = 'Palvelin'
       Kehote = 'Portti'
       Oletus = '4173'
       Tyyppi = 'portti' }

    @{ Avain = 'LOG_LEVEL'
       Kehote = 'Lokitaso (warn/error/debug)'
       Oletus = 'warn'
       Tyyppi = 'valinta'
       Vaihtoehdot = @('warn', 'error', 'debug') }

    @{ Avain = 'WEATHER_POSTAL_CODE'
       Otsikko = 'Sää (Open-Meteo, ei API-avainta)'
       Ohje = @('Palvelin päättelee postinumerosta sekä sijainnin että näytölle',
                'tulevan paikkakunnan nimen — koordinaatteja ei tarvitse tietää.')
       Kehote = 'Postinumero säätietoja varten'
       Oletus = '43500'
       Tyyppi = 'postinumero' }

    @{ Avain = 'WILMA_BASE_URL'
       Otsikko = 'Wilma'
       Kehote = 'Wilman osoite, esim. https://koulu.inschool.fi (tyhjä = Wilma pois käytöstä)'
       Oletus = ''
       Tyyppi = 'url' }

    @{ Avain = 'WILMA_USERNAME'
       Kehote = 'Wilman käyttäjätunnus (huoltaja)'
       Oletus = ''
       Tyyppi = 'teksti'
       Riippuu = 'WILMA_BASE_URL' }

    @{ Avain = 'WILMA_PASSWORD'
       Kehote = 'Wilman salasana'
       Oletus = ''
       Tyyppi = 'salaisuus'
       Riippuu = 'WILMA_BASE_URL' }

    @{ Avain = 'PAIKKY_BASE_URL'
       Otsikko = 'Päikky (varhaiskasvatus)'
       Ohje = @('Kunnan oma Päikky-osoite, esim. https://karstula.paikky.fi. Sama alusta',
                'pyörii kymmenissä kunnissa, kukin omalla aliverkkotunnuksellaan.')
       Kehote = 'Päikyn osoite (tyhjä = Päikky pois käytöstä)'
       Oletus = ''
       Tyyppi = 'url' }

    @{ Avain = 'PAIKKY_USERNAME'
       Kehote = 'Päikyn käyttäjätunnus (huoltajan puhelinnumero)'
       Oletus = ''
       Tyyppi = 'teksti'
       Riippuu = 'PAIKKY_BASE_URL' }

    @{ Avain = 'PAIKKY_PASSWORD'
       Ohje = @('HUOM: Päikky-tili lukkiutuu epäonnistuneista kirjautumisista, ja sama tunnus',
                'on huoltajan omassa puhelimessa. Väärä salasana täällä kaataa siis muutakin',
                'kuin näytön — tarkista se kerralla oikein.')
       Kehote = 'Päikyn salasana'
       Oletus = ''
       Tyyppi = 'salaisuus'
       Riippuu = 'PAIKKY_BASE_URL' }

    @{ Avain = 'CALENDAR_ICS_URL'
       Otsikko = 'Perhekalenteri'
       Kehote = 'Kalenterin ICS-osoite (Google Calendar, tyhjä = pois käytöstä)'
       Oletus = ''
       Tyyppi = 'url' }

    @{ Avain = 'EDIT_PIN'
       Otsikko = 'Puhelimen muokkausoikeus'
       Ohje = @('EDIT_PIN antaa muistilistan/asetusten/hälytysten muokkauksen puhelimesta (ei Wilma-tietoja).')
       Kehote = 'EDIT_PIN (tyhjä = ei käytössä)'
       Oletus = ''
       Tyyppi = 'salaisuus' }

    @{ Avain = 'FULL_PIN'
       Ohje = @('FULL_PIN antaa myös lasten Wilma-tiedot puhelimesta. Vähintään 6 merkkiä,',
                'lyhyempi EI ota tasoa käyttöön lainkaan.')
       Kehote = 'FULL_PIN (tyhjä = ei käytössä)'
       Oletus = ''
       Tyyppi = 'fullpin' }

    @{ Avain = 'TRUSTED_HOSTS'
       Otsikko = 'Luotetut laitteet'
       Kehote = 'Luotetut laitteet, pilkulla erotettuna (esim. 192.168.10.50,puhelin.local, tyhjä = ei mitään)'
       Oletus = ''
       Tyyppi = 'teksti' }
)

# Avaimet joita asennin EI enää kysy eikä kirjoita, mutta jotka palvelin yhä
# lukee. WEATHER_LAT/LON/PLACE ovat WEATHER_POSTAL_CODEn varareitti: jos
# postinumeroa ei ole, palvelin käyttää näitä. Siksi päivitys ei saa poistaa
# niitä vanhasta .env:stä — eikä päivitys poistakaan, koska se vain lisää
# puuttuvat avaimet tiedoston loppuun.
#
# Tämä lista on olemassa vain jottei .env.examplen ja mallin vertailu (ks.
# Get-MallistaPuuttuvatAvaimet) kaatuisi avaimeen joka on tarkoituksella
# poistettu mallista. Uusi asennus ei kirjoita näitä avaimia lainkaan.
$script:VanhentuneetAvaimet = @('WEATHER_LAT', 'WEATHER_LON', 'WEATHER_PLACE')

# Muotoilee arvon .env-riville. LAINAUSMERKIT EIVÄT OLE KOSMETIIKKAA: Node
# katkaisee lainausmerkittömän arvon risuaidan (#) kohdalta, ja loppuosa katoaa
# äänettömästi. Tämä on jo purrut oikeassa käytössä — salasana meni perille
# kahdeksan merkin katkelmana ja kirjautuminen epäonnistui ilman että mikään
# kertoi syytä. Sama koskee välilyöntejä.
#
# Node hyväksyy kolme lainausmerkkiä: ", ' ja gravis. Valitaan niistä
# ensimmäinen jota arvossa itsessään ei esiinny, koska Node ei tue kenoviivalla
# suojaamista vaan lopettaa arvon seuraavaan samaan merkkiin.
function Format-EnvArvo {
    param([string]$Arvo)
    if ($null -eq $Arvo) { $Arvo = '' }
    if ($Arvo -match "[`r`n]") {
        throw 'Arvo sisältää rivinvaihdon — sitä ei voi kirjoittaa .env-tiedostoon turvallisesti.'
    }
    foreach ($merkki in @("'", [string][char]96, '"')) {
        if ($merkki -eq '"' -and ($Arvo.Contains('\n') -or $Arvo.Contains('\r'))) { continue }
        if (-not $Arvo.Contains($merkki)) { return "$merkki$Arvo$merkki" }
    }
    throw 'Arvon lainausmerkki- ja kenoviivayhdistelmää ei voida tallentaa .env-tiedostoon muuttumattomana. Vaihda arvoa.'
}

# Sama jäsennin kuin palvelimen --env-file-lipussa. ASCII-JSON välttää Windows
# PowerShellin konsolikoodauksen erot; tunnukset kulkevat vain muistissa.
function Read-EnvTiedosto {
    param([string]$Polku, [Parameter(Mandatory)][string]$NodeExe)
    $json = 'process.stdout.write(JSON.stringify(require("node:util").parseEnv(require("node:fs").readFileSync(process.argv[2], "utf8"))).replace(/[^\x00-\x7f]/g, c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")))' | & $NodeExe - $Polku
    if ($LASTEXITCODE -ne 0) { throw '.env-tiedoston lukeminen niputetulla Nodella epäonnistui.' }
    $arvot = @{}
    ($json | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $arvot[$_.Name] = [string]$_.Value }
    return @{ Arvot = $arvot }
}
# Mallin avaimet joita olemassa olevassa .env:ssä ei ole. Tyhjä arvo EI ole
# puuttuva avain: tyhjä PAIKKY_PASSWORD on kelvollinen tila (Päikky ei
# käytössä), eikä sitä pidä kysyä joka päivityksellä uudestaan.
function Get-PuuttuvatAvaimet {
    param([hashtable]$Olemassa, [array]$Malli = $script:AsetusMalli)
    return @($Malli | Where-Object { -not $Olemassa.ContainsKey($_.Avain) } | ForEach-Object { $_.Avain })
}

# Kehityspuun tarkistus: onko .env.examplessa avaimia joita mallissa ei ole.
# Julkaisupaketissa .env.exampleä ei ole mukana, jolloin tämä palauttaa tyhjän
# eikä väitä mitään.
#
# Vanhentuneet avaimet eivät ole tässä puute: ne saavat esiintyä
# .env.examplessa (ja esiintyvät vanhoissa .env-tiedostoissa) ilman että
# asennus kaatuu. Tarkistus etsii vain sitä yhtä vikaa jota varten se on
# olemassa: .env.exampleen lisättiin UUSI avain jota asennin ei osaa kysyä.
function Get-MallistaPuuttuvatAvaimet {
    param([string]$EsimerkkiPolku, [array]$Malli = $script:AsetusMalli)
    if (-not (Test-Path $EsimerkkiPolku)) { return @() }
    $avaimet = @([IO.File]::ReadAllLines($EsimerkkiPolku) | ForEach-Object {
        if ($_ -match '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=') { $Matches[1] }
    })
    $tunnetut = @($Malli | ForEach-Object { $_.Avain }) + $script:VanhentuneetAvaimet
    return @($avaimet | Where-Object { $tunnetut -notcontains $_ } | Sort-Object)
}

# Rakentaa .env-tiedoston sisällön annetuista arvoista. Puhdas funktio —
# testattavissa ilman että mitään kirjoitetaan levylle.
function New-EnvTiedostoSisalto {
    param([hashtable]$Arvot, [array]$Malli = $script:AsetusMalli)
    $rivit = [System.Collections.Generic.List[string]]::new()
    $rivit.Add('# Luotu asenna.ps1:llä ' + (Get-Date -Format 'yyyy-MM-dd HH:mm'))
    $rivit.Add('# Sisältää Wilma- ja Päikky-salasanat selväkielisenä. Ks. KAYTTOONOTTO.md, kohta Tietoturva.')
    $rivit.Add('#')
    $rivit.Add('# Arvot ovat lainausmerkeissä tarkoituksella: Node katkaisee lainausmerkittömän')
    $rivit.Add('# arvon risuaidan (#) kohdalta, ja loppuosa katoaa äänettömästi.')
    foreach ($m in $Malli) {
        $rivit.Add('')
        if ($m.Otsikko) {
            $rivit.Add('# --- ' + $m.Otsikko + ' ---')
        }
        $rivit.Add($m.Avain + '=' + (Format-EnvArvo ([string]$Arvot[$m.Avain])))
    }
    return ($rivit -join "`r`n") + "`r`n"
}

# Päivityksessä .env:iä EI kirjoiteta uusiksi vaan puuttuvat avaimet lisätään
# loppuun. Näin käyttäjän omat kommentit, järjestys ja käsin tehdyt muutokset
# säilyvät sellaisenaan — ja mikä tärkeintä, tiedoston oikeudet säilyvät, koska
# tiedostoa ei luoda uudelleen.
function New-EnvLisaysSisalto {
    param([hashtable]$Arvot, [string[]]$Avaimet, [array]$Malli = $script:AsetusMalli)
    $rivit = [System.Collections.Generic.List[string]]::new()
    $rivit.Add('')
    $rivit.Add('# --- Lisätty päivityksessä ' + (Get-Date -Format 'yyyy-MM-dd HH:mm') + ' (asenna.ps1) ---')
    foreach ($m in $Malli) {
        if ($Avaimet -notcontains $m.Avain) { continue }
        $rivit.Add($m.Avain + '=' + (Format-EnvArvo ([string]$Arvot[$m.Avain])))
    }
    return ($rivit -join "`r`n") + "`r`n"
}

# Kirjoittaa .env:n UTF-8:na ilman BOMia (Noden --env-file-if-exists ei odota
# BOMia) ja rajaa sen oikeudet asentavaan käyttäjään + Administrators-ryhmään.
# .env sisältää Wilma-tilin salasanan selväkielisenä (docs/tietoturva.md:n
# tunnistama riski) — tämä ei poista riskiä mutta estää muita samalla
# koneella olevia käyttäjätilejä lukemasta sitä.
function Write-EnvTiedosto {
    param([string]$Polku, [string]$Sisalto)
    $enkoodaus = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText($Polku, $Sisalto, $enkoodaus)
    Protect-EnvTiedosto -Polku $Polku
}

# Lisää rivit olemassa olevan .env:n loppuun koskematta tiedoston oikeuksiin
# tai aiempaan sisältöön. AppendAllText ei lisää BOMia olemassa olevaan
# tiedostoon.
function Add-EnvTiedostoon {
    param([string]$Polku, [string]$Sisalto)
    $enkoodaus = [System.Text.UTF8Encoding]::new($false)
    $nykyinen = [System.IO.File]::ReadAllText($Polku)
    $etuliite = ''
    if ($nykyinen.Length -gt 0 -and -not $nykyinen.EndsWith("`n")) { $etuliite = "`r`n" }
    [System.IO.File]::AppendAllText($Polku, $etuliite + $Sisalto, $enkoodaus)
}

function Protect-EnvTiedosto {
    param([string]$Polku)
    $identiteetti = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    # Administrators-ryhmän SID on kielialueesta riippumaton (nimi vaihtelee
    # suomenkielisellä Windowsilla) — käytetään sitä eikä ryhmän nimeä.
    $adminSid = 'S-1-5-32-544'

    # Tiedoston omistaja pidetään mukana. Päivityksen voi ajaa eri
    # järjestelmänvalvojatililtä kuin millä asennus aikoinaan tehtiin, ja
    # palvelin käynnistyy sen alkuperäisen käyttäjän istunnossa: jos oikeudet
    # rajattaisiin vain päivittäjään, palvelin ei enää saisi .env:iä luettua
    # eikä mikään kertoisi miksi.
    $omistaja = $null
    try {
        $omistaja = (Get-Acl -Path $Polku).Owner
    } catch {
        $omistaja = $null
    }

    icacls $Polku /inheritance:r | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "icacls /inheritance:r epäonnistui tiedostolle $Polku" }
    icacls $Polku /grant:r "${identiteetti}:F" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "icacls /grant epäonnistui käyttäjälle $identiteetti tiedostolle $Polku" }
    icacls $Polku /grant:r "*${adminSid}:F" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "icacls /grant epäonnistui Administrators-ryhmälle tiedostolle $Polku" }
    if ($omistaja -and $omistaja -ne $identiteetti) {
        icacls $Polku /grant:r "${omistaja}:F" | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "Tiedoston omistajalle ($omistaja) ei saatu annettua oikeuksia tiedostoon $Polku. Tarkista käsin ettei palvelin jää ilman lukuoikeutta."
        }
    }
}

# Kysyy yhden mallin mukaisen asetuksen ja tarkistaa sen tyypin mukaan.
# Kysyy uudestaan kunnes arvo kelpaa — samoin kuin ennen mallia, mutta nyt
# yhdessä paikassa, jotta uuden avaimen lisääminen ei tarkoita uuden
# do/while-silmukan kirjoittamista.
function Read-AsetusArvo {
    param([hashtable]$Maaritys, [string]$Oletus)
    if (-not $PSBoundParameters.ContainsKey('Oletus')) { $Oletus = [string]$Maaritys.Oletus }

    if ($Maaritys.Tyyppi -eq 'salaisuus') {
        return Read-SalainenTeksti -Kehote $Maaritys.Kehote
    }
    if ($Maaritys.Tyyppi -eq 'fullpin') {
        do {
            $arvo = Read-SalainenTeksti -Kehote $Maaritys.Kehote
            if (-not (Test-FullPinPituus $arvo)) {
                Write-Host "Tämä on alle $script:FULL_PIN_MIN_PITUUS merkkiä — FULL_PIN EI tulisi käyttöön. Anna vähintään $script:FULL_PIN_MIN_PITUUS merkkiä tai jätä tyhjäksi." -ForegroundColor Yellow
                continue
            }
            return $arvo
        } while ($true)
    }

    # if/elseif eikä switch: switchin sisällä `continue` koskee switchiä eikä
    # ympäröivää silmukkaa, ja se on juuri se hiljainen virhe jota tässä
    # tarkistussilmukassa ei haluta.
    do {
        $arvo = Read-KysyttyArvo -Kehote $Maaritys.Kehote -Oletus $Oletus
        $tyyppi = [string]$Maaritys.Tyyppi

        if ($tyyppi -eq 'portti') {
            if (-not (Test-PorttiNumero $arvo)) {
                Write-Host 'Anna kokonaisluku väliltä 1-65535.' -ForegroundColor Yellow
            } else {
                return $arvo
            }
        } elseif ($tyyppi -eq 'valinta') {
            if ($Maaritys.Vaihtoehdot -notcontains $arvo) {
                Write-Host ('Anna yksi näistä: ' + ($Maaritys.Vaihtoehdot -join ', ') + '.') -ForegroundColor Yellow
            } else {
                return $arvo
            }
        } elseif ($tyyppi -eq 'desimaali') {
            if (-not (Test-DesimaaliValidi $arvo)) {
                Write-Host 'Anna desimaaliluku pisteellä, esim. 62.86667.' -ForegroundColor Yellow
            } else {
                return $arvo
            }
        } elseif ($tyyppi -eq 'postinumero') {
            if (-not (Test-PostinumeroValidi $arvo)) {
                Write-Host 'Anna postinumero viitenä numerona, esim. 43500.' -ForegroundColor Yellow
            } else {
                return $arvo
            }
        } elseif ($tyyppi -eq 'url') {
            if ($arvo -and -not (Test-UrlKelvollinen $arvo)) {
                Write-Host 'Anna kelvollinen http(s)-osoite, tai jätä tyhjäksi.' -ForegroundColor Yellow
            } else {
                return $arvo
            }
        } else {
            return $arvo
        }
    } while ($true)
}

# Kysyy mallin mukaiset avaimet ja palauttaa arvot. $Avaimet rajaa kysymykset
# (päivitys antaa tähän vain puuttuvat avaimet); $Pohja sisältää jo tiedossa
# olevat arvot, joita Riippuu-ehdot katsovat.
function Read-Asetukset {
    param(
        [string[]]$Avaimet,
        [hashtable]$Pohja = @{},
        [array]$Malli = $script:AsetusMalli
    )
    $arvot = @{}
    foreach ($avain in $Pohja.Keys) { $arvot[$avain] = $Pohja[$avain] }
    $edellinenOtsikko = $null

    foreach ($m in $Malli) {
        if ($Avaimet -notcontains $m.Avain) { continue }

        if ($m.Riippuu) {
            $riippuvuus = [string]$arvot[$m.Riippuu]
            if ([string]::IsNullOrWhiteSpace($riippuvuus)) {
                # Osoitetta ei annettu, joten tunnusta ja salasanaa ei kysytä.
                # Avain kirjoitetaan silti tyhjänä — se on kelvollinen tila.
                $arvot[$m.Avain] = ''
                continue
            }
        }

        if ($m.Otsikko -and $m.Otsikko -ne $edellinenOtsikko) {
            Write-Host ''
            Write-Host ('--- ' + $m.Otsikko + ' ---')
            $edellinenOtsikko = $m.Otsikko
        }
        if ($m.Ohje) {
            foreach ($ohjerivi in $m.Ohje) { Write-Host $ohjerivi }
        }
        $arvot[$m.Avain] = Read-AsetusArvo -Maaritys $m
    }
    return $arvot
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
    $nodePolku = Join-Path (Split-Path -Parent $ServerHakemisto) 'node\node.exe'
    $prosessit = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.ExecutablePath -and (Get-NormalisoituPolku $_.ExecutablePath) -eq (Get-NormalisoituPolku $nodePolku) })
    foreach ($p in $prosessit) {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
    return $prosessit.Count
}

# Sulkee tämän asennuksen kioskiselaimen. Selain ei pidä palvelimen tiedostoja
# lukossa (se hakee kaiken HTTP:llä), joten tämä ei ole tiedostojen korvaamisen
# ehto — mutta päivityksen ajan seinällä loistaisi muuten virhesivu, ja
# päivityksen jälkeen selaimessa olisi edellisen version JS-tiedostot joita ei
# enää ole olemassa. Täsmää vain kioskiin joka osoittaa tähän porttiin, ei
# kaikkiin Edge-ikkunoihin koneella.
function Stop-KioskiSelain {
    param([int]$Portti)
    $tunniste = "--kiosk"
    $osoite = 'http://localhost:' + $Portti + '(?=[/\s"'']|$)'
    $prosessit = @(Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine.Contains($tunniste) -and $_.CommandLine -match $osoite })
    foreach ($p in $prosessit) {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
    return $prosessit.Count
}

# Näyttääkö hakemisto Infonäytön asennukselta. Käytetään ennen peilaavaa
# kopiointia: /MIR poistaa kohteesta kaiken mitä lähteessä ei ole, joten
# väärään hakemistoon osoitettuna se olisi tuhoisa.
function Test-NayttaaAsennukselta {
    param([string]$Polku)
    if (-not (Test-Path $Polku)) { return $false }
    foreach ($merkki in @('node\node.exe', 'server\src\index.ts', 'server\package.json', 'asennus\kaynnista.ps1', 'VERSIO.txt')) {
        if (-not (Test-Path -LiteralPath (Join-Path $Polku $merkki) -PathType Leaf)) { return $false }
    }
    return -not (Test-Path -LiteralPath (Join-Path $Polku '.git'))
}

# /MIR saa koskea vain kokonaiseen julkaisupakettiin ja erilliseen tyhjään
# hakemistoon tai tunnistettuun asennukseen. Linkkejä ei seurata kummassakaan.
function Assert-EiLinkkeja {
    param([string]$Polku)
    $nykyinen = [IO.Path]::GetFullPath($Polku)
    while ($nykyinen) {
        if (Test-Path -LiteralPath $nykyinen) {
            if ((Get-Item -LiteralPath $nykyinen -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Linkitettyä asennuspolkua ei hyväksytä: $nykyinen"
            }
        }
        $nykyinen = Split-Path -Parent $nykyinen
    }
    $jonossa = [Collections.Generic.Stack[string]]::new()
    if (Test-Path -LiteralPath $Polku -PathType Container) { $jonossa.Push($Polku) }
    while ($jonossa.Count) {
        foreach ($kohde in Get-ChildItem -LiteralPath $jonossa.Pop() -Force) {
            if ($kohde.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Linkkiä ei hyväksytä paketissa tai kohteessa: $($kohde.FullName)" }
            if ($kohde.PSIsContainer) { $jonossa.Push($kohde.FullName) }
        }
    }
}

function Assert-PakettiKohde {
    param([string]$Lahde, [string]$Kohde)
    foreach ($polku in @($Lahde, $Kohde)) {
        if (-not (Test-AsennusHakemistoPolku $polku) -or $polku -notmatch '^[A-Za-z]:[\\/]') { throw 'Asennus vaatii paikallisen absoluuttisen polun.' }
        $normaali = Get-NormalisoituPolku $polku
        $kielletyt = @([IO.Path]::GetPathRoot($polku), $env:USERPROFILE, $env:WINDIR, $env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:ProgramData)
        foreach ($kielletty in $kielletyt) {
            if ($kielletty -and $normaali -eq (Get-NormalisoituPolku $kielletty)) { throw "Hakemisto ei ole sallittu asennuskohde: $polku" }
        }
        Assert-EiLinkkeja $polku
    }
    if (-not (Test-NayttaaAsennukselta $Lahde) -or -not (Test-Path -LiteralPath (Join-Path $Lahde 'web\dist\index.html') -PathType Leaf) -or -not (Test-Path -LiteralPath (Join-Path $Lahde 'node_modules') -PathType Container)) { throw 'Lähde ei ole ehjä Infonäytön julkaisupaketti.' }
    $a = Get-NormalisoituPolku $Lahde
    $b = Get-NormalisoituPolku $Kohde
    if ($a -eq $b) { return }
    if ($a.StartsWith($b + '\') -or $b.StartsWith($a + '\')) { throw 'Lähde ja kohde eivät saa olla sisäkkäisiä hakemistoja.' }
    if (Test-Path -LiteralPath $Kohde) {
        if (-not (Test-Path -LiteralPath $Kohde -PathType Container)) { throw 'Asennuskohde ei ole hakemisto.' }
        if (@(Get-ChildItem -LiteralPath $Kohde -Force).Count -and -not (Test-NayttaaAsennukselta $Kohde)) { throw 'Kohde ei ole tyhjä eikä tunnistettu Infonäytön asennus; peilaus estettiin.' }
    }
}

# Peilaa paketin kohteeseen. /MIR eikä /E: jos uusi versio on poistanut
# tiedoston, sen on oikeasti hävittävä kohteesta — muuten vanhan version
# .ts-tiedostot jäisivät roikkumaan server\src:iin ja voisivat tulla
# ajetuiksi. Poissulut koskevat myös poistovaihetta (todennettu:
# /XD data /XF .env säilyttää molemmat, ja poistaa silti ylimääräiset).
#
#   data  = perheen tietokanta, muistilista, hälytysäänet, lokit ja
#           infonaytto-ennen-viestilahteita.db (ainoa paluureitti edelliseen
#           julkaisuun). Sen tuhoaminen on peruuttamatonta.
#   .env  = tunnukset. Päivitys ei kirjoita sitä uusiksi lainkaan.
#
# /R:2 /W:2: robocopyn oletus (miljoona uusintaa 30 s välein) voisi jäädä
# roikkumaan pitkäksi aikaa jos jokin tiedosto on lukossa — asennus ei saa
# jäädä jumiin siihen, virhe kerrotaan selvästi sen sijaan.
function Copy-PakettiKohteeseen {
    param([string]$Lahde, [string]$Kohde)
    Assert-PakettiKohde -Lahde $Lahde -Kohde $Kohde
    if ((Get-NormalisoituPolku $Lahde) -eq (Get-NormalisoituPolku $Kohde)) {
        throw 'Lähde ja kohde ovat sama hakemisto — peilaavaa kopiointia ei tehdä.'
    }
    $lahdeData = Join-Path ([IO.Path]::GetFullPath($Lahde)) 'data'
    $kohdeData = Join-Path ([IO.Path]::GetFullPath($Kohde)) 'data'
    # Vain juuren data suojataan; riippuvuuksien omat data-kansiot kopioidaan.
    robocopy $Lahde $Kohde /MIR /XD $lahdeData $kohdeData /XF .env /XJ /COPY:DAT /DCOPY:DAT /NFL /NDL /NJH /NJS /NP /R:2 /W:2 | Out-Null
    # Robocopyn paluukoodit alle 8 ovat onnistumisia (bittimaski: 1 = kopioitu,
    # 2 = ylimääräisiä poistettu, 4 = epäsuhtaisia tiedostoja).
    if ($LASTEXITCODE -ge 8) {
        throw "Paketin kopiointi epäonnistui (robocopy-koodi $LASTEXITCODE). Kohde: $Kohde"
    }
}

# Käynnistin ajetaan erillisessä piilotetussa PowerShellissä. Näin sen muuttujat
# eivät korvaa asentimen muuttujia eikä taustakonsolia jää näkyviin.
function Start-AsennettuSovellus {
    param([string]$Kaynnistin, [int]$Portti, [string]$Edge, [switch]$VainPalvelin)
    $argumentit = "-ExecutionPolicy Bypass -NonInteractive -WindowStyle Hidden -File `"$Kaynnistin`" -Portti $Portti"
    if ($VainPalvelin) { $argumentit += ' -VainPalvelin' }
    else { $argumentit += " -Edge `"$Edge`"" }
    $prosessi = Start-Process -FilePath powershell.exe -ArgumentList $argumentit -WindowStyle Hidden -Wait -PassThru
    if ($prosessi.ExitCode -ne 0) { throw 'Infonäytön käynnistin epäonnistui.' }
}

function Invoke-Asennus {
    param([string]$PaketinJuuri)
    Write-Host 'Infonäytön asennus (julkaisupaketti)'
    $asennusJuuri = Read-KysyttyArvo -Kehote 'Asennushakemisto' -Oletus $PaketinJuuri
    Assert-PakettiKohde -Lahde $PaketinJuuri -Kohde $asennusJuuri
    $asennusJuuri = [IO.Path]::GetFullPath($asennusJuuri).TrimEnd('\')
    $envPolku = Join-Path $asennusJuuri '.env'
    $serverHakemisto = Join-Path $asennusJuuri 'server'
    $dataHakemisto = Join-Path $asennusJuuri 'data'
    $kaynnistinPolku = Join-Path $asennusJuuri 'asennus\kaynnista.ps1'
    $lahdeNode = Join-Path $PaketinJuuri 'node\node.exe'
    $edgePolku = Get-EdgePolku
    if (-not $edgePolku) { throw 'Microsoft Edgeä ei löytynyt. Asenna Edge ja yritä uudelleen.' }
    $mallistaPuuttuvat = @(Get-MallistaPuuttuvatAvaimet -EsimerkkiPolku (Join-Path $PaketinJuuri '.env.example'))
    if ($mallistaPuuttuvat.Count) { throw ('Asentimen asetusmallista puuttuu: ' + ($mallistaPuuttuvat -join ', ')) }

    $oliEnv = Test-Path -LiteralPath $envPolku -PathType Leaf
    $onPaivitys = $oliEnv
    $vanhatArvot = @{}
    $vanhaPortti = 4173
    $envEnnen = $null
    if ($oliEnv) {
        # Hylkää muut kuin UTF-8-tiedostot ennen lisäystä; vanhat tavut säilyvät.
        $envEnnen = [IO.File]::ReadAllBytes($envPolku)
        $utf8 = [Text.UTF8Encoding]::new($false, $true)
        $envTeksti = $utf8.GetString($envEnnen)
        if ($envTeksti.Contains([string][char]0)) { throw '.env pitää tallentaa UTF-8-muodossa ennen päivitystä.' }
        $vanhatArvot = (Read-EnvTiedosto -Polku $envPolku -NodeExe $lahdeNode).Arvot
        if ($vanhatArvot.ContainsKey('PORT') -and -not (Test-PorttiNumero $vanhatArvot.PORT)) { throw 'Nykyisen .env:n PORT ei ole kelvollinen. Korjaa se ennen päivitystä.' }
        if ($vanhatArvot.ContainsKey('PORT')) { $vanhaPortti = [int]$vanhatArvot.PORT }
        $tila = Read-KysyttyArvo -Kehote 'Päivitä säilyttäen asetukset (P) vai määritä asetukset uudestaan (U)' -Oletus 'P'
        if ($tila -notmatch '^[pPuU]$') { throw 'Tuntematon asennustila. Mitään ei muutettu.' }
        $onPaivitys = $tila -match '^[pP]$'
    }
    $avaimet = if ($onPaivitys) { @(Get-PuuttuvatAvaimet -Olemassa $vanhatArvot) } else { @($script:AsetusMalli | ForEach-Object { $_.Avain }) }
    $pohja = if ($onPaivitys) { $vanhatArvot } else { @{} }
    $envArvot = Read-Asetukset -Avaimet $avaimet -Pohja $pohja
    $portti = [int]$envArvot.PORT
    if (-not (Test-PorttiNumero $envArvot.PORT)) { throw 'PORT ei ole kelvollinen.' }
    # Nykyisen palvelimen portti voi olla käytössä kysymysten ajan.
    if ((-not $oliEnv -or $portti -ne $vanhaPortti) -and -not (Test-PorttiVapaa $portti)) { throw "Portti $portti on jo käytössä. Mitään ei muutettu." }
    $envSisalto = if ($onPaivitys) {
        if ($avaimet.Count) { New-EnvLisaysSisalto -Arvot $envArvot -Avaimet $avaimet } else { '' }
    } else { New-EnvTiedostoSisalto -Arvot $envArvot }

    $tehtavat = @{}
    $argumentit = @{}
    $argumentit[$palvelinTehtava] = "-ExecutionPolicy Bypass -NonInteractive -WindowStyle Hidden -File `"$kaynnistinPolku`" -Portti $portti -VainPalvelin"
    $argumentit[$nayttoTehtava] = "-ExecutionPolicy Bypass -NonInteractive -WindowStyle Hidden -File `"$kaynnistinPolku`" -Portti $portti -Edge `"$edgePolku`""
    foreach ($nimi in @($palvelinTehtava, $nayttoTehtava)) {
        $tehtava = Get-ScheduledTask -TaskName $nimi -ErrorAction SilentlyContinue
        if ($tehtava) {
            # Älä kaappaa saman nimistä toisen asennuksen tehtävää.
            if (@($tehtava.Actions).Count -ne 1 -or $tehtava.Actions[0].Arguments -notmatch [regex]::Escape('"' + $kaynnistinPolku + '"')) { throw "Tehtävä $nimi osoittaa toiseen asennukseen. Mitään ei muutettu." }
            $tehtavat[$nimi] = $tehtava
        }
    }
    $autostart = $tehtavat.Count -gt 0
    if (-not $autostart) { $autostart = (Read-KysyttyArvo -Kehote 'Otetaanko automaattikäynnistys käyttöön? (K/e)' -Oletus 'K') -match '^[kK]$' }
    $luoAutostart = $autostart -and $tehtavat.Count -eq 0
    $testaaWilma = $false
    if ($envArvot.WILMA_BASE_URL -and $envArvot.WILMA_USERNAME -and $envArvot.WILMA_PASSWORD) {
        $testaaWilma = (Read-KysyttyArvo -Kehote 'Testataanko lopuksi Wilma-yhteys kerran? (K/e)' -Oletus 'K') -match '^[kK]$'
    }
    Write-Host "Kohde: $asennusJuuri; portti: $portti. data-kansio säilytetään."
    if ((Get-NormalisoituPolku $PaketinJuuri) -ne (Get-NormalisoituPolku $asennusJuuri)) { Write-Host 'Ohjelmatiedostot peilataan: kohteen ylimääräiset tiedostot poistetaan (.env ja data säilyvät).' }
    if ($onPaivitys) { Write-Host ('Nykyiset asetukset ja käyttöoikeudet säilyvät. Lisättävät avaimet: ' + ($avaimet -join ', ')) }
    elseif ($oliEnv) { Write-Host 'Nykyinen .env korvataan uudelleen annetuilla asetuksilla.' -ForegroundColor Yellow }
    Write-Host 'Palvelin ja kioskiselain käynnistetään. Virranhallinta estää näytön sammumisen ja lepotilan.'
    if ((Read-KysyttyArvo -Kehote 'Tehdäänkö asennus? (k/E)' -Oletus 'E') -notmatch '^[kK]$') { Write-Host 'Asennus keskeytetty. Mitään ei muutettu.'; return }

    # Kaikki kysymykset ja tiedoston muodostaminen ovat nyt valmiit. Varmista
    # vielä polut ja ettei .env muuttunut käyttäjän vastatessa kysymyksiin.
    Assert-PakettiKohde -Lahde $PaketinJuuri -Kohde $asennusJuuri
    if ($oliEnv -and [Convert]::ToBase64String([IO.File]::ReadAllBytes($envPolku)) -ne [Convert]::ToBase64String($envEnnen)) { throw '.env muuttui asennuksen aikana. Aloita uudelleen.' }
    foreach ($tehtava in $tehtavat.Values) { Stop-ScheduledTask -InputObject $tehtava }
    if ($oliEnv) { Stop-KioskiSelain -Portti $vanhaPortti | Out-Null }
    if (Test-NayttaaAsennukselta $asennusJuuri) {
        Stop-VanhaPalvelin -ServerHakemisto $serverHakemisto | Out-Null
    }
    if (-not (Test-PorttiVapaa $portti)) { throw "Portti $portti on yhä käytössä. Ohjelmatiedostoja ei muutettu." }
    if ((Get-NormalisoituPolku $PaketinJuuri) -ne (Get-NormalisoituPolku $asennusJuuri)) {
        Copy-PakettiKohteeseen -Lahde $PaketinJuuri -Kohde $asennusJuuri
    }
    if ($onPaivitys) {
        if ($envSisalto) { Add-EnvTiedostoon -Polku $envPolku -Sisalto $envSisalto }
    } else { Write-EnvTiedosto -Polku $envPolku -Sisalto $envSisalto }
    if (-not (Test-Path -LiteralPath $dataHakemisto)) { New-Item -ItemType Directory -Path $dataHakemisto | Out-Null }

    if ($autostart) {
        $malliTehtava = $tehtavat.Values | Select-Object -First 1
        $kayttaja = if ($malliTehtava) { $malliTehtava.Principal.UserId } else { [Security.Principal.WindowsIdentity]::GetCurrent().Name }
        foreach ($nimi in @($palvelinTehtava, $nayttoTehtava)) {
            $toiminto = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argumentit[$nimi]
            if ($tehtavat.ContainsKey($nimi)) {
                # Set-Action säilyttää käyttäjän, liipaisimet, asetukset ja tilan.
                if ($tehtavat[$nimi].Actions[0].Arguments -ne $argumentit[$nimi] -or $tehtavat[$nimi].Actions[0].Execute -notmatch '(^|\\)powershell.exe$') {
                    Set-ScheduledTask -TaskName $nimi -TaskPath $tehtavat[$nimi].TaskPath -Action $toiminto | Out-Null
                }
            } elseif ($luoAutostart) {
                $liipaisin = New-ScheduledTaskTrigger -AtLogOn -User $kayttaja
                if ($nimi -eq $nayttoTehtava) { $liipaisin.Delay = 'PT5S' }
                $asetukset = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
                $principal = if ($malliTehtava) { $malliTehtava.Principal } else { New-ScheduledTaskPrincipal -UserId $kayttaja -LogonType Interactive -RunLevel Limited }
                Register-ScheduledTask -TaskName $nimi -Action $toiminto -Trigger $liipaisin -Settings $asetukset -Principal $principal -Description 'Infonäyttö (julkaisupaketti)' | Out-Null
            }
        }
    }
    $pikakuvakePolku = Join-Path ([Environment]::GetFolderPath('Desktop')) $pikakuvakeNimi
    New-KioskiPikakuvake -Polku $pikakuvakePolku -KaynnistinPolku $kaynnistinPolku -EdgePolku $edgePolku -Portti $portti
    foreach ($asetus in @('monitor-timeout-ac', 'monitor-timeout-dc', 'standby-timeout-ac', 'standby-timeout-dc', 'hibernate-timeout-ac', 'hibernate-timeout-dc')) {
        & powercfg /change $asetus 0
        if ($LASTEXITCODE -ne 0) { throw "Virranhallinnan asetus epäonnistui: $asetus" }
    }
    Set-ItemProperty -Path 'HKCU:\Control Panel\Desktop' -Name 'ScreenSaveActive' -Value '0'
    if ($luoAutostart -or ($tehtavat.ContainsKey($palvelinTehtava) -and $tehtavat[$palvelinTehtava].Settings.Enabled)) { Start-ScheduledTask -TaskName $palvelinTehtava }
    else { Start-AsennettuSovellus -Kaynnistin $kaynnistinPolku -Portti $portti -VainPalvelin }
    if (-not (Wait-PalvelinTerveys -Portti $portti -OdotusSekunnit 90)) { throw "Palvelin ei vastannut 90 sekunnissa. ASENNUS EI OLE VALMIS. Tarkista $dataHakemisto\logs\ ja käynnistä asennus\kaynnista.ps1 käsin." }
    if ($luoAutostart -or ($tehtavat.ContainsKey($nayttoTehtava) -and $tehtavat[$nayttoTehtava].Settings.Enabled)) { Start-ScheduledTask -TaskName $nayttoTehtava }
    else { Start-AsennettuSovellus -Kaynnistin $kaynnistinPolku -Portti $portti -Edge $edgePolku }
    if ($testaaWilma) {
        try {
            Invoke-WebRequest -Uri "http://localhost:$portti/api/providers/wilma/test" -Method Post -UseBasicParsing -TimeoutSec 30 | Out-Null
            Write-Host 'Wilma-yhteys toimii.' -ForegroundColor Green
        } catch { Write-Warning 'Wilma-yhteystesti epäonnistui. Tarkista Asetukset -> Wilma-yhteys. Asennettu palvelin toimii.' }
    }
    Write-Host "Asennus valmis: $asennusJuuri. Näyttö: http://localhost:$portti" -ForegroundColor Green
    Write-Host 'Testaa vielä koneen uudelleenkäynnistys ja automaattikirjautuminen. Ohje: asennus\KAYTTOONOTTO.md.'
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

Invoke-Asennus -PaketinJuuri (Split-Path -Parent $PSScriptRoot)
