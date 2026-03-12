export type PlaceholderCatalogItem = {
  name: string;
  description: string;
  example: string;
};

export const PLACEHOLDER_CATALOG: PlaceholderCatalogItem[] = [
  { name: 'eventName', description: 'Eventname', example: 'MSC Dreiecksrennen 2026' },
  { name: 'firstName', description: 'Vorname Fahrer', example: 'Max' },
  { name: 'lastName', description: 'Nachname Fahrer', example: 'Mustermann' },
  { name: 'driverName', description: 'Vollstaendiger Fahrername', example: 'Max Mustermann' },
  { name: 'className', description: 'Klassenname', example: 'Klasse 4A' },
  { name: 'startNumber', description: 'Startnummer', example: '42' },
  { name: 'amountOpen', description: 'Offener Betrag als Text', example: '120,00 EUR' },
  {
    name: 'verificationUrl',
    description: 'Verifizierungslink',
    example: 'https://example.org/verify?token=abc123'
  },
  { name: 'introText', description: 'Einleitender Kampagnentext', example: 'Wichtige Neuigkeiten fuer alle Teilnehmenden.' },
  { name: 'detailsText', description: 'Weiterer Detailabschnitt', example: 'Zeitplan und Anreise wurden aktualisiert.' },
  { name: 'ctaText', description: 'Button-Beschriftung fuer Kampagneninhalt', example: 'Alle Infos ansehen' },
  { name: 'ctaUrl', description: 'Button-Link fuer Kampagneninhalt', example: 'https://nennungstool.example.org/news' },
  { name: 'closingText', description: 'Abschlusstext', example: 'Viele Gruesse, euer Orga-Team' },
  { name: 'paymentDeadline', description: 'Frist fuer Zahlung', example: '15.04.2026' },
  { name: 'heroImageUrl', description: 'Bild-URL fuer den Hero-Bereich', example: 'https://nennungstool.example.org/assets/hero.jpg' },
  { name: 'heroEyebrow', description: 'Kleiner Titel ueber der Headline', example: 'MSC OBERLAUSITZ' },
  { name: 'heroSubtitle', description: 'Untertitel im Header', example: 'Wichtige Updates fuer deine Teilnahme' },
  { name: 'highlights', description: 'Mehrzeilige Highlights-Liste', example: 'Zeitplan aktualisiert\\nFahrerlager oeffnet 07:00' },
  { name: 'logoUrl', description: 'Logo-URL im Header', example: 'https://nennungstool.example.org/assets/logo.png' },
  { name: 'vehicleLabel', description: 'Zusammengefasste Fahrzeugbezeichnung', example: 'moto · KTM EXC 250' }
];

export const REQUIRED_PLACEHOLDERS_BY_TEMPLATE: Record<string, string[]> = {
  registration_received: ['eventName', 'driverName', 'verificationUrl'],
  accepted_open_payment: ['eventName', 'driverName', 'className', 'startNumber', 'amountOpen'],
  payment_reminder: ['eventName', 'driverName', 'amountOpen'],
  rejected: ['eventName', 'driverName'],
  newsletter: ['eventName'],
  event_update: ['eventName'],
  free_form: [],
  payment_reminder_followup: [],
  email_confirmation: ['driverName', 'verificationUrl']
};

export const KNOWN_PLACEHOLDER_NAMES = new Set(PLACEHOLDER_CATALOG.map((item) => item.name));
