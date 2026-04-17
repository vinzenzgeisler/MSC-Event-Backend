export type PlaceholderCatalogItem = {
  name: string;
  description: string;
  example: string;
};

export const PLACEHOLDER_CATALOG: PlaceholderCatalogItem[] = [
  { name: 'eventName', description: 'Veranstaltungsname', example: '12. Oberlausitzer Dreieck' },
  { name: 'locale', description: 'Mail-Sprache (de/cs/pl/en)', example: 'de' },
  { name: 'preheader', description: 'Kurztext im Header', example: 'Wichtige Infos zu deiner Anmeldung' },
  { name: 'headerTitle', description: 'Titelzeile im Prozess-Header', example: 'Anmeldung eingegangen' },
  { name: 'fallbackGreeting', description: 'Lokalisierte Anrede ohne Namen', example: 'Hallo' },
  { name: 'codriverName', description: 'Name des Beifahrers', example: 'Erika Musterfrau' },
  { name: 'firstName', description: 'Vorname Fahrer', example: 'Max' },
  { name: 'lastName', description: 'Nachname Fahrer', example: 'Mustermann' },
  { name: 'driverName', description: 'Vollständiger Fahrername', example: 'Max Mustermann' },
  { name: 'className', description: 'Klassenname', example: 'Klasse 4A' },
  { name: 'startNumber', description: 'Startnummer', example: '42' },
  {
    name: 'acceptedEntrySummaryText',
    description: 'Kompakte Beschreibung der konkret zugelassenen Nennung',
    example: 'Klasse 2 · Startnummer 92 · NSU Fox'
  },
  {
    name: 'rejectedEntrySummaryText',
    description: 'Kompakte Beschreibung der konkret abgelehnten Nennung',
    example: 'Klasse 2 · Startnummer 92 · NSU Fox'
  },
  {
    name: 'rejectionScopeHint',
    description: 'Hinweis zum Geltungsbereich der Ablehnung bei Mehrfachstartern',
    example: 'Diese Entscheidung bezieht sich ausschließlich auf die in dieser E-Mail genannte Nennung.'
  },
  { name: 'amountOpen', description: 'Offener Betrag als Text', example: '120,00 EUR' },
  { name: 'paymentDueDate', description: 'Zahlungsfrist', example: '15.04.2026' },
  { name: 'paymentRecipient', description: 'Zahlungsempfänger', example: 'MSC Oberlausitzer Dreiländereck e.V.' },
  { name: 'paymentIban', description: 'IBAN für Überweisung', example: 'DE38 8505 0100 0232 0498 07' },
  { name: 'paymentBic', description: 'BIC für Überweisung', example: 'WELADED1GRL' },
  { name: 'paymentReference', description: 'Verwendungszweck für Überweisung', example: 'Nennung 12OLD-7K4P9 Max Musterfahrer' },
  {
    name: 'paymentInstructionText',
    description: 'Vollständiger Zahlungsabschnitt als Mailtext',
    example: 'Der aktuelle Gesamtbetrag für deine Nennungen beträgt 150,00 EUR.'
  },
  {
    name: 'registrationNextStepText',
    description: 'Hinweis zum weiteren Ablauf nach Registrierung bzw. E-Mail-Bestätigung',
    example: 'Zahlungsinformationen erhältst du erst mit einer Zulassung.'
  },
  {
    name: 'verificationUrl',
    description: 'Verifizierungslink',
    example: 'https://example.org/verify?token=abc123'
  },
  { name: 'greetingText', description: 'Freie Begrüßung für Kampagnenmails', example: '{{fallbackGreeting}} {{driverName}},' },
  { name: 'contentText', description: 'Hauptinhalt der freien Kampagnenmail', example: 'Hier sind die wichtigsten Informationen für dich.' },
  { name: 'introText', description: 'Einleitender Kampagnentext', example: 'Hier sind aktuelle Informationen zu deiner Teilnahme.' },
  { name: 'detailsText', description: 'Weiterer Detailabschnitt', example: 'Zeitplan und Anreisehinweise wurden aktualisiert.' },
  { name: 'ctaText', description: 'Button-Beschriftung für Kampagneninhalt', example: 'Alle Infos ansehen' },
  { name: 'ctaUrl', description: 'Button-Link für Kampagneninhalt', example: 'https://nennungstool.example.org/news' },
  { name: 'closingText', description: 'Abschlusstext', example: 'Viele Grüße, euer Orga-Team' },
  { name: 'paymentDeadline', description: 'Frist für Zahlung', example: '15.04.2026' },
  { name: 'heroImageUrl', description: 'Bild-URL für den Hero-Bereich', example: 'https://nennungstool.example.org/assets/hero.jpg' },
  { name: 'heroEyebrow', description: 'Kleiner Titel über der Headline', example: 'MSC OBERLAUSITZ' },
  { name: 'heroSubtitle', description: 'Untertitel im Header', example: 'Wichtige Updates zur Veranstaltung' },
  { name: 'highlights', description: 'Mehrzeilige Highlights-Liste', example: 'Zeitplan aktualisiert\\nFahrerlager öffnet 07:00' },
  { name: 'logoUrl', description: 'Logo-URL im Header', example: 'https://nennungstool.example.org/assets/logo.png' },
  { name: 'vehicleLabel', description: 'Zusammengefasste Fahrzeugbezeichnung', example: 'moto · KTM EXC 250' }
];

export const REQUIRED_PLACEHOLDERS_BY_TEMPLATE: Record<string, string[]> = {
  registration_received: ['eventName', 'driverName', 'verificationUrl'],
  email_confirmation_reminder: ['eventName', 'driverName', 'verificationUrl'],
  accepted_open_payment: ['eventName', 'driverName', 'className', 'startNumber', 'amountOpen'],
  accepted_paid_completed: ['eventName', 'driverName'],
  preselection: ['eventName', 'driverName'],
  payment_reminder: ['eventName', 'driverName', 'amountOpen'],
  rejected: ['eventName', 'driverName'],
  newsletter: ['eventName', 'heroImageUrl'],
  event_update: ['eventName'],
  free_form: [],
  payment_reminder_followup: [],
  email_confirmation: ['driverName', 'verificationUrl'],
  codriver_info: ['eventName', 'driverName', 'codriverName']
};

export const KNOWN_PLACEHOLDER_NAMES = new Set(PLACEHOLDER_CATALOG.map((item) => item.name));
