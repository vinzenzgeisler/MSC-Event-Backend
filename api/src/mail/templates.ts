type TemplateData = Record<string, unknown> | null | undefined;

const readPath = (data: TemplateData, keyPath: string): unknown => {
  if (!data) {
    return undefined;
  }

  const keys = keyPath.split('.');
  let current: unknown = data;
  for (const key of keys) {
    if (!current || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }

  return current;
};

export const renderTemplateString = (template: string, data: TemplateData): string =>
  template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, keyPath) => {
    const value = readPath(data, keyPath);
    if (value === null || value === undefined) {
      return '';
    }
    return String(value);
  });
