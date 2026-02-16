import { APIGatewayProxyEventV2 } from 'aws-lambda';

export type AuthContext = {
  sub: string | null;
  groups: string[];
};

export const getAuthContext = (event: APIGatewayProxyEventV2): AuthContext => {
  const claims = ((event.requestContext as { authorizer?: { jwt?: { claims?: unknown } } }).authorizer?.jwt?.claims ??
    {}) as Record<string, string | undefined>;
  const rawGroups = claims['cognito:groups'];
  const groups = (() => {
    if (!rawGroups) {
      return [];
    }

    // API Gateway can pass groups as "admin,viewer" or as JSON string "[\"admin\"]".
    if (rawGroups.startsWith('[')) {
      try {
        const parsed = JSON.parse(rawGroups) as unknown;
        if (Array.isArray(parsed)) {
          return parsed
            .map((group) => String(group).trim())
            .filter((group) => group.length > 0);
        }
      } catch {
        // Fall through to split parsing.
      }
    }

    return rawGroups
      .split(/[,\s]+/)
      .map((group) => group.trim().replace(/^\[|\]$/g, '').replace(/^"|"$/g, ''))
      .filter((group) => group.length > 0);
  })();

  return {
    sub: claims.sub ?? null,
    groups
  };
};

export const hasGroup = (ctx: AuthContext, group: string): boolean => ctx.groups.includes(group);

export const hasAnyGroup = (ctx: AuthContext, groups: string[]): boolean =>
  groups.some((group) => ctx.groups.includes(group));
