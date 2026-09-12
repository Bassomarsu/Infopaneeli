import { lookupPostalCode } from "./postal-codes.ts";

/**
 * Mistä sääkortin sijainti tulee, ja missä järjestyksessä.
 *
 *   asetukset (tietokanta)  >  WEATHER_POSTAL_CODE  >  WEATHER_LAT/LON/PLACE  >  oletus
 *
 * Järjestys ei ole mielivaltainen. `.env` luetaan VAIN käynnistyksessä, ja se on
 * jo kerran hämännyt käyttäjää: tiedostoa muokattiin, mikään ei muuttunut, eikä
 * mikään kertonut miksi. Asetuksista vaihdettu postinumero sen sijaan vaikuttaa
 * heti — mutta vain jos sijainti luetaan HAKUHETKELLÄ eikä moduulin
 * latautuessa. Siksi tämä on funktio eikä vakio.
 *
 * Koordinaatit jäävät alimmaksi eivätkä katoa: käyttäjällä on tuotannossa
 * WEATHER_LAT/WEATHER_LON/WEATHER_PLACE, ja olemassa oleva asennus ei saa
 * muuttua toisenlaiseksi pelkän päivityksen takia.
 */
export interface WeatherLocation {
  place: string;
  latitude: number;
  longitude: number;
}

export interface WeatherLocationSources {
  /** Asetuspaneelista tallennettu postinumero, tai null jos sitä ei ole asetettu. */
  settingPostalCode: string | null;
  /** WEATHER_POSTAL_CODE. Tyhjä merkkijono = ei asetettu. */
  envPostalCode: string;
  /** WEATHER_LAT/WEATHER_LON/WEATHER_PLACE, tai niiden oletukset (Karstula). */
  envLocation: WeatherLocation;
}

/**
 * Mistä käytössä oleva sijainti tuli. Asetuspaneeli kertoo tämän käyttäjälle,
 * eikä selain voi päätellä sitä itse: `.env`:ssä voi olla joko postinumero tai
 * koordinaatit, eikä kumpikaan näy selaimeen asti.
 *
 *   settings  asetusten postinumero ratkaisi sijainnin
 *   env       .env ratkaisi sijainnin (postinumero, koordinaatit tai oletus)
 *   retained  annettua postinumeroa ei tunneta, joten EDELLINEN sijainti on yhä
 *             voimassa. Se ei ole "asetuksista" eikä ".env-tiedostosta" vaan
 *             vanhentunut arvo, eikä sitä siksi saa esittää kumpanakaan.
 */
export type WeatherLocationSource = "settings" | "env" | "retained";

export interface WeatherLocationResult {
  location: WeatherLocation;
  source: WeatherLocationSource;
  /**
   * Teksti lokiin, tai null jos mitään huomautettavaa ei ole. Sama varoitus ei
   * toistu peräkkäisillä hauilla (ks. WeatherLocationResolver) — sääproviderilla
   * on 20 minuutin sykli, joten toistuva varoitus täyttäisi lokin rivillä joka
   * ei kerro mitään uutta.
   */
  warning: string | null;
}

/** Postinumero koordinaateiksi, tai null jos numeroa ei ole tai sitä ei tunneta. */
function lookup(code: string): WeatherLocation | null {
  if (code === "") return null;
  const found = lookupPostalCode(code);
  if (!found) return null;
  return { place: found.place, latitude: found.latitude, longitude: found.longitude };
}

/**
 * Se yksi numero josta tällä haulla valitetaan, tai "" jos valitettavaa ei ole.
 *
 * Asetuksen numero voittaa .env:n myös valituksessa, koska se on se jonka
 * käyttäjä juuri kirjoitti ja siis se jota hän odottaa korjaavansa. .env:n
 * numerosta valitetaan vain kun asetuksissa ei ole numeroa lainkaan eikä .env:n
 * oma numero ratkennut — ja kun asetusten numero ratkesi, .env:n numero on
 * ohitettu eikä siitä ole mitään sanottavaa.
 *
 * Enintään yksi numero per haku on tarkoituksellista: valitusmuistia on yksi,
 * joten kahdesta vuorottelevasta numerosta valittaminen saisi varoituksen
 * heilahtelemaan päälle joka toisella haulla.
 */
function offendingCode(
  settingCode: string,
  envCode: string,
  fromSetting: WeatherLocation | null,
  fromEnv: WeatherLocation | null,
): string {
  if (fromSetting) return "";
  if (settingCode !== "") return settingCode;
  return fromEnv ? "" : envCode;
}

/**
 * Ratkaisee sijainnin ja muistaa kaksi asiaa hakujen välillä: viimeisimmän
 * kelvollisen sijainnin ja viimeksi valitetun postinumeron.
 *
 * Edellinen kelvollinen on tässä siksi, että TUNTEMATON POSTINUMERO EI SAA
 * PUDOTTAA SIJAINTIA OLETUKSEEN. Jos käyttäjä kirjoittaa asetuksiin kirjoitus-
 * virheellisen numeron, sääkortti näyttäisi muuten yhtäkkiä Karstulan säätä
 * ilman että mikään kertoo miksi — ja kortin otsikko vaihtuisi niin
 * huomaamattomasti ettei sitä välttämättä huomaa. Edellinen sijainti pysyy siis
 * voimassa, ja loki kertoo mikä meni pieleen.
 *
 * Muisti koskee VAIN tuota tapausta. "Postinumeroa ei ole annettu" ja
 * "postinumero on annettu mutta sitä ei tunneta" ovat eri tiloja, ja vain
 * jälkimmäinen saa käyttää muistia — ks. resolve().
 */
export class WeatherLocationResolver {
  /** Nyt voimassa oleva sijainti, jotta tuntematon numero ei pudota sitä. */
  private lastGood: WeatherLocation | null = null;
  /** Viimeksi valitettu numero, jotta sama varoitus ei toistu 20 min välein. */
  private lastWarnedCode: string | null = null;

  resolve(sources: WeatherLocationSources): WeatherLocationResult {
    const settingCode = sources.settingPostalCode?.trim() ?? "";
    // Tyhjä .env-arvo ei ole postinumero vaan "ei asetettu", eikä siitä siis
    // varoiteta — muuten jokainen asennus jossa muuttujaa ei ole valittaisi.
    const envCode = sources.envPostalCode.trim();

    // Asetus ennen .env:ää: se on se jonka käyttäjä juuri vaihtoi, ja vain sen
    // muuttaminen vaikuttaa ilman uudelleenkäynnistystä.
    const fromSetting = lookup(settingCode);
    const fromEnv = fromSetting ? null : lookup(envCode);

    // Varoitus muodostetaan TÄSMÄLLEEN KERRAN per haku ja TÄSMÄLLEEN YHDESTÄ
    // numerosta. Kumpikin ehto on maksettu vialla:
    //
    //  • Kerran: aiemmin varoitus laskettiin kahdessa eri haarassa, ja
    //    jälkimmäinen kutsu näki muistista oman äskeisen merkintänsä ja palautti
    //    null — varoitus nieltiin kokonaan.
    //  • Yhdestä numerosta: jos molemmat lähteet ovat tuntemattomia, valitetaan
    //    vain asetusten numerosta. Kahden vuorottelevan numeron muistaminen
    //    yhdessä muuttujassa saisi varoituksen heilahtelemaan (varoitus, ei
    //    varoitusta, varoitus) — mitattu. Ks. offendingCode().
    const offending = offendingCode(settingCode, envCode, fromSetting, fromEnv);
    const where = settingCode !== "" ? "asetuksissa" : "WEATHER_POSTAL_CODE-muuttujassa";
    const warning = this.warnOnce(offending, where);

    if (fromSetting) {
      this.lastGood = fromSetting;
      return { location: fromSetting, source: "settings", warning };
    }
    if (fromEnv) {
      this.lastGood = fromEnv;
      return { location: fromEnv, source: "env", warning };
    }

    // Kumpikaan lähde ei tuottanut tunnettua postinumeroa. Tässä on KAKSI ERI
    // TILANNETTA, ja niiden sekoittaminen oli oma vikansa:
    //
    //  a) postinumeroa ei ole annettu lainkaan → .env:n koordinaatit ovat ainoa
    //     oikea vastaus. Aiemmin tässäkin käytettiin `lastGood`ia, joten
    //     postinumerokentän tyhjennys EI palauttanut .env:n sijaintia: äsken
    //     asetettu kaupunki jäi voimaan uudelleenkäynnistykseen asti, hiljaa.
    //  b) postinumero on annettu mutta sitä ei tunneta → edellinen kelvollinen
    //     sijainti pidetään. Tämä on koko luokan olemassaolon syy, ja varoitus
    //     on jo annettu yllä, joten pudotus ei jää hiljaiseksi.
    const retained = settingCode !== "" || envCode !== "" ? this.lastGood : null;
    const location = retained ?? sources.envLocation;
    // Myös tyhjennyksen jälkeinen .env-sijainti on "edellinen kelvollinen":
    // seuraava tuntematon numero pitää sen, ei jotain sitä vanhempaa.
    this.lastGood = location;
    return { location, source: retained ? "retained" : "env", warning };
  }

  /**
   * Varoitusteksti tuntemattomasta postinumerosta — kerran per numero, ei kerran
   * per haku. AINOA paikka joka koskee valitusmuistiin, ja se kutsutaan
   * täsmälleen kerran jokaisella resolve-kutsulla.
   *
   * Tyhjä `offending` tarkoittaa ettei valitettavaa ole, jolloin muisti
   * nollataan: jos sama virheellinen numero kirjoitetaan myöhemmin uudelleen,
   * siitä kuuluu varoittaa uudestaan. Muisti EI nollaudu silloin kun asetuksissa
   * on tuntematon numero mutta .env tarjoaa kelvollisen — kelvollinen
   * .env-numero ei tee asetusten virheellisestä numerosta yhtään oikeampaa.
   */
  private warnOnce(offending: string, where: string): string | null {
    if (offending === "") {
      this.lastWarnedCode = null;
      return null;
    }
    if (offending === this.lastWarnedCode) return null;
    this.lastWarnedCode = offending;
    return `Postinumeroa ${offending} (${where}) ei löydy postinumeroaineistosta — sään sijainti pidetään ennallaan.`;
  }
}
