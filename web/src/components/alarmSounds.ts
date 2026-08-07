/**
 * Sisäänrakennetut hälytysäänet tuotetaan Web Audio API:lla
 * (oskillaattoreilla) eikä äänitiedostoilla: ei uusia riippuvuuksia, ei
 * binäärejä repoon, ja ääni toimii ilman verkkoa. `soundId` on silti pelkkä
 * tunniste (ei suoraan funktioviittaus) — ks. kommentti types.ts:n
 * Alarm-tyypissä.
 *
 * Perhe voi lisäksi pudottaa omia äänitiedostojaan palvelimen
 * data/sounds-kansioon (ks. server/src/core/alarm-sounds.ts). Ne listataan
 * `/api/alarm-sounds`-reitiltä ja tunnetaan tässä siitä ettei niiden `id`
 * löydy ALARM_SOUNDS-listalta — ei mistään kiinteästä etuliitteestä, jotta
 * client ei ole riippuvainen palvelimen sisäisestä tunnisteformaatista.
 */

export interface AlarmSoundDef {
  id: string;
  label: string;
}

/** Kolme selvästi erilaista ääntä: lempeä kilahdus, nouseva sarja, toistuva piippaus. */
export const ALARM_SOUNDS: AlarmSoundDef[] = [
  { id: "chime", label: "Kellon kilahdus" },
  { id: "rising", label: "Nouseva sarja" },
  { id: "beep", label: "Toistuva piippaus" },
];

export const DEFAULT_SOUND_ID = "chime";

/** Perheen oma äänitiedosto, sellaisena kuin palvelin sen listaa. */
export interface CustomSound {
  id: string;
  label: string;
}

/** True jos tunniste ei ole mikään sisäänrakennetuista — silloin se on (oletettavasti) oma äänitiedosto. */
export function isCustomSoundId(soundId: string): boolean {
  return !ALARM_SOUNDS.some((s) => s.id === soundId);
}

/**
 * Hakee listan perheen omista äänitiedostoista. Kutsujan (AlarmsPanel.vue)
 * vastuulla on kutsua tätä vain kun paneeli avataan, ei hälytyskellon
 * jokaisella 20 sekunnin syklillä — palvelin muutenkin välimuistittaa
 * listauksen, mutta turha verkkokutsukin on syytä välttää.
 */
export async function fetchCustomSounds(): Promise<CustomSound[]> {
  const response = await fetch("/api/alarm-sounds");
  if (!response.ok) {
    throw new Error(`Omien äänitiedostojen listaus epäonnistui (HTTP ${response.status})`);
  }
  return (await response.json()) as CustomSound[];
}

/**
 * Yksi jaettu AudioContext koko sovellukselle. Selain estää äänen toiston
 * kunnes sivulla on tapahtunut käyttäjän ele (kosketus, klikkaus) — konteksti
 * luodaan/herätetään vasta silloin, ei moduulin latautuessa, koska muuten
 * `new AudioContext()` syntyisi jo suljettuna ilman mitään keinoa avata sitä
 * ohjelmallisesti.
 */
let sharedContext: AudioContext | null = null;

/**
 * Kutsutaan käyttäjän eleestä (mikä tahansa kosketus riittää — ks.
 * useAlarms.ts). Idempotentti: turvallinen kutsua useasti.
 */
export function unlockAudio(): void {
  if (typeof window === "undefined") return;
  if (!sharedContext) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    sharedContext = new Ctor();
  }
  if (sharedContext.state === "suspended") {
    void sharedContext.resume();
  }
}

export function isAudioUnlocked(): boolean {
  return sharedContext?.state === "running";
}

// --- Pysäytettävyys: vain yksi hälytysääni kerrallaan, oli se kumpi tahansa toistotapa ---

/**
 * Yhden hälytyksen (tai esikuuntelun) äänen kokonaiskesto rajataan tähän.
 * Perustelu: sisäänrakennetut äänet kestävät toistoineenkin aina alle 15 s,
 * joten raja koskee käytännössä vain omia äänitiedostoja — kolmen minuutin
 * tiedosto kahdeksalla toistolla (suurin sallittu repeatCount) olisi ilman
 * ylärajaa lähes puoli tuntia yhtäjaksoista ääntä. Kolme minuuttia on reilusti
 * pidempi kuin mikä tahansa järkevä hälytysääni tarvitsee tullakseen
 * kuulluksi, mutta lyhyt verrattuna siihen mitä koko talo joutuisi muuten
 * kestämään. Näkyvä ilmoitus EI noudata tätä rajaa — se pysyy ruudulla
 * kunnes käyttäjä kuittaa (ks. AlarmsPanel.vue), joten itse hälytystä ei voi
 * menettää vaikka ääni vaikenee ajastimen takia.
 */
const MAX_TOTAL_PLAYBACK_MS = 3 * 60 * 1000;

interface PlaybackSession {
  /** Vaientaa äänen HETI. Idempotentti — turvallinen kutsua useasti tai kun mikään ei enää soi. */
  stop(): void;
}

/** Käynnissä oleva ääni, jos mikään soi — muuten null. Vain yksi kerrallaan. */
let currentSession: PlaybackSession | null = null;

/**
 * Pysäyttää käynnissä olevan hälytysäänen HETI, oli se sisäänrakennettu tai
 * oma äänitiedosto. Turvallinen kutsua vaikka mikään ei soisi. Käytetään
 * sekä automaattisesti uuden toiston alussa (`registerSession`, alla — vain
 * yksi ääni kerrallaan) että eksplisiittisesti: hälytyksen kuittauksesta
 * (useAlarms.ts), esikuuntelun pysäytyspainikkeesta ja hälytyspaneelin
 * sulkeutuessa/purkautuessa (AlarmsPanel.vue).
 */
export function stopAlarmSound(): void {
  currentSession?.stop();
}

/**
 * Rekisteröi uuden äänen käynnissä olevaksi istunnoksi. Pysäyttää ensin
 * automaattisesti edellisen (jos jokin vielä soi) ja asettaa kokonaiskeston
 * ylärajan (ks. MAX_TOTAL_PLAYBACK_MS yllä). `stopFn`:n on vaiennettava ääni
 * synkronisesti ja välittömästi kun se kutsutaan.
 */
function registerSession(stopFn: () => void): PlaybackSession {
  currentSession?.stop();
  const session: PlaybackSession = {
    stop: () => {
      window.clearTimeout(capTimer);
      stopFn();
      if (currentSession === session) currentSession = null;
    },
  };
  const capTimer = window.setTimeout(() => session.stop(), MAX_TOTAL_PLAYBACK_MS);
  currentSession = session;
  return session;
}

function clampVolume(volume: number): number {
  return Math.min(Math.max(volume, 0), 1);
}

// --- Sisäänrakennetut äänet: Web Audio -oskillaattorit ---

function gainEnvelope(ctx: AudioContext, gain: GainNode, peak: number, startAt: number, attack: number, release: number): void {
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0001), startAt + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + attack + release);
}

function tone(
  ctx: AudioContext,
  master: GainNode,
  frequency: number,
  startAt: number,
  duration: number,
  peakVolume: number,
  type: OscillatorType = "sine",
): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(frequency, startAt);
  gainEnvelope(ctx, gain, peakVolume, startAt, duration * 0.15, duration * 0.85);
  osc.connect(gain);
  gain.connect(master);
  osc.start(startAt);
  osc.stop(startAt + duration + 0.05);
}

/** Lempeä kellon kilahdus: perustaajuus + hiljainen yläsävel, hidas häivytys. */
function scheduleChime(ctx: AudioContext, master: GainNode, startAt: number, volume: number): number {
  const duration = 1.1;
  tone(ctx, master, 880, startAt, duration, volume);
  tone(ctx, master, 1760, startAt, duration * 0.7, volume * 0.35);
  return duration;
}

/** Nouseva neljän sävelen sarja, reipas ja herättävä. */
function scheduleRising(ctx: AudioContext, master: GainNode, startAt: number, volume: number): number {
  const notes = [523, 659, 784, 988];
  const step = 0.16;
  const noteDuration = 0.22;
  notes.forEach((freq, i) => tone(ctx, master, freq, startAt + i * step, noteDuration, volume, "triangle"));
  return notes.length * step + noteDuration;
}

/** Kolme lyhyttä, terävää piippausta — tyypillinen herätyskellon ääni. */
function scheduleBeep(ctx: AudioContext, master: GainNode, startAt: number, volume: number): number {
  const beepDuration = 0.14;
  const gap = 0.1;
  const beeps = 3;
  for (let i = 0; i < beeps; i += 1) {
    tone(ctx, master, 1046, startAt + i * (beepDuration + gap), beepDuration, volume, "square");
  }
  return beeps * (beepDuration + gap);
}

function scheduleOne(ctx: AudioContext, master: GainNode, soundId: string, startAt: number, volume: number): number {
  switch (soundId) {
    case "rising":
      return scheduleRising(ctx, master, startAt, volume);
    case "beep":
      return scheduleBeep(ctx, master, startAt, volume);
    case "chime":
    default:
      return scheduleChime(ctx, master, startAt, volume);
  }
}

/** Tauko toistojen välissä, jotta erilliset kierrokset erottuvat toisistaan. */
const REPEAT_GAP_S = 0.5;

/**
 * Soittaa jonkin sisäänrakennetuista (oskillaattori-)äänistä `repeatCount`
 * kertaa. KAIKKI toiston sävelet ajastetaan tässä etukäteen yhteen
 * `master`-solmuun (ei kutsu kutsua kohti) — pelkkä "älä ajasta seuraavaa
 * toistoa" ei riittäisi pysäytykseen, koska koko jono on jo ajastettu
 * ennen kuin funktio edes palaa. Pysäytys (ks. registerSession) siksi
 * mykistää `master`-solmun HETI sen sijaan että yrittäisi perua jo
 * ajastettuja `start`/`stop`-kutsuja yksitellen.
 */
async function playBuiltInSound(soundId: string, volume: number, repeatCount: number): Promise<void> {
  const ctx = sharedContext;
  if (!ctx) {
    throw new Error("Ääntä ei voi soittaa — selain ei tue Web Audio API:a");
  }
  if (ctx.state === "suspended") {
    await ctx.resume().catch(() => {});
  }
  if (ctx.state !== "running") {
    throw new Error("Ääni on estetty selaimessa — kosketa näyttöä ensin");
  }

  const master = ctx.createGain();
  master.gain.value = 1;
  master.connect(ctx.destination);

  let cursor = ctx.currentTime + 0.03;
  const clampedVolume = clampVolume(volume);
  for (let i = 0; i < Math.max(1, repeatCount); i += 1) {
    const took = scheduleOne(ctx, master, soundId, cursor, clampedVolume);
    cursor += took + REPEAT_GAP_S;
  }
  const totalMs = (cursor - ctx.currentTime) * 1000;

  const session = registerSession(() => {
    try {
      // Peruu kaikki jo ajastetut gain-arvot ja pudottaa äänen nollaan HETI —
      // tämä vaientaa kaikki master-solmun kautta kulkevat sävelet
      // riippumatta siitä montako niistä on vielä ajastettuna tulevaisuuteen.
      master.gain.cancelScheduledValues(ctx.currentTime);
      master.gain.setValueAtTime(0, ctx.currentTime);
    } catch {
      // Konteksti voi olla jo suljettu — disconnect alla riittää silti vaientamaan.
    }
    try {
      master.disconnect();
    } catch {
      // Jo irrotettu.
    }
  });

  // Luonnollinen loppu: vapautetaan istunto (ja irrotetaan solmu) kun
  // viimeinenkin etukäteen ajastettu sävel on soinut loppuun. session.stop()
  // on idempotentti, joten tämä on turvallinen kutsua vaikka joku on jo
  // pysäyttänyt äänen aiemmin — silloin tämä ei tee mitään ylimääräistä.
  window.setTimeout(() => session.stop(), totalMs + 200);
}

// --- Omat äänitiedostot: HTMLAudioElement ---

/**
 * Kuinka kauan odotetaan tiedoston latautumista ennen kuin luovutetaan —
 * kotiverkossa palvelimelta lataus on nopea, mutta esim. levy-yhteysongelma
 * ei saa jäädä jumittamaan hälytystä loputtomiin.
 */
const FILE_LOAD_TIMEOUT_MS = 8_000;

/**
 * Lataa <audio>-elementin annetusta URL:sta ja odottaa kunnes se on
 * soitettavissa. Hylätään joko 'error'-tapahtumasta (esim. 404, kadonnut
 * tiedosto) tai aikakatkaisusta — kumpikaan ei saa jäädä roikkumaan.
 */
function loadAudioElement(url: string): Promise<HTMLAudioElement> {
  return new Promise((resolve, reject) => {
    const audio = new Audio();
    let settled = false;

    const timer = window.setTimeout(() => settle(() => reject(new Error("Äänitiedoston lataus aikakatkaistiin"))), FILE_LOAD_TIMEOUT_MS);

    function cleanup(): void {
      window.clearTimeout(timer);
      audio.removeEventListener("canplay", onReady);
      audio.removeEventListener("error", onError);
    }
    function settle(action: () => void): void {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    }
    function onReady(): void {
      settle(() => resolve(audio));
    }
    function onError(): void {
      settle(() => reject(new Error("Äänitiedostoa ei löytynyt tai sitä ei voitu lukea")));
    }

    audio.addEventListener("canplay", onReady, { once: true });
    audio.addEventListener("error", onError, { once: true });
    audio.src = url;
    audio.load();
  });
}

/**
 * Yhden tiedostoäänen toiston tila muille tämän moduulin funktioille: onko
 * pysäytetty, ja mikä <audio>-elementti on juuri nyt käynnissä (jotta
 * `stop()` voi kutsua sen `pause()`ia synkronisesti). `stopped`-Promise
 * ratkeaa heti kun pysäytetään — sitä käytetään keskeyttämään mahdollinen
 * odotus (esim. toistojen välinen tauko) ilman että pitäisi odottaa koko
 * tauon loppuun asti.
 */
interface FileSession {
  isStopped(): boolean;
  bindAudio(audio: HTMLAudioElement): void;
  readonly stopped: Promise<void>;
}

function createFileSession(): { session: PlaybackSession; file: FileSession } {
  let stopped = false;
  let currentAudio: HTMLAudioElement | null = null;
  let resolveStopped: () => void = () => {};
  const stoppedPromise = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });

  const file: FileSession = {
    isStopped: () => stopped,
    bindAudio: (audio) => {
      currentAudio = audio;
    },
    stopped: stoppedPromise,
  };

  const session = registerSession(() => {
    stopped = true;
    if (currentAudio) {
      try {
        currentAudio.pause();
      } catch {
        // Ei kriittinen — audio jää joka tapauksessa soittamatta enää eteenpäin.
      }
    }
    resolveStopped();
  });

  return { session, file };
}

/**
 * Soittaa yhden oman äänitiedoston kerran loppuun asti — tai kunnes
 * `file.isStopped()` tulee todeksi. `HTMLAudioElement`ia koskee sama
 * selaimen autoplay-lukko kuin Web Audio -kontekstia (ks. unlockAudio) —
 * kioskiselain käynnistetään `--autoplay-policy=no-user-gesture-required`
 * -lipulla juuri tämän takia. Jos `play()` silti torjutaan JOSTAIN MUUSTA
 * syystä kuin siitä että joku juuri pysäytti äänen, se näkyy hylättynä
 * promisena eikä jää hiljaiseksi.
 */
async function playCustomFileOnce(soundId: string, volume: number, file: FileSession): Promise<void> {
  if (file.isStopped()) return;
  const url = `/api/alarm-sounds/${encodeURIComponent(soundId)}/file`;

  let audio: HTMLAudioElement;
  try {
    audio = await loadAudioElement(url);
  } catch (err) {
    if (file.isStopped()) return; // pysäytettiin latauksen aikana — ei virhe
    throw err;
  }
  if (file.isStopped()) return;
  file.bindAudio(audio);
  audio.volume = clampVolume(volume);

  try {
    await audio.play();
  } catch (err) {
    if (file.isStopped()) return; // play() keskeytyi koska joku pysäytti äänen — ei virhe
    throw err;
  }
  if (file.isStopped()) return; // ehdittiin pysäyttää juuri play():n ja tämän tarkistuksen välissä

  await new Promise<void>((resolve, reject) => {
    audio.addEventListener("ended", () => resolve(), { once: true });
    // stop() kutsuu audio.pause():a, joka laukaisee tämän — ilman tätä
    // odotus jäisi ikuisesti roikkumaan koska 'ended' ei tule pausatusta
    // äänestä.
    audio.addEventListener(
      "pause",
      () => {
        if (file.isStopped()) resolve();
      },
      { once: true },
    );
    audio.addEventListener(
      "error",
      () => {
        if (file.isStopped()) resolve();
        else reject(new Error("Äänitiedoston toisto keskeytyi"));
      },
      { once: true },
    );
  });
}

async function playCustomFileRepeated(soundId: string, volume: number, repeatCount: number, file: FileSession): Promise<void> {
  const count = Math.max(1, repeatCount);
  for (let i = 0; i < count; i += 1) {
    if (file.isStopped()) return;
    await playCustomFileOnce(soundId, volume, file);
    if (file.isStopped()) return;
    if (i < count - 1) {
      // Race stoppedin kanssa: pysäytys ei saa jäädä odottamaan tauon loppuun.
      await Promise.race([new Promise<void>((resolve) => window.setTimeout(resolve, REPEAT_GAP_S * 1000)), file.stopped]);
    }
  }
}

/**
 * Soittaa hälytysäänen `repeatCount` kertaa annetulla äänenvoimakkuudella —
 * joko sisäänrakennetun (Web Audio) tai perheen oman äänitiedoston. Vain
 * yksi ääni kerrallaan: uuden toiston aloitus pysäyttää automaattisesti
 * edellisen (ks. registerSession). Käynnissä oleva ääni voidaan aina
 * pysäyttää `stopAlarmSound()`:lla.
 *
 * KADONNUT ÄÄNITIEDOSTO EI SAA VAIENTAA HÄLYTYSTÄ: jos `soundId` viittaa
 * tiedostoon jota ei enää ole (poistettu, nimetty uudelleen) tai jonka
 * toisto muuten epäonnistuu, soitetaan sisäänrakennettu oletusääni sen
 * sijaan ja virhe silti heitetään eteenpäin — kutsuja (AlarmsPanel.vue,
 * useAlarms.ts) näyttää sen käyttäjälle `soundError`/`previewError`-kentässä.
 * Ääni siis kuuluu joka tapauksessa, mutta tilanne ei jää huomaamatta.
 * POIKKEUS: jos epäonnistuminen johtui siitä että käyttäjä itse pysäytti
 * äänen (`stopAlarmSound()`), ei soiteta oletusääntä eikä heitetä virhettä —
 * pysäytys ei ole vikatilanne.
 *
 * Jos sisäänrakennetun oletusäänenkin soitto epäonnistuu (esim. selain estää
 * äänen kokonaan), SE virhe kuuluu käyttäjälle — ei tiedosto-ongelma, koska
 * silloin syy on osuvampi ja toimenpide (kosketa näyttöä) eri.
 */
export async function playAlarmSound(soundId: string, volume: number, repeatCount: number): Promise<void> {
  unlockAudio();

  if (!isCustomSoundId(soundId)) {
    return playBuiltInSound(soundId, volume, repeatCount);
  }

  const { session, file } = createFileSession();
  try {
    await playCustomFileRepeated(soundId, volume, repeatCount, file);
  } catch (fileErr) {
    if (file.isStopped()) return; // käyttäjä pysäytti — ei varakäytäntöä eikä virhettä
    await playBuiltInSound(DEFAULT_SOUND_ID, volume, repeatCount);
    const detail = fileErr instanceof Error ? fileErr.message : "tuntematon virhe";
    throw new Error(`Äänitiedostoa ei voitu toistaa (${detail}) — soitettiin oletusääni sen sijaan`);
  } finally {
    // Vapauttaa istunnon nyt kun toisto on aidosti ohi (onnistuneesti,
    // pysäytettynä, tai varakäytännön jälkeen) — idempotentti, ei vaikuta
    // enää mihinkään jos joku (esim. varakäytäntö yllä) on jo ehtinyt
    // rekisteröidä uuden istunnon tämän tilalle.
    session.stop();
  }
}
