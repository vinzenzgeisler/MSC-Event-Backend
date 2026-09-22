/** Gemeinsamer Slug-Helfer fuer RacePic (Klassen-Slugs in publish.ts, Fotografen-Slugs in repository.ts). */
export const slugify = (value: string, fallback: string): string =>
  value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || fallback;
