import { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { sql } from 'drizzle-orm';
import { getDb } from './db/client';

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
    const claims = ((event.requestContext as { authorizer?: { jwt?: { claims?: unknown } } }).authorizer?.jwt?.claims ??
      {}) as Record<string, string | undefined>;
    const rawGroups = claims['cognito:groups'];
    const groups = rawGroups ? rawGroups.split(',').map((group) => group.trim()).filter(Boolean) : [];

    return json(200, {
      ok: true,
      sub: claims.sub ?? null,
      groups
    });
  }

  if (method === 'GET' && path === '/admin/db/ping') {
    try {
      const db = await getDb();
      const result = await db.execute(sql`select current_database() as name, now() as now`);
      const row = result.rows[0] as { name?: string; now?: string } | undefined;

      return json(200, {
        ok: true,
        database: row?.name ?? null,
        now: row?.now ?? null
      });
    } catch (error) {
      return json(500, { ok: false, message: 'DB ping failed' });
    }
  }

  if (method === 'GET' && path === '/admin/db/schema') {
    try {
      const db = await getDb();
      const result = await db.execute(sql`
        select table_name
        from information_schema.tables
        where table_schema = 'public'
        order by table_name
      `);

      return json(200, {
        ok: true,
        tables: result.rows.map((row) => row.table_name)
      });
    } catch (error) {
      return json(500, { ok: false, message: 'Schema query failed' });
    }
  }

  return json(404, { message: 'Not Found' });
};
