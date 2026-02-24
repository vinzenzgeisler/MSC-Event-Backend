import { APIGatewayProxyEventV2 } from 'aws-lambda';

const allowedRoles = ['admin', 'editor', 'viewer'] as const;
type AllowedRole = (typeof allowedRoles)[number];
const allowedRoleSet = new Set<string>(allowedRoles);

export type AuthContext = {
  sub: string | null;
  email: string | null;
  groups: AllowedRole[];
};

export const getAuthContext = (event: APIGatewayProxyEventV2): AuthContext => {
  const claims = ((event.requestContext as { authorizer?: { jwt?: { claims?: unknown } } }).authorizer?.jwt?.claims ??
    {}) as Record<string, unknown>;
  const rawGroups = claims['cognito:groups'];
  const groups = (() => {
    if (rawGroups === undefined || rawGroups === null) {
      return [];
    }

    if (Array.isArray(rawGroups)) {
      return rawGroups
        .map((group) => String(group).trim())
        .filter((group): group is AllowedRole => allowedRoleSet.has(group));
    }

    const rawGroupString = String(rawGroups);

    // API Gateway can pass groups as "admin,viewer" or as JSON string "[\"admin\"]".
    if (rawGroupString.startsWith('[')) {
      try {
        const parsed = JSON.parse(rawGroupString) as unknown;
        if (Array.isArray(parsed)) {
          const normalized = parsed
            .map((group) => String(group).trim())
            .filter((group): group is AllowedRole => allowedRoleSet.has(group));
          return Array.from(new Set(normalized));
        }
      } catch {
        // Fall through to split parsing.
      }
    }

    const normalized = rawGroupString
      .split(/[,\s]+/)
      .map((group) => group.trim().replace(/^\[|\]$/g, '').replace(/^"|"$/g, ''))
      .filter((group): group is AllowedRole => allowedRoleSet.has(group));
    return Array.from(new Set(normalized));
  })();

  return {
    sub: typeof claims.sub === 'string' ? claims.sub : null,
    email: typeof claims.email === 'string' ? claims.email : null,
    groups
  };
};

export const hasGroup = (ctx: AuthContext, group: AllowedRole): boolean => ctx.groups.includes(group);

export const hasAnyGroup = (ctx: AuthContext, groups: AllowedRole[]): boolean =>
  groups.some((group) => ctx.groups.includes(group));
