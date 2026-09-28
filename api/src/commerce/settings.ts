import { validateSettings, type PricingSettings, PricingError } from './pricing';
import type { Queryable } from './offers';

/**
 * Steuer-/Provisionseinstellungen als unveraenderliche Versionen (Migration 0114). Die aktuelle Version ist die
 * mit der hoechsten Nummer. Aenderungen laufen mit optimistischer Sperre (`expectedVersion`), damit zwei Admins
 * einander nicht unbemerkt ueberschreiben und ein doppelt gesendeter Aufruf keine zweite Version erzeugt.
 */

export type SettingsVersion = PricingSettings & { id: string; version: number; note: string | null; createdBy: string; createdAt: string };

type SettingsRow = {
  id: string;
  version: number;
  sale_tax_rate_bp: number | null;
  commission_bp: number;
  seller_share_basis: 'NET' | 'GROSS';
  seller_vat_rate_bp: number | null;
  artist_social_levy_bp: number;
  note: string | null;
  created_by: string;
  created_at: Date;
};

export class SettingsError extends Error {
  constructor(public readonly code: 'SETTINGS_MISSING' | 'SETTINGS_VERSION_CONFLICT', message?: string) {
    super(message ?? code);
    this.name = 'SettingsError';
  }
}

const toVersion = (row: SettingsRow): SettingsVersion => ({
  id: row.id,
  version: Number(row.version),
  saleTaxRateBp: row.sale_tax_rate_bp,
  commissionBp: Number(row.commission_bp),
  sellerShareBasis: row.seller_share_basis,
  sellerVatRateBp: row.seller_vat_rate_bp,
  artistSocialLevyBp: Number(row.artist_social_levy_bp),
  note: row.note,
  createdBy: row.created_by,
  createdAt: row.created_at.toISOString()
});

export const loadCurrentSettings = async (tx: Queryable): Promise<SettingsVersion> => {
  const result = await tx.query<SettingsRow>('select * from commerce_settings_version order by version desc limit 1');
  if (!result.rows[0]) throw new SettingsError('SETTINGS_MISSING');
  return toVersion(result.rows[0]);
};

export const listSettingsVersions = async (tx: Queryable, limit = 20): Promise<SettingsVersion[]> =>
  (await tx.query<SettingsRow>('select * from commerce_settings_version order by version desc limit $1', [limit])).rows.map(toVersion);

export const createSettingsVersion = async (
  tx: Queryable,
  input: PricingSettings & { expectedVersion: number; note: string; actor: string }
): Promise<SettingsVersion> => {
  validateSettings(input);
  const current = await loadCurrentSettings(tx);
  if (current.version !== input.expectedVersion) throw new SettingsError('SETTINGS_VERSION_CONFLICT');
  try {
    const result = await tx.query<SettingsRow>(
      `insert into commerce_settings_version
         (version, sale_tax_rate_bp, commission_bp, seller_share_basis, seller_vat_rate_bp, artist_social_levy_bp, note, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
      [current.version + 1, input.saleTaxRateBp, input.commissionBp, input.sellerShareBasis, input.sellerVatRateBp, input.artistSocialLevyBp, input.note, input.actor]
    );
    return toVersion(result.rows[0]);
  } catch (error) {
    // Paralleler Insert derselben Versionsnummer: ebenfalls ein Versionskonflikt.
    if ((error as { code?: string } | null)?.code === '23505') throw new SettingsError('SETTINGS_VERSION_CONFLICT');
    throw error;
  }
};

export { PricingError };
