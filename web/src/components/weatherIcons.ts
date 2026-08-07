import { h, type VNode } from "vue";

/**
 * Small icon set the weather card and its hourly dialog render as inline SVG
 * — no external icon library involved. Pulled out of WeatherCard.vue so the
 * hourly dialog can draw the same icons without duplicating the SVG math.
 */
export type WeatherIcon = "clear" | "partly" | "cloudy" | "rain" | "snow" | "thunder" | "fog";

/**
 * Yksi sääikoni voi koostua useasta osasta (esim. aurinko + pilvi), ja kukin
 * osa saa oman värinsä sen sijaan että koko ikoni perii yhden currentColor-
 * värin — näin esim. "partly" erottaa auringon ja pilven toisistaan myös
 * väriltään, ei vain muodoltaan. Sävyt on valittu tummaa taustaa vasten:
 * riittävän kirkkaita erottuakseen, mutta ei niin kylläisiä että kortti
 * muuttuu meluisaksi muiden korttien rinnalla.
 */
const SUN = "#ffce54"; // lämmin kultainen aurinko
const CLOUD = "#aab7cc"; // vaalea sinertävänharmaa pilvi (kirkas sää / puolipilvinen)
const CLOUD_STORM = "#8892a8"; // tummempi, "raskaampi" pilvi sade/lumi/ukkos-ikoneissa
const RAIN = "#5ec8f2"; // sininen sadepisara
const SNOW = "#eaf4ff"; // jäisenvalkoinen lumihiutale
const BOLT = "#ffb454"; // oranssinkeltainen salama
const FOG = "#c3ccd9"; // vaalea, utuinen harmaa

function svgIcon(children: VNode[]): VNode {
  return h(
    "svg",
    { viewBox: "0 0 24 24", fill: "none", "stroke-linecap": "round", "stroke-linejoin": "round" },
    children,
  );
}

const CLOUD_PATH = "M6.5 18.5a4 4 0 0 1-.4-7.98A5.5 5.5 0 0 1 16.9 8.6 4.5 4.5 0 0 1 16.5 18.5h-10Z";

function cloud(color: string, offsetY = 0): VNode {
  return h("path", {
    d: CLOUD_PATH,
    transform: offsetY ? `translate(0 ${offsetY})` : undefined,
    stroke: color,
    "stroke-width": 1.6,
    fill: "none",
  });
}

function sunRays(color: string): VNode[] {
  return Array.from({ length: 8 }, (_, i) => {
    const angle = (i * Math.PI) / 4;
    return h("line", {
      x1: 12 + Math.cos(angle) * 8.5,
      y1: 12 + Math.sin(angle) * 8.5,
      x2: 12 + Math.cos(angle) * 11,
      y2: 12 + Math.sin(angle) * 11,
      stroke: color,
      "stroke-width": 1.6,
    });
  });
}

function rainDrops(y: number, color: string): VNode[] {
  return [7, 12, 17].map((x) =>
    h("line", { x1: x, y1: y, x2: x - 1.4, y2: y + 3.4, stroke: color, "stroke-width": 1.6 }),
  );
}

function snowDots(y: number, color: string): VNode[] {
  return [7, 12, 17].map((x) => h("circle", { cx: x, cy: y, r: 1.05, fill: color, stroke: "none" }));
}

const ICON_BUILDERS: Record<WeatherIcon, () => VNode> = {
  clear: () => svgIcon([h("circle", { cx: 12, cy: 12, r: 5.2, fill: SUN, stroke: "none" }), ...sunRays(SUN)]),
  partly: () =>
    svgIcon([h("circle", { cx: 8, cy: 7.5, r: 3.4, fill: SUN, stroke: "none" }), cloud(CLOUD, 1.5)]),
  cloudy: () => svgIcon([cloud(CLOUD)]),
  fog: () => svgIcon([h("path", { d: "M5 9.5h14M4 13h16M6 16.5h12", stroke: FOG, "stroke-width": 1.6 })]),
  rain: () => svgIcon([cloud(CLOUD_STORM, -2), ...rainDrops(16.5, RAIN)]),
  snow: () => svgIcon([cloud(CLOUD_STORM, -2), ...snowDots(17.5, SNOW)]),
  thunder: () =>
    svgIcon([
      cloud(CLOUD_STORM, -3),
      h("path", { d: "M13 14.5 9.5 19h3l-1 3.5 4.5-5.5h-3z", fill: BOLT, stroke: "none" }),
    ]),
};

/**
 * Accepts a plain string rather than the `WeatherIcon` union because the
 * shared `WeatherHour` contract in `../types` types `condition.icon` as
 * `string` (it crosses the server/client boundary as JSON). An unknown value
 * — including old cached data — falls back to a plain cloudy icon instead of
 * throwing.
 */
export function iconFor(icon: string): VNode {
  const builder = ICON_BUILDERS[icon as WeatherIcon];
  return (builder ?? ICON_BUILDERS.cloudy)();
}
