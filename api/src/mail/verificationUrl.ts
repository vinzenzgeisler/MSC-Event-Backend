export const buildPublicVerificationUrl = (entryId: string, token: string): string | null => {
  const baseUrl = process.env.PUBLIC_VERIFY_BASE_URL?.trim();
  if (!baseUrl) {
    return null;
  }
  try {
    const url = new URL(baseUrl);
    url.searchParams.set('entryId', entryId);
    url.searchParams.set('token', token);
    return url.toString();
  } catch {
    return null;
  }
};
