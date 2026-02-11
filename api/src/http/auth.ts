import { APIGatewayProxyEventV2 } from 'aws-lambda';

export type AuthContext = {
  sub: string | null;
  groups: string[];
};

export const getAuthContext = (event: APIGatewayProxyEventV2): AuthContext => {
  const claims = ((event.requestContext as { authorizer?: { jwt?: { claims?: unknown } } }).authorizer?.jwt?.claims ??
    {}) as Record<string, string | undefined>;
  const rawGroups = claims['cognito:groups'];
  const groups = rawGroups ? rawGroups.split(',').map((group) => group.trim()).filter(Boolean) : [];

  return {
    sub: claims.sub ?? null,
    groups
  };
};

export const hasGroup = (ctx: AuthContext, group: string): boolean => ctx.groups.includes(group);

export const hasAnyGroup = (ctx: AuthContext, groups: string[]): boolean =>
  groups.some((group) => ctx.groups.includes(group));
