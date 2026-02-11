type TemplateData = Record<string, unknown> | null | undefined;

const toLines = (data: TemplateData): string[] => {
  if (!data) {
    return [];
  }
  return Object.entries(data).map(([key, value]) => `${key}: ${String(value)}`);
};

export const renderTemplate = (templateId: string, data: TemplateData) => {
  const lines: string[] = [];
  lines.push(`Template: ${templateId}`);
  lines.push('');
  lines.push(...toLines(data));
  lines.push('');
  lines.push('Diese E-Mail wurde automatisch versendet.');
  return lines.join('\n');
};