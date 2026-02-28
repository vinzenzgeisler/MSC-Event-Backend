import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
  UserType
} from '@aws-sdk/client-cognito-identity-provider';
import { z } from 'zod';

const allowedRoles = ['admin', 'editor', 'viewer'] as const;

const roleSchema = z.enum(allowedRoles);

const listUsersSchema = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(60).default(25),
  search: z.string().trim().min(1).max(100).optional(),
  role: roleSchema.optional(),
  enabled: z.boolean().optional()
});

const createUserSchema = z.object({
  email: z.string().email(),
  roles: z.array(roleSchema).min(1),
  temporaryPassword: z.string().min(8).max(256).optional(),
  sendInvitation: z.boolean().default(true)
}).superRefine((value, ctx) => {
  // Without invitation mail, an explicit temporary password is required so the account can be used.
  if (!value.sendInvitation && !value.temporaryPassword) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['temporaryPassword'],
      message: 'temporaryPassword is required when sendInvitation is false'
    });
  }
});

const patchRolesSchema = z.object({
  roles: z.array(roleSchema).min(1)
});

const patchStatusSchema = z.object({
  enabled: z.boolean()
});

type ListUsersInput = z.infer<typeof listUsersSchema>;
type CreateUserInput = z.infer<typeof createUserSchema>;
type PatchRolesInput = z.infer<typeof patchRolesSchema>;
type PatchStatusInput = z.infer<typeof patchStatusSchema>;

const createClient = () =>
  new CognitoIdentityProviderClient({
    region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'eu-central-1'
  });

const getUserPoolId = () => {
  const userPoolId = process.env.COGNITO_USER_POOL_ID;
  if (!userPoolId) {
    throw new Error('IAM_USER_POOL_NOT_CONFIGURED');
  }
  return userPoolId;
};

const normalizeRoles = (roles: string[]) => Array.from(new Set(roles.filter((role) => allowedRoles.includes(role as (typeof allowedRoles)[number]))));

const getAttributesMap = (user: UserType | { Attributes?: { Name?: string; Value?: string }[] }) => {
  const map = new Map<string, string>();
  for (const attr of user.Attributes ?? []) {
    if (attr.Name && attr.Value !== undefined) {
      map.set(attr.Name, attr.Value);
    }
  }
  return map;
};

const getUserRoles = async (client: CognitoIdentityProviderClient, userPoolId: string, username: string) => {
  const response = await client.send(
    new AdminListGroupsForUserCommand({
      UserPoolId: userPoolId,
      Username: username
    })
  );
  return normalizeRoles((response.Groups ?? []).map((group) => group.GroupName ?? ''));
};

const mapUserDto = async (client: CognitoIdentityProviderClient, userPoolId: string, user: UserType) => {
  const roles = await getUserRoles(client, userPoolId, user.Username ?? '');
  const attrs = getAttributesMap(user);
  return {
    id: user.Username ?? '',
    username: user.Username ?? '',
    email: attrs.get('email') ?? null,
    enabled: user.Enabled ?? false,
    status: (user.UserStatus ?? 'UNKNOWN').toLowerCase(),
    emailVerified: attrs.get('email_verified') === 'true',
    roles,
    createdAt: user.UserCreateDate?.toISOString() ?? null,
    updatedAt: user.UserLastModifiedDate?.toISOString() ?? null
  };
};

const loadUserDto = async (client: CognitoIdentityProviderClient, userPoolId: string, userId: string) => {
  const response = await client.send(
    new AdminGetUserCommand({
      UserPoolId: userPoolId,
      Username: userId
    })
  );

  const attrs = getAttributesMap({
    Attributes: response.UserAttributes
  });
  const roles = await getUserRoles(client, userPoolId, response.Username ?? userId);
  return {
    id: response.Username ?? userId,
    username: response.Username ?? userId,
    email: attrs.get('email') ?? null,
    enabled: response.Enabled ?? false,
    status: (response.UserStatus ?? 'UNKNOWN').toLowerCase(),
    emailVerified: attrs.get('email_verified') === 'true',
    roles,
    createdAt: response.UserCreateDate?.toISOString() ?? null,
    updatedAt: response.UserLastModifiedDate?.toISOString() ?? null
  };
};

const mapCognitoError = (error: unknown): never => {
  if (!(error instanceof Error)) {
    throw error;
  }
  if (error.name === 'UserNotFoundException') {
    throw new Error('IAM_USER_NOT_FOUND');
  }
  if (error.name === 'UsernameExistsException') {
    throw new Error('IAM_USER_EXISTS');
  }
  if (error.name === 'NotAuthorizedException') {
    throw new Error('IAM_PERMISSION_DENIED');
  }
  if (error.name === 'InvalidPasswordException') {
    throw new Error('IAM_INVALID_TEMP_PASSWORD');
  }
  if (error.name === 'CodeDeliveryFailureException') {
    throw new Error('IAM_INVITATION_SEND_FAILED');
  }
  if (error.name === 'InvalidParameterException') {
    throw new Error('IAM_INVALID_PARAMETER');
  }
  if (error.name === 'GroupNotFoundException') {
    throw new Error('IAM_ROLE_MAPPING_FAILED');
  }
  throw error;
};

export const listIamRoles = () => ({
  roles: [
    {
      key: 'admin',
      description: 'Full access'
    },
    {
      key: 'editor',
      description: 'Entries/checkin/notes write and exports read'
    },
    {
      key: 'viewer',
      description: 'Read-only access'
    }
  ]
});

export const listIamUsers = async (input: ListUsersInput) => {
  const client = createClient();
  const userPoolId = getUserPoolId();
  const safeSearch = input.search?.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const filter = safeSearch ? `email ^= \"${safeSearch}\"` : undefined;

  try {
    const response = await client.send(
      new ListUsersCommand({
        UserPoolId: userPoolId,
        Limit: input.limit,
        PaginationToken: input.cursor,
        Filter: filter
      })
    );

    const mapped = await Promise.all((response.Users ?? []).map((user) => mapUserDto(client, userPoolId, user)));
    const filtered = mapped.filter((user) => {
      if (input.role && !user.roles.includes(input.role)) {
        return false;
      }
      if (input.enabled !== undefined && user.enabled !== input.enabled) {
        return false;
      }
      return true;
    });

    return {
      users: filtered,
      meta: {
        nextCursor: response.PaginationToken ?? null,
        limit: input.limit
      }
    };
  } catch (error) {
    mapCognitoError(error);
  }
};

export const createIamUser = async (input: CreateUserInput) => {
  const client = createClient();
  const userPoolId = getUserPoolId();
  const username = input.email.trim().toLowerCase();
  const roles = normalizeRoles(input.roles);
  if (roles.length === 0) {
    throw new Error('IAM_ROLE_MAPPING_FAILED');
  }

  try {
    await client.send(
      new AdminCreateUserCommand({
        UserPoolId: userPoolId,
        Username: username,
        UserAttributes: [
          { Name: 'email', Value: username },
          { Name: 'email_verified', Value: 'false' }
        ],
        DesiredDeliveryMediums: input.sendInvitation ? ['EMAIL'] : undefined,
        MessageAction: input.sendInvitation ? undefined : 'SUPPRESS',
        TemporaryPassword: input.temporaryPassword
      })
    );

    for (const role of roles) {
      await client.send(
        new AdminAddUserToGroupCommand({
          UserPoolId: userPoolId,
          Username: username,
          GroupName: role
        })
      );
    }

    return {
      user: await loadUserDto(client, userPoolId, username)
    };
  } catch (error) {
    mapCognitoError(error);
  }
};

export const patchIamUserRoles = async (userId: string, input: PatchRolesInput) => {
  const client = createClient();
  const userPoolId = getUserPoolId();
  const desiredRoles = normalizeRoles(input.roles);
  if (desiredRoles.length === 0) {
    throw new Error('IAM_ROLE_MAPPING_FAILED');
  }

  try {
    await loadUserDto(client, userPoolId, userId);
    const currentRoles = await getUserRoles(client, userPoolId, userId);

    const toRemove = currentRoles.filter((role) => !desiredRoles.includes(role));
    const toAdd = desiredRoles.filter((role) => !currentRoles.includes(role));

    for (const role of toRemove) {
      await client.send(
        new AdminRemoveUserFromGroupCommand({
          UserPoolId: userPoolId,
          Username: userId,
          GroupName: role
        })
      );
    }

    for (const role of toAdd) {
      await client.send(
        new AdminAddUserToGroupCommand({
          UserPoolId: userPoolId,
          Username: userId,
          GroupName: role
        })
      );
    }

    return {
      user: await loadUserDto(client, userPoolId, userId)
    };
  } catch (error) {
    mapCognitoError(error);
  }
};

export const patchIamUserStatus = async (userId: string, input: PatchStatusInput) => {
  const client = createClient();
  const userPoolId = getUserPoolId();

  try {
    if (input.enabled) {
      await client.send(
        new AdminEnableUserCommand({
          UserPoolId: userPoolId,
          Username: userId
        })
      );
    } else {
      await client.send(
        new AdminDisableUserCommand({
          UserPoolId: userPoolId,
          Username: userId
        })
      );
    }

    return {
      user: await loadUserDto(client, userPoolId, userId)
    };
  } catch (error) {
    mapCognitoError(error);
  }
};

export const validateListIamUsersInput = (query: Record<string, string | undefined>) =>
  listUsersSchema.parse({
    cursor: query.cursor,
    limit: query.limit === undefined ? undefined : Number(query.limit),
    search: query.search,
    role: query.role,
    enabled: query.enabled === undefined ? undefined : query.enabled === 'true'
  });

export const validateCreateIamUserInput = (payload: unknown) => createUserSchema.parse(payload);
export const validatePatchIamUserRolesInput = (payload: unknown) => patchRolesSchema.parse(payload);
export const validatePatchIamUserStatusInput = (payload: unknown) => patchStatusSchema.parse(payload);
