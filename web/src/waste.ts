export interface WasteCompany { id: string; name: string; municipalities: string[]; website: string; adapter: 'vingo' | 'manual' }
export interface WasteData { companyName: string; events: { id: string; label: string; date: string }[]; sourceUrl: string; configured: boolean; enabled: boolean }
export interface WasteConfig { companyId: string; municipality: string; address: string; propertyId: string; configured: boolean; enabled: boolean; blocked: boolean }
export interface WasteProperty { id: string; address: string }
export function safeWasteUrl(value?: string): string | undefined {
  try { const url = new URL(value ?? ''); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
}
