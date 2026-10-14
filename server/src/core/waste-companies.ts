import fs from "node:fs";

export interface WasteCompany {
  id: string;
  name: string;
  municipalities: string[];
  website: string;
  /** vingo = vanha Vingo-asiointi (Puhas, Etappi), vingo2 = Vingo 2.0 -portaali (Sammakkokangas). */
  adapter: "vingo" | "vingo2" | "manual";
  baseUrl?: string;
  /** Vingo 2.0: rajapinnan osoite ja asiakastunniste portaalin ajonaikaisesta konfiguraatiosta. */
  apiUrl?: string;
  tenantId?: string;
}
interface Directory { sourceUrl: string; checkedAt: string; companies: WasteCompany[] }
const directory = JSON.parse(fs.readFileSync(new URL("../data/waste-companies.json", import.meta.url), "utf8")) as Directory;

/** Municipality membership is a suggestion, not proof of the property's collection company. */
export function getWasteCompanies(): WasteCompany[] {
  return directory.companies.map(company => ({ ...company, municipalities: [...company.municipalities] }));
}

/** Yhtiöllä on automaattinen kirjautuva liitäntä (toisin kuin käsin asetettava). */
export function hasWasteAdapter(company: WasteCompany | undefined): boolean {
  return company?.adapter === "vingo" || company?.adapter === "vingo2";
}

export function findWasteCompany(id: string): WasteCompany | undefined {
  return getWasteCompanies().find(company => company.id === id);
}

export function wasteCompaniesForMunicipality(municipality: string): WasteCompany[] {
  const normalized = municipality.trim().normalize("NFC").toLocaleLowerCase("fi");
  return getWasteCompanies().filter(company => company.municipalities.some(name => name.toLocaleLowerCase("fi") === normalized));
}
