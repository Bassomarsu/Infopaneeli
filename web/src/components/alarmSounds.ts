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

/** Soittaa jonkin sisäänrakennetuista (oskillaattori-)äänistä `repeatCount` kertaa. */
async function playBuiltInSound(soundId: string, volume: number, repeatCount: number): Promise<void> {
  unlockAudio();
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
  const clampedVolume = Math.min(Math.max(volume, 0), 1);
  for (let i = 0; i < Math.max(1, repeatCount); i += 1) {
    const took = scheduleOne(ctx, master, soundId, cursor, clampedVolume);
    cursor += took + REPEAT_GAP_S;
  }

  // Master-solmu irrotetaan kun viimeinenkin sävel on soinut loppuun, jotta
  // se ei jää roikkumaan graafiin — pieni viive antaa "stop"-kutsuille aikaa.
  const totalMs = (cursor - ctx.currentTime) * 1000;
  window.setTimeout(() => master.disconnect(), totalMs + 200);
}

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
 * Soittaa yhden oman äänitiedoston kerran loppuun asti. `HTMLAudioElement`ia
 * koskee sama selaimen autoplay-lukko kuin Web Audio -kontekstia (ks.
 * unlockAudio) — kioskiselain käynnistetään
 * `--autoplay-policy=no-user-gesture-required`-lipulla juuri tämän takia,
 * mutta jos `play()` silti torjutaan, se näkyy hylättynä promisena eikä jää
 * hiljaiseksi.
 */
async function playCustomFileOnce(soundId: string, volume: number): Promise<void> {
  const url = `/api/alarm-sounds/${encodeURIComponent(soundId)}/file`;
  const audio = await loadAudioElement(url);
  audio.volume = Math.min(Math.max(volume, 0), 1);
  await audio.play();
  await new Promise<void>((resolve, reject) => {
    audio.addEventListener("ended", () => resolve(), { once: true });
    audio.addEventListener("error", () => reject(new Error("Äänitiedoston toisto keskeytyi")), { once: true });
  });
}

async function playCustomFileRepeated(soundId: string, volume: number, repeatCount: number): Promise<void> {
  const count = Math.max(1, repeatCount);
  for (let i = 0; i < count; i += 1) {
    await playCustomFileOnce(soundId, volume);
    if (i < count - 1) {
      await new Promise((resolve) => window.setTimeout(resolve, REPEAT_GAP_S * 1000));
    }
  }
}

/**
 * Soittaa hälytysäänen `repeatCount` kertaa annetulla äänenvoimakkuudella —
 * joko sisäänrakennetun (Web Audio) tai perheen oman äänitiedoston.
 *
 * KADONNUT ÄÄNITIEDOSTO EI SAA VAIENTAA HÄLYTYSTÄ: jos `soundId` viittaa
 * tiedostoon jota ei enää ole (poistettu, nimetty uudelleen) tai jonka
 * toisto muuten epäonnistuu, soitetaan sisäänrakennettu oletusääni sen
 * sijaan ja virhe silti heitetään eteenpäin — kutsuja (AlarmsPanel.vue,
 * useAlarms.ts) näyttää sen käyttäjälle `soundError`/`previewError`-kentässä.
 * Ääni siis kuuluu joka tapauksessa, mutta tilanne ei jää huomaamatta.
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

  try {
    await playCustomFileRepeated(soundId, volume, repeatCount);
  } catch (fileErr) {
    await playBuiltInSound(DEFAULT_SOUND_ID, volume, repeatCount);
    const detail = fileErr instanceof Error ? fileErr.message : "tuntematon virhe";
    throw new Error(`Äänitiedostoa ei voitu toistaa (${detail}) — soitettiin oletusääni sen sijaan`);
  }
}
