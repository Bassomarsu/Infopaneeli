export interface WasteCompany { id: string; name: string; municipalities: string[]; website: string; adapter: 'vingo' | 'manual' }
export interface WasteData { companyName: string; events: { id: string; label: string; date: string }[]; sourceUrl: string; configured: boolean; enabled: boolean }
export interface WasteConfig { companyId: string; municipality: string; address: string; propertyId: string; configured: boolean; enabled: boolean; blocked: boolean; blockedForSeconds: number; keyMissing: boolean }
export interface WasteProperty { id: string; address: string }
/**
 * Palvelimen oma viesti on aina paras saatavilla oleva selitys: vain se tietää oliko
 * kyse yhtiön huoltokatkosta, verkosta vai oikeasti hylätyistä tunnuksista. Aiemmin
 * tämä kerros heitti kaiken pois ja sanoi "tarkista yhteys ja tunnukset" myös
 * huoltokatkossa — ja juuri se kehotus saa käyttäjän kokeilemaan salasanoja, kunnes
 * jätehuoltotili lukkiutuu. Varatekstit eivät siksi mainitse tunnuksia lainkaan:
 * niihin päädytään vain kun palvelin ei kerro mitään (yhteys katkesi kesken pyynnön,
 * vastaus ei ollut JSONia, tai välissä oleva palvelin vastasi omalla sivullaan).
 */
export function wasteRequestError(status: number, body: unknown): string {
  const message = (body as { error?: unknown } | null | undefined)?.error;
  if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 300);
  if (status === 403) return 'Tarvitset täyden käyttöoikeuden jätehuollon yhteyden asetuksiin.';
  if (status === 429) return 'Pyyntöjä tehtiin liian tiheästi. Odota hetki ennen uutta yritystä.';
  return 'Jätehuollon pyyntö epäonnistui (HTTP ' + status + '). Yritä myöhemmin uudelleen.';
}
/**
 * Lukitustilan teksti. Kertoo ENSIN milloin yritys onnistuu itsestään ja vasta sitten
 * tunnusten syöttämisestä, koska odottaminen ei kuluta yhtään kirjautumisyritystä ja
 * uuden salasanan arvaaminen kuluttaa. `secondsLeft <= 0` tarkoittaa että jäähdytys
 * on ohi ja "Hae kiinteistöt" toimii taas ilman mitään käyttäjän toimenpidettä.
 */
export function wasteBlockedNotice(secondsLeft: number): string {
  const tail = ' Jos tunnukset ovat muuttuneet, syötä ne uudelleen ja tallenna yhteys.';
  if (secondsLeft <= 0) return 'Jätehuolto hylkäsi tunnukset viimeksi. Voit hakea kiinteistöt uudelleen nyt.' + tail;
  return 'Jätehuolto hylkäsi tunnukset viimeksi, joten kirjautumista ei toisteta heti. Uusi yritys on mahdollinen ' + Math.ceil(secondsLeft / 60) + ' min kuluttua.' + tail;
}
export function safeWasteUrl(value?: string): string | undefined {
  try { const url = new URL(value ?? ''); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
}
