import type { InjectionKey, Ref } from 'vue';

/**
 * Onko ympäröivä kortti niin matala että koristeet on jätettävä pois.
 *
 * Injektio eikä propsi, koska kortin sisältö on CardShellin slotissa ja voi
 * olla monta komponenttia syvällä (esim. ShoppingCard -> HouseholdList). Sama
 * kuvio kuin `widgetPanelKey`illä.
 *
 * Oletusarvo puuttuvalle tarjoajalle on AINA `false`: komponentti jota
 * käytetään kortin ulkopuolella (dialogit) ei ole tiivis, ja väärin päin
 * erehtyminen piilottaisi sieltä tietoa ilman mitään syytä.
 */
export const cardCompactKey: InjectionKey<Readonly<Ref<boolean>>> = Symbol('cardCompact');
