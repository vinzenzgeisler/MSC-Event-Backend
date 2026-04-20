import { APIGatewayProxyEventV2 } from 'aws-lambda';

const allowedRoles = ['admin', 'editor', 'viewer'] as const;
export type AllowedRole = (typeof allowedRoles)[number];
const allowedRoleSet = new Set<string>(allowedRoles);
const legacyRoleAliases: Record<string, AllowedRole> = {
  checkin: 'editor'
};

export type AdminPermission =
  | 'dashboard.read'
  | 'entries.read'
  | 'entries.status.write'
  | 'entries.checkin.write'
  | 'entries.payment.write'
  | 'entries.notes.write'
  | 'entries.delete'
  | 'communication.read'
  | 'communication.write'
  | 'exports.read'
  | 'exports.write'
  | 'settings.read'
  | 'settings.write'
  | 'iam.read'
  | 'iam.write';

const rolePermissions: Record<AllowedRole, AdminPermission[]> = {
  admin: [
    'dashboard.read',
    'entries.read',
    'entries.status.write',
    'entries.checkin.write',
    'entries.payment.write',
    'entries.notes.write',
    'entries.delete',
    'communication.read',
    'communication.write',
    'exports.read',
    'exports.write',
    'settings.read',
    'settings.write',
    'iam.read',
    'iam.write'
  ],
  editor: [
    'dashboard.read',
    'entries.read',
    'entries.status.write',
    'entries.checkin.write',
    'entries.payment.write',
    'entries.notes.write',
    'exports.read'
  ],
  viewer: ['dashboard.read', 'entries.read', 'exports.read']
};

export type AuthContext = {
  sub: string | null;
  email: string | null;
  groups: AllowedRole[];
  mfaAuthenticated: boolean;
};

const normalizeRole = (value: string): AllowedRole | null => {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  const aliased = legacyRoleAliases[normalized] ?? normalized;
  return allowedRoleSet.has(aliased) ? (aliased as AllowedRole) : null;
};

const parseClaimAsStringArray = (value: unknown): string[] => {
  if (value === undefined || value === null) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter((item) => item.length > 0);
  }
  const raw = String(value).trim();
  if (!raw) {
    return [];
  }
  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item).trim()).filter((item) => item.length > 0);
      }
    } catch {
      // Fall through to split parsing.
    }
  }
  return raw
    .split(/[,\s]+/)
    .map((item) => item.trim().replace(/^\[|\]$/g, '').replace(/^"|"$/g, ''))
    .filter((item) => item.length > 0);
};

const isMfaAuthenticated = (claims: Record<string, unknown>): boolean => {
  const amrValues = [
    ...parseClaimAsStringArray(claims.amr),
    ...parseClaimAsStringArray(claims['cognito:amr'])
  ].map((value) => value.toLowerCase());

  if (amrValues.some((value) => value === 'mfa' || value.includes('mfa') || value === 'totp' || value === 'otp')) {
    return true;
  }

  const explicitBoolean = claims.mfa_authenticated;
  if (typeof explicitBoolean === 'boolean') {
    return explicitBoolean;
  }
  if (typeof explicitBoolean === 'string') {
    return explicitBoolean.toLowerCase() === 'true';
  }

  return false;
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
      const normalized = rawGroups
        .map((group) => normalizeRole(String(group)))
        .filter((group): group is AllowedRole => group !== null);
      return Array.from(new Set(normalized));
    }

    const rawGroupString = String(rawGroups);

    // API Gateway can pass groups as "admin,viewer" or as JSON string "[\"admin\"]".
    if (rawGroupString.startsWith('[')) {
      try {
        const parsed = JSON.parse(rawGroupString) as unknown;
        if (Array.isArray(parsed)) {
          const normalized = parsed
            .map((group) => normalizeRole(String(group)))
            .filter((group): group is AllowedRole => group !== null);
          return Array.from(new Set(normalized));
        }
      } catch {
        // Fall through to split parsing.
      }
    }

    const normalized = rawGroupString
      .split(/[,\s]+/)
      .map((group) => group.trim().replace(/^\[|\]$/g, '').replace(/^"|"$/g, ''))
      .map((group) => normalizeRole(group))
      .filter((group): group is AllowedRole => group !== null);
    return Array.from(new Set(normalized));
  })();

  return {
    sub: typeof claims.sub === 'string' ? claims.sub : null,
    email: typeof claims.email === 'string' ? claims.email : null,
    groups,
    mfaAuthenticated: isMfaAuthenticated(claims)
  };
};

export const hasGroup = (ctx: AuthContext, group: AllowedRole): boolean => ctx.groups.includes(group);

export const hasAnyGroup = (ctx: AuthContext, groups: AllowedRole[]): boolean =>
  groups.some((group) => ctx.groups.includes(group));

export const hasPermission = (ctx: AuthContext, permission: AdminPermission): boolean =>
  ctx.groups.some((group) => rolePermissions[group].includes(permission));

export const hasAnyPermission = (ctx: AuthContext, permissions: AdminPermission[]): boolean =>
  permissions.some((permission) => hasPermission(ctx, permission));
