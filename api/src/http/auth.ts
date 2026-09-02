import { APIGatewayProxyEventV2 } from 'aws-lambda';

const allowedRoles = ['admin', 'editor', 'viewer', 'technical_inspector', 'marshal_manager'] as const;
export type AllowedRole = (typeof allowedRoles)[number];
const allowedRoleSet = new Set<string>(allowedRoles);
const legacyRoleAliases: Record<string, AllowedRole> = {
  checkin: 'editor'
};

export const adminPermissions = [
  'dashboard.read',
  'entries.read',
  'entries.payment.read',
  'entries.status.write',
  'entries.checkin.write',
  'entries.participants.write',
  'stamp_cards.print',
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
  'iam.write',
  'inspection.read',
  'inspection.write',
  'marshals.read',
  'marshals.write',
  'marshals.export'
] as const;
export type AdminPermission = (typeof adminPermissions)[number];
export type AdminReadPermission = Extract<AdminPermission, `${string}.read`>;
const adminPermissionSet = new Set<string>(adminPermissions);

const rolePermissions: Record<AllowedRole, AdminPermission[]> = {
  admin: [
    'dashboard.read',
    'entries.read',
    'entries.payment.read',
    'entries.status.write',
    'entries.checkin.write',
    'entries.participants.write',
    'stamp_cards.print',
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
    'iam.write',
    'inspection.read',
    'inspection.write',
    'marshals.read',
    'marshals.write',
    'marshals.export'
  ],
  editor: [
    'dashboard.read',
    'entries.read',
    'entries.payment.read',
    'entries.status.write',
    'entries.checkin.write',
    'entries.participants.write',
    'stamp_cards.print',
    'entries.payment.write',
    'entries.notes.write',
    'exports.read'
  ],
  viewer: ['dashboard.read', 'entries.read', 'entries.payment.read', 'exports.read'],
  technical_inspector: ['inspection.read', 'inspection.write'],
  marshal_manager: ['marshals.read', 'marshals.write', 'marshals.export']
};

export type AuthContext = {
  sub: string | null;
  email: string | null;
  groups: AllowedRole[];
  scopes: string[];
  mfaAuthenticated: boolean;
  automationApproval: AutomationApprovalContext | null;
};

export const MSC_SUPPORT_SCOPE_PREFIX = 'msc-support/';
export const MSC_SUPPORT_READ_SCOPE = `${MSC_SUPPORT_SCOPE_PREFIX}entries.read`;
export const MSC_SUPPORT_DELETE_SCOPE = `${MSC_SUPPORT_SCOPE_PREFIX}entries.delete`;
export const MSC_AUTOMATION_SCOPE_PREFIX = 'msc-automation/';

export const automationScopeForPermission = (
  permission: AdminPermission
): string => `${MSC_AUTOMATION_SCOPE_PREFIX}${permission}`;

export const permissionFromAutomationScope = (
  scope: string
): AdminPermission | null => {
  if (!scope.startsWith(MSC_AUTOMATION_SCOPE_PREFIX)) {
    return null;
  }
  const permission = scope.slice(MSC_AUTOMATION_SCOPE_PREFIX.length);
  return adminPermissionSet.has(permission)
    ? (permission as AdminPermission)
    : null;
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
  const automationApproval = getAutomationApprovalContext(event);
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
    sub: automationApproval
      ? `automation:${automationApproval.actionId}`
      : typeof claims.sub === 'string'
        ? claims.sub
        : null,
    email: typeof claims.email === 'string' ? claims.email : null,
    groups,
    scopes: parseClaimAsStringArray(claims.scope),
    mfaAuthenticated: isMfaAuthenticated(claims),
    automationApproval
  };
};

export const hasGroup = (ctx: AuthContext, group: AllowedRole): boolean => ctx.groups.includes(group);

export const hasAnyGroup = (ctx: AuthContext, groups: AllowedRole[]): boolean =>
  groups.some((group) => ctx.groups.includes(group));

export const hasPermission = (
  ctx: AuthContext,
  permission: AdminPermission
): boolean => ctx.groups.some((group) =>
  rolePermissions[group].includes(permission)
) || ctx.scopes.includes(`${MSC_SUPPORT_SCOPE_PREFIX}${permission}`) || (
  !permission.endsWith('.read') &&
  ctx.automationApproval !== null &&
  hasAutomationPermission(ctx, permission)
);

export const hasAutomationPermission = (
  ctx: AuthContext,
  permission: AdminPermission
): boolean => ctx.scopes.includes(automationScopeForPermission(permission));

export const hasPermissionOrAutomation = (
  ctx: AuthContext,
  permission: AdminReadPermission
): boolean => hasPermission(ctx, permission) ||
  (permission.endsWith('.read') && hasAutomationPermission(ctx, permission));

export const canReadEventClassOptions = (ctx: AuthContext): boolean =>
  (['settings.read', 'entries.read'] satisfies AdminReadPermission[]).some((permission) =>
    hasPermissionOrAutomation(ctx, permission)
  );

const approvalActionIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const payloadHashPattern = /^[a-f0-9]{64}$/;

export type AutomationApprovalContext = {
  actionId: string;
  payloadHash: string;
  approvedAt: string;
};

export const getAutomationApprovalContext = (
  event: APIGatewayProxyEventV2,
  nowMs = Date.now()
): AutomationApprovalContext | null => {
  const headers = Object.fromEntries(
    Object.entries(event.headers ?? {}).map(([key, value]) => [
      key.toLowerCase(),
      value
    ])
  );
  const actionId = headers['x-msc-approval-action-id']?.trim() ?? '';
  const payloadHash =
    headers['x-msc-approval-payload-sha256']?.trim().toLowerCase() ?? '';
  const approvedAt = headers['x-msc-approval-approved-at']?.trim() ?? '';
  const idempotencyKey = headers['idempotency-key']?.trim() ?? '';
  const approvedAtMs = Date.parse(approvedAt);
  if (
    !approvalActionIdPattern.test(actionId) ||
    !payloadHashPattern.test(payloadHash) ||
    idempotencyKey !== actionId ||
    !Number.isFinite(approvedAtMs) ||
    approvedAtMs > nowMs + 60_000 ||
    nowMs - approvedAtMs > 20 * 60_000
  ) {
    return null;
  }
  return { actionId, payloadHash, approvedAt };
};

export const hasAnyPermission = (ctx: AuthContext, permissions: AdminPermission[]): boolean =>
  permissions.some((permission) => hasPermission(ctx, permission));

/** @deprecated Use hasPermission(ctx, 'entries.read') directly. */
export const hasSupportRegistrationRead = (ctx: AuthContext): boolean =>
  hasPermission(ctx, 'entries.read');

/** @deprecated Use hasPermission(ctx, 'entries.delete') directly. */
export const hasSupportEntryDelete = (ctx: AuthContext): boolean =>
  hasPermission(ctx, 'entries.delete');
