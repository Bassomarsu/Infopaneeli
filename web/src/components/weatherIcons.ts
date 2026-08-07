import { h, type VNode } from "vue";

/**
 * Small icon set the weather card and its hourly dialog render as inline SVG
 * — no external icon library involved. Pulled out of WeatherCard.vue so the
 * hourly dialog can draw the same icons without duplicating the SVG math.
 */
export type WeatherIcon = "clear" | "partly" | "cloudy" | "rain" | "snow" | "thunder" | "fog";

function svgIcon(children: VNode[]): VNode {
  return h(
    "svg",
    { viewBox: "0 0 24 24", fill: "none", "stroke-linecap": "round", "stroke-linejoin": "round" },
    children,
  );
}

const CLOUD_PATH = "M6.5 18.5a4 4 0 0 1-.4-7.98A5.5 5.5 0 0 1 16.9 8.6 4.5 4.5 0 0 1 16.5 18.5h-10Z";

function cloud(offsetY = 0): VNode {
  return h("path", {
    d: CLOUD_PATH,
    transform: offsetY ? `translate(0 ${offsetY})` : undefined,
    stroke: "currentColor",
    "stroke-width": 1.6,
    fill: "none",
  });
}

function sunRays(): VNode[] {
  return Array.from({ length: 8 }, (_, i) => {
    const angle = (i * Math.PI) / 4;
    return h("line", {
      x1: 12 + Math.cos(angle) * 8.5,
      y1: 12 + Math.sin(angle) * 8.5,
      x2: 12 + Math.cos(angle) * 11,
      y2: 12 + Math.sin(angle) * 11,
      stroke: "currentColor",
      "stroke-width": 1.6,
    });
  });
}

function rainDrops(y: number): VNode[] {
  return [7, 12, 17].map((x) =>
    h("line", { x1: x, y1: y, x2: x - 1.4, y2: y + 3.4, stroke: "currentColor", "stroke-width": 1.6 }),
  );
}

function snowDots(y: number): VNode[] {
  return [7, 12, 17].map((x) => h("circle", { cx: x, cy: y, r: 1.05, fill: "currentColor", stroke: "none" }));
}

const ICON_BUILDERS: Record<WeatherIcon, () => VNode> = {
  clear: () => svgIcon([h("circle", { cx: 12, cy: 12, r: 5.2, fill: "currentColor", stroke: "none" }), ...sunRays()]),
  partly: () =>
    svgIcon([h("circle", { cx: 8, cy: 7.5, r: 3.4, fill: "currentColor", stroke: "none" }), cloud(1.5)]),
  cloudy: () => svgIcon([cloud()]),
  fog: () => svgIcon([h("path", { d: "M5 9.5h14M4 13h16M6 16.5h12", stroke: "currentColor", "stroke-width": 1.6 })]),
  rain: () => svgIcon([cloud(-2), ...rainDrops(16.5)]),
  snow: () => svgIcon([cloud(-2), ...snowDots(17.5)]),
  thunder: () =>
    svgIcon([
      cloud(-3),
      h("path", { d: "M13 14.5 9.5 19h3l-1 3.5 4.5-5.5h-3z", fill: "currentColor", stroke: "none" }),
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
