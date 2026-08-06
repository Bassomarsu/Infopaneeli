<#
.SYNOPSIS
    Sets up Infonäyttö to start automatically and run as a wall display.

.DESCRIPTION
    Creates a scheduled task that starts the backend at logon, another that
    opens Edge in kiosk mode against it, and switches the machine to a power
    plan that never blanks the screen.

    Run this once on the display machine, from an elevated PowerShell:

        powershell -ExecutionPolicy Bypass -File .\asenna-kioski.ps1

    Undo everything with:

        powershell -ExecutionPolicy Bypass -File .\asenna-kioski.ps1 -Poista

.PARAMETER Poista
    Removes the scheduled tasks instead of creating them. Power settings are
    left as they are, because they may have been changed for other reasons.
#>
[CmdletBinding()]
param(
    [switch]$Poista,
    [int]$Portti = 4173
)

$ErrorActionPreference = 'Stop'

$projektiJuuri = Split-Path -Parent $PSScriptRoot
$palvelinTehtava = 'Infonaytto-palvelin'
$nayttoTehtava = 'Infonaytto-naytto'

function Test-Adminina {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Adminina)) {
    Write-Error 'Aja tämä skripti järjestelmänvalvojana (Run as administrator).'
}

if ($Poista) {
    foreach ($nimi in @($palvelinTehtava, $nayttoTehtava)) {
        $olemassa = Get-ScheduledTask -TaskName $nimi -ErrorAction SilentlyContinue
        if ($olemassa) {
            Unregister-ScheduledTask -TaskName $nimi -Confirm:$false
            Write-Output "Poistettu ajastettu tehtävä: $nimi"
        }
        else {
            Write-Output "Tehtävää ei ollut: $nimi"
        }
    }
    Write-Output 'Valmis. Virranhallinnan asetuksia ei muutettu.'
    return
}

# --- Tarkistukset ennen asennusta -------------------------------------------

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
    Write-Error 'Node.js ei löydy PATHista. Asenna Node 24 tai uudempi ensin.'
}

$palvelinSkripti = Join-Path $projektiJuuri 'server\src\index.ts'
if (-not (Test-Path $palvelinSkripti)) {
    Write-Error "Palvelinta ei löydy polusta $palvelinSkripti. Aja skripti projektin asennus-kansiosta."
}

if (-not (Test-Path (Join-Path $projektiJuuri 'web\dist\index.html'))) {
    Write-Warning 'Käyttöliittymää ei ole käännetty. Aja `npm run build` ennen kuin näyttö avataan.'
}

if (-not (Test-Path (Join-Path $projektiJuuri '.env'))) {
    Write-Warning '.env puuttuu — Wilma ja kalenteri eivät toimi ennen kuin se on täytetty.'
}

$edge = @(
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $edge) {
    Write-Error 'Microsoft Edgeä ei löytynyt.'
}

# --- Palvelin käynnistyy kirjautumisen yhteydessä ---------------------------
# Kirjautumisliipaisin eikä "run whether user is logged on or not", koska
# kioskiselain tarvitsee työpöytäistunnon.

$palvelinToiminto = New-ScheduledTaskAction `
    -Execute $node `
    -Argument '--env-file-if-exists=..\.env src\index.ts' `
    -WorkingDirectory (Join-Path $projektiJuuri 'server')

$liipaisin = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# RestartCount pitää palvelimen pystyssä myös kaatumisen jälkeen — laite on
# seinällä eikä sitä käydä käynnistämässä käsin.
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
    -Trigger $liipaisin `
    -Settings $asetukset `
    -Description 'Infonäytön taustapalvelin' `
    -Force | Out-Null

Write-Output "Luotu ajastettu tehtävä: $palvelinTehtava"

# --- Selain kioskitilassa ---------------------------------------------------
# Viive antaa palvelimen ehtiä kuunteluun ennen kuin sivu avataan.

$nayttoToiminto = New-ScheduledTaskAction `
    -Execute $edge `
    -Argument "--kiosk http://localhost:$Portti --edge-kiosk-type=fullscreen --no-first-run --disable-features=TranslateUI --disable-pinch --overscroll-history-navigation=0"

$nayttoLiipaisin = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$nayttoLiipaisin.Delay = 'PT20S'

Register-ScheduledTask `
    -TaskName $nayttoTehtava `
    -Action $nayttoToiminto `
    -Trigger $nayttoLiipaisin `
    -Settings $asetukset `
    -Description 'Infonäytön kioskiselain' `
    -Force | Out-Null

Write-Output "Luotu ajastettu tehtävä: $nayttoTehtava"

# --- Virranhallinta ---------------------------------------------------------
# Näyttö ei saa sammua eikä kone mennä lepotilaan. Sekä verkkovirralla (AC)
# että akulla (DC), koska Surface siirtyy akulle hetkellisesti jos laturi
# irtoaa vahingossa.

powercfg /change monitor-timeout-ac 0
powercfg /change monitor-timeout-dc 0
powercfg /change standby-timeout-ac 0
powercfg /change standby-timeout-dc 0
powercfg /change hibernate-timeout-ac 0
powercfg /change hibernate-timeout-dc 0
Write-Output 'Virranhallinta: näyttö ja lepotila eivät sammu.'

# Näytönsäästäjä pois.
Set-ItemProperty -Path 'HKCU:\Control Panel\Desktop' -Name 'ScreenSaveActive' -Value '0'
Write-Output 'Näytönsäästäjä pois käytöstä.'

Write-Output ''
Write-Output 'Valmis. Vielä käsin tehtävät asiat:'
Write-Output '  1. Automaattikirjautuminen: netplwiz -> poista rasti "Käyttäjän on annettava...".'
Write-Output '  2. Windows Update -aktiiviset tunnit niin laajaksi kuin sallitaan, ettei kone'
Write-Output '     käynnisty uudelleen kesken päivän.'
Write-Output "  3. Testaa: käynnistä kone uudelleen ja varmista että näyttö palaa itsestään."
