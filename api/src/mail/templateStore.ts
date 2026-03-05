import { and, eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { emailTemplate, emailTemplateVersion } from '../db/schema';

export type StoredTemplateVersion = {
  templateKey: string;
  version: number;
  subjectTemplate: string;
  bodyTemplate: string;
  bodyHtmlTemplate: string;
  bodyTextTemplate: string;
};

export const getTemplateVersion = async (
  templateKey: string,
  version?: number
): Promise<StoredTemplateVersion | null> => {
  const db = await getDb();

  const rows = await db
    .select({
      templateKey: emailTemplate.templateKey,
      version: emailTemplateVersion.version,
      subjectTemplate: emailTemplateVersion.subjectTemplate,
      bodyTemplate: emailTemplateVersion.bodyTemplate,
      bodyHtmlTemplate: emailTemplateVersion.bodyHtmlTemplate,
      bodyTextTemplate: emailTemplateVersion.bodyTextTemplate
    })
    .from(emailTemplate)
    .innerJoin(emailTemplateVersion, eq(emailTemplateVersion.templateId, emailTemplate.id))
    .where(
      version === undefined
        ? and(eq(emailTemplate.templateKey, templateKey), eq(emailTemplate.isActive, true))
        : and(
            eq(emailTemplate.templateKey, templateKey),
            eq(emailTemplateVersion.version, version),
            eq(emailTemplate.isActive, true)
          )
    )
    .orderBy(emailTemplateVersion.version);

  if (rows.length === 0) {
    return null;
  }

  const selected = version === undefined ? rows[rows.length - 1] : rows[0];
  return {
    ...selected,
    bodyHtmlTemplate: selected.bodyHtmlTemplate ?? selected.bodyTemplate,
    bodyTextTemplate: selected.bodyTextTemplate ?? selected.bodyTemplate
  };
};
