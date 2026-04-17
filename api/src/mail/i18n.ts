export type SupportedMailLocale = 'de' | 'cs' | 'pl' | 'en';

const SUPPORTED: Set<SupportedMailLocale> = new Set(['de', 'cs', 'pl', 'en']);

const normalizeLocaleCandidate = (value: string): string => value.trim().toLowerCase().replace('_', '-').split('-')[0] ?? '';

export const normalizeMailLocale = (value: unknown): SupportedMailLocale | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = normalizeLocaleCandidate(value);
  if (!normalized) {
    return null;
  }
  if (SUPPORTED.has(normalized as SupportedMailLocale)) {
    return normalized as SupportedMailLocale;
  }
  return 'en';
};

export const resolveMailLocale = (data: Record<string, unknown>, defaultLocale: SupportedMailLocale = 'de'): SupportedMailLocale => {
  const explicit =
    normalizeMailLocale(data.locale) ??
    normalizeMailLocale(data.preferredLanguage) ??
    normalizeMailLocale(data.language);
  if (explicit) {
    return explicit;
  }
  return defaultLocale;
};

type MailChromeCopy = {
  highlightsTitle: string;
  detailsTitle: string;
  nextStepsTitle: string;
  paymentDeadlineTitle: string;
  organizerNoteTitle: string;
  entryContextTitle: string;
  codriverEntryContextTitle: string;
  fallbackGreeting: string;
  replyHint: string;
  impressumLabel: string;
  privacyLabel: string;
  signoffLead: string;
  signoffLine1: string;
  signoffLine2: string;
  signoffLine3: string;
  verificationCta: string;
  confirmationReminderCta: string;
  ctaFallbackPrefix: string;
};

const CHROME_COPY: Record<SupportedMailLocale, MailChromeCopy> = {
  de: {
    highlightsTitle: 'Highlights',
    detailsTitle: 'Details',
    nextStepsTitle: 'Nächste Schritte',
    paymentDeadlineTitle: 'Zahlungsfrist',
    organizerNoteTitle: 'Hinweis vom Veranstalter',
    entryContextTitle: 'Deine Anmeldung',
    codriverEntryContextTitle: 'Eintragung als Beifahrer',
    fallbackGreeting: 'Hallo',
    replyHint: 'Bei Fragen antworte einfach auf diese E-Mail.',
    impressumLabel: 'Impressum',
    privacyLabel: 'Datenschutz',
    signoffLead: 'Wir freuen uns auf dich.',
    signoffLine1: 'Mit freundlichen Grüßen',
    signoffLine2: 'Dein Orga-Team',
    signoffLine3: 'MSC Oberlausitzer Dreiländereck e.V.',
    verificationCta: 'E-Mail-Adresse bestätigen',
    confirmationReminderCta: 'Jetzt bestätigen',
    ctaFallbackPrefix: 'Falls der Button nicht funktioniert:'
  },
  en: {
    highlightsTitle: 'Highlights',
    detailsTitle: 'Details',
    nextStepsTitle: 'Next steps',
    paymentDeadlineTitle: 'Payment deadline',
    organizerNoteTitle: 'Organizer note',
    entryContextTitle: 'Your registration',
    codriverEntryContextTitle: 'Codriver assignment',
    fallbackGreeting: 'Hello',
    replyHint: 'If you have any questions, simply reply to this email.',
    impressumLabel: 'Legal notice',
    privacyLabel: 'Privacy',
    signoffLead: 'We are looking forward to seeing you.',
    signoffLine1: 'Kind regards',
    signoffLine2: 'Your organizer team',
    signoffLine3: 'MSC Oberlausitzer Dreiländereck e.V.',
    verificationCta: 'Confirm email address',
    confirmationReminderCta: 'Confirm now',
    ctaFallbackPrefix: 'If the button does not work:'
  },
  cs: {
    highlightsTitle: 'Hlavní body',
    detailsTitle: 'Detaily',
    nextStepsTitle: 'Další kroky',
    paymentDeadlineTitle: 'Termín platby',
    organizerNoteTitle: 'Poznámka pořadatele',
    entryContextTitle: 'Vaše přihláška',
    codriverEntryContextTitle: 'Zařazení jako spolujezdec',
    fallbackGreeting: 'Dobrý den',
    replyHint: 'V případě dotazů stačí odpovědět na tento e-mail.',
    impressumLabel: 'Impresum',
    privacyLabel: 'Ochrana údajů',
    signoffLead: 'Těšíme se na vás.',
    signoffLine1: 'S pozdravem',
    signoffLine2: 'Váš organizační tým',
    signoffLine3: 'MSC Oberlausitzer Dreiländereck e.V.',
    verificationCta: 'Potvrdit e-mailovou adresu',
    confirmationReminderCta: 'Potvrdit nyní',
    ctaFallbackPrefix: 'Pokud tlačítko nefunguje:'
  },
  pl: {
    highlightsTitle: 'Najważniejsze informacje',
    detailsTitle: 'Szczegóły',
    nextStepsTitle: 'Kolejne kroki',
    paymentDeadlineTitle: 'Termin płatności',
    organizerNoteTitle: 'Informacja od organizatora',
    entryContextTitle: 'Twoje zgłoszenie',
    codriverEntryContextTitle: 'Wpis jako pilot',
    fallbackGreeting: 'Dzień dobry',
    replyHint: 'W razie pytań wystarczy odpowiedzieć na tę wiadomość.',
    impressumLabel: 'Impressum',
    privacyLabel: 'Polityka prywatności',
    signoffLead: 'Cieszymy się na spotkanie z Tobą.',
    signoffLine1: 'Z pozdrowieniami',
    signoffLine2: 'Zespół organizacyjny',
    signoffLine3: 'MSC Oberlausitzer Dreiländereck e.V.',
    verificationCta: 'Potwierdź adres e-mail',
    confirmationReminderCta: 'Potwierdź teraz',
    ctaFallbackPrefix: 'Jeśli przycisk nie działa:'
  }
};

export const getMailChromeCopy = (locale: SupportedMailLocale): MailChromeCopy => CHROME_COPY[locale] ?? CHROME_COPY.en;

type ProcessCopy = {
  subjectTemplate: string;
  bodyTextTemplate: string;
  headerTitle: string;
  preheader: string;
};

type ProcessTemplateKey =
  | 'registration_received'
  | 'email_confirmation_reminder'
  | 'accepted_open_payment'
  | 'payment_reminder'
  | 'accepted_paid_completed'
  | 'rejected';

const PROCESS_COPY: Record<SupportedMailLocale, Record<ProcessTemplateKey, ProcessCopy>> = {
  de: {
    registration_received: {
      subjectTemplate: 'Anmeldung eingegangen - {{eventName}}',
      headerTitle: 'Anmeldung eingegangen',
      preheader: 'Wir haben deine Nennung erhalten',
      bodyTextTemplate:
        '{{fallbackGreeting}} {{driverName}},\n\n' +
        'deine Nennung für das {{eventName}} ist bei uns eingegangen. Bitte bestätige jetzt deine E-Mail-Adresse über den gelben Button.\n\n' +
        '{{registrationNextStepText}}'
    },
    email_confirmation_reminder: {
      subjectTemplate: 'Erinnerung: E-Mail bestätigen - {{eventName}}',
      headerTitle: 'E-Mail-Bestätigung fehlt',
      preheader: 'Bitte bestätige deine E-Mail-Adresse',
      bodyTextTemplate:
        '{{fallbackGreeting}} {{driverName}},\n\n' +
        'deine Nennung für das {{eventName}} ist noch nicht bestätigt. Bitte bestätige deine E-Mail-Adresse jetzt.\n\n' +
        '{{registrationNextStepText}}\n\n' +
        'Ohne Bestätigung können wir deine Nennung nicht abschließend bearbeiten.'
    },
    accepted_open_payment: {
      subjectTemplate: 'Zulassung bestätigt - {{eventName}}',
      headerTitle: 'Zugelassen · Zahlung offen',
      preheader: 'Deine Nennung ist zugelassen',
      bodyTextTemplate:
        '{{fallbackGreeting}} {{driverName}},\n\n' +
        'Folgende Nennung wurde für das {{eventName}} zugelassen:\n{{acceptedEntrySummaryText}}\n\n' +
        '{{entryScopeHint}}\n\n' +
        '{{paymentInstructionText}}\n\n' +
        '{{combinedTransferHint}}\n\n' +
        'Die angehängte Nennbestätigung enthält alle weiteren Angaben zur Zulassung.'
    },
    accepted_paid_completed: {
      subjectTemplate: 'Nennung vollständig - {{eventName}}',
      headerTitle: 'Zugelassen · Bezahlt',
      preheader: 'Deine Nennung ist vollständig abgeschlossen',
      bodyTextTemplate:
        '{{fallbackGreeting}} {{driverName}},\n\n' +
        'vielen Dank, deine Zahlung ist vollständig eingegangen und deine Nennung für das {{eventName}} ist jetzt komplett abgeschlossen.\n\n' +
        'Damit ist alles erledigt. Du kannst dich jetzt auf die Veranstaltung freuen.'
    },
    payment_reminder: {
      subjectTemplate: 'Zahlungserinnerung - {{eventName}}',
      headerTitle: 'Zahlungserinnerung',
      preheader: 'Bitte schließe deine Zahlung ab',
      bodyTextTemplate:
        '{{fallbackGreeting}} {{driverName}},\n\n' +
        'für deine zugelassene Nennung zum {{eventName}} ist aktuell noch ein Betrag offen.\n\n' +
        '{{paymentInstructionText}}'
    },
    rejected: {
      subjectTemplate: 'Status deiner Nennung - {{eventName}}',
      headerTitle: 'Status-Update',
      preheader: 'Aktueller Stand zu deiner Nennung',
      bodyTextTemplate:
        '{{fallbackGreeting}} {{driverName}},\n\n' +
        'Folgende Nennung können wir für das {{eventName}} aktuell leider nicht berücksichtigen:\n{{rejectedEntrySummaryText}}\n\n' +
        '{{rejectionScopeHint}}\n\n' +
        'Wenn du Rückfragen hast, antworte einfach auf diese E-Mail.'
    }
  },
  en: {
    registration_received: {
      subjectTemplate: 'Registration received - {{eventName}}',
      headerTitle: 'Registration received',
      preheader: 'We have received your entry',
      bodyTextTemplate:
        '{{fallbackGreeting}} {{driverName}},\n\n' +
        'we have received your entry for the {{eventName}}. Please confirm your email address using the yellow button.\n\n' +
        '{{registrationNextStepText}}'
    },
    email_confirmation_reminder: {
      subjectTemplate: 'Reminder: confirm your email - {{eventName}}',
      headerTitle: 'Email confirmation pending',
      preheader: 'Please confirm your email address',
      bodyTextTemplate:
        '{{fallbackGreeting}} {{driverName}},\n\n' +
        'your entry for the {{eventName}} is still unconfirmed. Please confirm your email address now.\n\n' +
        '{{registrationNextStepText}}\n\n' +
        'Without confirmation, we cannot finish processing your entry.'
    },
    accepted_open_payment: {
      subjectTemplate: 'Acceptance confirmed - {{eventName}}',
      headerTitle: 'Accepted · Payment pending',
      preheader: 'Your entry has been accepted',
      bodyTextTemplate:
        '{{fallbackGreeting}} {{driverName}},\n\n' +
        'The following entry has been accepted for the {{eventName}}:\n{{acceptedEntrySummaryText}}\n\n' +
        '{{entryScopeHint}}\n\n' +
        '{{paymentInstructionText}}\n\n' +
        '{{combinedTransferHint}}\n\n' +
        'The attached PDF entry confirmation contains all further details regarding your acceptance.'
    },
    accepted_paid_completed: {
      subjectTemplate: 'Registration completed - {{eventName}}',
      headerTitle: 'Accepted · Paid',
      preheader: 'Your entry is fully completed',
      bodyTextTemplate:
        '{{fallbackGreeting}} {{driverName}},\n\n' +
        'thank you, we have received your payment in full and your entry for the {{eventName}} is now fully completed.\n\n' +
        'Everything is settled. You can now look forward to the event.'
    },
    payment_reminder: {
      subjectTemplate: 'Payment reminder - {{eventName}}',
      headerTitle: 'Payment reminder',
      preheader: 'Please complete your payment',
      bodyTextTemplate:
        '{{fallbackGreeting}} {{driverName}},\n\n' +
        'there is still an outstanding amount for your accepted entry to the {{eventName}}.\n\n' +
        '{{paymentInstructionText}}'
    },
    rejected: {
      subjectTemplate: 'Status update for your registration - {{eventName}}',
      headerTitle: 'Status update',
      preheader: 'Current status of your entry',
      bodyTextTemplate:
        '{{fallbackGreeting}} {{driverName}},\n\n' +
        'Unfortunately, we cannot accept the following entry for the {{eventName}} at this time:\n{{rejectedEntrySummaryText}}\n\n' +
        '{{rejectionScopeHint}}\n\n' +
        'If you have any questions, simply reply to this email.'
    }
  },
  cs: {
    registration_received: {
      subjectTemplate: 'Přihláška přijata - {{eventName}}',
      headerTitle: 'Přihláška přijata',
      preheader: 'Vaši přihlášku jsme obdrželi',
      bodyTextTemplate:
        '{{fallbackGreeting}} {{driverName}},\n\n' +
        'obdrželi jsme vaši přihlášku pro {{eventName}}. Potvrďte prosím svou e-mailovou adresu pomocí tlačítka.\n\n' +
        '{{registrationNextStepText}}'
    },
    email_confirmation_reminder: {
      subjectTemplate: 'Připomínka: potvrďte e-mail - {{eventName}}',
      headerTitle: 'Chybí potvrzení e-mailu',
      preheader: 'Potvrďte prosím svůj e-mail',
      bodyTextTemplate:
        '{{fallbackGreeting}} {{driverName}},\n\n' +
        'vaše přihláška pro {{eventName}} ještě není potvrzena. Potvrďte prosím svůj e-mail nyní.\n\n' +
        '{{registrationNextStepText}}\n\n' +
        'Bez potvrzení nelze přihlášku finálně zpracovat.'
    },
    accepted_open_payment: {
      subjectTemplate: 'Přijetí potvrzeno - {{eventName}}',
      headerTitle: 'Přijato · platba otevřená',
      preheader: 'Vaše přihláška byla přijata',
      bodyTextTemplate:
        '{{fallbackGreeting}} {{driverName}},\n\n' +
        'Pro {{eventName}} byla přijata tato přihláška:\n{{acceptedEntrySummaryText}}\n\n' +
        '{{entryScopeHint}}\n\n' +
        '{{paymentInstructionText}}\n\n' +
        '{{combinedTransferHint}}\n\n' +
        'Přiložené PDF potvrzení přihlášky obsahuje všechny další podrobnosti o přijetí.'
    },
    accepted_paid_completed: {
      subjectTemplate: 'Přihláška dokončena - {{eventName}}',
      headerTitle: 'Přijato · zaplaceno',
      preheader: 'Vaše přihláška je kompletní',
      bodyTextTemplate:
        '{{fallbackGreeting}} {{driverName}},\n\n' +
        'děkujeme, vaše platba byla plně přijata a vaše přihláška pro {{eventName}} je nyní kompletní.\n\n' +
        'Tím je vše vyřízeno. Na akci se nyní můžete těšit.'
    },
    payment_reminder: {
      subjectTemplate: 'Připomínka platby - {{eventName}}',
      headerTitle: 'Připomínka platby',
      preheader: 'Prosíme o dokončení platby',
      bodyTextTemplate:
        '{{fallbackGreeting}} {{driverName}},\n\n' +
        'u vaší přijaté přihlášky pro {{eventName}} je stále evidována otevřená částka.\n\n' +
        '{{paymentInstructionText}}'
    },
    rejected: {
      subjectTemplate: 'Stav vaší přihlášky - {{eventName}}',
      headerTitle: 'Aktualizace stavu',
      preheader: 'Aktuální stav vaší přihlášky',
      bodyTextTemplate:
        '{{fallbackGreeting}} {{driverName}},\n\n' +
        'Bohužel nyní nemůžeme pro {{eventName}} přijmout tuto přihlášku:\n{{rejectedEntrySummaryText}}\n\n' +
        '{{rejectionScopeHint}}\n\n' +
        'V případě dotazů stačí odpovědět na tento e-mail.'
    }
  },
  pl: {
    registration_received: {
      subjectTemplate: 'Zgłoszenie otrzymane - {{eventName}}',
      headerTitle: 'Zgłoszenie otrzymane',
      preheader: 'Otrzymaliśmy Twoje zgłoszenie',
      bodyTextTemplate:
        '{{fallbackGreeting}} {{driverName}},\n\n' +
        'otrzymaliśmy Twoje zgłoszenie na {{eventName}}. Potwierdź proszę adres e-mail przyciskiem.\n\n' +
        '{{registrationNextStepText}}'
    },
    email_confirmation_reminder: {
      subjectTemplate: 'Przypomnienie: potwierdź e-mail - {{eventName}}',
      headerTitle: 'Brak potwierdzenia e-mail',
      preheader: 'Potwierdź adres e-mail',
      bodyTextTemplate:
        '{{fallbackGreeting}} {{driverName}},\n\n' +
        'Twoje zgłoszenie na {{eventName}} nadal nie jest potwierdzone. Potwierdź teraz adres e-mail.\n\n' +
        '{{registrationNextStepText}}\n\n' +
        'Bez potwierdzenia nie możemy zakończyć procesu zgłoszenia.'
    },
    accepted_open_payment: {
      subjectTemplate: 'Akceptacja potwierdzona - {{eventName}}',
      headerTitle: 'Zaakceptowano · płatność otwarta',
      preheader: 'Twoje zgłoszenie zostało zaakceptowane',
      bodyTextTemplate:
        '{{fallbackGreeting}} {{driverName}},\n\n' +
        'Na {{eventName}} zaakceptowano następujące zgłoszenie:\n{{acceptedEntrySummaryText}}\n\n' +
        '{{entryScopeHint}}\n\n' +
        '{{paymentInstructionText}}\n\n' +
        '{{combinedTransferHint}}\n\n' +
        'Załączone potwierdzenie PDF zawiera wszystkie dalsze informacje dotyczące akceptacji.'
    },
    accepted_paid_completed: {
      subjectTemplate: 'Zgłoszenie zakończone - {{eventName}}',
      headerTitle: 'Zaakceptowano · opłacono',
      preheader: 'Twoje zgłoszenie jest kompletne',
      bodyTextTemplate:
        '{{fallbackGreeting}} {{driverName}},\n\n' +
        'dziękujemy, Twoja płatność została w pełni zaksięgowana, a Twoje zgłoszenie na {{eventName}} jest teraz całkowicie zakończone.\n\n' +
        'Wszystko jest już załatwione. Możesz teraz cieszyć się oczekiwaniem na wydarzenie.'
    },
    payment_reminder: {
      subjectTemplate: 'Przypomnienie o płatności - {{eventName}}',
      headerTitle: 'Przypomnienie o płatności',
      preheader: 'Prosimy o dokończenie płatności',
      bodyTextTemplate:
        '{{fallbackGreeting}} {{driverName}},\n\n' +
        'dla Twojego zaakceptowanego zgłoszenia na {{eventName}} nadal widnieje otwarta kwota.\n\n' +
        '{{paymentInstructionText}}'
    },
    rejected: {
      subjectTemplate: 'Status Twojego zgłoszenia - {{eventName}}',
      headerTitle: 'Aktualizacja statusu',
      preheader: 'Aktualny status Twojego zgłoszenia',
      bodyTextTemplate:
        '{{fallbackGreeting}} {{driverName}},\n\n' +
        'Niestety obecnie nie możemy przyjąć na {{eventName}} następującego zgłoszenia:\n{{rejectedEntrySummaryText}}\n\n' +
        '{{rejectionScopeHint}}\n\n' +
        'W razie pytań po prostu odpowiedz na tę wiadomość.'
    }
  }
};

export const getProcessTemplateCopy = (
  templateKey: ProcessTemplateKey,
  locale: SupportedMailLocale
): ProcessCopy => {
  const byLocale = PROCESS_COPY[locale] ?? PROCESS_COPY.en;
  return byLocale[templateKey] ?? PROCESS_COPY.en[templateKey];
};
