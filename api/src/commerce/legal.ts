/**
 * Versionen der Rechtstexte, denen Kaeufer beim Checkout zustimmen (Commerce AP15, Nachweis in
 * `commerce_legal_acceptance`). Die Texte selbst stehen unter docs/racepic/legal/. Solange der Status `DRAFT`
 * ist, sind sie nicht rechtlich freigegeben (AP00); der Checkout darf dann nur mit Testdaten laufen.
 */
export const LEGAL_DOCUMENTS_STATUS = 'DRAFT' as 'DRAFT' | 'APPROVED';

export const LEGAL_DOCUMENT_VERSIONS = {
  /** Allgemeine Geschaeftsbedingungen fuer Kaeufer. */
  terms: '2026-09-28-entwurf.1',
  /** Lizenzbedingungen (private Nutzung). */
  license: '2026-09-28-entwurf.1',
  /** Datenschutzhinweis zur Kaufabwicklung. */
  privacy: '2026-09-28-entwurf.1',
  /** Widerrufsbelehrung inkl. Hinweis zur elektronischen Widerrufsfunktion. */
  withdrawal: '2026-09-28-entwurf.1',
  /** Ausdrueckliche Zustimmung zur sofortigen Ausfuehrung und Kenntnis vom Erloeschen des Widerrufsrechts (§ 356 Abs. 5 BGB). */
  digitalContentWaiver: '2026-09-28-entwurf.1'
} as const;

export type LegalDocumentKey = keyof typeof LEGAL_DOCUMENT_VERSIONS;

/** Beschriftung des zahlungspflichtigen Buttons (§ 312j Abs. 3 BGB verlangt eine eindeutige Beschriftung). */
export const ORDER_BUTTON_LABEL = 'Zahlungspflichtig bestellen';

export const isLegalDocumentsApproved = (): boolean => LEGAL_DOCUMENTS_STATUS === 'APPROVED';
