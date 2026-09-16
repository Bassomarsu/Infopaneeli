import fs from "node:fs";
import { localDateKey, shiftDateKey } from "./time.ts";

export const NAMEDAY_SOURCE_URL = "https://github.com/fergusq/nimipaivat/tree/53b17371022631140abdd560f85e0800fda415d6/2000";
export interface NamedayDay { date: string; names: string[] }
export interface NamedayData { today: NamedayDay; tomorrow: NamedayDay; calendarYear: number; sourceUrl: string }
let table: Record<string, string[]> | undefined;
export function namesForDate(date: string): string[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw new Error("Virheellinen nimipäivän päivämäärä");
  table ??= JSON.parse(fs.readFileSync(new URL("../data/namedays-2000.json", import.meta.url), "utf8")) as Record<string, string[]>;
  // Kaksoiskappale siivotaan LUKUVAIHEESSA eikä datatiedostosta: lähteessä
  // 15.7. on "Rauna, Rauni, Rauni", ja namedays-2000.json on todennettu
  // alkuperäistä tekstitiedostoa vasten SHA-256:lla (ks. docs/widget-sources.md).
  // Tiedoston korjaaminen rikkoisi sen todennuksen yhden näyttövirheen takia.
  // `Set` säilyttää lisäysjärjestyksen, joten nimien järjestys ei muutu.
  return [...new Set(table[date.slice(5)] ?? [])];
}
export function getNamedays(now = new Date()): NamedayData {
  const today = localDateKey(now);
  const tomorrow = shiftDateKey(today, 1);
  return { today: { date: today, names: namesForDate(today) }, tomorrow: { date: tomorrow, names: namesForDate(tomorrow) }, calendarYear: 2000, sourceUrl: NAMEDAY_SOURCE_URL };
}
