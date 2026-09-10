const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;

export const parseNotificationRecipients = (raw: string | undefined): string[] =>
  Array.from(
    new Set(
      (raw ?? '')
        .split(/[,;]/)
        .map((value) => value.trim().toLowerCase())
        .filter((value) => EMAIL_PATTERN.test(value))
    )
  );

export const getOrgaNotificationRecipients = (): string[] =>
  parseNotificationRecipients(process.env.ORGA_NOTIFICATION_RECIPIENTS);
