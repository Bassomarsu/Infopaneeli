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

export interface WeatherLocationResult {
  location: WeatherLocation;
  /**
   * Teksti lokiin, tai null jos mitään huomautettavaa ei ole. Sama varoitus ei
   * toistu peräkkäisillä hauilla (ks. WeatherLocationResolver) — sääproviderilla
   * on 20 minuutin sykli, joten toistuva varoitus täyttäisi lokin rivillä joka
   * ei kerro mitään uutta.
   */
  warning: string | null;
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
 */
export class WeatherLocationResolver {
  private lastGood: WeatherLocation | null = null;
  private lastWarnedCode: string | null = null;

  resolve(sources: WeatherLocationSources): WeatherLocationResult {
    // Asetus ennen .env:ää: se on se jonka käyttäjä juuri vaihtoi, ja vain sen
    // muuttaminen vaikuttaa ilman uudelleenkäynnistystä.
    const fromSetting = this.tryPostalCode(sources.settingPostalCode);
    if (fromSetting) return fromSetting;

    // Tyhjä .env-arvo ei ole postinumero vaan "ei asetettu", eikä siitä siis
    // varoiteta — muuten jokainen asennus jossa muuttujaa ei ole valittaisi.
    const envCode = sources.envPostalCode.trim();
    const fromEnv = envCode === "" ? null : this.tryPostalCode(envCode);
    if (fromEnv) return fromEnv;

    // Kumpikin postinumerolähde tyhjä tai tuntematon. Jos jokin sijainti on jo
    // kerran ratkennut, pidetään se; muuten koordinaatit (tai niiden oletus)
    // ovat ainoa jäljellä oleva tieto. Varoitus on tällöin jo annettu yllä,
    // joten pudotus ei ole hiljainen.
    const fallback = this.lastGood ?? sources.envLocation;
    this.lastGood = fallback;
    const warning = this.pendingWarning(sources);
    return { location: fallback, warning };
  }

  /**
   * Postinumeron muuntoyritys. Palauttaa tuloksen vain jos numero on tunnettu;
   * tuntematon numero jättää päätöksen kutsujalle, joka jatkaa
   * etusijajärjestyksessä eteenpäin.
   */
  private tryPostalCode(code: string | null): WeatherLocationResult | null {
    if (code === null || code.trim() === "") return null;
    const found = lookupPostalCode(code);
    if (!found) return null;

    const location = { place: found.place, latitude: found.latitude, longitude: found.longitude };
    this.lastGood = location;
    // Kun numero taas kelpaa, unohdetaan aiempi valitus: jos sama virheellinen
    // numero kirjoitetaan myöhemmin uudelleen, siitä kuuluu varoittaa uudestaan.
    this.lastWarnedCode = null;
    return { location, warning: null };
  }

  /**
   * Varoitusteksti tuntemattomasta postinumerosta — kerran per numero, ei kerran
   * per haku. Asetuksen numero voittaa .env:n myös valituksessa, koska se on se
   * jonka käyttäjä juuri kirjoitti ja siis se jota hän odottaa korjaavansa.
   */
  private pendingWarning(sources: WeatherLocationSources): string | null {
    const settingCode = sources.settingPostalCode?.trim() ?? "";
    const envCode = sources.envPostalCode.trim();
    const offending = settingCode !== "" ? settingCode : envCode;
    if (offending === "") return null;
    if (offending === this.lastWarnedCode) return null;
    this.lastWarnedCode = offending;

    const where = settingCode !== "" ? "asetuksissa" : "WEATHER_POSTAL_CODE-muuttujassa";
    return `Postinumeroa ${offending} (${where}) ei löydy postinumeroaineistosta — sään sijainti pidetään ennallaan.`;
  }
}
