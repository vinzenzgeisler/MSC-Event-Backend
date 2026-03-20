import { PLACEHOLDER_CATALOG, REQUIRED_PLACEHOLDERS_BY_TEMPLATE } from './placeholders';

export type MailRenderOptions = {
  showBadge?: boolean;
  mailLabel?: string | null;
  includeEntryContext?: boolean;
};

export type ComposerFieldType = 'text' | 'url';

export type ComposerField = {
  key: string;
  label: string;
  type: ComposerFieldType;
  required: boolean;
  multiline: boolean;
  placeholder: string;
  helpText: string;
  defaultValue?: string;
};

export type TemplateComposerContract = {
  enabled: boolean;
  fields: ComposerField[];
  allowedPlaceholders: string[];
  requiredPlaceholders: string[];
};

export type TemplateContract = {
  scope: 'campaign' | 'process';
  channels: string[];
  composer: TemplateComposerContract;
  renderOptions: {
    showBadgeDefault: boolean;
    defaultMailLabel: string | null;
    includeEntryContextDefault: boolean;
  };
};

const CAMPAIGN_TEXT_BASE_FIELDS: ComposerField[] = [
  {
    key: 'introText',
    label: 'Einleitung',
    type: 'text',
    required: false,
    multiline: true,
    placeholder: 'Kurze Einleitung',
    helpText: 'Wird oberhalb der Details gerendert.'
  },
  {
    key: 'detailsText',
    label: 'Details',
    type: 'text',
    required: false,
    multiline: true,
    placeholder: 'Weitere Informationen',
    helpText: 'Hauptinhalt der Mitteilung.'
  },
  {
    key: 'closingText',
    label: 'Abschluss',
    type: 'text',
    required: false,
    multiline: true,
    placeholder: 'Viele Grüße, euer Team',
    helpText: 'Wird als Abschluss unterhalb der Details gerendert.'
  }
];

const CAMPAIGN_CTA_FIELDS: ComposerField[] = [
  {
    key: 'ctaText',
    label: 'CTA Text',
    type: 'text',
    required: false,
    multiline: false,
    placeholder: 'Mehr erfahren',
    helpText: 'Optionaler Button-Text.'
  },
  {
    key: 'ctaUrl',
    label: 'CTA URL',
    type: 'url',
    required: false,
    multiline: false,
    placeholder: 'https://...',
    helpText: 'Optionaler Button-Link. Ohne URL wird kein CTA angezeigt.'
  }
];

const CAMPAIGN_ALLOWED_PLACEHOLDERS = [
  'eventName',
  'locale',
  'preheader',
  'firstName',
  'lastName',
  'driverName',
  'className',
  'startNumber',
  'amountOpen',
  'verificationUrl',
  'introText',
  'detailsText',
  'closingText',
  'ctaText',
  'ctaUrl',
  'paymentDeadline',
  'heroImageUrl',
  'heroEyebrow',
  'heroSubtitle',
  'highlights',
  'logoUrl',
  'vehicleLabel',
  'headerTitle',
  'fallbackGreeting'
];

const makeCampaignContract = (overrides?: {
  requiredPlaceholders?: string[];
  additionalFields?: ComposerField[];
  includeCtaFields?: boolean;
  includeEntryContextDefault?: boolean;
}): TemplateContract => {
  const requiredPlaceholders = overrides?.requiredPlaceholders ?? [];
  const includeCtaFields = overrides?.includeCtaFields ?? true;
  return {
    scope: 'campaign',
    channels: ['campaign'],
    composer: {
      enabled: true,
      fields: [
        ...CAMPAIGN_TEXT_BASE_FIELDS,
        ...(includeCtaFields ? CAMPAIGN_CTA_FIELDS : []),
        ...(overrides?.additionalFields ?? [])
      ],
      allowedPlaceholders: CAMPAIGN_ALLOWED_PLACEHOLDERS,
      requiredPlaceholders
    },
    renderOptions: {
      showBadgeDefault: false,
      defaultMailLabel: null,
      includeEntryContextDefault: overrides?.includeEntryContextDefault ?? false
    }
  };
};

const makeProcessContract = (overrides?: {
  requiredPlaceholders?: string[];
  includeEntryContextDefault?: boolean;
  showBadgeDefault?: boolean;
  defaultMailLabel?: string | null;
}): TemplateContract => ({
  scope: 'process',
  channels: ['detail', 'quick_action'],
  composer: {
    enabled: false,
    fields: [],
    allowedPlaceholders: PLACEHOLDER_CATALOG.map((item) => item.name),
    requiredPlaceholders: overrides?.requiredPlaceholders ?? []
  },
  renderOptions: {
    showBadgeDefault: overrides?.showBadgeDefault ?? false,
    defaultMailLabel: overrides?.defaultMailLabel ?? null,
    includeEntryContextDefault: overrides?.includeEntryContextDefault ?? true
  }
});

const PROCESS_DEFAULT_CONTRACT: TemplateContract = {
  scope: 'process',
  channels: ['detail', 'quick_action'],
  composer: {
    enabled: false,
    fields: [],
    allowedPlaceholders: PLACEHOLDER_CATALOG.map((item) => item.name),
    requiredPlaceholders: []
  },
  renderOptions: {
    showBadgeDefault: false,
    defaultMailLabel: null,
    includeEntryContextDefault: true
  }
};

const CONTRACTS: Record<string, TemplateContract> = {
  newsletter: makeCampaignContract({
    requiredPlaceholders: REQUIRED_PLACEHOLDERS_BY_TEMPLATE.newsletter ?? [],
    additionalFields: [
      {
        key: 'heroImageUrl',
        label: 'Hero Bild URL',
        type: 'url',
        required: true,
        multiline: false,
        placeholder: 'https://...',
        helpText: 'Headerbild für den Newsletter.'
      },
      {
        key: 'highlights',
        label: 'Highlights',
        type: 'text',
        required: false,
        multiline: true,
        placeholder: 'Punkt 1\\nPunkt 2',
        helpText: 'Je Zeile ein Highlight.'
      },
      {
        key: 'heroEyebrow',
        label: 'Hero Eyebrow',
        type: 'text',
        required: false,
        multiline: false,
        placeholder: 'MSC OBERLAUSITZ',
        helpText: 'Kleine Überschrift über dem Eventnamen.'
      },
      {
        key: 'heroSubtitle',
        label: 'Hero Untertitel',
        type: 'text',
        required: false,
        multiline: false,
        placeholder: 'Aktuelles rund um dein Rennen',
        helpText: 'Untertitel im Header.'
      }
    ],
    includeEntryContextDefault: true
  }),
  event_update: makeCampaignContract({
    requiredPlaceholders: REQUIRED_PLACEHOLDERS_BY_TEMPLATE.event_update ?? [],
    additionalFields: [
      {
        key: 'heroImageUrl',
        label: 'Hero Bild URL',
        type: 'url',
        required: false,
        multiline: false,
        placeholder: 'https://...',
        helpText: 'Optionales Headerbild.'
      },
      {
        key: 'highlights',
        label: 'Highlights',
        type: 'text',
        required: false,
        multiline: true,
        placeholder: 'Punkt 1\\nPunkt 2',
        helpText: 'Je Zeile ein Highlight.'
      }
    ],
    includeEntryContextDefault: true
  }),
  free_form: makeCampaignContract({
    requiredPlaceholders: REQUIRED_PLACEHOLDERS_BY_TEMPLATE.free_form ?? [],
    includeEntryContextDefault: false
  }),
  payment_reminder_followup: makeCampaignContract({
    requiredPlaceholders: REQUIRED_PLACEHOLDERS_BY_TEMPLATE.payment_reminder_followup ?? [],
    additionalFields: [
      {
        key: 'paymentDeadline',
        label: 'Zahlungsfrist',
        type: 'text',
        required: false,
        multiline: false,
        placeholder: '15.04.2026',
        helpText: 'Frist der erneuten Zahlungsaufforderung.'
      }
    ],
    includeEntryContextDefault: true
  }),
  preselection: makeProcessContract({
    requiredPlaceholders: REQUIRED_PLACEHOLDERS_BY_TEMPLATE.preselection ?? [],
    includeEntryContextDefault: true
  }),
  accepted_open_payment: makeProcessContract({
    requiredPlaceholders: REQUIRED_PLACEHOLDERS_BY_TEMPLATE.accepted_open_payment ?? [],
    includeEntryContextDefault: true
  }),
  accepted_paid_completed: makeProcessContract({
    requiredPlaceholders: REQUIRED_PLACEHOLDERS_BY_TEMPLATE.accepted_paid_completed ?? [],
    includeEntryContextDefault: true
  }),
  email_confirmation_reminder: makeProcessContract({
    requiredPlaceholders: REQUIRED_PLACEHOLDERS_BY_TEMPLATE.email_confirmation_reminder ?? [],
    includeEntryContextDefault: true
  }),
  email_confirmation: makeProcessContract({
    requiredPlaceholders: REQUIRED_PLACEHOLDERS_BY_TEMPLATE.email_confirmation ?? [],
    includeEntryContextDefault: false
  }),
  payment_reminder: makeProcessContract({
    requiredPlaceholders: REQUIRED_PLACEHOLDERS_BY_TEMPLATE.payment_reminder ?? [],
    includeEntryContextDefault: true
  }),
  rejected: makeProcessContract({
    requiredPlaceholders: REQUIRED_PLACEHOLDERS_BY_TEMPLATE.rejected ?? [],
    includeEntryContextDefault: false
  }),
  registration_received: makeProcessContract({
    requiredPlaceholders: REQUIRED_PLACEHOLDERS_BY_TEMPLATE.registration_received ?? [],
    includeEntryContextDefault: true,
    showBadgeDefault: false,
    defaultMailLabel: null
  }),
  codriver_info: makeProcessContract({
    requiredPlaceholders: REQUIRED_PLACEHOLDERS_BY_TEMPLATE.codriver_info ?? [],
    includeEntryContextDefault: true,
    showBadgeDefault: false,
    defaultMailLabel: null
  })
};

export const CAMPAIGN_TEMPLATE_KEYS = new Set(
  Object.entries(CONTRACTS)
    .filter(([, contract]) => contract.scope === 'campaign')
    .map(([key]) => key)
);

export const getTemplateContract = (templateKey: string): TemplateContract => {
  const contract = CONTRACTS[templateKey];
  if (!contract) {
    const requiredPlaceholders = REQUIRED_PLACEHOLDERS_BY_TEMPLATE[templateKey] ?? [];
    return {
      ...PROCESS_DEFAULT_CONTRACT,
      composer: {
        ...PROCESS_DEFAULT_CONTRACT.composer,
        requiredPlaceholders
      }
    };
  }
  return contract;
};
