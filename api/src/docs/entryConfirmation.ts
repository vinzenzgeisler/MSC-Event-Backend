
import { and, desc, eq, isNull } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { getDb } from '../db/client';
import { document, documentGenerationJob, entry, event, eventClass, eventPricingRule, invoice, person, vehicle } from '../db/schema';
import { renderEntryConfirmationPdf, type EntryConfirmationPdfPayload } from './pdf';
import { buildGiroCodeMatrix, buildGiroCodePayload, isValidBic, isValidIban } from './girocode';
import { getAssetObjectBuffer, uploadPdf } from './storage';
import { writeAuditLog } from '../audit/log';
import { buildEntryConfirmationConfigFallback, overlayEntryConfirmationConfig } from '../domain/entryConfirmationConfig';
import { buildPaymentReference } from '../domain/paymentReference';
import { getEntryLineTotalCents, sumEntryLineTotalCents } from '../domain/pricingSnapshot';
import { getEntryConfirmationDefaults } from '../routes/adminConfig';
import { resolveMailLocale, type SupportedMailLocale } from '../mail/i18n';

const ENTRY_CONFIRMATION_TEMPLATE_VERSION = 'v9';
const ENTRY_CONFIRMATION_TYPE = 'entry_confirmation';
const ENTRY_CONFIRMATION_FILE_NAME = 'Nennbestätigung.pdf';
const MAIL_LOGO_KEY = 'public/mail/msc-logo.png';
const MAIL_FONT_REGULAR_KEY = 'public/mail/fonts/arial.ttf';
const MAIL_FONT_BOLD_KEY = 'public/mail/fonts/arialbd.ttf';
const DEFAULT_ENTRY_CONTACT_EMAIL = 'nennung@msc-oberlausitzer-dreilaendereck.eu';

type EntrySummary = {
  className: string;
  startNumber: string | null;
  vehicleSummary: string;
};

type TranslationConfig = {
  locale: SupportedMailLocale;
  includeTranslatedPage: boolean;
  translatedTitle: string;
  issueDateLabel: string;
  labels: {
    entryDetails: string;
    additionalEntries: string;
    pendingEntries: string;
    payment: string;
    eventInfo: string;
    schedule: string;
    importantNotes: string;
    closing: string;
    className: string;
    startNumber: string;
    vehicle: string;
    backupVehicle: string;
    codriver: string;
    status: string;
    fee: string;
    dueDate: string;
    recipient: string;
    iban: string;
    bic: string;
    bank: string;
    reference: string;
    paddock: string;
    address: string;
    arrival: string;
    access: string;
    organizer: string;
    contact: string;
    online: string;
  };
  text: {
    greeting: (name: string) => string;
    introLine: (eventName: string) => string;
    additionalEntriesIntro: string;
    entryScopeOnlyHint: string;
    entryScopePendingHint: string;
    entryScopeAcceptedHint: string;
    combinedTransferHint: string;
    paymentOpenLine: string;
    paymentPaidLine: string;
    paymentNoAdditionalAmountLine: string;
    carryLine: string;
    paymentIntroOpen: string;
    paymentIntroPaid: string;
    paymentIntroNoAdditionalAmount: string;
    qrCaption: string;
    closingHint: string;
    authorityHint: string;
    noAdditionalAmountStatus: string;
  };
};

const TRANSLATIONS: Record<SupportedMailLocale, TranslationConfig> = {
  de: {
    locale: 'de',
    includeTranslatedPage: false,
    translatedTitle: 'Nennbestätigung',
    issueDateLabel: 'Ausgestellt am',
    labels: {
      entryDetails: 'Nennungsdaten',
      additionalEntries: 'Weitere zugelassene Nennungen',
      pendingEntries: 'Weitere gemeldete Nennungen',
      payment: 'Zahlung',
      eventInfo: 'Veranstaltungsinfos',
      schedule: 'Termine',
      importantNotes: 'Wichtige Hinweise',
      closing: 'Abschluss',
      className: 'Klasse',
      startNumber: 'Startnummer',
      vehicle: 'Fahrzeug',
      backupVehicle: 'Ersatzfahrzeug',
      codriver: 'Beifahrer',
      status: 'Status',
      fee: 'Nenngeld',
      dueDate: 'Frist',
      recipient: 'Empfänger',
      iban: 'IBAN',
      bic: 'BIC',
      bank: 'Bank',
      reference: 'Verwendungszweck',
      paddock: 'Fahrerlager',
      address: 'Adresse',
      arrival: 'Anreise',
      access: 'Zufahrt',
      organizer: 'Veranstalter',
      contact: 'Kontakt',
      online: 'Online'
    },
    text: {
      greeting: (name: string) => `Guten Tag ${name},`,
      introLine: (eventName: string) => `hiermit bestätigen wir Ihre Zulassung zur Veranstaltung ${eventName}. Die wichtigsten Angaben zu Ihrer Nennung haben wir für Sie in diesem Schreiben zusammengefasst.`,
      additionalEntriesIntro: 'Zusätzlich sind für diese Veranstaltung bereits weitere Nennungen auf Ihren Namen zugelassen.',
      entryScopeOnlyHint: 'Diese Bestätigung und der ausgewiesene Betrag beziehen sich ausschließlich auf die unten genannte Nennung.',
      entryScopePendingHint:
        'Diese Bestätigung und der ausgewiesene Betrag beziehen sich ausschließlich auf die unten genannte Nennung. Weitere Nennungen auf Ihren Namen werden gesondert entschieden und berechnet.',
      entryScopeAcceptedHint:
        'Diese Bestätigung und der ausgewiesene Betrag beziehen sich ausschließlich auf die unten genannte Nennung. Für weitere zugelassene Nennungen erhalten Sie jeweils eine gesonderte Bestätigung.',
      combinedTransferHint:
        'Bei Zulassung weiterer Nennungen desselben Fahrers können die Beträge gemeinsam überwiesen werden.',
      paymentOpenLine: 'Das Nenngeld ist derzeit noch offen. Bitte überweisen Sie den Betrag fristgerecht unter dem unten angegebenen Verwendungszweck.',
      paymentPaidLine: 'Das Nenngeld ist bereits eingegangen. Vielen Dank.',
      paymentNoAdditionalAmountLine: 'Für diese zugelassene Nennung ist aktuell kein zusätzlicher Zahlbetrag offen.',
      carryLine: 'Bitte bringen Sie diese Nennbestätigung digital oder ausgedruckt zur Veranstaltung mit.',
      paymentIntroOpen: 'Die Zahlungsdaten sind nachfolgend aufgeführt. Der GiroCode kann direkt mit einer Banking-App gescannt werden.',
      paymentIntroPaid: 'Ihre Zahlung ist bereits verbucht. Die Zahlungsdaten werden daher nur zur Dokumentation aufgeführt.',
      paymentIntroNoAdditionalAmount: 'Für diese zugelassene Nennung ist kein weiterer Zahlbetrag fällig. Die Angaben werden daher nur zur Dokumentation aufgeführt.',
      qrCaption: 'GiroCode für Banking-App',
      closingHint: 'Bitte beachten Sie die aufgeführten Hinweise zu Anreise, Fahrerlager und organisatorischem Ablauf. Bei Rückfragen unterstützt Sie das Veranstaltungsteam gern.',
      authorityHint: 'Die deutsche Fassung ist zur Vorlage bei der Veranstaltung maßgeblich.',
      noAdditionalAmountStatus: 'kein zusätzlicher Betrag offen'
    }
  },
  en: {
    locale: 'en',
    includeTranslatedPage: true,
    translatedTitle: 'Entry Confirmation',
    issueDateLabel: 'Issued on',
    labels: {
      entryDetails: 'Accepted Entry',
      additionalEntries: 'Further Accepted Entries',
      pendingEntries: 'Further Submitted Entries',
      payment: 'Payment',
      eventInfo: 'Event Information',
      schedule: 'Schedule',
      importantNotes: 'Important Notes',
      closing: 'Closing Information',
      className: 'Class',
      startNumber: 'Start Number',
      vehicle: 'Vehicle',
      backupVehicle: 'Backup Vehicle',
      codriver: 'Codriver',
      status: 'Status',
      fee: 'Entry Fee',
      dueDate: 'Due Date',
      recipient: 'Recipient',
      iban: 'IBAN',
      bic: 'BIC',
      bank: 'Bank',
      reference: 'Reference',
      paddock: 'Paddock',
      address: 'Address',
      arrival: 'Arrival',
      access: 'Access',
      organizer: 'Organizer',
      contact: 'Contact',
      online: 'Online'
    },
    text: {
      greeting: (name: string) => `Hello ${name},`,
      introLine: (eventName: string) => `this letter confirms your acceptance for ${eventName}. We have summarised the key details of your entry below.`,
      additionalEntriesIntro: 'Further entries in your name have already been accepted for this event.',
      entryScopeOnlyHint: 'This confirmation and the amount shown apply only to the entry listed below.',
      entryScopePendingHint:
        'This confirmation and the amount shown apply only to the entry listed below. Any further entries in your name will be decided and charged separately.',
      entryScopeAcceptedHint:
        'This confirmation and the amount shown apply only to the entry listed below. You will receive a separate confirmation for each further accepted entry.',
      combinedTransferHint:
        'If further entries for the same rider are accepted, the amounts may be paid together.',
      paymentOpenLine: 'The entry fee is still outstanding. Please transfer the amount in due time using the reference shown below.',
      paymentPaidLine: 'Your payment has already been received. Thank you.',
      paymentNoAdditionalAmountLine: 'There is currently no additional payment due for this accepted entry.',
      carryLine: 'Please bring this confirmation with you to the event, either digitally or printed.',
      paymentIntroOpen: 'The payment details are listed below.',
      paymentIntroPaid: 'Your payment has already been recorded. The payment details are shown here for documentation purposes.',
      paymentIntroNoAdditionalAmount: 'No additional amount is currently due for this accepted entry. The information below is included for documentation purposes.',
      qrCaption: 'GiroCode',
      closingHint: 'Please note the information below regarding arrival, paddock access and organisational matters. If you have questions, the organising team will be happy to help.',
      authorityHint: 'The German version remains the authoritative version for presentation at the event.',
      noAdditionalAmountStatus: 'no additional amount due'
    }
  },
  cs: {
    locale: 'cs',
    includeTranslatedPage: true,
    translatedTitle: 'Potvrzení přihlášky',
    issueDateLabel: 'Vystaveno dne',
    labels: {
      entryDetails: 'Přijatá přihláška',
      additionalEntries: 'Další přijaté přihlášky',
      pendingEntries: 'Další podané přihlášky',
      payment: 'Platba',
      eventInfo: 'Informace o akci',
      schedule: 'Harmonogram',
      importantNotes: 'Důležité informace',
      closing: 'Závěrečné informace',
      className: 'Třída',
      startNumber: 'Startovní číslo',
      vehicle: 'Vozidlo',
      backupVehicle: 'Náhradní vozidlo',
      codriver: 'Spolujezdec',
      status: 'Stav',
      fee: 'Startovné',
      dueDate: 'Termín',
      recipient: 'Příjemce',
      iban: 'IBAN',
      bic: 'BIC',
      bank: 'Banka',
      reference: 'Platební údaj',
      paddock: 'Depo',
      address: 'Adresa',
      arrival: 'Příjezd',
      access: 'Vjezd',
      organizer: 'Pořadatel',
      contact: 'Kontakt',
      online: 'Online'
    },
    text: {
      greeting: (name: string) => `Dobrý den ${name},`,
      introLine: (eventName: string) => `tímto potvrzujeme přijetí vaší přihlášky na ${eventName}. Níže jsme shrnuli nejdůležitější údaje o vaší přihlášce.`,
      additionalEntriesIntro: 'Pro tuto akci jsou na vaše jméno již přijaty i další přihlášky.',
      entryScopeOnlyHint: 'Toto potvrzení a uvedená částka se vztahují výhradně k níže uvedené přihlášce.',
      entryScopePendingHint:
        'Toto potvrzení a uvedená částka se vztahují výhradně k níže uvedené přihlášce. O dalších přihláškách na vaše jméno bude rozhodnuto a budou účtovány samostatně.',
      entryScopeAcceptedHint:
        'Toto potvrzení a uvedená částka se vztahují výhradně k níže uvedené přihlášce. Pro každou další přijatou přihlášku obdržíte samostatné potvrzení.',
      combinedTransferHint:
        'Budou-li přijaty další přihlášky téhož jezdce, mohou být částky uhrazeny společně.',
      paymentOpenLine: 'Startovné je stále neuhrazené. Prosíme o převod částky včas s uvedeným platebním údajem.',
      paymentPaidLine: 'Vaše platba již byla přijata. Děkujeme.',
      paymentNoAdditionalAmountLine: 'Pro tuto přijatou přihlášku momentálně není splatná žádná další částka.',
      carryLine: 'Prosíme, přivezte si toto potvrzení na akci, v digitální nebo tištěné podobě.',
      paymentIntroOpen: 'Platební údaje jsou uvedeny níže.',
      paymentIntroPaid: 'Vaše platba již byla zaevidována. Platební údaje jsou uvedeny pouze pro evidenci.',
      paymentIntroNoAdditionalAmount: 'Pro tuto přijatou přihlášku nyní není splatná žádná další částka. Níže uvedené údaje slouží pouze pro evidenci.',
      qrCaption: 'GiroCode',
      closingHint: 'Věnujte prosím pozornost níže uvedeným informacím k příjezdu, depu a organizaci. V případě dotazů vám pořadatelský tým rád pomůže.',
      authorityHint: 'Německá verze je pro předložení na akci rozhodující.',
      noAdditionalAmountStatus: 'žádná další částka není splatná'
    }
  },
  pl: {
    locale: 'pl',
    includeTranslatedPage: true,
    translatedTitle: 'Potwierdzenie zgłoszenia',
    issueDateLabel: 'Wystawiono dnia',
    labels: {
      entryDetails: 'Zaakceptowane zgłoszenie',
      additionalEntries: 'Pozostałe zaakceptowane zgłoszenia',
      pendingEntries: 'Pozostałe zgłoszone wpisy',
      payment: 'Płatność',
      eventInfo: 'Informacje o wydarzeniu',
      schedule: 'Terminy',
      importantNotes: 'Ważne informacje',
      closing: 'Informacje końcowe',
      className: 'Klasa',
      startNumber: 'Numer startowy',
      vehicle: 'Pojazd',
      backupVehicle: 'Pojazd rezerwowy',
      codriver: 'Pilot',
      status: 'Status',
      fee: 'Wpisowe',
      dueDate: 'Termin',
      recipient: 'Odbiorca',
      iban: 'IBAN',
      bic: 'BIC',
      bank: 'Bank',
      reference: 'Tytuł przelewu',
      paddock: 'Padok',
      address: 'Adres',
      arrival: 'Dojazd',
      access: 'Wjazd',
      organizer: 'Organizator',
      contact: 'Kontakt',
      online: 'Online'
    },
    text: {
      greeting: (name: string) => `Dzień dobry ${name},`,
      introLine: (eventName: string) => `niniejszym potwierdzamy przyjęcie Twojego zgłoszenia na ${eventName}. Poniżej zebraliśmy najważniejsze informacje dotyczące zgłoszenia.`,
      additionalEntriesIntro: 'Na to wydarzenie zaakceptowano już również inne zgłoszenia na Twoje nazwisko.',
      entryScopeOnlyHint: 'To potwierdzenie i wskazana kwota dotyczą wyłącznie poniższego zgłoszenia.',
      entryScopePendingHint:
        'To potwierdzenie i wskazana kwota dotyczą wyłącznie poniższego zgłoszenia. Pozostałe zgłoszenia na Twoje nazwisko będą rozpatrywane i rozliczane osobno.',
      entryScopeAcceptedHint:
        'To potwierdzenie i wskazana kwota dotyczą wyłącznie poniższego zgłoszenia. Dla każdego kolejnego zaakceptowanego zgłoszenia otrzymasz osobne potwierdzenie.',
      combinedTransferHint:
        'W przypadku akceptacji kolejnych zgłoszeń tego samego kierowcy kwoty mogą zostać opłacone łącznie.',
      paymentOpenLine: 'Wpisowe jest jeszcze nieopłacone. Prosimy o terminowy przelew z podanym tytułem płatności.',
      paymentPaidLine: 'Twoja płatność została już zaksięgowana. Dziękujemy.',
      paymentNoAdditionalAmountLine: 'Dla tego zaakceptowanego zgłoszenia nie ma obecnie żadnej dodatkowej kwoty do zapłaty.',
      carryLine: 'Prosimy o zabranie tego potwierdzenia na wydarzenie, w wersji elektronicznej lub wydrukowanej.',
      paymentIntroOpen: 'Dane do płatności podano poniżej.',
      paymentIntroPaid: 'Twoja płatność została już odnotowana. Dane płatności są pokazane wyłącznie informacyjnie.',
      paymentIntroNoAdditionalAmount: 'Dla tego zaakceptowanego zgłoszenia nie ma obecnie dodatkowej kwoty do zapłaty. Poniższe dane mają wyłącznie charakter informacyjny.',
      qrCaption: 'GiroCode',
      closingHint: 'Prosimy zwrócić uwagę na poniższe informacje dotyczące dojazdu, padoku i organizacji. W razie pytań zespół organizacyjny chętnie pomoże.',
      authorityHint: 'Wersja niemiecka pozostaje wersją obowiązującą do okazania podczas wydarzenia.',
      noAdditionalAmountStatus: 'brak dodatkowej kwoty do zapłaty'
    }
  }
};

export type EntryConfirmationAttachmentRef = {
  documentId: string;
  fileName: string;
  contentType: 'application/pdf';
  s3Key: string;
  fileSizeBytes: number | null;
  source: 'document';
  revisionHash: string;
};

type EntryConfirmationSourcePayload = EntryConfirmationPdfPayload;

const formatCurrencyCents = (value: number | null | undefined): string => {
  const cents = Number.isFinite(value ?? NaN) ? Number(value) : 0;
  return `${(cents / 100).toFixed(2).replace('.', ',')} EUR`;
};

const formatDate = (value: string | Date | null | undefined): string | null => {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return new Intl.DateTimeFormat('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'Europe/Berlin'
  }).format(date);
};

const formatDateTime = (value: string | Date | null | undefined): string | null => {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return new Intl.DateTimeFormat('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Berlin'
  }).format(date);
};

const formatEventDateText = (startsAt: string | Date | null, endsAt: string | Date | null): string => {
  const start = formatDate(startsAt);
  const end = formatDate(endsAt);
  if (start && end) {
    return `${start} - ${end}`;
  }
  return start ?? end ?? 'Termin folgt';
};

const normalizeText = (value: string | null | undefined): string | null => {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
};

const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`);
  return `{${entries.join(',')}}`;
};

const formatVehicleSummary = (input: {
  make: string | null;
  model: string | null;
  year: number | null;
  displacementCcm: number | null;
}): string => {
  const parts = [normalizeText(input.make), normalizeText(input.model)].filter((value): value is string => Boolean(value));
  const meta = [
    Number.isFinite(input.year ?? NaN) ? `Baujahr ${input.year}` : null,
    Number.isFinite(input.displacementCcm ?? NaN) ? `${input.displacementCcm} ccm` : null
  ].filter((value): value is string => Boolean(value));
  if (meta.length > 0) {
    parts.push(`(${meta.join(', ')})`);
  }
  return parts.join(' ');
};

const resolveEntryScopeHint = (
  translation: TranslationConfig,
  input: { hasPendingSiblings: boolean; hasAcceptedSiblings: boolean }
): string => {
  if (input.hasPendingSiblings) {
    return translation.text.entryScopePendingHint;
  }
  if (input.hasAcceptedSiblings) {
    return translation.text.entryScopeAcceptedHint;
  }
  return translation.text.entryScopeOnlyHint;
};

const translateStatus = (
  openAmountCents: number,
  locale: SupportedMailLocale,
  isInvoicePaid: boolean,
  translation: TranslationConfig
): string => {
  if (openAmountCents <= 0 && !isInvoicePaid) {
    return translation.text.noAdditionalAmountStatus;
  }
  if (locale === 'cs') {
    return openAmountCents > 0 ? 'otevřeno' : 'uhrazeno';
  }
  if (locale === 'pl') {
    return openAmountCents > 0 ? 'otwarte' : 'opłacone';
  }
  if (locale === 'en') {
    return openAmountCents > 0 ? 'open' : 'paid';
  }
  return openAmountCents > 0 ? 'offen' : 'bezahlt';
};

const buildEntrySummaryLine = (item: EntrySummary, startNumberLabel: string): string =>
  [item.className, item.startNumber ? `${startNumberLabel} ${item.startNumber}` : null, item.vehicleSummary]
    .filter((value): value is string => Boolean(value))
    .join(' · ');

const buildPayload = async (
  eventId: string,
  entryId: string
): Promise<{ payload: EntryConfirmationSourcePayload; driverPersonId: string } | null> => {
  const db = await getDb();
  const rows = await db
    .select({
      eventName: event.name,
      eventStartsAt: event.startsAt,
      eventEndsAt: event.endsAt,
      eventContactEmail: event.contactEmail,
      eventWebsiteUrl: event.websiteUrl,
      eventEntryConfirmationConfig: event.entryConfirmationConfig,
      className: eventClass.name,
      startNumber: entry.startNumberNorm,
      orgaCode: entry.orgaCode,
      driverPersonId: entry.driverPersonId,
      codriverPersonId: entry.codriverPersonId,
      backupVehicleId: entry.backupVehicleId,
      driverFirstName: person.firstName,
      driverLastName: person.lastName,
      driverStreet: person.street,
      driverZip: person.zip,
      driverCity: person.city,
      driverNationality: person.nationality,
      vehicleMake: vehicle.make,
      vehicleModel: vehicle.model,
      vehicleYear: vehicle.year,
      vehicleDisplacement: vehicle.displacementCcm,
      totalCents: invoice.totalCents,
      pricingSnapshot: invoice.pricingSnapshot,
      paidAmountCents: invoice.paidAmountCents,
      paymentStatus: invoice.paymentStatus,
      earlyDeadline: eventPricingRule.earlyDeadline,
      entryFeeCents: entry.entryFeeCents
    })
    .from(entry)
    .innerJoin(event, eq(entry.eventId, event.id))
    .innerJoin(eventClass, eq(entry.classId, eventClass.id))
    .innerJoin(person, eq(entry.driverPersonId, person.id))
    .leftJoin(vehicle, eq(entry.vehicleId, vehicle.id))
    .leftJoin(invoice, and(eq(invoice.eventId, entry.eventId), eq(invoice.driverPersonId, entry.driverPersonId)))
    .leftJoin(eventPricingRule, eq(eventPricingRule.eventId, entry.eventId))
    .where(and(eq(entry.id, entryId), eq(entry.eventId, eventId), isNull(entry.deletedAt)))
    .limit(1);

  const row = rows[0];
  if (!row) {
    return null;
  }

  const codriverRow = row.codriverPersonId
    ? (
        await db
          .select({
            firstName: person.firstName,
            lastName: person.lastName
          })
          .from(person)
          .where(eq(person.id, row.codriverPersonId))
          .limit(1)
      )[0]
    : null;

  const backupVehicleRow = row.backupVehicleId
    ? (
        await db
          .select({
            make: vehicle.make,
            model: vehicle.model,
            year: vehicle.year,
            displacementCcm: vehicle.displacementCcm
          })
          .from(vehicle)
          .where(eq(vehicle.id, row.backupVehicleId))
          .limit(1)
      )[0]
    : null;

  const acceptedSiblingRows = await db
    .select({
      id: entry.id,
      acceptanceStatus: entry.acceptanceStatus,
      className: eventClass.name,
      startNumber: entry.startNumberNorm,
      vehicleMake: vehicle.make,
      vehicleModel: vehicle.model,
      vehicleYear: vehicle.year,
      vehicleDisplacement: vehicle.displacementCcm
    })
    .from(entry)
    .innerJoin(eventClass, eq(entry.classId, eventClass.id))
    .leftJoin(vehicle, eq(entry.vehicleId, vehicle.id))
    .where(
      and(
        eq(entry.eventId, eventId),
        eq(entry.driverPersonId, row.driverPersonId),
        isNull(entry.deletedAt)
      )
    );

  const globalDefaults = (await getEntryConfirmationDefaults()).config;
  const config = overlayEntryConfirmationConfig(
    overlayEntryConfirmationConfig(buildEntryConfirmationConfigFallback(), globalDefaults),
    row.eventEntryConfirmationConfig ?? {}
  );

  const totalCents = getEntryLineTotalCents(row.pricingSnapshot, entryId) ?? row.entryFeeCents ?? row.totalCents ?? 0;
  const isInvoicePaid = row.paymentStatus === 'paid';
  const paidAmountCents = isInvoicePaid ? totalCents : 0;
  const openAmountCents = Math.max(0, totalCents - paidAmountCents);
  const driverFullName = `${row.driverFirstName} ${row.driverLastName}`.trim();
  const locale = resolveMailLocale({ nationality: row.driverNationality }, 'de');
  const translation = TRANSLATIONS[locale] ?? TRANSLATIONS.en;
  const eventDateText = formatEventDateText(row.eventStartsAt, row.eventEndsAt);
  const paymentReference = buildPaymentReference({
    prefix: config.paymentReferencePrefix,
    orgaCode: row.orgaCode,
    firstName: row.driverFirstName,
    lastName: row.driverLastName
  });
  const paymentDueDate = formatDate(row.earlyDeadline);
  const hasPendingSiblings = acceptedSiblingRows.some(
    (item) => item.id !== entryId && (item.acceptanceStatus === 'pending' || item.acceptanceStatus === 'shortlist')
  );
  const hasAcceptedSiblings = acceptedSiblingRows.some((item) => item.id !== entryId && item.acceptanceStatus === 'accepted');
  const acceptedEntryIds = acceptedSiblingRows
    .filter((item) => item.acceptanceStatus === 'accepted')
    .map((item) => item.id);
  const acceptedEntriesTotalCents = sumEntryLineTotalCents(row.pricingSnapshot, acceptedEntryIds);
  const acceptedEntriesTotal = formatCurrencyCents(acceptedEntriesTotalCents);
  const germanEntryScopeHint = resolveEntryScopeHint(TRANSLATIONS.de, { hasPendingSiblings, hasAcceptedSiblings });
  const translatedEntryScopeHint = resolveEntryScopeHint(translation, { hasPendingSiblings, hasAcceptedSiblings });
  const includeCombinedTransferHint = hasPendingSiblings || hasAcceptedSiblings;
  const germanCombinedTransferHint = hasAcceptedSiblings
    ? `Bei gemeinsamer Überweisung Ihrer bereits zugelassenen Nennungen beträgt der aktuelle Gesamtbetrag ${acceptedEntriesTotal}.`
    : TRANSLATIONS.de.text.combinedTransferHint;
  const translatedCombinedTransferHint = hasAcceptedSiblings
    ? locale === 'en'
      ? `If you pay your already accepted entries together, the current total amount is ${acceptedEntriesTotal}.`
      : locale === 'cs'
        ? `Při společné úhradě vašich již přijatých přihlášek činí aktuální celková částka ${acceptedEntriesTotal}.`
        : locale === 'pl'
          ? `Przy wspólnej płatności za już zaakceptowane zgłoszenia aktualna łączna kwota wynosi ${acceptedEntriesTotal}.`
          : germanCombinedTransferHint
    : translation.text.combinedTransferHint;

  const primaryVehicleSummary = formatVehicleSummary({
    make: row.vehicleMake,
    model: row.vehicleModel,
    year: row.vehicleYear,
    displacementCcm: row.vehicleDisplacement
  });
  const backupVehicleSummary = backupVehicleRow
    ? formatVehicleSummary({
        make: backupVehicleRow.make,
        model: backupVehicleRow.model,
        year: backupVehicleRow.year,
        displacementCcm: backupVehicleRow.displacementCcm
      })
    : null;

  const focusedEntry: EntrySummary = {
    className: row.className,
    startNumber: row.startNumber ?? null,
    vehicleSummary: primaryVehicleSummary
  };
  const additionalAcceptedEntries: EntrySummary[] = acceptedSiblingRows
    .filter((item) => item.id !== entryId && item.acceptanceStatus === 'accepted')
    .map((item) => ({
      className: item.className,
      startNumber: item.startNumber,
      vehicleSummary: formatVehicleSummary({
        make: item.vehicleMake,
        model: item.vehicleModel,
        year: item.vehicleYear,
        displacementCcm: item.vehicleDisplacement
      })
    }))
    .filter((item) => item.className.trim().length > 0 || item.vehicleSummary.trim().length > 0);
  const pendingEntries: EntrySummary[] = acceptedSiblingRows
    .filter((item) => item.id !== entryId && (item.acceptanceStatus === 'pending' || item.acceptanceStatus === 'shortlist'))
    .map((item) => ({
      className: item.className,
      startNumber: item.startNumber,
      vehicleSummary: formatVehicleSummary({
        make: item.vehicleMake,
        model: item.vehicleModel,
        year: item.vehicleYear,
        displacementCcm: item.vehicleDisplacement
      })
    }))
    .filter((item) => item.className.trim().length > 0 || item.vehicleSummary.trim().length > 0);

  const germanPaymentDetails = [
    { label: TRANSLATIONS.de.labels.status, value: translateStatus(openAmountCents, 'de', isInvoicePaid, TRANSLATIONS.de) },
    { label: TRANSLATIONS.de.labels.fee, value: formatCurrencyCents(totalCents) },
    paymentDueDate ? { label: TRANSLATIONS.de.labels.dueDate, value: paymentDueDate } : null,
    normalizeText(config.paymentRecipient) ? { label: TRANSLATIONS.de.labels.recipient, value: config.paymentRecipient as string } : null,
    normalizeText(config.paymentIban) ? { label: TRANSLATIONS.de.labels.iban, value: config.paymentIban as string } : null,
    normalizeText(config.paymentBic) ? { label: TRANSLATIONS.de.labels.bic, value: config.paymentBic as string } : null,
    normalizeText(config.paymentBankName) ? { label: TRANSLATIONS.de.labels.bank, value: config.paymentBankName as string } : null,
    openAmountCents > 0 ? { label: TRANSLATIONS.de.labels.reference, value: paymentReference } : null
  ].filter((item): item is { label: string; value: string } => Boolean(item));

  const translatedPaymentDetails = [
    { label: translation.labels.status, value: translateStatus(openAmountCents, locale, isInvoicePaid, translation) },
    { label: translation.labels.fee, value: formatCurrencyCents(totalCents) },
    paymentDueDate ? { label: translation.labels.dueDate, value: paymentDueDate } : null,
    normalizeText(config.paymentRecipient) ? { label: translation.labels.recipient, value: config.paymentRecipient as string } : null,
    normalizeText(config.paymentIban) ? { label: translation.labels.iban, value: config.paymentIban as string } : null,
    normalizeText(config.paymentBic) ? { label: translation.labels.bic, value: config.paymentBic as string } : null,
    normalizeText(config.paymentBankName) ? { label: translation.labels.bank, value: config.paymentBankName as string } : null,
    openAmountCents > 0 ? { label: translation.labels.reference, value: paymentReference } : null
  ].filter((item): item is { label: string; value: string } => Boolean(item));

  let paymentQrCode: ReturnType<typeof buildGiroCodeMatrix> | null = null;
  const giroCodePayload =
    openAmountCents > 0 && config.paymentRecipient && config.paymentIban && isValidIban(config.paymentIban) && isValidBic(config.paymentBic)
      ? buildGiroCodePayload({
          recipient: config.paymentRecipient,
          iban: config.paymentIban,
          bic: config.paymentBic ?? null,
          amountEur: openAmountCents / 100,
          reference: paymentReference
        })
      : null;
  if (giroCodePayload) {
    paymentQrCode = buildGiroCodeMatrix(giroCodePayload);
  }

  const germanEventInfo = [
    normalizeText(config.paddockInfo) ? { label: TRANSLATIONS.de.labels.paddock, value: config.paddockInfo as string } : null,
    [config.venueName, config.venueStreet, [config.venueZip, config.venueCity].filter(Boolean).join(' ')]
      .filter((value): value is string => Boolean(normalizeText(value)))
      .join('\n')
      .trim()
      ? {
          label: TRANSLATIONS.de.labels.address,
          value: [config.venueName, config.venueStreet, [config.venueZip, config.venueCity].filter(Boolean).join(' ')]
            .filter((value): value is string => Boolean(normalizeText(value)))
            .join('\n')
        }
      : null,
    normalizeText(config.arrivalNotes) ? { label: TRANSLATIONS.de.labels.arrival, value: config.arrivalNotes as string } : null,
    normalizeText(config.accessNotes) ? { label: TRANSLATIONS.de.labels.access, value: config.accessNotes as string } : null
  ].filter((item): item is { label: string; value: string } => Boolean(item));

  const translatedEventInfo = [
    normalizeText(config.paddockInfo) ? { label: translation.labels.paddock, value: config.paddockInfo as string } : null,
    [config.venueName, config.venueStreet, [config.venueZip, config.venueCity].filter(Boolean).join(' ')]
      .filter((value): value is string => Boolean(normalizeText(value)))
      .join('\n')
      .trim()
      ? {
          label: translation.labels.address,
          value: [config.venueName, config.venueStreet, [config.venueZip, config.venueCity].filter(Boolean).join(' ')]
            .filter((value): value is string => Boolean(normalizeText(value)))
            .join('\n')
        }
      : null,
    normalizeText(config.arrivalNotes) ? { label: translation.labels.arrival, value: config.arrivalNotes as string } : null,
    normalizeText(config.accessNotes) ? { label: translation.labels.access, value: config.accessNotes as string } : null
  ].filter((item): item is { label: string; value: string } => Boolean(item));

  const schedule = (config.scheduleItems ?? [])
    .map((item) => {
      const start = formatDateTime(item.startsAt);
      const end = formatDateTime(item.endsAt);
      const timeText = start && end ? `${start} - ${end}` : start ?? end ?? null;
      return [item.label, timeText, normalizeText(item.note)].filter((value): value is string => Boolean(value)).join(': ');
    })
    .filter((value) => value.trim().length > 0);

  const footerLines = [
    normalizeText(config.organizerName) ?? 'MSC Oberlausitzer Dreiländereck e.V.',
    normalizeText(config.organizerContactEmail) ?? DEFAULT_ENTRY_CONTACT_EMAIL,
    normalizeText(config.organizerContactPhone),
    normalizeText(config.websiteUrl) ?? row.eventWebsiteUrl ?? null
  ].filter((value): value is string => Boolean(value));

  const translatedPage = translation.includeTranslatedPage
    ? {
        title: translation.translatedTitle,
        issueDateLabel: translation.issueDateLabel,
        greeting: translation.text.greeting(driverFullName),
        paragraphs: [
          translation.text.introLine(row.eventName),
          additionalAcceptedEntries.length > 0 ? translation.text.additionalEntriesIntro : '',
          translatedEntryScopeHint,
          openAmountCents > 0
            ? translation.text.paymentOpenLine
            : isInvoicePaid
              ? translation.text.paymentPaidLine
              : translation.text.paymentNoAdditionalAmountLine,
          includeCombinedTransferHint ? translatedCombinedTransferHint : '',
          translation.text.carryLine
        ].filter((value) => value.trim().length > 0),
        sectionTitles: {
          entryDetails: translation.labels.entryDetails,
          additionalEntries: translation.labels.additionalEntries,
          pendingEntries: translation.labels.pendingEntries,
          payment: translation.labels.payment,
          eventInfo: translation.labels.eventInfo,
          schedule: translation.labels.schedule,
          importantNotes: translation.labels.importantNotes,
          closing: translation.labels.closing
        },
        focusedEntrySummary: buildEntrySummaryLine(focusedEntry, translation.labels.startNumber),
        additionalEntries:
          additionalAcceptedEntries.length > 0
            ? additionalAcceptedEntries.map((item) => buildEntrySummaryLine(item, translation.labels.startNumber))
            : null,
        pendingEntries:
          pendingEntries.length > 0
            ? pendingEntries.map((item) => buildEntrySummaryLine(item, translation.labels.startNumber))
            : null,
        paymentIntro:
          openAmountCents > 0
            ? translation.text.paymentIntroOpen
            : isInvoicePaid
              ? translation.text.paymentIntroPaid
              : translation.text.paymentIntroNoAdditionalAmount,
        paymentDetails: translatedPaymentDetails,
        eventInfo: translatedEventInfo.length > 0 ? translatedEventInfo : null,
        schedule: schedule.length > 0 ? schedule : null,
        importantNotes: (config.importantNotes ?? []).filter((value) => value.trim().length > 0),
        closingHint: translation.text.closingHint,
        authorityHint: translation.text.authorityHint
      }
    : null;

  return {
    driverPersonId: row.driverPersonId,
    payload: {
      organizer: {
        name: normalizeText(config.organizerName) ?? 'MSC Oberlausitzer Dreiländereck e.V.',
        addressLine: normalizeText(config.organizerAddressLine),
        websiteUrl: normalizeText(config.websiteUrl) ?? row.eventWebsiteUrl ?? null,
        contactEmail: normalizeText(config.organizerContactEmail) ?? DEFAULT_ENTRY_CONTACT_EMAIL,
        contactPhone: normalizeText(config.organizerContactPhone)
      },
      event: {
        title: 'Nennbestätigung',
        name: row.eventName,
        dateText: eventDateText,
        issueDateText: formatDate(new Date()) ?? '',
        gateHeadline: normalizeText(config.gateHeadline),
        locale
      },
      recipient: {
        lines: [
          driverFullName,
          normalizeText(row.driverStreet),
          [normalizeText(row.driverZip), normalizeText(row.driverCity)].filter((value): value is string => Boolean(value)).join(' ')
        ].filter((line): line is string => Boolean(normalizeText(line)))
      },
      intro: {
        greeting: TRANSLATIONS.de.text.greeting(driverFullName),
        paragraphs: [
          TRANSLATIONS.de.text.introLine(row.eventName),
          additionalAcceptedEntries.length > 0 ? TRANSLATIONS.de.text.additionalEntriesIntro : '',
          germanEntryScopeHint,
          openAmountCents > 0
            ? TRANSLATIONS.de.text.paymentOpenLine
            : isInvoicePaid
              ? TRANSLATIONS.de.text.paymentPaidLine
              : TRANSLATIONS.de.text.paymentNoAdditionalAmountLine,
          includeCombinedTransferHint ? germanCombinedTransferHint : '',
          TRANSLATIONS.de.text.carryLine
        ].filter((value) => value.trim().length > 0)
      },
      sections: {
        entryDetails: TRANSLATIONS.de.labels.entryDetails,
        additionalEntries: TRANSLATIONS.de.labels.additionalEntries,
        pendingEntries: TRANSLATIONS.de.labels.pendingEntries,
        payment: TRANSLATIONS.de.labels.payment,
        eventInfo: TRANSLATIONS.de.labels.eventInfo,
        schedule: TRANSLATIONS.de.labels.schedule,
        importantNotes: TRANSLATIONS.de.labels.importantNotes,
        closing: TRANSLATIONS.de.labels.closing
      },
      focusedEntrySummary: buildEntrySummaryLine(focusedEntry, TRANSLATIONS.de.labels.startNumber),
      additionalEntries:
        additionalAcceptedEntries.length > 0
          ? additionalAcceptedEntries.map((item) => buildEntrySummaryLine(item, TRANSLATIONS.de.labels.startNumber))
          : null,
      pendingEntries:
        pendingEntries.length > 0
          ? pendingEntries.map((item) => buildEntrySummaryLine(item, TRANSLATIONS.de.labels.startNumber))
          : null,
      translation: {
        primaryLocale: 'de',
        secondaryLocale: translatedPage ? locale : null,
        authorityHint: translatedPage ? TRANSLATIONS.de.text.authorityHint : null
      },
      translatedPage,
      entryData: [
        { label: TRANSLATIONS.de.labels.className, value: row.className },
        row.startNumber ? { label: TRANSLATIONS.de.labels.startNumber, value: row.startNumber } : null,
        { label: TRANSLATIONS.de.labels.vehicle, value: primaryVehicleSummary },
        backupVehicleSummary ? { label: TRANSLATIONS.de.labels.backupVehicle, value: backupVehicleSummary } : null,
        codriverRow ? { label: TRANSLATIONS.de.labels.codriver, value: `${codriverRow.firstName} ${codriverRow.lastName}`.trim() } : null
      ].filter((item): item is { label: string; value: string } => Boolean(item && normalizeText(item.value))),
      payment:
        germanPaymentDetails.length > 0
          ? {
              intro:
                openAmountCents > 0
                  ? TRANSLATIONS.de.text.paymentIntroOpen
                  : isInvoicePaid
                    ? TRANSLATIONS.de.text.paymentIntroPaid
                    : TRANSLATIONS.de.text.paymentIntroNoAdditionalAmount,
              details: germanPaymentDetails,
              qrCode: paymentQrCode,
              qrCaption: paymentQrCode ? TRANSLATIONS.de.text.qrCaption : null
            }
          : null,
      eventInfo: germanEventInfo.length > 0 ? germanEventInfo : null,
      schedule: schedule.length > 0 ? schedule : null,
      importantNotes: (config.importantNotes ?? []).filter((value) => value.trim().length > 0),
      footer: {
        legalHint: TRANSLATIONS.de.text.closingHint,
        lines: footerLines
      }
    }
  };
};

export const buildEntryConfirmationRevisionHash = (payload: EntryConfirmationSourcePayload): string => {
  const hashPayload = {
    ...payload,
    event: {
      ...payload.event,
      issueDateText: '__generated__'
    },
    payment: payload.payment
      ? {
          ...payload.payment,
          qrCode: payload.payment.qrCode ? '__qr__' : null
        }
      : null
  };
  return createHash('sha256').update(stableStringify(hashPayload)).digest('hex');
};

export const getOrCreateEntryConfirmationAttachment = async (
  eventId: string,
  entryId: string,
  actorUserId: string | null
): Promise<EntryConfirmationAttachmentRef> => {
  const built = await buildPayload(eventId, entryId);
  if (!built) {
    throw new Error('ENTRY_NOT_FOUND');
  }
  const db = await getDb();
  const revisionHash = buildEntryConfirmationRevisionHash(built.payload);

  const existing = await db
    .select({
      id: document.id,
      s3Key: document.s3Key
    })
    .from(document)
    .where(
      and(
        eq(document.eventId, eventId),
        eq(document.entryId, entryId),
        eq(document.type, ENTRY_CONFIRMATION_TYPE),
        eq(document.templateVersion, ENTRY_CONFIRMATION_TEMPLATE_VERSION),
        eq(document.templateVariant, revisionHash),
        eq(document.status, 'generated')
      )
    )
    .orderBy(desc(document.createdAt))
    .limit(1);

  if (existing[0]) {
    return {
      documentId: existing[0].id,
      fileName: ENTRY_CONFIRMATION_FILE_NAME,
      contentType: 'application/pdf',
      s3Key: existing[0].s3Key,
      fileSizeBytes: null,
      source: 'document',
      revisionHash
    };
  }

  const logoImage = await getAssetObjectBuffer(MAIL_LOGO_KEY);
  const regularFont = await getAssetObjectBuffer(MAIL_FONT_REGULAR_KEY);
  const boldFont = await getAssetObjectBuffer(MAIL_FONT_BOLD_KEY);
  const pdfBuffer = await renderEntryConfirmationPdf({
    ...built.payload,
    fonts: {
      regular: regularFont,
      bold: boldFont
    },
    organizer: {
      ...built.payload.organizer,
      logoImage
    }
  });
  const pdfSha256 = createHash('sha256').update(pdfBuffer).digest('hex');
  const s3Key = `documents/${eventId}/${entryId}/entry_confirmation/${revisionHash}/${ENTRY_CONFIRMATION_TEMPLATE_VERSION}/${randomUUID()}.pdf`;
  await uploadPdf(s3Key, pdfBuffer);

  const inserted = await db
    .insert(document)
    .values({
      eventId,
      entryId,
      driverPersonId: built.driverPersonId,
      type: ENTRY_CONFIRMATION_TYPE,
      templateVariant: revisionHash,
      templateVersion: ENTRY_CONFIRMATION_TEMPLATE_VERSION,
      sha256: pdfSha256,
      s3Key,
      status: 'generated',
      createdBy: actorUserId
    })
    .returning({ id: document.id });

  const documentId = inserted[0]?.id;
  if (!documentId) {
    throw new Error('ENTRY_CONFIRMATION_DOCUMENT_INSERT_FAILED');
  }

  await db.insert(documentGenerationJob).values({
    documentId,
    status: 'succeeded'
  });

  await writeAuditLog(db as never, {
    eventId,
    actorUserId,
    action: 'document_generated',
    entityType: 'document',
    entityId: documentId,
    payload: {
      entryId,
      type: ENTRY_CONFIRMATION_TYPE,
      templateVersion: ENTRY_CONFIRMATION_TEMPLATE_VERSION,
      revisionHash
    }
  });

  return {
    documentId,
    fileName: ENTRY_CONFIRMATION_FILE_NAME,
    contentType: 'application/pdf',
    s3Key,
    fileSizeBytes: pdfBuffer.length,
    source: 'document',
    revisionHash
  };
};
