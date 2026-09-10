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

    # Pääsuorituksen systeemirajapinnat korvataan tässä lohkossa. Tiedostot ja
    # kopiointi ovat silti oikeita; ohjelmia, ajastuksia tai rekisteriä ei muuteta.
    foreach ($tapaus in @('paivitys', 'peruutus', 'healthvirhe', 'uusi', 'valmiit-asetukset', 'tehtavat', 'disabled', 'osittaiset')) {
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
            if ($tapaus -in @('tehtavat', 'disabled', 'osittaiset')) {
                foreach ($nimi in @('Infonaytto-palvelin', 'Infonaytto-naytto')) {
                    if ($tapaus -eq 'osittaiset' -and $nimi -eq 'Infonaytto-naytto') { continue }
                    $script:testitehtavat[$nimi] = [PSCustomObject]@{
                        TaskName = $nimi; TaskPath = '\'; Principal = [PSCustomObject]@{ UserId = 'ALKUPERAINEN\kayttaja' }
                        Settings = [PSCustomObject]@{ Enabled = $tapaus -ne 'disabled' }
                        Actions = @([PSCustomObject]@{ Execute = 'powershell.exe'; Arguments = '-File "' + (Join-Path $script:kohde 'asennus\kaynnista.ps1') + '" -Portti 4173' })
                    }
                }
            }
            function Get-EdgePolku { 'C:\test-edge\msedge.exe' }
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
            function New-ScheduledTaskTrigger { return @{ Delay = '' } }
            function New-ScheduledTaskSettingsSet { return @{} }
            function New-ScheduledTaskPrincipal { return @{} }
            function Register-ScheduledTask { $script:tapahtumat.Add('register') }
            function Set-ScheduledTask { param($TaskName, $TaskPath, $Action) $script:tapahtumat.Add('set-' + $TaskName); $script:testitehtavat[$TaskName].Actions = @($Action) }
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
                Assert-Testi ($script:tapahtumat.Count -eq 0 -and [Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $script:kohde '.env'))) -eq [Convert]::ToBase64String($script:ennen)) 'Peruutus ei pysäytä eikä kirjoita mitään'
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
