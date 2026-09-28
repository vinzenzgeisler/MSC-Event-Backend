import type { Queryable } from './offers';

/**
 * Produktadapter (Plan 3.2): Commerce kennt nur `commerce_product`; was ein Produkt fachlich ist, liefert
 * der ProductTypeHandler seines Typs. V1 kennt ausschliesslich `RACEPIC_IMAGE_LICENSE`.
 */
export type ProductTypeCode = 'RACEPIC_IMAGE_LICENSE';

export type ResolvedProduct = {
  productId: string;
  sellerId: string;
  /** Fachliche Referenz, z. B. die RacePic-Bild-ID. */
  referenceId: string;
  /** Ob das Produkt aktuell verkauft/ausgeliefert werden darf (Bild veroeffentlicht und nicht entfernt). */
  available: boolean;
};

export interface ProductTypeHandler {
  readonly productType: ProductTypeCode;
  resolve(tx: Queryable, productId: string): Promise<ResolvedProduct | null>;
}

export const racepicImageLicenseHandler: ProductTypeHandler = {
  productType: 'RACEPIC_IMAGE_LICENSE',
  async resolve(tx, productId) {
    const result = await tx.query<{ id: string; seller_id: string; image_id: string; visibility: string }>(
      `select p.id, p.seller_id, i.id as image_id, i.visibility
         from commerce_product p
         join racepic_image i on i.id = p.racepic_image_id
        where p.id = $1 and p.product_type = 'RACEPIC_IMAGE_LICENSE'`,
      [productId]
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return {
      productId: row.id,
      sellerId: row.seller_id,
      referenceId: row.image_id,
      available: row.visibility === 'PUBLISHED'
    };
  }
};

const handlers = new Map<ProductTypeCode, ProductTypeHandler>([[racepicImageLicenseHandler.productType, racepicImageLicenseHandler]]);

export const getProductTypeHandler = (productType: string): ProductTypeHandler => {
  const handler = handlers.get(productType as ProductTypeCode);
  if (!handler) {
    throw new Error(`Unbekannter Produkttyp: ${productType}`);
  }
  return handler;
};
