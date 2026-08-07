/**
 * Asettaa EDIT_PINin kelvolliseksi mutta FULL_PINin liian LYHYEKSI (alle
 * kuusi merkkiä, ks. access.ts:n FULL_PIN_MIN_LENGTH) ennen kuin config.ts
 * luetaan — sama ES-moduulien evaluointijärjestyksen kikka kuin
 * edit-pin-test-env.ts:ssä. Tarkoituksella eri arvo kuin muissa
 * env-tiedostoissa käytetty EDIT_PIN, jotta testi ei voi vahingossa
 * läpäistä sattumalta täsmäävän arvon takia.
 */
process.env.EDIT_PIN ??= "1357";
process.env.FULL_PIN ??= "123"; // alle kuusi merkkiä — pitää jäädä pois käytöstä
