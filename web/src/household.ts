import { useEditAccess } from "./composables/useEditAccess.ts";
export interface Waste { id: string; label: string; date: string; intervalWeeks: number; nextDate: string }
export interface Shopping { id: string; text: string; done: boolean }
export interface Seasonal { id: string; label: string; date: string; annual: boolean; completedDate: string | null; occurrenceDate: string; done: boolean }
export interface HouseholdData { waste: Waste[]; shopping: Shopping[]; seasonal: Seasonal[]; anniversaries: Seasonal[] }
export async function mutateHousehold(kind: keyof HouseholdData, method: "POST" | "PATCH" | "DELETE", body?: Record<string, unknown>, id?: string): Promise<void> {
 const response = await useEditAccess().editFetch('/api/household/' + kind + (id ? '/' + encodeURIComponent(id) : ''), { method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
 if (!response.ok) { const payload = await response.json().catch(() => null); throw new Error(response.status === 401 || response.status === 403 ? 'Muokkaus vaatii PIN-koodin' : payload?.error ?? 'Tallennus epäonnistui'); }
}
export function dateLabel(date: string): string { return new Intl.DateTimeFormat('fi-FI', {day:'numeric',month:'numeric',year:'numeric',timeZone:'Europe/Helsinki'}).format(new Date(date + 'T12:00:00Z')); }
