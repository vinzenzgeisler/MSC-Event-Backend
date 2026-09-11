export type InspectionRequirement = 'payment' | 'waiver';
export type InspectionTechStatus = 'pending' | 'passed' | 'failed';

export type InspectionEligibility = {
  ready: boolean;
  paymentStatus: 'due' | 'paid' | 'not_required' | 'unknown';
  waiverSigned: boolean;
  missingRequirements: InspectionRequirement[];
};

export type InspectionProgressEntry = {
  id: string;
  startNumber: string | null;
  className: string;
  vehicleMake: string | null;
  vehicleModel: string | null;
  techStatus: InspectionTechStatus;
  backupVehicleId: string | null;
  backupVehicleMake?: string | null;
  backupVehicleModel?: string | null;
  backupTechStatus: InspectionTechStatus;
};

export type InspectionProgressTarget = {
  entryId: string;
  target: 'primary' | 'backup';
  startNumber: string | null;
  className: string;
  vehicleMake: string | null;
  vehicleModel: string | null;
  status: InspectionTechStatus;
};

export type ParticipantInspectionSummary = {
  totalTargets: number;
  passedTargets: number;
  pendingTargets: number;
  failedTargets: number;
  stampReady: boolean;
  targets: InspectionProgressTarget[];
};

export const evaluateInspectionEligibility = (
  paymentStatus: string | null | undefined,
  waiverSigned: boolean
): InspectionEligibility => {
  const normalizedPaymentStatus: InspectionEligibility['paymentStatus'] =
    paymentStatus === 'paid' || paymentStatus === 'not_required' || paymentStatus === 'due'
      ? paymentStatus
      : 'unknown';
  const missingRequirements: InspectionRequirement[] = [];
  if (normalizedPaymentStatus !== 'paid' && normalizedPaymentStatus !== 'not_required') {
    missingRequirements.push('payment');
  }
  if (!waiverSigned) missingRequirements.push('waiver');
  return {
    ready: missingRequirements.length === 0,
    paymentStatus: normalizedPaymentStatus,
    waiverSigned,
    missingRequirements
  };
};

export const buildParticipantInspectionSummary = (
  entries: InspectionProgressEntry[],
  eligibility: InspectionEligibility
): ParticipantInspectionSummary => {
  const targets = entries.flatMap<InspectionProgressTarget>((entry) => [
    {
      entryId: entry.id,
      target: 'primary',
      startNumber: entry.startNumber,
      className: entry.className,
      vehicleMake: entry.vehicleMake,
      vehicleModel: entry.vehicleModel,
      status: entry.techStatus
    },
    ...(entry.backupVehicleId
      ? [{
          entryId: entry.id,
          target: 'backup' as const,
          startNumber: entry.startNumber,
          className: entry.className,
          vehicleMake: entry.backupVehicleMake ?? null,
          vehicleModel: entry.backupVehicleModel ?? null,
          status: entry.backupTechStatus
        }]
      : [])
  ]);
  const passedTargets = targets.filter((target) => target.status === 'passed').length;
  const pendingTargets = targets.filter((target) => target.status === 'pending').length;
  const failedTargets = targets.filter((target) => target.status === 'failed').length;
  return {
    totalTargets: targets.length,
    passedTargets,
    pendingTargets,
    failedTargets,
    stampReady: eligibility.ready && targets.length > 0 && passedTargets === targets.length,
    targets
  };
};
