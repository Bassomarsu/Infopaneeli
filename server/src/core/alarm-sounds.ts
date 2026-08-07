import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { config } from "./config.ts";

/**
 * Perhe pudottaa omat hälytysäänitiedostonsa `config.soundsDir`-kansioon
 * käsin (ei latausta käyttöliittymästä — kioskiselaimesta ei voi kätevästi
 * valita tiedostoa, ja multipart-lataus toisi uuden riippuvuuden ja
 * kirjoitusoikeuden tarpeen kotipalvelimelle ilman todellista hyötyä). Tämä
 * moduuli listaa kansion sisällön ja ratkaisee soittopyynnön tunnisteen
 * ($id) turvallisesti oikeaksi tiedostopoluksi.
 *
 * TÄRKEÄÄ polkuhyökkäyksen kannalta: tunniste (id) EI ole tiedostonimi eikä
 * sitä koskaan dekoodata takaisin tiedostonimeksi. Se on tiedostonimestä
 * laskettu, ALARM_SOUND_ID_PATTERNiin (ks. core/settings.ts) ja URL-
 * polkusegmenttiin sopiva merkkijono. Tiedosto ratkaistaan AINA hakemalla id
 * nykyisestä listauksesta (Array.find), eikä koskaan rakentamalla polkua
 * suoraan pyynnön parametrista — polkuhyökkäys ei siis ole edes teoriassa
 * mahdollinen `resolveCustomSound`in kautta, oli id mitä tahansa
 * (`"../../../secret"`, `"..%2f..%2f"`, mitä vain). `path.resolve` +
 * etuliitetarkistus (`withinDir`) ja `fs.realpathSync`-tarkistus ovat silti
 * mukana toisena turvakerroksena listausta rakennettaessa, siltä varalta
 * että kansiossa olisi esim. kansion ulkopuolelle osoittava symlinkki.
 */

export interface CustomSound {
  id: string;
  /** Näytetään käyttöliittymässä — alkuperäinen tiedostonimi ilman päätettä. */
  label: string;
}

interface ResolvedSound extends CustomSound {
  path: string;
  mimeType: string;
}

/** Vain nämä päätteet tunnistetaan — mikä tahansa muu tiedosto kansiossa ohitetaan hiljaa. */
const MIME_BY_EXT: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
};

/** Listaus välimuistitetaan tämän ajan, jotta peräkkäiset kutsut (esim. hälytyksen laukeaminen + esikuuntelu) eivät lue hakemistoa joka kerta. */
const DEFAULT_CACHE_TTL_MS = 15_000;

function withinDir(real: string, dirReal: string): boolean {
  return real === dirReal || real.startsWith(dirReal + path.sep);
}

/**
 * Tunniste lasketaan tiedostonimestä: lyhyt, luettava tavu alkuperäisestä
 * nimestä (diakriitit pois, esim. "herätys" -> "heratys") + hajautusarvo
 * koko tiedostonimestä. Sama tiedostonimi tuottaa aina saman tunnisteen niin
 * kauan kuin tiedostoa ei nimetä uudelleen — tunnisteesta ei kuitenkaan
 * yritetä eikä tarvitse palauttaa alkuperäistä nimeä takaisin, ratkaisu
 * tehdään aina listauksen kautta (ks. tiedoston yläkommentti).
 */
function makeSoundId(filename: string): string {
  const base = path.parse(filename).name;
  const slug = base
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // diakriitit pois: ä->a, ö->o, å->a, é->e, ...
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 20);
  const hash = createHash("sha1").update(filename, "utf8").digest("hex").slice(0, 10);
  return `file-${slug || "aani"}-${hash}`;
}

export class AlarmSoundLibrary {
  private readonly dir: string;
  private readonly cacheTtlMs: number;
  private cache: ResolvedSound[] | null = null;
  private cacheAt = 0;

  constructor(dir: string, cacheTtlMs = DEFAULT_CACHE_TTL_MS) {
    this.dir = dir;
    this.cacheTtlMs = cacheTtlMs;
    this.ensureDir();
  }

  /** Luo kansion jos sitä ei ole, jotta käyttäjällä on ylipäätään paikka mihin tiedostot laittaa. */
  private ensureDir(): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch {
      // Ei kaadeta palvelinta pelkän äänikansion takia — listaus palautuu
      // alla tyhjänä jos hakemistoa ei silti saada auki.
    }
  }

  private buildList(): ResolvedSound[] {
    this.ensureDir();
    let dirReal: string;
    try {
      dirReal = fs.realpathSync(this.dir);
    } catch {
      return [];
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.dir, { withFileTypes: true });
    } catch {
      return [];
    }

    const sounds: ResolvedSound[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue; // ei alikansioita eikä symlinkkejä — vain tavalliset tiedostot kelpaavat
      const ext = path.extname(entry.name).toLowerCase();
      const mimeType = MIME_BY_EXT[ext];
      if (!mimeType) continue;

      const full = path.resolve(this.dir, entry.name);
      let real: string;
      try {
        real = fs.realpathSync(full);
      } catch {
        continue;
      }
      if (!withinDir(real, dirReal)) continue; // puolustus syvyydessä: ei koskaan tarjoilla kansion ulkopuolelle osoittavaa polkua

      sounds.push({
        id: makeSoundId(entry.name),
        label: path.parse(entry.name).name,
        path: real,
        mimeType,
      });
    }

    sounds.sort((a, b) => a.label.localeCompare(b.label, "fi"));
    return sounds;
  }

  private currentList(forceRefresh: boolean): ResolvedSound[] {
    const now = Date.now();
    if (forceRefresh || this.cache === null || now - this.cacheAt > this.cacheTtlMs) {
      this.cache = this.buildList();
      this.cacheAt = now;
    }
    return this.cache;
  }

  /**
   * `forceRefresh`: käytä true kun käyttäjä avaa hälytyspaneelin — silloin
   * halutaan tuore listaus. Muissa tapauksissa (esim. hälytyksen laukeaminen)
   * välimuisti riittää eikä levyä lueta jokaisella hälytyskellon 20 sekunnin
   * syklillä, koska tätä funktiota ei kutsuta sieltä lainkaan — vain
   * paneelin avatessa ja äänen soittohetkellä.
   */
  listCustomSounds(forceRefresh = false): CustomSound[] {
    return this.currentList(forceRefresh).map(({ id, label }) => ({ id, label }));
  }

  /**
   * Ratkaisee soitto-/esikatselupyynnön tunnisteen tiedostopoluksi. Palauttaa
   * null jos tunnistetta ei löydy nykyisestä listauksesta — mistä tahansa
   * syystä (tiedosto poistettu, nimetty uudelleen, tunniste on täysin
   * mielivaltainen). Kutsuja (routes/api.ts) vastaa 404:n palauttamisesta;
   * client (web/alarmSounds.ts) vastaa siitä ettei hälytys jää hiljaiseksi.
   */
  resolveCustomSound(id: string): { path: string; mimeType: string } | null {
    const found = this.currentList(false).find((s) => s.id === id);
    return found ? { path: found.path, mimeType: found.mimeType } : null;
  }
}

/** Tuotannon jaettu instanssi — reitit (routes/api.ts) käyttävät tätä. */
export const alarmSoundLibrary = new AlarmSoundLibrary(config.soundsDir);

export function listCustomSounds(forceRefresh = false): CustomSound[] {
  return alarmSoundLibrary.listCustomSounds(forceRefresh);
}

export function resolveCustomSound(id: string): { path: string; mimeType: string } | null {
  return alarmSoundLibrary.resolveCustomSound(id);
}
