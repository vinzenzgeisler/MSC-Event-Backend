import { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

const json = (statusCode: number, body: Record<string, unknown>): APIGatewayProxyStructuredResultV2 => ({
  statusCode,
  headers: {
    'content-type': 'application/json'
  },
  body: JSON.stringify(body)
});

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
  const method = event.requestContext.http.method;
  const path = event.requestContext.http.path;
  const stage = process.env.STAGE ?? 'dev';

  if (method === 'GET' && path === '/health') {
    return json(200, { ok: true, stage });
  }

  if (method === 'GET' && path === '/admin/ping') {
    const claims = (event.requestContext.authorizer?.jwt?.claims ?? {}) as Record<string, string | undefined>;
    const rawGroups = claims['cognito:groups'];
    const groups = rawGroups ? rawGroups.split(',').map((group) => group.trim()).filter(Boolean) : [];

    return json(200, {
      ok: true,
      sub: claims.sub ?? null,
      groups
    });
  }

  return json(404, { message: 'Not Found' });
};
