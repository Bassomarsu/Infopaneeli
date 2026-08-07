/**
 * Asettaa EDIT_PINin ja FULL_PINin testiajoa varten ennen kuin config.ts
 * luetaan — sama ES-moduulien evaluointijärjestyksen kikka kuin
 * test-env.ts:ssä (ES-moduulit evaluoidaan riippuvuusjärjestyksessä, joten
 * tämän tiedoston sivuvaikutus ehtii ennen sitä importoivan tiedoston
 * myöhempiä tuonteja).
 *
 * FULL_PIN on tässä kuusimerkkinen (vähimmäispituus, ks. access.ts) ja
 * selvästi erilainen kuin EDIT_PIN, jotta testit eivät voi vahingossa
 * läpäistä väärän tason tarkistusta kahden arvon sattumalta täsmätessä.
 *
 * Oma tiedostonsa test-env.ts:n sijaan: se on yhteinen kaikille testeille
 * eikä sen ole syytä tuntea yksittäisen ominaisuuden ympäristömuuttujia.
 * Käytä `??=`, jotta joku toinen testiajo (esim. smoke-testi) voi asettaa
 * oman arvonsa ilman että tämä ylikirjoittaa sen.
 */
process.env.EDIT_PIN ??= "4242";
process.env.FULL_PIN ??= "424242";
