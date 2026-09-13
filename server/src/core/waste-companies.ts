import fs from "node:fs";

export interface WasteCompany {
  id: string;
  name: string;
  municipalities: string[];
  website: string;
  adapter: "vingo" | "manual";
  baseUrl?: string;
}
interface Directory { sourceUrl: string; checkedAt: string; companies: WasteCompany[] }
const directory = JSON.parse(fs.readFileSync(new URL("../data/waste-companies.json", import.meta.url), "utf8")) as Directory;

/** Municipality membership is a suggestion, not proof of the property's collection company. */
export function getWasteCompanies(): WasteCompany[] {
  return directory.companies.map(company => ({ ...company, municipalities: [...company.municipalities] }));
}

export function findWasteCompany(id: string): WasteCompany | undefined {
  return getWasteCompanies().find(company => company.id === id);
}

export function wasteCompaniesForMunicipality(municipality: string): WasteCompany[] {
  const normalized = municipality.trim().normalize("NFC").toLocaleLowerCase("fi");
  return getWasteCompanies().filter(company => company.municipalities.some(name => name.toLocaleLowerCase("fi") === normalized));
}
