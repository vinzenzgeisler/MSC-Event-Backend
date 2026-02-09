const START_NUMBER_REGEX = /^[A-Z0-9]{1,6}$/;

export const normalizeStartNumber = (raw: string | null | undefined): string | null => {
  if (!raw) {
    return null;
  }

  const normalized = raw.trim().toUpperCase();
  if (!normalized) {
    return null;
  }

  if (!START_NUMBER_REGEX.test(normalized)) {
    return null;
  }

  return normalized;
};

export const isValidStartNumber = (value: string | null | undefined): boolean => {
  if (!value) {
    return false;
  }
  return START_NUMBER_REGEX.test(value);
};
