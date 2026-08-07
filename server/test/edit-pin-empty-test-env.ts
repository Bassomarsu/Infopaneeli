/**
 * Pakottaa sekä EDIT_PINin että FULL_PINin tyhjäksi ennen kuin config.ts
 * luetaan — ks. edit-pin-test-env.ts:n kommentti samasta ES-moduulien
 * evaluointijärjestyksen kikasta. Tavallinen `process.env.EDIT_PIN = ""`
 * importien VÄLISSÄ ei toimisi: importit evaluoituvat aina ennen
 * importoivan tiedoston muuta koodia riippumatta niiden sijainnista
 * lähdekoodissa, joten sivuvaikutus täytyy olla toisen, ensin importoitavan
 * moduulin rungossa. FULL_PIN asetetaan tässä eksplisiittisesti tyhjäksi
 * (ei vain jätetä asettamatta) jotta testi ei riipu siitä ettei kukaan
 * muu ole asettanut sitä ympäristöön.
 */
process.env.EDIT_PIN = "";
process.env.FULL_PIN = "";
