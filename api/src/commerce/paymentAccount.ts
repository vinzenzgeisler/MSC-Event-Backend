import type Stripe from 'stripe';
import { logOperationalEvent } from '../observability/logger';
import type { Queryable } from './offers';

/**
 * Stripe-Connect-Zahlungskonto der Fotograf:innen (Commerce AP06): Express-Konto, Hosted Onboarding,
 * Dashboard-Link und Capability-Synchronisation. Getrennte Charges und Transfers: das Konto braucht nur die
 * Faehigkeit `transfers`. Es werden weder Bank- noch KYC-Rohdaten gespeichert (nur Statusflags und die Namen
 * offener Anforderungen), und Onboarding-/Dashboard-Links werden weder gespeichert noch versendet.
 *
 * Eine Auszahlung ist damit noch nicht freigegeben: `commerce_seller.payouts_blocked` bleibt an, bis der
 * Steuerstatus geklaert ist (Marketplace-Plan Abschnitt 6).
 */

export type StripeConnectApi = Pick<Stripe, 'accounts' | 'accountLinks'>;

export type PaymentAccountErrorCode =
  | 'PHOTOGRAPHER_NOT_ELIGIBLE'
  | 'SELLER_SUSPENDED'
  | 'NO_ACCOUNT'
  | 'ONBOARDING_INCOMPLETE'
  | 'STRIPE_UNAVAILABLE'
  | 'ONBOARDING_URLS_MISSING';

export class PaymentAccountError extends Error {
  constructor(public readonly code: PaymentAccountErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'PaymentAccountError';
  }
}

export type PaymentAccountStatus = 'PENDING' | 'ENABLED' | 'RESTRICTED' | 'DISABLED';

export type AccountSnapshot = {
  charges_enabled?: boolean;
  payouts_enabled?: boolean;
  details_submitted?: boolean;
  capabilities?: { transfers?: string } | null;
  requirements?: {
    currently_due?: string[] | null;
    past_due?: string[] | null;
    disabled_reason?: string | null;
    current_deadline?: number | null;
  } | null;
};

export type DerivedAccountState = {
  status: PaymentAccountStatus;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  requirements: { currentlyDue: string[]; pastDue: string[]; disabledReason: string | null; currentDeadline: number | null };
};

/** Reine Ableitung des MSC-Status aus einem Stripe-Konto. ENABLED nur bei eingereichten Angaben, aktiven Auszahlungen und Transfer-Faehigkeit. */
export const deriveAccountState = (account: AccountSnapshot): DerivedAccountState => {
  const requirements = {
    currentlyDue: account.requirements?.currently_due ?? [],
    pastDue: account.requirements?.past_due ?? [],
    disabledReason: account.requirements?.disabled_reason ?? null,
    currentDeadline: account.requirements?.current_deadline ?? null
  };
  const detailsSubmitted = account.details_submitted === true;
  const payoutsEnabled = account.payouts_enabled === true;
  const transfersActive = account.capabilities?.transfers === 'active';
  let status: PaymentAccountStatus;
  if (requirements.disabledReason) {
    status = requirements.disabledReason.startsWith('rejected') ? 'DISABLED' : 'RESTRICTED';
  } else if (requirements.pastDue.length > 0) {
    // Ueberfaellige Anforderungen fuehren bei Stripe bald zur Sperre: konservativ schon jetzt einschraenken.
    status = 'RESTRICTED';
  } else if (detailsSubmitted && payoutsEnabled && transfersActive) {
    status = 'ENABLED';
  } else {
    status = 'PENDING';
  }
  return { status, chargesEnabled: account.charges_enabled === true, payoutsEnabled, detailsSubmitted, requirements };
};

const PHOTOGRAPHER_STATUS_BY_ACCOUNT_STATUS: Record<PaymentAccountStatus, string> = {
  PENDING: 'PAYMENT_ONBOARDING_PENDING',
  ENABLED: 'PAYMENT_ENABLED',
  RESTRICTED: 'PAYMENT_RESTRICTED',
  DISABLED: 'PAYMENT_DISABLED'
};

/** Nur diese Fotografenstatus duerfen ein Zahlungskonto anlegen oder fortsetzen. */
const ELIGIBLE_PHOTOGRAPHER_STATUSES = new Set([
  'ACTIVE_FREE',
  'PAYMENT_ONBOARDING_REQUIRED',
  'PAYMENT_ONBOARDING_PENDING',
  'PAYMENT_ENABLED',
  'PAYMENT_RESTRICTED'
]);
/** Statuswechsel durch die Synchronisation nur innerhalb dieser Familie (nie DISABLED/PENDING_APPROVAL/INVITED ueberschreiben). */
const SYNCABLE_PHOTOGRAPHER_STATUSES = new Set([...ELIGIBLE_PHOTOGRAPHER_STATUSES, 'PAYMENT_DISABLED']);

type SellerRow = { id: string; status: string; payouts_blocked: boolean };
type AccountRow = { id: string; seller_id: string; provider_account_id: string; status: PaymentAccountStatus; charges_enabled: boolean; payouts_enabled: boolean; details_submitted: boolean; requirements: unknown; synced_at: Date | null };

const loadPhotographer = async (tx: Queryable, photographerId: string) =>
  (await tx.query<{ id: string; email: string; status: string }>(
    'select id, email, status from racepic_photographer where id = $1 and deleted_at is null',
    [photographerId]
  )).rows[0];

const ensureSeller = async (tx: Queryable, photographerId: string): Promise<SellerRow> => {
  await tx.query(
    `insert into commerce_seller (kind, photographer_id, display_name)
     select 'PHOTOGRAPHER', p.id, p.display_name from racepic_photographer p where p.id = $1
     on conflict (photographer_id) where photographer_id is not null do nothing`,
    [photographerId]
  );
  return (await tx.query<SellerRow>('select id, status, payouts_blocked from commerce_seller where photographer_id = $1', [photographerId])).rows[0];
};

const loadAccount = async (tx: Queryable, sellerId: string): Promise<AccountRow | undefined> =>
  (await tx.query<AccountRow>('select * from commerce_payment_account where seller_id = $1', [sellerId])).rows[0];

const applyState = async (tx: Queryable, photographerId: string, sellerId: string, state: DerivedAccountState) => {
  await tx.query(
    `update commerce_payment_account
        set status = $2, charges_enabled = $3, payouts_enabled = $4, details_submitted = $5,
            requirements = $6::jsonb, synced_at = now(), updated_at = now()
      where seller_id = $1`,
    [sellerId, state.status, state.chargesEnabled, state.payoutsEnabled, state.detailsSubmitted, JSON.stringify(state.requirements)]
  );
  const target = PHOTOGRAPHER_STATUS_BY_ACCOUNT_STATUS[state.status];
  await tx.query(
    `update racepic_photographer set status = $2, updated_at = now()
      where id = $1 and status = any($3::text[]) and status <> $2`,
    [photographerId, target, [...SYNCABLE_PHOTOGRAPHER_STATUSES]]
  );
};

const viewOf = (seller: SellerRow | undefined, account: AccountRow | undefined) => ({
  hasAccount: Boolean(account),
  status: account?.status ?? null,
  chargesEnabled: account?.charges_enabled ?? false,
  payoutsEnabled: account?.payouts_enabled ?? false,
  detailsSubmitted: account?.details_submitted ?? false,
  requirements: (account?.requirements as DerivedAccountState['requirements'] | undefined) ?? null,
  syncedAt: account?.synced_at ? account.synced_at.toISOString() : null,
  // Freigabe von Auszahlungen haengt zusaetzlich am geklaerten Steuerstatus (nicht am Stripe-Konto).
  payoutsReleased: seller ? !seller.payouts_blocked : false
});

export type PaymentAccountView = ReturnType<typeof viewOf>;

export const getPaymentAccountView = async (tx: Queryable, photographerId: string): Promise<PaymentAccountView> => {
  const seller = (await tx.query<SellerRow>('select id, status, payouts_blocked from commerce_seller where photographer_id = $1', [photographerId])).rows[0];
  const account = seller ? await loadAccount(tx, seller.id) : undefined;
  return viewOf(seller, account);
};

/** Gleicht das Konto mit Stripe ab (Capability-Synchronisation). Ohne Konto passiert nichts. */
export const refreshPaymentAccount = async (tx: Queryable, stripe: StripeConnectApi, photographerId: string): Promise<PaymentAccountView> => {
  const seller = (await tx.query<SellerRow>('select id, status, payouts_blocked from commerce_seller where photographer_id = $1', [photographerId])).rows[0];
  const account = seller ? await loadAccount(tx, seller.id) : undefined;
  if (!seller || !account) return viewOf(seller, account);
  let remote: Stripe.Account;
  try {
    remote = await stripe.accounts.retrieve(account.provider_account_id);
  } catch {
    logOperationalEvent('error', 'racepic_payment_account.sync_failed', {});
    throw new PaymentAccountError('STRIPE_UNAVAILABLE');
  }
  await applyState(tx, photographerId, seller.id, deriveAccountState(remote as unknown as AccountSnapshot));
  return getPaymentAccountView(tx, photographerId);
};

/**
 * Abgleich aus einem Stripe-Webhook (`account.updated`, `capability.updated`): sucht das Konto ueber die
 * Stripe-Konto-ID und holt den aktuellen Stand bei Stripe, statt der Nachricht zu vertrauen. So sind doppelte,
 * verzoegerte oder vertauschte Ereignisse unschaedlich. Unbekannte Konten werden ignoriert (`false`).
 */
export const syncPaymentAccountByProviderId = async (tx: Queryable, stripe: StripeConnectApi, providerAccountId: string): Promise<boolean> => {
  const row = (await tx.query<{ seller_id: string; photographer_id: string | null }>(
    `select a.seller_id, s.photographer_id
       from commerce_payment_account a join commerce_seller s on s.id = a.seller_id
      where a.provider = 'STRIPE' and a.provider_account_id = $1`,
    [providerAccountId]
  )).rows[0];
  if (!row || !row.photographer_id) return false;
  let remote: Stripe.Account;
  try {
    remote = await stripe.accounts.retrieve(providerAccountId);
  } catch {
    logOperationalEvent('error', 'racepic_payment_account.webhook_sync_failed', {});
    throw new PaymentAccountError('STRIPE_UNAVAILABLE');
  }
  await applyState(tx, row.photographer_id, row.seller_id, deriveAccountState(remote as unknown as AccountSnapshot));
  return true;
};

export type OnboardingUrls = { returnUrl: string; refreshUrl: string };

/** Legt bei Bedarf Seller und Express-Konto an und erzeugt einen kurzlebigen Hosted-Onboarding-Link (nicht gespeichert). */
export const createOnboardingLink = async (
  tx: Queryable,
  stripe: StripeConnectApi,
  photographerId: string,
  urls: OnboardingUrls
): Promise<{ url: string; expiresAt: string }> => {
  if (!urls.returnUrl || !urls.refreshUrl) throw new PaymentAccountError('ONBOARDING_URLS_MISSING');
  const photographer = await loadPhotographer(tx, photographerId);
  if (!photographer || !ELIGIBLE_PHOTOGRAPHER_STATUSES.has(photographer.status)) throw new PaymentAccountError('PHOTOGRAPHER_NOT_ELIGIBLE');
  const seller = await ensureSeller(tx, photographerId);
  if (seller.status !== 'ACTIVE') throw new PaymentAccountError('SELLER_SUSPENDED');

  let account = await loadAccount(tx, seller.id);
  try {
    if (!account) {
      // Stabiler Idempotency-Key: parallele Aufrufe erzeugen bei Stripe hoechstens ein Konto.
      const created = await stripe.accounts.create(
        {
          type: 'express',
          country: 'DE',
          email: photographer.email,
          capabilities: { transfers: { requested: true } },
          metadata: { racepic_photographer_id: photographerId, commerce_seller_id: seller.id }
        },
        { idempotencyKey: `racepic-connect-account-${photographerId}` }
      );
      await tx.query(
        `insert into commerce_payment_account (seller_id, provider_account_id, status)
         values ($1, $2, 'PENDING') on conflict (seller_id) do nothing`,
        [seller.id, created.id]
      );
      account = await loadAccount(tx, seller.id);
      await applyState(tx, photographerId, seller.id, deriveAccountState(created as unknown as AccountSnapshot));
    }
    const link = await stripe.accountLinks.create({
      account: (account as AccountRow).provider_account_id,
      type: 'account_onboarding',
      return_url: urls.returnUrl,
      refresh_url: urls.refreshUrl
    });
    return { url: link.url, expiresAt: new Date(link.expires_at * 1000).toISOString() };
  } catch (error) {
    if (error instanceof PaymentAccountError) throw error;
    logOperationalEvent('error', 'racepic_payment_account.onboarding_failed', {});
    throw new PaymentAccountError('STRIPE_UNAVAILABLE');
  }
};

/** Kurzlebiger Login-Link ins Express-Dashboard; nur nach abgeschlossenem Onboarding (Stripe verlangt eingereichte Angaben). */
export const createDashboardLink = async (
  tx: Queryable,
  stripe: StripeConnectApi,
  photographerId: string
): Promise<{ url: string }> => {
  const photographer = await loadPhotographer(tx, photographerId);
  if (!photographer || !ELIGIBLE_PHOTOGRAPHER_STATUSES.has(photographer.status)) throw new PaymentAccountError('PHOTOGRAPHER_NOT_ELIGIBLE');
  const seller = (await tx.query<SellerRow>('select id, status, payouts_blocked from commerce_seller where photographer_id = $1', [photographerId])).rows[0];
  const account = seller ? await loadAccount(tx, seller.id) : undefined;
  if (!seller || !account) throw new PaymentAccountError('NO_ACCOUNT');
  if (seller.status !== 'ACTIVE') throw new PaymentAccountError('SELLER_SUSPENDED');
  if (!account.details_submitted) throw new PaymentAccountError('ONBOARDING_INCOMPLETE');
  try {
    const link = await stripe.accounts.createLoginLink(account.provider_account_id);
    return { url: link.url };
  } catch {
    logOperationalEvent('error', 'racepic_payment_account.dashboard_failed', {});
    throw new PaymentAccountError('STRIPE_UNAVAILABLE');
  }
};
