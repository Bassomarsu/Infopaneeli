/**
 * Hälytysäänet tuotetaan Web Audio API:lla (oskillaattoreilla) eikä
 * äänitiedostoilla: ei uusia riippuvuuksia, ei binäärejä repoon, ja ääni
 * toimii ilman verkkoa. `soundId` on silti pelkkä tunniste (ei suoraan
 * funktioviittaus), jotta oma äänitiedosto voidaan joskus lisätä samaan
 * kenttään — ks. kommentti types.ts:n Alarm-tyypissä.
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

/**
 * Soittaa hälytysäänen `repeatCount` kertaa annetulla äänenvoimakkuudella.
 * Heittää virheen jos ääntä ei (vielä) voi soittaa — kutsujan (AlarmsPanel,
 * useAlarms) tehtävä on näyttää tämä käyttäjälle, ei jättää epäonnistumista
 * hiljaiseksi.
 */
export async function playAlarmSound(soundId: string, volume: number, repeatCount: number): Promise<void> {
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
