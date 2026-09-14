/** Ylen virallinen RSS-hakemisto https://yle.fi/rss, tarkistettu 14.9.2026. */
export const newsCategories: ReadonlyArray<{id:string;name:string;url:string}> = [
  {
    "id": "paauutiset",
    "name": "Pääuutiset",
    "url": "https://yle.fi/rss/uutiset/paauutiset"
  },
  {
    "id": "tuoreimmat",
    "name": "Tuoreimmat",
    "url": "https://yle.fi/rss/uutiset/tuoreimmat"
  },
  {
    "id": "kotimaa",
    "name": "Kotimaa",
    "url": "https://yle.fi/rss/t/18-34837/fi"
  },
  {
    "id": "ulkomaat",
    "name": "Ulkomaat",
    "url": "https://yle.fi/rss/t/18-34953/fi"
  },
  {
    "id": "talous",
    "name": "Talous",
    "url": "https://yle.fi/rss/t/18-19274/fi"
  },
  {
    "id": "politiikka",
    "name": "Politiikka",
    "url": "https://yle.fi/rss/t/18-38033/fi"
  },
  {
    "id": "kulttuuri",
    "name": "Kulttuuri",
    "url": "https://yle.fi/rss/t/18-150067/fi"
  },
  {
    "id": "tiede",
    "name": "Tiede",
    "url": "https://yle.fi/rss/t/18-819/fi"
  },
  {
    "id": "luonto",
    "name": "Luonto",
    "url": "https://yle.fi/rss/t/18-35354/fi"
  },
  {
    "id": "urheilu",
    "name": "Urheilu",
    "url": "https://yle.fi/rss/urheilu"
  },
  {
    "id": "etela-karjala",
    "name": "Etelä-Karjala",
    "url": "https://yle.fi/rss/t/18-141372/fi"
  },
  {
    "id": "etela-pohjanmaa",
    "name": "Etelä-Pohjanmaa",
    "url": "https://yle.fi/rss/t/18-146311/fi"
  },
  {
    "id": "etela-savo",
    "name": "Etelä-Savo",
    "url": "https://yle.fi/rss/t/18-141852/fi"
  },
  {
    "id": "kainuu",
    "name": "Kainuu",
    "url": "https://yle.fi/rss/t/18-141399/fi"
  },
  {
    "id": "kanta-hame",
    "name": "Kanta-Häme",
    "url": "https://yle.fi/rss/t/18-138727/fi"
  },
  {
    "id": "keski-pohjanmaa",
    "name": "Keski-Pohjanmaa",
    "url": "https://yle.fi/rss/t/18-135629/fi"
  },
  {
    "id": "keski-suomi",
    "name": "Keski-Suomi",
    "url": "https://yle.fi/rss/t/18-148148/fi"
  },
  {
    "id": "kymenlaakso",
    "name": "Kymenlaakso",
    "url": "https://yle.fi/rss/t/18-131408/fi"
  },
  {
    "id": "lappi",
    "name": "Lappi",
    "url": "https://yle.fi/rss/t/18-139752/fi"
  },
  {
    "id": "pirkanmaa",
    "name": "Pirkanmaa",
    "url": "https://yle.fi/rss/t/18-146831/fi"
  },
  {
    "id": "pohjanmaa",
    "name": "Pohjanmaa",
    "url": "https://yle.fi/rss/t/18-148149/fi"
  },
  {
    "id": "pohjois-karjala",
    "name": "Pohjois-Karjala",
    "url": "https://yle.fi/rss/t/18-141936/fi"
  },
  {
    "id": "pohjois-pohjanmaa",
    "name": "Pohjois-Pohjanmaa",
    "url": "https://yle.fi/rss/t/18-148154/fi"
  },
  {
    "id": "pohjois-savo",
    "name": "Pohjois-Savo",
    "url": "https://yle.fi/rss/t/18-141764/fi"
  },
  {
    "id": "paijat-hame",
    "name": "Päijät-Häme",
    "url": "https://yle.fi/rss/t/18-141401/fi"
  },
  {
    "id": "satakunta",
    "name": "Satakunta",
    "url": "https://yle.fi/rss/t/18-139772/fi"
  },
  {
    "id": "uusimaa",
    "name": "Uusimaa",
    "url": "https://yle.fi/rss/t/18-147345/fi"
  },
  {
    "id": "varsinais-suomi",
    "name": "Varsinais-Suomi",
    "url": "https://yle.fi/rss/t/18-135507/fi"
  }
];
export function isNewsCategory(value: unknown): value is string { return typeof value === 'string' && newsCategories.some(c => c.id === value); }
