# Päikky — providerin toteutus

Miksi Päikky-provider tekee niin kuin tekee. Rajapinnan mitattu kuvaus —
päätepisteet, vastausrakenteet ja niistä suoraan seuraavat vaatimukset — on
tiedostossa [`paikky-rajapinta.md`](paikky-rajapinta.md), eikä sitä toisteta
tässä. Yleiskuva on [README](../README.md):ssä.

Valmista kirjastoa ei ole, joten asiakas on kirjoitettu itse — silti *vähemmän*
työtä kuin Wilma, koska mitään ei tarvitse jäsentää HTML:stä.

## Aikavyöhykemuunnos on omassa moduulissaan

Päikyn ajat tulevat UTC:nä. Muunnos on `core/time.ts`:n `isoToLocalClock`, ei
providerin sisällä — käyttöjärjestelmän vyöhykettä lukevat oikotiet
(`getHours()`, `toLocaleTimeString()` ilman `timeZone`-optiota) näyttäisivät
oikealta kehityskoneella ja olisivat kolme tuntia väärässä Linux-asennuksella,
jonka oletusvyöhyke on UTC.

## Varaamaton päivä on toimintakehotus

`plannable` ilman merkintöjä on **varaamaton päivä**, ja se on ainoa Päikyn
tieto joka on toimintakehotus: varaus lukittuu `lockingTime`-hetkellä, ja
ohittaminen maksaa hoitopaikan. Siksi se erotetaan vapaapäivästä eikä
kumpaakaan näytetä toisena.

## Tilin lukituksen esto on tiukempi kuin Wilmassa

`fatalLimit: 2`, jäähdytys 2 h → 12 h, manuaalitestejä 3/vrk. Syy: Päikyssä
**yksi hakukierros on yksi kirjautuminen**, ja sama tunnus on huoltajan omassa
puhelimessa — väärä salasana täällä kaataa muutakin kuin näytön. [Wilman
luvut](wilma.md) on mitoitettu eri tilanteeseen eikä niitä peritä.

## Näytettävät lapset valitaan erikseen Päikylle

Asetus on `visiblePaikkyChildren`, ja sääntö on sama kuin Wilmalla: **`null` tai
tyhjä lista tarkoittaa kaikkia**, jottei viimeisenkin valinnan poistaminen jätä
korttia tyhjäksi. Sama sääntö on kolmessa paikassa — `useScheduleDay`,
`ScheduleCard`in otsikko ja `PaikkyCareDays`in suodatin — ja jos ne eriävät,
kortin otsikko nimeää lapsen jonka rivejä ei näy.

## Ilman `PAIKKY_*`-tunnuksia Päikkyä ei ole olemassa

Provider rekisteröidään vain jos tunnukset on annettu, joten `/api/dashboard` ei
sisällä `paikky`-avainta lainkaan eivätkä kortit kasvata itselleen välilehtiä.
Tämä on tarkoituksellista ja eri linja kuin Wilmalla: Wilma on tämän näytön
olemassaolon syy, ja sen puuttuvista tunnuksista kerrotaan kortissa. Päikky on
lisäosa, ja kenenkään muun asennuksessa ei pidä näkyä tyhjää
"Hoitoajat"-välilehteä.

## Viestien virhe ei kaada hoitoaikoja

Viestipäätepiste on toteutuksen heikoiten todennettu osa (ks.
[`paikky-rajapinta.md`](paikky-rajapinta.md), kohta *Viestit*). Siksi jäsentäjä
pudottaa yksittäisen kelvottoman viestin sen sijaan että kaataisi haun, ja
viestien virhe raportoidaan omana kenttänään (`messagesError`) — jotta vika
näkyy mutta ei vie mukanaan sitä dataa, jota varten kortti on.
