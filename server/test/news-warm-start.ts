/**
 * Uutiskortti ei saa väittää verkkovikaa pelkän lämpimän käynnistyksen takia.
 *
 * ERILLINEN TESTI JA ERILLINEN MUUTOS. Tämä vika löytyi sääkortin sijainti-
 * korjauksen yhteydessä (18.9.2026) eikä se ole sen osa: `projectNewsSnapshot`
 * kuvasi `stale`n suoraan `failed`iksi, ja `Provider` asettaa `stale`n myös
 * silloin kun se vain lämmittelee levyvälimuistista eikä mitään ole
 * yritettykään. Jos tallennettu aihealuevalinta ei täsmännyt välimuistin
 * valintaan, kortti näytti käynnistyksen jälkeen punaista
 * "EI YHTEYTTÄ · Lähde ei vastaa" siihen asti että ensimmäinen haku valmistui.
 *
 * Erottelu on `error`: se asetetaan vain oikeassa epäonnistumisessa.
 * Sääkortin oma testi (weather-location-refresh.ts) mittaa saman sen omalla
 * puolella; nämä ovat tahallaan eri tiedostoissa, koska ne ovat eri muutoksia.
 *
 * Aja:  npm run test:news-warm-start --workspace=server
 */
import "./test-env.ts";
import assert from "node:assert/strict";
import type { ProviderSnapshot } from "../src/core/provider.ts";
import { writeCache } from "../src/core/store.ts";
import { updateSettings } from "../src/core/settings.ts";
import { createNewsProvider, projectNewsSnapshot } from "../src/providers/news.ts";

const VANHA = { items: [], categories: ["paauutiset"] };

function snapshotOf(status: ProviderSnapshot["status"], error: ProviderSnapshot["error"]): ProviderSnapshot<unknown> {
  return { id: "news", status, data: VANHA, fetchedAt: "2026-09-18T05:00:00.000Z", error };
}

// Valinta on eri kuin välimuistissa, joten suodatus koskee kaikkia alla.
updateSettings({ newsCategories: ["kotimaa"] });

// LÄMMIN KÄYNNISTYS EI OLE VERKKOVIKA — luettuna oikealta providerilta, jotta
// testi nojaa Providerin todelliseen käyttäytymiseen eikä oletukseen siitä.
{
  writeCache("news", VANHA, "2026-09-18T05:00:00.000Z");
  const provider = createNewsProvider();
  const lammin = provider.snapshot();
  assert.equal(lammin.status, "stale", "Provider lämmittelee välimuistista tilaan stale");
  assert.equal(lammin.error, null, "lämmin käynnistys ei aseta virhettä — tämä on erotteleva signaali");

  const nakyy = projectNewsSnapshot(lammin);
  assert.equal(nakyy.data, null, "vanhan valinnan otsikoita ei esitetä uuden valinnan tuloksena");
  assert.equal(nakyy.fetchedAt, null);
  assert.equal(nakyy.status, "idle", "lämmin käynnistys ei saa näyttää EI YHTEYTTÄ -virhettä");
  provider.stop();
}

// ...eikä korjaus saa niellä oikeaa vikaa.
{
  const virhe = { type: "Error", message: "Ylen uutissyötteen haku epäonnistui (HTTP 503)" };
  for (const status of ["stale", "failed"] as const) {
    const out = projectNewsSnapshot(snapshotOf(status, virhe));
    assert.equal(out.data, null);
    assert.equal(out.status, "failed", `${status} + virhe: oikea verkkovika näkyy yhä virheenä`);
    assert.deepEqual(out.error, virhe, "virheteksti on kortin ainoa selitys");
  }
}

// Kylmä käynnistys ilman välimuistia: dataa ei ole, joten suodatettavaa ei ole
// eikä tilannekuvaan kosketa.
{
  const tyhja: ProviderSnapshot<unknown> = { id: "news", status: "idle", data: null, fetchedAt: null, error: null };
  assert.equal(projectNewsSnapshot(tyhja), tyhja);
}

console.log("News warm start: lämmin käynnistys on Haetaan… eikä EI YHTEYTTÄ, oikea vika näkyy yhä passed");
