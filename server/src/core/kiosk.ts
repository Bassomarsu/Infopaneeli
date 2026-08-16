import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface KioskExitResult {
  ok: boolean;
  error?: string;
}

/**
 * Suorittaa yhden ulkoisen komennon ja heittää jos se palauttaa nollasta
 * poikkeavan poistumiskoodin (sama sopimus kuin node:child_processin
 * promisifioidulla execFilellä — heitetyssä virheessä on `.code`-kenttä).
 * Injektoitavissa testejä varten, samalla mallilla kuin StorageLike
 * (web/src/composables/useEditAccess.ts) ja AlarmSoundPlayer
 * (web/src/composables/useAlarms.ts): oikea toteutus (`defaultRunner`
 * alempana) käynnistää oikean prosessin, testit antavat väärennetyn
 * toteutuksen, jotta yksikään testi ei koskaan sulje oikeaa kioskiselainta.
 */
export type CommandRunner = (command: string, args: string[]) => Promise<void>;

const defaultRunner: CommandRunner = async (command, args) => {
  await execFileAsync(command, args);
};

interface PlatformKillSpec {
  command: string;
  args: string[];
  /**
   * Poistumiskoodi joka tarkoittaa "sopivaa prosessia ei löytynyt" — EI
   * virhe tässä yhteydessä, koska lopputulos (kioskiselain ei ole
   * käynnissä) on jo se mitä pyydettiin. Ilman tätä esim. kaksi peräkkäistä
   * kioskista-poistumispyyntöä (tai poistuminen kun selain oli jo kaatunut)
   * näyttäisi virheeltä käyttäjälle turhaan.
   */
  alreadyClosedCode: number;
}

/**
 * Windows: kioski avataan Edgellä (ks. asennus/kaynnista-kioski.ps1), aina
 * samalla prosessinimellä eikä omalla --user-data-dir:llä. `/IM msedge.exe`
 * täsmää KAIKKIIN saman koneen Edge-prosesseihin (myös Chromiumin
 * moniprosessiarkkitehtuurin renderer-/GPU-prosesseihin, joilla on sama
 * imagenimi) — hyväksyttävää, koska laite on omistettu seinänäyttö eikä sillä
 * ole muuta käyttöä Edgelle (ks. asennus/KAYTTOONOTTO.md). Poistumiskoodi 128
 * on taskkillin oma "prosessia ei löytynyt" -koodi.
 */
const WINDOWS_KILL: PlatformKillSpec = {
  command: "taskkill",
  args: ["/IM", "msedge.exe", "/F"],
  alreadyClosedCode: 128,
};

/**
 * Linux: Chromium käynnistetään openbox-autostartista `exec`-komennolla
 * kiinteään, tälle sovellukselle varattuun profiilikansioon
 * (`~/.config/infonaytto-chromium`, ks. asennus/asenna-kioski.sh). Se näkyy
 * prosessin komentorivillä `--user-data-dir=...infonaytto-chromium`-
 * argumenttina, ja "infonaytto-chromium" on riittävän erottuva merkkijono
 * ettei se voi vahingossa täsmätä mihinkään muuhun koneen prosessiin.
 * Kovakoodattu tähän — ei koskaan pyynnöstä, ks. tiedoston yläosan
 * turvallisuuskommentti (routes/api.ts). Poistumiskoodi 1 on pkillin oma
 * "yhtään täsmäävää prosessia ei löytynyt" -koodi.
 */
const LINUX_KILL: PlatformKillSpec = {
  command: "pkill",
  args: ["-f", "infonaytto-chromium"],
  alreadyClosedCode: 1,
};

function specForPlatform(platform: NodeJS.Platform): PlatformKillSpec | null {
  if (platform === "win32") return WINDOWS_KILL;
  if (platform === "linux") return LINUX_KILL;
  return null;
}

/**
 * Sulkee kioskiselaimen prosessin — ainoa keino poistua kioskitilasta, koska
 * selain ei voi tehdä sitä itselleen (ks. tiimin päätös/api.tsin
 * kommentti). Kutsuja (routes/api.ts) vastaa siitä että tänne päästään vain
 * paikalliselta laitteelta oikean FULL_PINin jälkeen — tämä funktio itse ei
 * tee mitään pääsynvalvontaa, se vain suorittaa jo hyväksytyn toimenpiteen.
 *
 * `platform` ja `runner` ovat injektoitavissa yksikkötestausta varten
 * (ks. tiedoston yläosan CommandRunner-kommentti) — oletusarvot ovat aina
 * oikeat tuotannossa, testit antavat aina omansa.
 */
export async function exitKiosk(
  platform: NodeJS.Platform = process.platform,
  runner: CommandRunner = defaultRunner,
): Promise<KioskExitResult> {
  const spec = specForPlatform(platform);
  if (!spec) return { ok: false, error: `Kioskista poistuminen ei ole tuettu alustalla "${platform}"` };

  try {
    await runner(spec.command, spec.args);
    return { ok: true };
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? (err as { code?: unknown }).code : undefined;
    if (code === spec.alreadyClosedCode) return { ok: true };
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
