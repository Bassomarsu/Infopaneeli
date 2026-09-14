# Ruokalistan ja nimipäivien lähteet

Tarkistettu 13.9.2026.

## Ruokalista

Kortti näyttää asetuksista valittujen koulujen ateriat. Lähde on [kouluruoka.fi](https://kouluruoka.fi/). Ruokalistan hammasrattaan **Ruokalistan koulut** -kohdassa haetaan koulua tai kuntaa ja valitaan enintään kahdeksan listaa. Samalla listalla oleville sisaruksille riittää yksi valinta. Tyhjä valinta ei hae mitään. Version 0.4.0 Karstula-oletus säilyy, kunnes käyttäjä muuttaa sitä.
Sivun oma julkinen Gatsby-aineisto on `https://kouluruoka.fi/page-data/menu/karstula_koulut/page-data.json`; seuraava viikko on saman polun `2/page-data.json`.
Kouluhakemisto luetaan etusivun page-data/index/page-data.json-tiedoston ilmoittamista staticQueryHashes-kyselyistä. Hash-numeroita ei ole kiinnitetty koodiin. Hakemisto sisältää koulun nimen, kunnan ja lähteen tunnisteen; 13.9.2026 siinä oli 1361 eri listaa. Koulujen viikkopolussa Karstulan tunniste korvataan valitun koulun tunnisteella.

Karstulan molemmat viikkopolut palauttivat HTTP 200 tarkistuksessa. Karstulan julkinen paikkaluettelo sisälsi vain `karstula_koulut`; päiväkotien kattavuutta ei voitu varmistaa. Koulujen aamiaista ei tulkita päiväkodin listaksi.

Palvelin hakee listan neljän tunnin välein ja käyttää samaa pysyvää välimuistia ja virhetilaa kuin muut tietolähteet. Seuraavan viikon 404 tarkoittaa julkaisematonta viikkoa. Verkkovirhe tai muuttunut rakenne säilyttää saman koulun aiemman listan vanhentunut-merkinnällä. Yhden koulun katko ei peitä muita kouluja. Koulun vaihtuessa poistettu koulu katoaa heti, ja kesken olevan haun jälkeen haetaan uusin valinta. Vanhat päivät eivät näyttäydy tämän päivän aterioina. Vuosi ratkaistaan lähteen viikon alusta, myös vuodenvaihteessa. Kortin linkki avataan vain käyttöliittymän salliessa ulkoiset linkit.

## Nimipäivät

Mukana tulee **vuoden 2000 suomenkielinen nimipäiväkalenteri**: 751 nimeä 362 päivälle. Tämä ei ole nykyinen virallinen nimipäiväkalenteri; vuoden 2000 jälkeen lisätyt nimet puuttuvat. Kortti kertoo kalenterin vuoden. Tieto toimii ilman verkkoyhteyttä.

Lähde: [fergusq/nimipaivat](https://github.com/fergusq/nimipaivat/tree/53b17371022631140abdd560f85e0800fda415d6/2000), tiedosto `2000/txt/namedays-fi.txt`, commit `53b17371022631140abdd560f85e0800fda415d6` (6.12.2017).
Alkuperäisen tekstitiedoston SHA-256: `dd68a23474bbd9e93fd82f1515d38a76fb7c5764016d99126703a59ab472005d`.
`server/src/data/namedays-2000.json` on muunnettu kyseisistä nimi–päivämääräriveistä muotoon `MM-DD: [nimet]`, ilman nimien lisäyksiä tai päivämäärien muutoksia.

[Lähteen README](https://github.com/fergusq/nimipaivat/blob/53b17371022631140abdd560f85e0800fda415d6/README.md) ilmoittaa näiden historiallisten luetteloiden 15 vuoden luettelosuojan rauenneen ja sallii niiden vapaan kopioinnin. README:n MIT-lisenssi koskee muunnosskriptejä, ei nimipäiväaineistoa. Tähän projektiin ei ole kopioitu lähteen skriptejä. Uudempaa yliopiston kalenteria ei ole kopioitu: [virallinen nimipäivärajapinta](https://almanakka.helsinki.fi/en/name-days/name-day-interface) vaatii erikseen hankittavan käyttöavaimen.

Päivämäärät vaihtuvat Europe/Helsinki-aikavyöhykkeellä. Huominen lasketaan kalenteripäivinä, joten vuodenvaihde ja kesäaika eivät muuta hakua. Päivällä ilman nimeä näytetään tyhjä nimilista; nimiä ei arvata.
