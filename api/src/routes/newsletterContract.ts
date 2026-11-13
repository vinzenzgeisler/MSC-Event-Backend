import { createHash, randomBytes } from 'crypto';
import { z } from 'zod';
export type NewsletterLocale = 'de' | 'en' | 'cs' | 'pl';
const locales = ['de', 'en', 'cs', 'pl'] as const;
export const CONSENT_VERSION = '2026-09-20-v1';
export const TOKEN_TTL_HOURS = 48;

export const consentText: Record<NewsletterLocale, string> = {
  de: 'Ich möchte den Newsletter des MSC Oberlausitzer Dreiländereck e. V. per E-Mail erhalten. Ich kann meine Einwilligung jederzeit mit Wirkung für die Zukunft widerrufen.',
  en: 'I would like to receive the MSC Oberlausitzer Dreiländereck e. V. newsletter by email. I can withdraw my consent at any time with effect for the future.',
  cs: 'Chci dostávat newsletter MSC Oberlausitzer Dreiländereck e. V. e-mailem. Svůj souhlas mohu kdykoli odvolat s účinkem do budoucna.',
  pl: 'Chcę otrzymywać newsletter MSC Oberlausitzer Dreiländereck e. V. pocztą elektroniczną. Mogę wycofać zgodę w dowolnym momencie ze skutkiem na przyszłość.'
};

export const mailCopy: Record<NewsletterLocale, { confirmSubject: string; confirmText: string; confirmCta: string; unsubscribeSubject: string; unsubscribeText: string; unsubscribeCta: string }> = {
  de: { confirmSubject: 'Newsletter-Anmeldung bestätigen', confirmText: 'Bitte bestätige deine Anmeldung zum MSC-Newsletter. Erst nach dem Klick auf den Button ist deine Adresse aktiv.', confirmCta: 'Anmeldung bestätigen', unsubscribeSubject: 'Newsletter-Abmeldung bestätigen', unsubscribeText: 'Über den folgenden Button kannst du dich sicher vom MSC-Newsletter abmelden.', unsubscribeCta: 'Newsletter abbestellen' },
  en: { confirmSubject: 'Confirm your newsletter subscription', confirmText: 'Please confirm your MSC newsletter subscription. Your address becomes active only after clicking the button.', confirmCta: 'Confirm subscription', unsubscribeSubject: 'Confirm newsletter unsubscribe', unsubscribeText: 'Use the button below to securely unsubscribe from the MSC newsletter.', unsubscribeCta: 'Unsubscribe' },
  cs: { confirmSubject: 'Potvrďte odběr newsletteru', confirmText: 'Potvrďte prosím odběr newsletteru MSC. Vaše adresa bude aktivní až po kliknutí na tlačítko.', confirmCta: 'Potvrdit odběr', unsubscribeSubject: 'Potvrďte odhlášení newsletteru', unsubscribeText: 'Pomocí tlačítka níže se můžete bezpečně odhlásit z newsletteru MSC.', unsubscribeCta: 'Odhlásit odběr' },
  pl: { confirmSubject: 'Potwierdź subskrypcję newslettera', confirmText: 'Potwierdź subskrypcję newslettera MSC. Adres stanie się aktywny dopiero po kliknięciu przycisku.', confirmCta: 'Potwierdź subskrypcję', unsubscribeSubject: 'Potwierdź rezygnację z newslettera', unsubscribeText: 'Użyj poniższego przycisku, aby bezpiecznie zrezygnować z newslettera MSC.', unsubscribeCta: 'Wypisz się' }
};

export const mailGreeting: Record<NewsletterLocale, string> = {
  de: 'Hallo,',
  en: 'Hello,',
  cs: 'Dobrý den,',
  pl: 'Dzień dobry,'
};

export const normalizeNewsletterLocale = (value: unknown): NewsletterLocale =>
  value === 'cz' ? 'cs' : locales.includes(value as NewsletterLocale) ? value as NewsletterLocale : 'de';
export const hashNewsletterToken = (value: string) => createHash('sha256').update(value).digest('hex');
export const normalizeEmail = (value: string) => value.trim().toLowerCase();
export const newToken = () => randomBytes(32).toString('base64url');
export const consentHash = (locale: NewsletterLocale) => hashNewsletterToken(consentText[locale]);
export const publicBaseUrl = () => (process.env.NEWSLETTER_PUBLIC_BASE_URL || 'http://localhost:8080/newsletter').replace(/\/$/, '');
export const websiteLocale = (locale: NewsletterLocale) => locale === 'cs' ? 'cz' : locale;

export const getNewsletterConfig = (rawLocale: unknown) => {
  const locale = normalizeNewsletterLocale(rawLocale);
  return { enabled: process.env.NEWSLETTER_ENABLED !== 'false', locale, consentVersion: CONSENT_VERSION, consentText: consentText[locale], privacyUrl: 'https://www.msc-oberlausitz.de/privacy' };
};

export const validateNewsletterSignup = (body: unknown) => z.object({
  email: z.string().trim().email().max(320), locale: z.string().optional(),
  consentVersion: z.literal(CONSENT_VERSION), consentAccepted: z.literal(true), website: z.string().max(200).optional().default('')
}).parse(body);
export const validateNewsletterEmailRequest = (body: unknown) => z.object({ email: z.string().trim().email().max(320), locale: z.string().optional(), website: z.string().max(200).optional().default('') }).parse(body);
export const validateNewsletterToken = (body: unknown) => z.object({ token: z.string().min(20).max(200) }).parse(body);
export const validateNewsletterListQuery = (query: Record<string, string | undefined>) => z.object({ status: z.enum(['pending', 'active', 'unsubscribed', 'bounced', 'complained']).optional(), locale: z.enum(locales).optional(), search: z.string().trim().max(200).optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) }).parse(query);

