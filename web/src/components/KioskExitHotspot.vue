<script setup lang="ts">
/**
 * Näkymätön painike kioskitilasta poistumiseen — ei mitään visuaalista
 * vihjettä, ks. tiimin vaatimus. PIN kysytään vasta App.vuen avaamassa
 * KioskExitDialogissa, tämä komponentti vain tunnistaa eleen.
 *
 * SIJAINTI: yläpalkin päivämäärän kohdalla (App.vuen topbar__date-wrap), EI
 * ruudun nurkassa. Käyttäjän oma tarkennus alkuperäiseen nurkka-ehdotukseen:
 * ruudun reuna on juuri se kohta johon osutaan vahingossa pöytää
 * pyyhittäessä tai näyttöä siirrettäessä, kun taas päivämäärän kohdalla
 * oleva rajattu alue vaatii tietoisemman kosketuksen. Tämä komponentti
 * OLETTAA olevansa upotettu position:relative-elementtiin joka on kooltaan
 * juuri päivämäärätekstin kokoinen (ks. App.vuen topbar__date-wrap) — se
 * peittää sen alan, ei mitään kiinteää pikselikoordinaattia, koska dateLabel
 * vaihtaa pituutta päivästä toiseen. Ks. tyylin perustelu alempana siitä
 * miksi alue on päivämäärän PÄÄLLÄ eikä sen perässä.
 *
 * Ele on silti PITKÄ PAINALLUS (ks. HOLD_MS), ei yksi napautus eikä useampi
 * nopea napautus — paikka on turvallisempi kuin nurkka, mutta näkymätön
 * painike joka laukeaisi yhdestä kosketuksesta laukeaisi silti joskus
 * vahingossa (esim. sormi liukuu kellosta päivämäärän yli), ja seurauksena
 * olisi kioskin sulkeutuminen kesken päivän:
 *  - Yksi napautus tai useampi nopea napautus samaan kohtaan ei erota
 *    tarkoituksellista kosketusta ohimenevästä.
 *  - Pitkä, PAIKALLAAN pysyvä painallus ei laukea kummastakaan: liike
 *    peruuntuu MOVE_TOLERANCE_PX:n ylityksestä (ks. useLongPress.ts) eikä
 *    ohimenevä kosketus kestä koko HOLD_MS:ää. Sama peruste jolla esim.
 *    puhelinten piilotetut kehittäjävalikot käyttävät pitkää painallusta
 *    eivätkä napautusta.
 *
 * Kosketusalue ulottuu päivämäärätekstin oman rivikorkeuden yli (ks. tyylin
 * top/bottom-arvot) käytettävyyden vuoksi — position:absolute pitää sen
 * silti kokonaan pois dokumentin virtauksesta, joten se ei voi työntää
 * kelloa/päivämäärää sivuun eikä muuttaa yläpalkin rivin korkeutta.
 */
import { createLongPressTracker } from "../composables/useLongPress.ts";

const emit = defineEmits<{ trigger: [] }>();

const HOLD_MS = 3000;
const MOVE_TOLERANCE_PX = 24;

const tracker = createLongPressTracker(HOLD_MS, MOVE_TOLERANCE_PX, () => emit("trigger"));
</script>

<template>
  <div
    class="hotspot"
    aria-hidden="true"
    @pointerdown="tracker.onPointerDown"
    @pointermove="tracker.onPointerMove"
    @pointerup="tracker.onPointerUp"
    @pointercancel="tracker.onPointerCancel"
  ></div>
</template>

<style scoped>
/*
 * Alue on PÄIVÄMÄÄRÄN OMA ALA, ei sen vieressä oleva tyhjä kaistale.
 *
 * Aiemmin tämä oli `left: 100%; width: 3.5rem`, eli alue alkoi päivämäärän
 * oikeasta reunasta ja jatkui siitä eteenpäin. Se vei sen ULOS yläpalkin
 * aikasarakkeesta: 901 px:n levyisellä ruudulla sarake loppui x=298:aan mutta
 * alue jatkui x=341:een, keskisarakkeen NÄKYVÄN hälytysbannerin alle. Koska
 * bannerissa on `pointer-events: none`, painallus valui sen läpi tänne, ja
 * kolmen sekunnin painallus bannerin vasemmassa päässä avasi poistumisdialogin
 * (mitattu välillä 901–975 px). Bannerin puolelta sitä ei voi korjata
 * menettämättä joko tätä aluetta tai bannerin luettavuutta — molemmat
 * kiertotiet mitattiin ja hylättiin, ks. App.vuen kommentti.
 *
 * `inset` päivämäärän omaan laatikkoon poistaa koko ongelman: alue ei voi
 * ulottua sarakkeensa ulkopuolelle, koska päivämäärä itse ei voi. Se ei
 * myöskään voi enää työntää sivua leveämmäksi kuin ruutu (320 px:llä vanha
 * alue ulottui 21 px ruudun yli).
 *
 * Ala ei tästä pienene liikaa: päivämäärä on levein kapeallakin ruudulla
 * (mitattu 155 px yhdellä rivillä, kapeimmillaan pisimmän sanan verran),
 * ja pysty­suunnassa 0.9rem ylä- ja alapuolelle antaa n. 52 px korkeutta.
 * Mitattu vähintään 44x44 px jokaisella leveydellä 320–2736, molemmissa
 * bannerin tiloissa ja molemmilla päiväyspituuksilla.
 *
 * Vahinkolaukaisun riski ei kasva: päivämäärä on pelkkää tekstiä, jota ei
 * paineta mistään muusta syystä, eikä se ole ruudun reunassa kuten alun perin
 * hylätty nurkkasijainti. Ele on yhä kolmen sekunnin PAIKALLAAN pysyvä
 * painallus ja PIN kysytään edelleen erikseen.
 */
.hotspot {
  position: absolute;
  inset: -0.9rem 0;
  z-index: 50;
  background: transparent;
  touch-action: none;
}
</style>
