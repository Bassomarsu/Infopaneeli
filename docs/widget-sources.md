# Ruokalistan ja nimipäivien lähteet

Tarkistettu 13.9.2026. Ruokalistan osalta tarkistettu uudelleen 16.9.2026, kun lähteen osoite vaihtui.

## Ruokalista

Kortti näyttää asetuksista valittujen koulujen ateriat. Lähde on [kouluruoka.fi](https://kouluruoka.fi/). Ruokalistan hammasrattaan **Ruokalistan koulut** -kohdassa haetaan koulua tai kuntaa ja valitaan enintään kahdeksan listaa. Samalla listalla oleville sisaruksille riittää yksi valinta. Tyhjä valinta ei hae mitään. Version 0.4.0 Karstula-oletus säilyy, kunnes käyttäjä muuttaa sitä.
Ruokalista luetaan itse ruokalistasivulta `https://kouluruoka.fi/menu/karstula_koulut/`; seuraava viikko on saman polun `2/`. Sivun sisällä JSON on elementissä `<script id="gatsby-inlined-page-data">`, ja palvelin kaivaa sen sieltä.

**Osoite vaihtui 16.9.2026.** Aiemmin luettiin sivuston Gatsby-aineistoa `https://kouluruoka.fi/page-data/menu/karstula_koulut/page-data.json`. Se vastaa nyt HTTP 404:llä ja palauttaa 7,5 kt HTML:ää; sama JSON löytyy edellä kuvatusta upotuksesta täsmälleen samalla rakenteella (`result.pageContext.menu`), joten jäsennintä ei tarvinnut muuttaa. Seuraavan viikon polku `2/` on luettu sivuston omasta ruokalistapohjasta, jossa "Ensi viikko" -painike siirtyy osoitteeseen `/menu/<tunniste>/2/` — sitä ei siis arvattu. 16.9.2026 tuo polku vastasi 404:llä, koska seuraavaa viikkoa ei ollut vielä julkaistu; se on tavallinen tilanne kesken viikon eikä virhe.
Kouluhakemisto luetaan etusivun page-data/index/page-data.json-tiedoston ilmoittamista staticQueryHashes-kyselyistä. Hash-numeroita ei ole kiinnitetty koodiin. Hakemisto sisältää koulun nimen, kunnan ja lähteen tunnisteen; 13.9.2026 siinä oli 1361 eri listaa. Koulujen viikkopolussa Karstulan tunniste korvataan valitun koulun tunnisteella.

Karstulan julkinen paikkaluettelo sisälsi vain `karstula_koulut`; päiväkotien kattavuutta ei voitu varmistaa. Koulujen aamiaista ei tulkita päiväkodin listaksi.

### Käyttöehdot ja se, mihin tämä lähde perustuu

Tämä arvio on tehty 16.9.2026 samalla tarkkuudella kuin Ylen RSS-syötteen ehdot (ks. `server/src/providers/news.ts` -tiedoston alku), ja se kirjataan tähän jotta seuraava lukija tietää millä pohjalla lähdettä käytetään.

- **Käyttöehtosivua ei ole.** Sivuston ainoat tietosivut ovat [Tietoa palvelusta](https://kouluruoka.fi/info/) ja [Tietosuoja](https://kouluruoka.fi/tietosuoja/). Kumpikaan ei ota kantaa ruokalistatietojen käyttöön, kopiointiin, uudelleenjulkaisuun eikä automaattiseen hakemiseen. **Tekijänoikeussivua ei myöskään ole**, eikä sivuilla ole tekijänoikeusmerkintää. Lupaa käyttöön ei siis ole annettu — mutta sitä ei ole myöskään evätty, toisin kuin Ylellä, jonka ehdot on kirjoitettu auki ja joita siksi noudatetaan kirjaimellisesti.
- **robots.txt sallii kaiken**: `User-agent: *` ja `Allow: /`, ei yhtään `Disallow`-riviä eikä `crawl-delay`ia. Automaattista hakemista ei siis ole teknisesti kielletty.
- **Palvelu on mainosrahoitteinen**: ruokalistasivu lataa Googlen mainostagin (`securepubads.g.doubleclick.net/tag/js/gpt.js`) ja sisältää mainospaikkoja. Tämä näyttö ei renderöi mainoksia. Se on rehellistä sanoa ääneen: haemme sisällön, emme sitä mikä sen maksaa.
- **Julkaisija on Btor Oy** (ilmoitettu Tietoa palvelusta -sivulla). Ruokalistat ovat alun perin kuntien julkista tietoa, mutta niiden kokoaminen ja esitystapa ovat palvelun omia.
- **Käytetty polku oli sivuston sisäinen koontiartefakti, ei luvattu rajapinta.** Gatsbyn `page-data`-tiedostot ovat sivugeneraattorin tuotos, joita ei ole dokumentoitu eikä versioitu ulkopuolisille. Tämä ei ole teoreettinen varaus: juuri se osoittautui todeksi 16.9.2026, kun polku katosi ilman ilmoitusta. Nykyinen upotettu `gatsby-inlined-page-data` on täsmälleen yhtä epävirallinen ja voi kadota samalla tavalla.

### Miksi vanha polku katosi — ja mitä se ennustaa

Selvitetty 16.9.2026 mittaamalla, ei arvaamalla:

- `page-data.json` vastaa **HTTP 200:lla** tavallisilla sivuilla (`/index/`, `/info/`, `/tietosuoja/` — kukin 136–148 tavua) ja **404:llä jokaisella ruokalistasivulla**, sekä Karstulan että Oulun normaalikoulun kohdalla. Katosi siis yhden sivupohjan aineisto, ei `page-data`-polku.
- Sivuston oma JS-nippu rakentaa Gatsbyn lataajan muodossa `new ProdLoader(asyncRequires, matchPaths, window.pageData)`. Upotettu sivuaineisto on siis Gatsbyn oma ominaisuus, ei käsintehty kiertotie.
- `ETag` ja `Last-Modified` ovat **identtiset** kaikilla osoitteilla (HTML ja JSON), arvona viimeisin koonti — 16.9.2026 klo 01:14 UTC. Sivusto siis koostetaan kokonaan uudelleen joka yö, ja ruokalistasivuja on noin 1361 koulua × 2 viikkoa ≈ 2700.

**Tämä ei näytä tietoiselta sulkemiselta.** Aineisto on yhä sivussa sellaisenaan: ei tunnistetta, ei kutsurajaa, ei obfuskointia, ei 403:a, eikä `robots.txt`iin ilmestynyt yhtään `Disallow`-riviä. Rajapintaa ei suojattu vaan siirrettiin — ja ~2700 erillisen `page-data.json`-tiedoston jättäminen pois joka yön koonnista on ymmärrettävä koonti- ja kokosäästö, kun sama JSON on jo jokaisen sivun sisällä.

**Yksi konkreettinen varoitusmerkki silti on.** Nipun reittitaulussa on uusi `/dmenu/`-perhe, mukaan lukien asiakaspään reitti `/dmenu/[restaurantId]`. Se on kesken: mukana on vain Kaskinen ja Tornio, eli 2 koulua 1361:stä, ja `/dmenu/karstula_koulut/` vastaa 404:llä. Jos tuo siirtymä viedään loppuun, ruokalistat voivat muuttua asiakaspäässä renderöitäviksi — jolloin **myös upotettu aineisto katoaa** eikä HTML:ssä ole enää ruokalistaa lainkaan. Se on todennäköisin tapa, jolla tämä lähde seuraavaksi hajoaa, ja se hajoaisi näkyvästi: provideri epäonnistuu eikä näytä väärää listaa.

Käytännön seuraus on sama kuin Ylellä: **lähde voi loppua milloin tahansa ilman ilmoitusta**, ja provideri kestää sen kuten minkä tahansa katkoksen — vanha lista jää näkyviin vanhentunut-merkinnällä ja katkaisija hidastaa yritykset. Kuormaa pidetään pienenä: haku on neljän tunnin välein ja enintään kaksi pyyntöä per koulu per kierros. Jos lähde joskus julkaisee käyttöehdot, ne on luettava ja tämä kohta päivitettävä ennen seuraavaa muutosta.

Palvelin hakee listan neljän tunnin välein ja käyttää samaa pysyvää välimuistia ja virhetilaa kuin muut tietolähteet. Seuraavan viikon 404 tarkoittaa julkaisematonta viikkoa. Verkkovirhe tai muuttunut rakenne säilyttää saman koulun aiemman listan vanhentunut-merkinnällä. Yhden koulun katko ei peitä muita kouluja. Kun **jokainen** valittu koulu epäonnistuu, virhe nousee providerille asti: vasta silloin perääntyminen, katkaisija ja lokin `provider_failed` laukeavat, ja kortti näyttää tilan samalla tavalla kuin muutkin kortit. Aiemmin virhe jäi koulukohtaiseen kenttään ja kortti väitti tietoja tuoreiksi, joten katko saattoi jäädä huomaamatta päiviksi. Vastauksen koko on rajattu (2 Mt sivulle, 4 Mt kouluhakemiston osalle), jottei rikkinäinen vastaus päädy pysyvään välimuistiin. Koulun vaihtuessa poistettu koulu katoaa heti, ja kesken olevan haun jälkeen haetaan uusin valinta. Vanhat päivät eivät näyttäydy tämän päivän aterioina. Vuosi ratkaistaan lähteen viikon alusta, myös vuodenvaihteessa. Kortin linkki avataan vain käyttöliittymän salliessa ulkoiset linkit.

## Nimipäivät

Mukana tulee **vuoden 2000 suomenkielinen nimipäiväkalenteri**: 751 nimeä 362 päivälle. Tämä ei ole nykyinen virallinen nimipäiväkalenteri; vuoden 2000 jälkeen lisätyt nimet puuttuvat. Kortti kertoo kalenterin vuoden. Tieto toimii ilman verkkoyhteyttä.

Lähde: [fergusq/nimipaivat](https://github.com/fergusq/nimipaivat/tree/53b17371022631140abdd560f85e0800fda415d6/2000), tiedosto `2000/txt/namedays-fi.txt`, commit `53b17371022631140abdd560f85e0800fda415d6` (6.12.2017).
Alkuperäisen tekstitiedoston SHA-256: `dd68a23474bbd9e93fd82f1515d38a76fb7c5764016d99126703a59ab472005d`.
`server/src/data/namedays-2000.json` on muunnettu kyseisistä nimi–päivämääräriveistä muotoon `MM-DD: [nimet]`, ilman nimien lisäyksiä tai päivämäärien muutoksia.

[Lähteen README](https://github.com/fergusq/nimipaivat/blob/53b17371022631140abdd560f85e0800fda415d6/README.md) ilmoittaa näiden historiallisten luetteloiden 15 vuoden luettelosuojan rauenneen ja sallii niiden vapaan kopioinnin. README:n MIT-lisenssi koskee muunnosskriptejä, ei nimipäiväaineistoa. Tähän projektiin ei ole kopioitu lähteen skriptejä. Uudempaa yliopiston kalenteria ei ole kopioitu: [virallinen nimipäivärajapinta](https://almanakka.helsinki.fi/en/name-days/name-day-interface) vaatii erikseen hankittavan käyttöavaimen.

Lähteessä 15.7. on "Rauna, Rauni, Rauni". Kaksoiskappale poistetaan **lukuvaiheessa** (`namesForDate`), ei datatiedostosta: `namedays-2000.json` on todennettu alkuperäistä tekstitiedostoa vasten yllä olevalla SHA-256-tiivisteellä nollalla erolla, eikä sitä rikota yhden näyttövirheen takia. Nimien järjestys säilyy ennallaan.

Päivämäärät vaihtuvat Europe/Helsinki-aikavyöhykkeellä. Huominen lasketaan kalenteripäivinä, joten vuodenvaihde ja kesäaika eivät muuta hakua. Päivällä ilman nimeä näytetään tyhjä nimilista; nimiä ei arvata.
