import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// The tests use a real Node executable for .env parsing. Keep the same runtime
// as npm even if another Node installation appears first in PATH.
const env = { ...process.env, PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH };

let failed = false;

function run(label, command, args) {
  console.log(`\n--- ${label} ---`);
  const result = spawnSync(command, args, { cwd: repoRoot, env, stdio: "inherit", windowsHide: true });
  if (result.error) console.error(result.error.message);
  if ((result.status ?? 1) !== 0) failed = true;
}

// Kumpikin asennin testataan sillä tulkilla jolla se oikeasti ajetaan.
// Windows-asennin käyttää robocopya ja NTFS-oikeuksia, joten sen testit
// vaativat Windowsin.
if (process.platform === "win32") {
  run("Windows-asennin (asenna.ps1)", "powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
    path.join(repoRoot, "asennus", "test-asenna.ps1"),
  ]);
} else {
  console.log("skip Windows installer tests — requires Windows, robocopy and NTFS");
}

// Linux-asentimen testit ajetaan MYÖS Windowsilla jos bash löytyy (Git Bash):
// kehityskone on Windows, eikä asenna.sh:n regressioita saa jättää ajamatta
// pelkästään sen takia.
function findBash() {
  if (process.platform !== "win32") return "/bin/bash";
  const candidates = [];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    // System32\bash.exe ja WindowsApps\bash.exe ovat WSL:n käynnistimiä: ne
    // ajaisivat testit toisessa tiedostojärjestelmässä (/mnt/...), jossa
    // annettu suhteellinen polku ei osoita tähän puuhun.
    if (/(system32|windowsapps)[\\/]*$/i.test(dir)) continue;
    candidates.push(path.join(dir, "bash.exe"));
  }
  for (const base of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA]) {
    if (!base) continue;
    candidates.push(path.join(base, "Git", "bin", "bash.exe"));
    candidates.push(path.join(base, "Programs", "Git", "bin", "bash.exe"));
  }
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

const bash = findBash();
if (bash) {
  // Suhteellinen polku tarkoituksella: Git Bash saa näin polun jonka se osaa
  // jäsentää ilman asemakirjain- ja kenoviivakäännöstä.
  run("Linux-asennin (asenna.sh)", bash, ["asennus/test-asenna.sh"]);
} else {
  console.log("\nskip Linux installer tests — bash not found (Git Bash on Windows)");
}

process.exitCode = failed ? 1 : 0;
