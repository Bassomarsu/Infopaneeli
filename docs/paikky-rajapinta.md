# Päikky-rajapinta — todennettu kuvaus

Päikyssä ei ole virallista eikä dokumentoitua rajapintaa. Tämä kuvaus on
selvitetty huoltajasovelluksen JS-nipusta (`guardian-web-v/1.32.10`) ja
**varmistettu oikeilla kutsuilla huoltajan omilla tunnuksilla 31.8.2026**.
Kaikki alla olevat vastausrakenteet ovat nähtyä dataa, eivät päättelyä —
paitsi `/v2/communications`-viestin kentät, jotka on luettu koodista, koska
postilaatikko oli tyhjä (ks. lopun varaus).

Toimittaja on Abilita. Sama alusta pyörii 79 kunnassa, kukin omalla
aliverkkotunnuksellaan; Karstula on `https://karstula.paikky.fi`.

## Yhteyskäytäntö

Kanta on `https://<kunta>.paikky.fi/api/`. Sovellus käyttää axiosia, joten
rungot ovat `application/json`.

Otsakkeet joka pyyntöön:

| Otsake | Arvo | Huom |
|---|---|---|
| `X-Paikky-Client` | `guardian-web` | **Pakollinen.** Väärä arvo → `400 {"error":"invalid-client"}` |
| `X-Paikky-Locale` | `fi` | |
| `X-Paikky-Version` | `1.32.10` | Vapaaehtoinen mutta ks. `minVersion` alla |
| `Authorization` | `Bearer <accessToken>` | Kaikkiin paitsi `v1/providers` ja `v1/login` |

Julkiset päätepisteet ilman tunnistautumista: `GET /api/v1/providers`
(79 kunnan lista) ja `GET /api/v1/login/settings` (client-otsakkeen kanssa).
Jälkimmäinen palauttaa `minVersion`-luvun (nyt `1032000`); jos tallennetun
istunnon `loginVersion` alittaa sen, palvelin mitätöi istunnon. **Toimittaja
voi siis lukita integraation ulos muuttamatta yhtään polkua.**

Julkista OpenAPI-määritystä ei ole. `/v3/api-docs` ja `/swagger-ui.html`
vastaavat 200:lla, mutta sisältö on SPA:n fallback-HTML — älä luota
statuskoodiin ilman sisällön tarkistusta.

## Kirjautuminen

```
POST /api/v1/login
{ "username": "<puhelinnumero>", "password": "<salasana>", "remember": "false" }
```

Vastaus:

```json
{ "accessToken": "<220 merkkiä>", "userId": "47", "username": "…",
  "entityId": "103", "loginVersion": 1032010 }
```

Päivittäisessä kirjautumisessa **ei ole** Suomi.fi-tunnistusta, MFA:ta eikä
CAPTCHAa. Vahvaa tunnistautumista tarvitaan vain tunnuksen aktivointiin ja
salasanan nollaukseen.

Vastauksessa **ei ole refresh-tokenia eikä vanhenemisaikaa**. Token on
läpinäkymätön, ja sen vanhenemisen huomaa ainoana merkkinä 401-vastauksesta —
istunnonhallinta on rakennettava sen varaan.

> **Tili lukkiutuu epäonnistuneista kirjautumisista.** Sama tunnus on
> huoltajan omassa puhelimessa, joten lukitus kaataa muutakin kuin näytön.
> Kirjautumista ei saa yrittää silmukassa — sama syy kuin miksi Wilman
> katkaisija on olemassa.

## Lapset

```
GET /api/v2/guardians/self          → { id, type, firstName, lastName, homeEmail, … }
GET /api/v2/guardians/self/children → { children: [ { id, type:"child", firstName, lastName, photoUrl } ] }
```

Lapsen `id` (esim. `104`) on avain kaikkiin kalenterivastauksiin.

## Hoitoajat — kuukausikalenteri

```
GET /api/v2/calendar?month=YYYY-MM
```

```json
{ "results": {
    "balance": { "2026-09": { "104": {} } },
    "days": {
      "2026-08-31": { "104": {
          "type": "current", "changeable": false, "status": "PRESENT",
          "markings": [ { "type": "PRESENT",
                          "from": "2026-08-31T05:00:00Z",
                          "to":   "2026-08-31T13:10:00Z" } ],
          "presentFrom": "2026-08-31T05:00:00Z" } },
      "2026-09-01": { "104": {
          "type": "locked", "changeable": true,
          "markings": [ { "type": "PRESENT", "from": "…T05:00:00Z", "to": "…T13:10:00Z" } ] } },
      "2026-09-05": {},
      "2026-09-07": { "104": {
          "type": "plannable",
          "planningPeriod": { "from": "…T03:30:00Z", "to": "…T14:00:00Z" },
          "lockingTime": "2026-09-06T21:00:00Z",
          "needsAttention": false,
          "markings": [ { "type": "PRESENT", "from": "…", "to": "…",
                          "fromDefaultPlan": false } ] } },
      "2026-07-27": { "104": { "type": "past", "markingType": "SCHEDULED_DAY_OFF" } }
    } } }
```

Päiväolion **täydellinen avainjoukko** (elo-, syys- ja lokakuu yhdistettynä):
`changeable`, `lockingTime`, `markingType`, `markings`, `needsAttention`,
`planningPeriod`, `presentFrom`, `status`, `type`. Muita ei esiinny.

Huomioita, jotka rikkovat toteutuksen jos ne ohitetaan:

- **`markings[].from`/`to` ovat UTC-ISO-aikoja** (`05:00:00Z` = 08:00 Suomen
  kesäaikaa). Muunnos on tehtävä `Europe/Helsinki`-vyöhykkeeseen, ei
  palvelimen paikallisaikaan.
- Vastaus kattaa **kalenterinäkymän ruudukon kokonaisina viikkoina**, ei
  pyydettyä kuukautta: `month=2026-10` sisälsi 28.9.–1.11. (35 pv) ja
  `month=2026-09` sisälsi 31.8.–4.10. (35 pv). Kahta kuukautta haettaessa
  **samat päivät esiintyvät molemmissa vastauksissa** — duplikaatit on
  siivottava.
- **Älä oleta ylivuotoa.** Kuukausi joka alkaa maanantaina ja päättyy
  sunnuntaina antaa tasan oman pituutensa eikä yhtään päivää naapureista.
  Vuosina 2026–2030 tämä osuu kohdalle täsmälleen kerran: **helmikuu 2027**
  (1.2. ma – 28.2. su, 28 pv). Silloin päivänvaihdon jälkeen katsottava
  huominen ei ole vastauksessa. Seuraavan kuukauden haun on siis
  perustuttava **tarkistukseen siitä kattaako vastaus tarvittavan päivän**,
  ei oletukseen että ruudukko ylivuotaa.
- **Kolme eri tilaa, jotka on erotettava toisistaan.** Tämä on helpoin tapa
  näyttää väärää tietoa itsevarmasti:
  - `type: "plannable"` ja `markings: []` → **hoitoaikoja ei ole vielä
    varattu.** Lokakuussa näitä oli 20 päivää. Toimenpidettä vaativa tila.
  - `days[pvm]` on `{}` tai siitä puuttuu lapsen avain → viikonloppu tai
    päiväkoti kiinni (~10 päivää kuukaudessa). Tämä on "ei hoitoa".
  - `type: "past"` ja `markingType` → mennyt päivä.
- `type`: `past` | `current` | `locked` | `plannable` | `unplannable`.
  `locked` tarkoittaa varattua mutta lukittua, ei poissaoloa.
- `status` ja `presentFrom` esiintyvät **vain** kuluvana päivänä,
  `markingType` **vain** menneillä. `presentFrom` on **toteutunut
  sisäänkirjaus**, `markings` on **suunnitelma**.
- `needsAttention` esiintyi vain arvolla `false` tai puuttui kokonaan.
  Älä oleta sen olevan aina läsnä.
- `lockingTime` kertoo milloin varaus lukittuu (esim.
  `"2026-09-06T21:00:00Z"` = su 24:00 paikallista aikaa).

## Toteutuneet ajat — päivän saldo

```
GET /api/v2/calendar/balance?day=YYYY-MM-DD     (myös ?week= ja ?month=)
```

Alla oleva näyte on **menneeltä päivältä 28.8.2026**. Päivä on mainittava,
koska `plan` vaihtelee päivittäin — sitä ei saa verrata toisen päivän
kalenterimerkintään.

```json
{ "results": { "children": { "104": {
      "serviceNeed": [ { "name": "varhaiskasvatus", "unlimited": true, "minutesPerWeek": 2100 } ],
      "plan":   [ { "type": "PRESENT", "from": "8:00", "to": "14:45" } ],
      "actual": [ { "type": "PRESENT", "from": "7:59", "to": "16:00" } ],
      "used":   [ { "type": "PRESENT", "from": "7:59", "to": "16:00" } ],
      "totalUsedMinutes": 481 } } } }
```

**Tämä on ainoa paikka josta uloskirjausaika saadaan** — kalenterissa on
`presentFrom` muttei `presentTo`.

**`actual` on tyhjä niin kauan kuin lapsi on paikalla.** Kuluvana päivänä
31.8. `balance.actual` oli `[]`, vaikka kalenterin `presentFrom` kertoi
sisäänkirjauksen klo 08:00. Taulukko täyttyy vasta uloskirjauksen jälkeen.
Käyttöliittymän on siis luettava "paikalla nyt" kalenterin `presentFrom`- ja
`status`-kentistä, **ei** `actual`-taulukosta, jota odottaessa kortti
näyttäisi tyhjää koko hoitopäivän ajan.

`balance.plan` on sama varaus kuin kalenterin `markings`, ei erillinen
oletusviikko: 31.8. kalenteri antoi `05:00Z–13:10Z` eli 08:00–16:10 ja
`balance.plan` antoi `8:00–16:10`. Tämä on samalla riippumaton tarkistus
sille, että UTC→Helsinki-muunnos on tehty oikein.

> Formaattiepäjohdonmukaisuus: `balance` palauttaa paikallisia kellonaikoja
> merkkijonoina (`"8:00"`, ei nollattua tuntia), kalenteri UTC-ISO-aikoja.
> Ne on jäsennettävä eri koodilla.

**`?week=` ja `?month=` eivät korvaa `?day=`:tä.** Ne palauttavat eri
rakenteen, jossa on vain minuuttisummia — ei kellonaikoja:

```json
// ?week=2026-08-24
{ "results": { "104": { "days": [ { "day": "2026-08-24", "minutes": 490 }, … ],
                        "totalMinutes": 2442 } } }
// ?month=2026-08
{ "results": { "104": { "summary": { "used": { "minutes": 7808 }, "serviceNeed": [ … ] },
                        "periods": [], "weeks": [ { "year": 2026, "week": 31, … } ] } } }
```

Toteutuneet kellonajat saa siis vain päivä kerrallaan, yksi kutsu per päivä.

> **Infonäyttö ei käytä tätä päätepistettä lainkaan.** `plan` kahdentaa
> kalenterin `markings`-tiedon, ja `actual` täyttyy vasta uloskirjauksesta —
> eli ainoa oma tieto valmistuu illalla, kun näyttöä ei enää katsota. Kutsu
> maksaisi yhden lokirivin kunnan järjestelmään huoltajan nimellä ja toisi
> mukanaan nollatäyttämättömät kellonajat, joissa merkkijonovertailu
> `"8:00" > "14:45"` on tosi. "Paikalla nyt" luetaan kalenterin `status`- ja
> `presentFrom`-kentistä ilman lisäkutsua. Uloskirjausaikaa ei siis haeta,
> ja haettu lapsi näytetään pelkkänä "haettu" ilman kellonaikaa.

## Viestit

Viestilista **ei** ole `/v2/messages` — se on lähetys (POST) ja vastaa
autentikoituunkin GET-pyyntöön 404:llä. Oikea päätepiste on:

```
GET /api/v2/communications?n=20[&before=<id>]
GET /api/v2/communications?since=<ts>&lastChanged=<ts>
```

Todennettu vastaus (postilaatikko tyhjä):

```json
{ "results": { "communications": [], "lastChanged": null, "endOfData": true } }
```

Yksittäisen viestin kentät on luettu renderöintikoodista, **ei nähty
oikeana datana**: `uniqueId`, `type` (`message` | `bulletin` |
`answered-form` | `unanswered-form`), `created`, `creator`, `attachments[]`,
otsikko ja lukutila. Muut päätepisteet: `GET /api/v1/bulletins/{id}`,
`POST /api/v2/messages/{id}/read`.

**Tästä syystä viestien jäsentäjä on kirjoitettava puolustavasti:** puuttuvat
kentät eivät saa kaataa hakua, ja ensimmäisen oikean viestin saapuessa raaka
vastaus kannattaa tallentaa `snapshotDir`-kansioon debug-tilassa, jotta
rakenne nähdään kerran oikeasti.

## Muut löydetyt päätepisteet

`GET /api/v2/default_plans` ja `/v2/default_plans/{id}` (oletusviikko),
`POST /api/v2/calendar/change` (hoitoajan muutos — **ei toteuteta**,
infonäyttö on lukulaite), `GET /api/v2/forms/{id}/answer/{id}`.

## Rajoitteet, jotka koskevat toteutusta

- Salasana vanhenee (arviolta ~180 vrk); vanhentuessa integraatio hajoaa ja
  korjaus vaatii ihmisen. Näytön on kerrottava vanhentuneesta datasta, ei
  näytettävä vanhaa itsevarmasti.
- Kunnan tietosuojaseloste kertoo, että jokainen luku kirjautuu lokiin
  huoltajan nimellä. Pollauksen on oltava harvaa; hoitoajat eivät muutu
  minuuteittain.
- Lapsen läsnäolotieto on arkaluonteista ja näyttö on yhteisessä tilassa.
  Päikky kuuluu `SENSITIVE_PROVIDERS`-joukkoon samoin kuin Wilma.
