# Windows-asentimen regressiot: vain oma tilapäishakemisto, ei oikeita tehtäviä,
# prosesseja, rekisteriä tai käyttäjän .env-tiedostoa. Vaatii Node 24+ ja robocopyn.
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\asenna.ps1" -VainFunktiot
$script:onnistui = 0
function Assert-Testi {
    param([bool]$Ehto, [string]$Nimi)
    if (-not $Ehto) { throw "TESTI EPÄONNISTUI: $Nimi" }
    $script:onnistui++
    Write-Host "OK: $Nimi"
}
function Assert-Heittaa {
    param([scriptblock]$Toiminto, [string]$Nimi)
    $heitti = $false
    try { & $Toiminto | Out-Null } catch { $heitti = $true }
    Assert-Testi $heitti $Nimi
}
$tempJuuri = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$testijuuri = Join-Path $tempJuuri ('infonaytto-asennustesti-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testijuuri | Out-Null
$node = (Get-Command node.exe).Source
function Write-TestFile {
    param([string]$Polku, [string]$Sisalto = 'fixture')
    $kansio = Split-Path -Parent $Polku
    if (-not (Test-Path -LiteralPath $kansio)) { New-Item -ItemType Directory -Path $kansio -Force | Out-Null }
    [IO.File]::WriteAllText($Polku, $Sisalto, [Text.UTF8Encoding]::new($false))
}
function New-TestPackage {
    param([string]$Polku)
    foreach ($tiedosto in @('server\src\index.ts', 'server\package.json', 'asennus\kaynnista.ps1', 'web\dist\index.html', 'VERSIO.txt', 'node_modules\fixture\index.js')) {
        Write-TestFile (Join-Path $Polku $tiedosto)
    }
    New-Item -ItemType Directory -Path (Join-Path $Polku 'node') | Out-Null
    Copy-Item -LiteralPath $node -Destination (Join-Path $Polku 'node\node.exe')
}
try {
    $lahde = Join-Path $testijuuri 'paketti'
    New-TestPackage $lahde
    Assert-Testi (-not (Test-PorttiNumero '99999999999999999999999999')) 'Liian suuri portti hylätään ilman ylivuotoa'
    Assert-Testi (@(Get-MallistaPuuttuvatAvaimet -EsimerkkiPolku (Join-Path $PSScriptRoot '..\.env.example')).Count -eq 0) '.env.example avaimet mukana asetusmallissa'

    $envTesti = Join-Path $testijuuri 'lainaukset.env'
    $testiarvot = @('salasana#välilyönti äö', 'C:\new\record', "yksi'kaksi", 'kaksi"kolme', ('a''b' + [char]96 + 'c'), '')
    foreach ($arvo in $testiarvot) {
        Write-TestFile $envTesti ('VALUE=' + (Format-EnvArvo $arvo))
        $luettu = (Read-EnvTiedosto -Polku $envTesti -NodeExe $node).Arvot.VALUE
        Assert-Testi ($luettu -ceq $arvo) 'Lainattu arvo säilyy Noden parseEnv-lukijalla'
    }
    Assert-Heittaa { Format-EnvArvo "eka`ntoka" } 'Rivinvaihto estetään ennen kirjoittamista'
    Assert-Heittaa { Format-EnvArvo ('a''b"c' + [char]96) } 'Kaikki kolme lainausmerkkiä estetään'
    Write-TestFile $envTesti "export PORT=4173 # kommentti`r`nWILMA_PASSWORD='rivi1`nrivi2' # kommentti`r`nPAIKKY_PASSWORD=`r`n"
    $luettu = (Read-EnvTiedosto -Polku $envTesti -NodeExe $node).Arvot
    Assert-Testi ($luettu.PORT -eq '4173' -and $luettu.WILMA_PASSWORD -eq "rivi1`nrivi2" -and $luettu.ContainsKey('PAIKKY_PASSWORD')) 'Vanhan .env:n kommentit, export, tyhjä ja moniriviarvo luetaan kuten palvelimessa'
    & {
        $script:kysytyt = [Collections.Generic.List[string]]::new()
        function Read-AsetusArvo { param($Maaritys) $script:kysytyt.Add($Maaritys.Avain); return '' }
        $pohja = @{ WILMA_PASSWORD = 'säilyy'; PORT = '4173' }
        $arvot = Read-Asetukset -Avaimet @('PAIKKY_BASE_URL', 'PAIKKY_USERNAME', 'PAIKKY_PASSWORD') -Pohja $pohja
        Assert-Testi ($arvot -is [hashtable]) 'Asetuskysymysten otsikot eivät saastuta palautusarvoa'
        Assert-Testi ($script:kysytyt.Count -eq 1 -and $script:kysytyt[0] -eq 'PAIKKY_BASE_URL' -and $arvot.WILMA_PASSWORD -eq 'säilyy' -and $arvot.PAIKKY_PASSWORD -eq '') 'Päivitys kysyy vain puuttuvat käytössä olevan integraation asetukset'
    }

    $kohde = Join-Path $testijuuri 'kohde'
    New-TestPackage $kohde
    Write-TestFile (Join-Path $kohde '.env') '# säilytä tämä täsmälleen'
    Write-TestFile (Join-Path $kohde 'data\infonaytto.db') 'perheen tietokanta'
    Write-TestFile (Join-Path $kohde 'data\infonaytto-ennen-viestilahteita.db') 'paluuversio'
    Write-TestFile (Join-Path $kohde 'server\src\poistunut.ts') 'vanha koodi'
    Write-TestFile (Join-Path $lahde '.env') 'ei saa korvata'
    Write-TestFile (Join-Path $lahde 'data\infonaytto.db') 'ei saa korvata'
    Write-TestFile (Join-Path $lahde 'node_modules\fixture\data\uusi.json') 'riippuvuuden data'
    $envKohde = Join-Path $kohde '.env'
    $tavut = [IO.File]::ReadAllBytes($envKohde)
    $acl = (Get-Acl -LiteralPath $envKohde).Sddl
    Copy-PakettiKohteeseen -Lahde $lahde -Kohde $kohde
    Assert-Testi (-not (Test-Path -LiteralPath (Join-Path $kohde 'server\src\poistunut.ts'))) 'Todellinen robocopy /MIR poistaa poistuneet ohjelmatiedostot'
    Assert-Testi (Test-Path -LiteralPath (Join-Path $kohde 'node_modules\fixture\data\uusi.json')) 'Riippuvuuksien data-nimiset kansiot kopioidaan'
    Assert-Testi ([Convert]::ToBase64String([IO.File]::ReadAllBytes($envKohde)) -eq [Convert]::ToBase64String($tavut) -and (Get-Acl -LiteralPath $envKohde).Sddl -eq $acl) 'Todellinen robocopy säilyttää .env tavut ja ACL:n'
    Assert-Testi ([IO.File]::ReadAllText((Join-Path $kohde 'data\infonaytto.db')) -eq 'perheen tietokanta' -and [IO.File]::ReadAllText((Join-Path $kohde 'data\infonaytto-ennen-viestilahteita.db')) -eq 'paluuversio') 'Todellinen robocopy säilyttää datan ja paluutietokannan'
    Add-EnvTiedostoon -Polku $envKohde -Sisalto "PAIKKY_PASSWORD=''`r`n"
    $jalki = [IO.File]::ReadAllBytes($envKohde)
    Assert-Testi ([Convert]::ToBase64String($jalki[0..($tavut.Length - 1)]) -eq [Convert]::ToBase64String($tavut) -and (Get-Acl -LiteralPath $envKohde).Sddl -eq $acl) 'Puuttuvan asetuksen lisääminen säilyttää vanhat tavut ja ACL:n'
    Assert-Heittaa { Copy-PakettiKohteeseen $lahde $lahde } 'Samaan hakemistoon peilaaminen estetään'
    Assert-Heittaa { Copy-PakettiKohteeseen $lahde (Join-Path $lahde 'sisalla') } 'Lähteen alihakemistoon peilaaminen estetään'
    Assert-Heittaa { Copy-PakettiKohteeseen $lahde $testijuuri } 'Lähteen ylähakemistoon peilaaminen estetään'
    Assert-Heittaa { Copy-PakettiKohteeseen $lahde ([IO.Path]::GetPathRoot($testijuuri)) } 'Aseman juureen peilaaminen estetään'
    $vieras = Join-Path $testijuuri 'vieras'
    Write-TestFile (Join-Path $vieras '.env') 'toinen projekti'
    Write-TestFile (Join-Path $vieras 'data\muistio.txt') 'ei infonäyttö'
    Assert-Heittaa { Copy-PakettiKohteeseen $lahde $vieras } 'Pelkkä .env ja data eivät oikeuta peilausta'
    $linkki = Join-Path $kohde 'linkki'
    New-Item -ItemType Junction -Path $linkki -Target $vieras | Out-Null
    Assert-Heittaa { Copy-PakettiKohteeseen $lahde $kohde } 'Kohteen junction estää peilauksen'
    [IO.Directory]::Delete($linkki)
    $linkki = Join-Path $lahde 'linkki'
    New-Item -ItemType Junction -Path $linkki -Target $vieras | Out-Null
    Assert-Heittaa { Copy-PakettiKohteeseen $lahde $kohde } 'Lähteen junction estää peilauksen'
    [IO.Directory]::Delete($linkki)
    Write-TestFile (Join-Path $kohde '.git') 'kehityskopio'
    Assert-Heittaa { Copy-PakettiKohteeseen $lahde $kohde } 'Kehityskopioon ei peilata'
    Remove-Item -LiteralPath (Join-Path $kohde '.git')
    & {
        $script:pysaytetyt = [Collections.Generic.List[int]]::new()
        function Get-CimInstance {
            @(
                [PSCustomObject]@{ ProcessId = 11; CommandLine = 'msedge.exe --kiosk http://localhost:4173 --edge-kiosk-type=fullscreen' }
                [PSCustomObject]@{ ProcessId = 12; CommandLine = 'msedge.exe --kiosk http://localhost:41730 --edge-kiosk-type=fullscreen' }
                [PSCustomObject]@{ ProcessId = 13; CommandLine = 'msedge.exe http://localhost:4173' }
            )
        }
        function Stop-Process { param($Id, [switch]$Force) $script:pysaytetyt.Add($Id) }
        Stop-KioskiSelain -Portti 4173 | Out-Null
        Assert-Testi ($script:pysaytetyt.Count -eq 1 -and $script:pysaytetyt[0] -eq 11) 'Kioskiselaimen pysäytys rajautuu tarkkaan porttiin ja kioskitilaan'
    }

    # Kirjautumisliipaisimen tili vanhenee kun kone nimetään uudelleen (mitattu
    # 14.10.2026: TABLET-G57EUL3E -> INFOPANEELI, kioski ei enää käynnistynyt).
    & {
        $script:tilit = @{ 'UUSI\kayttaja' = 'S-1-5-21-1-2-3-1001'; 'kayttaja' = 'S-1-5-21-1-2-3-1001'; 'UUSI\toinen' = 'S-1-5-21-1-2-3-1002' }
        function Get-TiliSid { param($Tili) return $script:tilit[$Tili] }
        function Get-TilinNimi { param($Sid) if ($Sid -eq 'S-1-5-21-1-2-3-1001') { return 'UUSI\kayttaja' } return $null }
        function New-Liipaisin { param($Luokka, $Kayttaja, $Viive = '', $Kaytossa = $true) [PSCustomObject]@{ CimClass = [PSCustomObject]@{ CimClassName = $Luokka }; UserId = $Kayttaja; Delay = $Viive; Enabled = $Kaytossa } }
        function New-Tehtava { param($Ajaja, $Liipaisimet) [PSCustomObject]@{ TaskName = 'Infonaytto-naytto'; Principal = [PSCustomObject]@{ UserId = $Ajaja }; Triggers = $Liipaisimet } }

        $aika = New-Liipaisin 'MSFT_TaskTimeTrigger' 'VANHA\kayttaja'
        $korjaus = Get-KorjatutLiipaisimet (New-Tehtava 'kayttaja' @((New-Liipaisin 'MSFT_TaskLogonTrigger' 'VANHA\kayttaja' 'PT5S' $false), $aika))
        Assert-Testi ($null -ne $korjaus -and $korjaus.Vanha -eq 'VANHA\kayttaja' -and $korjaus.Uusi -eq 'UUSI\kayttaja') 'Uudelleennimetyn koneen kirjautumisliipaisin ohjataan tehtävän ajajan nykyiseen nimeen'
        Assert-Testi ($korjaus.Liipaisimet.Count -eq 2 -and $korjaus.Liipaisimet[0].UserId -eq 'UUSI\kayttaja' -and $korjaus.Liipaisimet[0].Delay -eq 'PT5S' -and -not $korjaus.Liipaisimet[0].Enabled) 'Korjattu liipaisin säilyttää viiveen ja käytössä-tilan'
        Assert-Testi ([object]::ReferenceEquals($korjaus.Liipaisimet[1], $aika)) 'Muut kuin kirjautumisliipaisimet jäävät koskematta'
        Assert-Testi ($null -eq (Get-KorjatutLiipaisimet (New-Tehtava 'kayttaja' @(New-Liipaisin 'MSFT_TaskLogonTrigger' 'UUSI\kayttaja' 'PT5S')))) 'Toimivaa liipaisinta ei kirjoiteta uudelleen'
        Assert-Testi ($null -eq (Get-KorjatutLiipaisimet (New-Tehtava 'kayttaja' @(New-Liipaisin 'MSFT_TaskLogonTrigger' 'UUSI\toinen')))) 'Toiseen olemassa olevaan tiliin osoittava liipaisin on käyttäjän valinta'
        Assert-Testi ($null -eq (Get-KorjatutLiipaisimet (New-Tehtava 'kayttaja' @(New-Liipaisin 'MSFT_TaskLogonTrigger' '')))) 'Kaikkien käyttäjien kirjautumisliipaisin ei ole rikki'
        Assert-Testi ($null -eq (Get-KorjatutLiipaisimet (New-Tehtava 'kayttaja' @()))) 'Tehtävä ilman liipaisimia ohitetaan'
        Assert-Testi ($null -eq (& { $WarningPreference = 'SilentlyContinue'; Get-KorjatutLiipaisimet (New-Tehtava 'POISTETTU\kayttaja' @(New-Liipaisin 'MSFT_TaskLogonTrigger' 'VANHA\kayttaja')) })) 'Ratkeamatonta ajajaa ei arvata, liipaisin jää ennalleen'
    }
    Assert-Testi ((Get-TiliSid 'S-1-5-18') -eq 'S-1-5-18' -and (Get-TiliSid 'SYSTEM') -eq 'S-1-5-18') 'Oikea tilinratkaisu: SID- ja nimimuoto'
    Assert-Testi ($null -eq (Get-TiliSid ('EI-OLE-' + [Guid]::NewGuid().ToString('N').Substring(0, 8) + '\kayttaja')) -and $null -eq (Get-TiliSid '')) 'Oikea tilinratkaisu: olematon tili ja tyhjä'

    # Pääsuorituksen systeemirajapinnat korvataan tässä lohkossa. Tiedostot ja
    # kopiointi ovat silti oikeita; ohjelmia, ajastuksia tai rekisteriä ei muuteta.
    foreach ($tapaus in @('paivitys', 'peruutus', 'healthvirhe', 'uusi', 'valmiit-asetukset', 'tehtavat', 'disabled', 'osittaiset', 'nimetty')) {
        & {
            param($tapaus)
            $script:tapaus = $tapaus
            $script:kohde = Join-Path $testijuuri $tapaus
            $script:vahvistettu = $false
            $script:tapahtumat = [Collections.Generic.List[string]]::new()
            $script:kysytty = [Collections.Generic.List[string]]::new()
            $script:testitehtavat = @{}
            $script:perusarvot = @{}
            foreach ($m in $script:AsetusMalli) { $script:perusarvot[$m.Avain] = [string]$m.Oletus }
            if ($tapaus -ne 'uusi') {
                New-TestPackage $script:kohde
                $vanhaMalli = if ($tapaus -eq 'valmiit-asetukset') { $script:AsetusMalli } else { @($script:AsetusMalli | Where-Object { $_.Avain -notlike 'PAIKKY_*' }) }
                Write-TestFile (Join-Path $script:kohde '.env') (New-EnvTiedostoSisalto -Arvot $script:perusarvot -Malli $vanhaMalli)
                Write-TestFile (Join-Path $script:kohde 'data\arvokas.txt') 'säilyy'
                $script:ennen = [IO.File]::ReadAllBytes((Join-Path $script:kohde '.env'))
            }
            if ($tapaus -in @('tehtavat', 'disabled', 'osittaiset', 'nimetty', 'peruutus')) {
                foreach ($nimi in @('Infonaytto-palvelin', 'Infonaytto-naytto')) {
                    if ($tapaus -eq 'osittaiset' -and $nimi -eq 'Infonaytto-naytto') { continue }
                    $script:testitehtavat[$nimi] = [PSCustomObject]@{
                        TaskName = $nimi; TaskPath = '\'; Principal = [PSCustomObject]@{ UserId = 'ALKUPERAINEN\kayttaja' }
                        Settings = [PSCustomObject]@{ Enabled = $tapaus -ne 'disabled' }
                        Actions = @([PSCustomObject]@{ Execute = 'powershell.exe'; Arguments = '-File "' + (Join-Path $script:kohde 'asennus\kaynnista.ps1') + '" -Portti 4173' })
                        Triggers = @([PSCustomObject]@{ CimClass = [PSCustomObject]@{ CimClassName = 'MSFT_TaskLogonTrigger' }; UserId = $(if ($tapaus -in @('nimetty', 'peruutus')) { 'VANHA\kayttaja' } else { 'ALKUPERAINEN\kayttaja' }); Delay = 'PT5S'; Enabled = $true })
                    }
                }
            }
            function Get-EdgePolku { 'C:\test-edge\msedge.exe' }
            function Get-TiliSid { param($Tili) if ($Tili -eq 'ALKUPERAINEN\kayttaja') { return 'S-1-5-21-1-2-3-1001' } return $null }
            function Get-TilinNimi { param($Sid) if ($Sid -eq 'S-1-5-21-1-2-3-1001') { return 'ALKUPERAINEN\kayttaja' } return $null }
            function Read-KysyttyArvo {
                param($Kehote, $Oletus)
                if ($script:vahvistettu) { throw 'Kysymys vasta mutaatioiden jälkeen' }
                if ($Kehote -eq 'Asennushakemisto') { return $script:kohde }
                if ($Kehote -like 'Tehdäänkö*') {
                    if ($script:tapaus -eq 'peruutus') { return 'E' }
                    $script:vahvistettu = $true
                    return 'K'
                }
                return $Oletus
            }
            function Read-AsetusArvo { param($Maaritys) $script:kysytty.Add($Maaritys.Avain); return [string]$Maaritys.Oletus }
            function Get-ScheduledTask { param($TaskName) return $script:testitehtavat[$TaskName] }
            function Stop-ScheduledTask { if (-not $script:vahvistettu) { throw 'Ennenaikainen tehtävän pysäytys' }; $script:tapahtumat.Add('stop-task') }
            function Stop-KioskiSelain { param($Portti) if (-not $script:vahvistettu) { throw 'Ennenaikainen pysäytys' }; $script:tapahtumat.Add('stop-browser'); return 0 }
            function Stop-VanhaPalvelin { param($ServerHakemisto) if (-not $script:vahvistettu) { throw 'Ennenaikainen pysäytys' }; $script:tapahtumat.Add('stop-server'); return 0 }
            function Test-PorttiVapaa { return $true }
            function New-ScheduledTaskAction { param($Execute, $Argument) return @{ Execute = $Execute; Arguments = $Argument } }
            function New-ScheduledTaskTrigger { param([switch]$AtLogOn, $User) return [PSCustomObject]@{ CimClass = [PSCustomObject]@{ CimClassName = 'MSFT_TaskLogonTrigger' }; UserId = $User; Delay = ''; Enabled = $true } }
            function New-ScheduledTaskSettingsSet { return @{} }
            function New-ScheduledTaskPrincipal { return @{} }
            function Register-ScheduledTask { $script:tapahtumat.Add('register') }
            function Set-ScheduledTask {
                param($TaskName, $TaskPath, $Action, $Trigger)
                if (-not $script:vahvistettu) { throw 'Ennenaikainen ajastuksen muutos' }
                if ($Action) { $script:tapahtumat.Add('set-' + $TaskName); $script:testitehtavat[$TaskName].Actions = @($Action) }
                if ($Trigger) { $script:tapahtumat.Add('trigger-' + $TaskName); $script:testitehtavat[$TaskName].Triggers = @($Trigger) }
            }
            function New-KioskiPikakuvake { $script:tapahtumat.Add('shortcut') }
            function powercfg { $global:LASTEXITCODE = 0 }
            function Set-ItemProperty { $script:tapahtumat.Add('power') }
            function Start-ScheduledTask {
                param($TaskName)
                if ($script:testitehtavat.ContainsKey($TaskName) -and -not $script:testitehtavat[$TaskName].Settings.Enabled) { throw 'Disabled tehtävää ei saa käynnistää' }
                $script:tapahtumat.Add('start-' + $TaskName)
            }
            function Start-AsennettuSovellus { param($Kaynnistin, $Portti, $Edge, [switch]$VainPalvelin) if ($VainPalvelin) { $script:tapahtumat.Add('start-Infonaytto-palvelin') } else { $script:tapahtumat.Add('start-Infonaytto-naytto') } }
            function Wait-PalvelinTerveys { $script:tapahtumat.Add('health'); return $script:tapaus -ne 'healthvirhe' }
            if ($tapaus -eq 'healthvirhe') { Assert-Heittaa { Invoke-Asennus -PaketinJuuri $lahde } 'Pääsuoritus päättyy virheeseen kun palvelin ei vastaa' }
            else { Invoke-Asennus -PaketinJuuri $lahde }
            if ($tapaus -eq 'healthvirhe') { Assert-Testi ($script:tapahtumat.Contains('health')) 'Virheellinen asennus ehti terveystarkistukseen asti' }
            if ($tapaus -eq 'peruutus') {
                Assert-Testi ($script:tapahtumat.Count -eq 0 -and [Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $script:kohde '.env'))) -eq [Convert]::ToBase64String($script:ennen)) 'Peruutus ei pysäytä eikä kirjoita mitään, ei myöskään laskettua liipaisinkorjausta'
            } else {
                $jalki = (Read-EnvTiedosto -Polku (Join-Path $script:kohde '.env') -NodeExe $node).Arvot
                Assert-Testi (@(Get-PuuttuvatAvaimet -Olemassa $jalki).Count -eq 0) "$tapaus`: pääsuoritus kirjoittaa kaikki mallin avaimet"
                if ($tapaus -ne 'uusi') {
                    $jalkiTavut = [IO.File]::ReadAllBytes((Join-Path $script:kohde '.env'))
                    if ($tapaus -eq 'valmiit-asetukset') {
                        Assert-Testi ($script:kysytty.Count -eq 0 -and [Convert]::ToBase64String($jalkiTavut) -eq [Convert]::ToBase64String($script:ennen)) 'Täydellistä .env-tiedostoa ei kirjoiteta eikä asetuksia kysytä'
                    } else {
                        Assert-Testi ($script:kysytty.Count -eq 1 -and $script:kysytty[0] -eq 'PAIKKY_BASE_URL' -and [Convert]::ToBase64String($jalkiTavut[0..($script:ennen.Length - 1)]) -eq [Convert]::ToBase64String($script:ennen)) "$tapaus`: vain Päikky kysytään ja vanha .env säilyy"
                    }
                } else { Assert-Testi (-not $script:tapahtumat.Contains('stop-browser') -and -not $script:tapahtumat.Contains('stop-server')) 'Uusi asennus ei pysäytä toisen asennuksen prosesseja' }
                if ($script:testitehtavat.Count) {
                    Assert-Testi (-not $script:tapahtumat.Contains('register') -and @($script:testitehtavat.Values | Where-Object { $_.Principal.UserId -ne 'ALKUPERAINEN\kayttaja' }).Count -eq 0) "$tapaus`: ajastusten käyttäjä ja olemassa oleva tehtäväjoukko säilyvät"
                    $liipaisinMuuttui = @($script:tapahtumat | Where-Object { $_ -like 'trigger-*' }).Count -gt 0
                    if ($tapaus -eq 'nimetty') {
                        Assert-Testi (@($script:testitehtavat.Values | Where-Object { $_.Triggers.Count -ne 1 -or $_.Triggers[0].UserId -ne 'ALKUPERAINEN\kayttaja' -or $_.Triggers[0].Delay -ne 'PT5S' }).Count -eq 0 -and $script:tapahtumat.Contains('trigger-Infonaytto-naytto')) 'nimetty: vanhentunut kirjautumisliipaisin korjataan päivityksessä viiveineen'
                    } else { Assert-Testi (-not $liipaisinMuuttui) "$tapaus`: toimivaan kirjautumisliipaisimeen ei kosketa" }
                    if ($tapaus -eq 'disabled') { Assert-Testi (@($script:testitehtavat.Values | Where-Object { $_.Settings.Enabled }).Count -eq 0) 'Käytöstä poistetut ajastukset jäävät pois käytöstä' }
                }
                $selainAlkoi = $script:tapahtumat.Contains('start-Infonaytto-naytto')
                Assert-Testi ($selainAlkoi -eq ($tapaus -ne 'healthvirhe')) "$tapaus`: selain käynnistyy vasta onnistuneen terveystarkistuksen jälkeen"
            }
        } $tapaus
    }
    Write-Host "Asentimen testit läpi: $script:onnistui" -ForegroundColor Green
} finally {
    # Vain tämän ajon luoma, täsmällisesti rajattu temp-hakemisto poistetaan.
    $poistettava = [IO.Path]::GetFullPath($testijuuri)
    if (-not $poistettava.StartsWith($tempJuuri, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $poistettava) -notmatch '^infonaytto-asennustesti-[a-f0-9]{32}$') { throw 'Testihakemiston poiston turvaraja petti.' }
    if (Test-Path -LiteralPath $poistettava) { Remove-Item -LiteralPath $poistettava -Recurse -Force }
}
