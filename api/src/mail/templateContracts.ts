import { PLACEHOLDER_CATALOG, REQUIRED_PLACEHOLDERS_BY_TEMPLATE } from './placeholders';

export type MailRenderOptions = {
  showBadge?: boolean;
  mailLabel?: string | null;
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
  };
};

const CAMPAIGN_FIELDS_BASE: ComposerField[] = [
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
    placeholder: 'Viele Gruesse, euer Team',
    helpText: 'Wird als Abschluss unterhalb der Details gerendert.'
  },
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
  'paymentDeadline'
];

const makeCampaignContract = (overrides?: {
  requiredPlaceholders?: string[];
  additionalFields?: ComposerField[];
}): TemplateContract => {
  const requiredPlaceholders = overrides?.requiredPlaceholders ?? [];
  return {
    scope: 'campaign',
    channels: ['campaign'],
    composer: {
      enabled: true,
      fields: [...CAMPAIGN_FIELDS_BASE, ...(overrides?.additionalFields ?? [])],
      allowedPlaceholders: CAMPAIGN_ALLOWED_PLACEHOLDERS,
      requiredPlaceholders
    },
    renderOptions: {
      showBadgeDefault: false,
      defaultMailLabel: null
    }
  };
};

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
    showBadgeDefault: true,
    defaultMailLabel: 'Prozessmail'
  }
};

const CONTRACTS: Record<string, TemplateContract> = {
  newsletter: makeCampaignContract({
    requiredPlaceholders: REQUIRED_PLACEHOLDERS_BY_TEMPLATE.newsletter ?? []
  }),
  event_update: makeCampaignContract({
    requiredPlaceholders: REQUIRED_PLACEHOLDERS_BY_TEMPLATE.event_update ?? []
  }),
  free_form: makeCampaignContract({
    requiredPlaceholders: REQUIRED_PLACEHOLDERS_BY_TEMPLATE.free_form ?? []
  }),
  payment_reminder_followup: makeCampaignContract({
    requiredPlaceholders: REQUIRED_PLACEHOLDERS_BY_TEMPLATE.payment_reminder_followup ?? [],
    additionalFields: [
      {
        key: 'paymentDeadline',
        label: 'Zahlungsfrist',
        type: 'text',
        required: true,
        multiline: false,
        placeholder: '15.04.2026',
        helpText: 'Frist der erneuten Zahlungsaufforderung.'
      }
    ]
  }),
  email_confirmation: makeCampaignContract({
    requiredPlaceholders: REQUIRED_PLACEHOLDERS_BY_TEMPLATE.email_confirmation ?? [],
    additionalFields: [
      {
        key: 'verificationUrl',
        label: 'Verifizierungslink',
        type: 'url',
        required: true,
        multiline: false,
        placeholder: 'https://...',
        helpText: 'Link zur E-Mail-Bestaetigung.'
      }
    ]
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

