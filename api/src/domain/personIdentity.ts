export type PersonIdentitySource = {
  firstName: string | null;
  lastName: string | null;
  publicationName?: string | null;
};

export type StandardPersonIdentity = {
  displayName: string;
  identityProtected: boolean;
  firstName: string | null;
  lastName: string | null;
};

export const collapseIdentityWhitespace = (value: string): string =>
  value.trim().replace(/\s+/gu, ' ');

export const legalFullName = (source: PersonIdentitySource): string =>
  collapseIdentityWhitespace(`${source.firstName ?? ''} ${source.lastName ?? ''}`) || 'Unbekannt';

export const isIdentityProtected = (source: Pick<PersonIdentitySource, 'publicationName'>): boolean =>
  Boolean(source.publicationName?.trim());

export const standardPersonIdentity = (source: PersonIdentitySource): StandardPersonIdentity => {
  const publicationName = collapseIdentityWhitespace(source.publicationName ?? '');
  if (publicationName) {
    return {
      displayName: publicationName,
      identityProtected: true,
      firstName: null,
      lastName: null
    };
  }
  return {
    displayName: legalFullName(source),
    identityProtected: false,
    firstName: source.firstName,
    lastName: source.lastName
  };
};

const normalizedLeakText = (value: string): string =>
  collapseIdentityWhitespace(value).toLocaleLowerCase('de-DE');

export const containsLegalName = (value: string, source: PersonIdentitySource): boolean => {
  if (!isIdentityProtected(source)) return false;
  const haystack = normalizedLeakText(value);
  const forward = normalizedLeakText(`${source.firstName ?? ''} ${source.lastName ?? ''}`);
  const reverse = normalizedLeakText(`${source.lastName ?? ''} ${source.firstName ?? ''}`);
  return Boolean(forward && (haystack.includes(forward) || haystack.includes(reverse)));
};

export const assertNoLegalNameLeak = (value: string, sources: PersonIdentitySource[]): void => {
  if (sources.some((source) => containsLegalName(value, source))) {
    throw new Error('PROTECTED_LEGAL_NAME_IN_OUTPUT');
  }
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const replaceLegalNameInText = (value: string, source: PersonIdentitySource): string => {
  const identity = standardPersonIdentity(source);
  if (!identity.identityProtected) return value;
  const variants = [
    collapseIdentityWhitespace(`${source.firstName ?? ''} ${source.lastName ?? ''}`),
    collapseIdentityWhitespace(`${source.lastName ?? ''} ${source.firstName ?? ''}`)
  ].filter(Boolean);
  return variants.reduce(
    (current, legalName) => current.replace(new RegExp(escapeRegExp(legalName).replace(/ /g, '\\s+'), 'giu'), identity.displayName),
    value
  );
};

export const sanitizeProtectedStructuredData = (value: unknown, source: PersonIdentitySource): unknown => {
  if (!isIdentityProtected(source)) return value;
  if (typeof value === 'string') return replaceLegalNameInText(value, source);
  if (Array.isArray(value)) return value.map((item) => sanitizeProtectedStructuredData(item, source));
  if (!value || typeof value !== 'object') return value;
  const identity = standardPersonIdentity(source);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => {
    if (key === 'driverName' || key === 'displayName') return [key, identity.displayName];
    if (key === 'firstName' || key === 'lastName' || key === 'driverFirstName' || key === 'driverLastName') return [key, null];
    if (key === 'email' || key === 'driverEmail' || key === 'phone' || key === 'street' || key === 'zip' || key === 'city') return [key, null];
    return [key, sanitizeProtectedStructuredData(item, source)];
  }));
};

export const replaceProtectedLegalNamesInValue = (value: unknown, sources: PersonIdentitySource[]): unknown => {
  if (typeof value === 'string') {
    return sources.reduce((current, source) => replaceLegalNameInText(current, source), value);
  }
  if (Array.isArray(value)) return value.map((item) => replaceProtectedLegalNamesInValue(item, sources));
  if (!value || typeof value !== 'object' || value instanceof Date || Buffer.isBuffer(value)) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, replaceProtectedLegalNamesInValue(item, sources)])
  );
};
