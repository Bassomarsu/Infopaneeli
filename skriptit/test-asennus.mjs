import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Windows-asennin käyttää robocopya ja NTFS-oikeuksia. Näiden testejä ei voi
// suorittaa Linuxissa PowerShellin asentamisella; muu testisarja toimii siellä.
if (process.platform !== "win32") {
  console.log("skip Windows installer tests — requires Windows, robocopy and NTFS");
} else {
  const result = spawnSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
    fileURLToPath(new URL("../asennus/test-asenna.ps1", import.meta.url)),
  ], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    // The test uses a real Node executable for .env parsing. Keep the same
    // runtime as npm even if another Node installation appears first in PATH.
    env: { ...process.env, PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH },
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
}
