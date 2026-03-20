import QRCode from 'qrcode';

type GiroCodeInput = {
  recipient: string;
  iban: string;
  bic?: string | null;
  amountEur: number;
  reference: string;
  purpose?: string | null;
};

export type QrCodeMatrix = {
  size: number;
  modules: boolean[];
};

const normalize = (value: string | null | undefined): string => (value ?? '').trim();

const normalizeIban = (value: string): string => value.replace(/\s+/g, '').toUpperCase();

const normalizeBic = (value: string): string => value.replace(/\s+/g, '').toUpperCase();

export const isValidIban = (value: string | null | undefined): boolean => /^[A-Z]{2}[0-9A-Z]{13,32}$/.test(normalizeIban(normalize(value)));

export const isValidBic = (value: string | null | undefined): boolean => {
  const candidate = normalizeBic(normalize(value));
  return candidate.length === 0 || /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(candidate);
};

export const buildGiroCodePayload = (input: GiroCodeInput): string | null => {
  const recipient = normalize(input.recipient);
  const iban = normalizeIban(input.iban);
  const bic = normalizeBic(input.bic ?? '');
  const reference = normalize(input.reference);
  const purpose = normalize(input.purpose ?? '');

  if (!recipient || !reference || !isValidIban(iban) || !isValidBic(bic) || input.amountEur <= 0) {
    return null;
  }

  return [
    'BCD',
    '002',
    '1',
    'SCT',
    bic,
    recipient,
    iban,
    `EUR${input.amountEur.toFixed(2)}`,
    '',
    reference,
    purpose
  ].join('\n');
};

export const buildGiroCodeMatrix = (payload: string): QrCodeMatrix => {
  const qr = QRCode.create(payload, { errorCorrectionLevel: 'M' });
  const size = qr.modules.size;
  const data = Array.from(qr.modules.data, (value) => Boolean(value));
  return {
    size,
    modules: data
  };
};

export const renderGiroCodePng = async (payload: string): Promise<Buffer> => {
  const dataUrl = await QRCode.toDataURL(payload, {
    errorCorrectionLevel: 'M',
    margin: 0,
    color: {
      dark: '#000000',
      light: '#FFFFFF'
    },
    width: 256
  });
  const [, base64] = dataUrl.split(',', 2);
  return Buffer.from(base64, 'base64');
};
