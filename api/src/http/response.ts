import { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

type FieldError = {
  field: string;
  code: string;
  message: string;
};

export const json = (
  statusCode: number,
  body: Record<string, unknown>
): APIGatewayProxyStructuredResultV2 => ({
  statusCode,
  headers: {
    'content-type': 'application/json'
  },
  body: JSON.stringify(body)
});

const defaultCodeForStatus = (statusCode: number): string => {
  if (statusCode === 400) {
    return 'VALIDATION_ERROR';
  }
  if (statusCode === 401) {
    return 'UNAUTHORIZED';
  }
  if (statusCode === 403) {
    return 'FORBIDDEN';
  }
  if (statusCode === 404) {
    return 'NOT_FOUND';
  }
  if (statusCode === 409) {
    return 'CONFLICT';
  }
  return 'INTERNAL_ERROR';
};

const parseFieldErrorsFromDetails = (details?: Record<string, unknown>): FieldError[] | undefined => {
  const issues = details?.issues;
  if (!Array.isArray(issues)) {
    return undefined;
  }

  const mapped = issues
    .map((issue) => {
      const raw = issue as Record<string, unknown>;
      const path = Array.isArray(raw.path) ? raw.path.map((part) => String(part)).join('.') : '';
      const code = typeof raw.code === 'string' ? raw.code : 'invalid';
      const message = typeof raw.message === 'string' ? raw.message : 'Invalid value';
      return {
        field: path || 'body',
        code,
        message
      };
    })
    .filter((item) => item.field.length > 0);

  return mapped.length > 0 ? mapped : undefined;
};

export const errorJson = (
  statusCode: number,
  message: string,
  details?: Record<string, unknown>,
  code?: string,
  fieldErrors?: FieldError[]
): APIGatewayProxyStructuredResultV2 => {
  const derivedFieldErrors = parseFieldErrorsFromDetails(details);
  return json(statusCode, {
    ok: false,
    code: code ?? defaultCodeForStatus(statusCode),
    message,
    ...((fieldErrors && fieldErrors.length > 0 ? fieldErrors : derivedFieldErrors)
      ? { fieldErrors: (fieldErrors && fieldErrors.length > 0 ? fieldErrors : derivedFieldErrors) }
      : {}),
    ...(details ? { details } : {})
  });
};
