export type RunGroupClass = {
  id: string;
  eventId: string;
  runGroupId: string | null;
  registrationClosed?: boolean;
  vehicleType?: string;
};

export type RunGroupEntry = {
  id: string;
  driverPersonId: string;
  classId: string;
  backupClassId: string | null;
  isBackupVehicle: boolean;
};

export const effectiveRunGroupId = (clazz: Pick<RunGroupClass, 'id' | 'runGroupId'>): string =>
  clazz.runGroupId ?? clazz.id;

export const reservedStartNumberClassIds = (classId: string, backupClassId: string | null): string[] =>
  backupClassId && backupClassId !== classId ? [classId, backupClassId] : [classId];

export const assertBackupClassCompatible = (
  primary: RunGroupClass,
  backup: RunGroupClass,
  options: { requireOpen?: boolean; backupVehicleType?: string | null } = {}
) => {
  if (primary.eventId !== backup.eventId || effectiveRunGroupId(primary) !== effectiveRunGroupId(backup)) {
    throw new Error('BACKUP_CLASS_INVALID');
  }
  if (options.requireOpen && backup.registrationClosed) {
    throw new Error('BACKUP_CLASS_CLOSED');
  }
  if (options.backupVehicleType && backup.vehicleType !== options.backupVehicleType) {
    throw new Error('BACKUP_CLASS_VEHICLE_TYPE_MISMATCH');
  }
};

export const assertUniqueEffectiveRunGroups = (
  entries: RunGroupEntry[],
  classesById: ReadonlyMap<string, RunGroupClass>
) => {
  const occupied = new Set<string>();
  for (const item of entries) {
    const primary = classesById.get(item.classId);
    if (!primary) {
      throw new Error('CLASS_NOT_FOUND');
    }
    if (!item.isBackupVehicle) {
      const key = `${item.driverPersonId}:${effectiveRunGroupId(primary)}`;
      if (occupied.has(key)) {
        throw new Error('RUN_GROUP_CONFLICT');
      }
      occupied.add(key);
    }
    if (item.backupClassId) {
      const backup = classesById.get(item.backupClassId);
      if (!backup) {
        throw new Error('BACKUP_CLASS_INVALID');
      }
      assertBackupClassCompatible(primary, backup);
    }
  }
};
