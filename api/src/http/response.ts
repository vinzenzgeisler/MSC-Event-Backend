import { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

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

export const errorJson = (
  statusCode: number,
  message: string,
  details?: Record<string, unknown>
): APIGatewayProxyStructuredResultV2 =>
  json(statusCode, {
    ok: false,
    message,
    ...(details ? { details } : {})
  });
