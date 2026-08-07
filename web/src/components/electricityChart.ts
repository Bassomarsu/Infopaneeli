/**
 * Muuntaa kosketus- tai hiiripisteen vaakasijainnin (px, suhteessa .bars-elementin
 * vasempaan reunaan) lähimmäksi tunniksi. Kaaviota käsitellään yhtenä 24 tunnin
 * levyisenä alueena eikä vaadita osumista yksittäiseen palkkiin — kapealla
 * kortilla (pienin sallittu paneelikoko) yksi palkki on kosketuksen tarkkuutta
 * (~44px) kapeampi, joten pikselintarkka osuma ei olisi käytännössä mahdollinen.
 */
export function hourFromPointerX(x: number, containerWidth: number, hours = 24): number {
  if (!(containerWidth > 0) || hours <= 0) return 0;
  const hour = Math.floor((x / containerWidth) * hours);
  return Math.min(hours - 1, Math.max(0, hour));
}
