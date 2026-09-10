const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;

export const parseNotificationRecipients = (raw: string | undefined): string[] => {
  const values = (raw ?? '')
    .split(/[,;]/)
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const invalid = values.filter((value) => !EMAIL_PATTERN.test(value));
  if (invalid.length > 0) {
    throw new Error('ORGA_NOTIFICATION_RECIPIENTS contains an invalid email address.');
  }
  return Array.from(new Set(values));
};
