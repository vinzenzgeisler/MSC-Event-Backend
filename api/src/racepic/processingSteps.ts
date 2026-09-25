import { getPool } from '../db/client';

export type RacePicProcessingStage = 'ingest' | 'analyze' | 'match' | 'publish';

const LEASE_SECONDS: Record<RacePicProcessingStage, number> = {
  ingest: 180,
  analyze: 240,
  match: 360,
  publish: 180
};

/** Atomically claims a stage so concurrent SQS deliveries cannot run the same work twice. */
export const claimProcessingStep = async (
  imageId: string,
  step: RacePicProcessingStage,
  pipelineVersion: string
): Promise<boolean> => {
  const pool = await getPool();
  const result = await pool.query(
    `insert into racepic_processing_step
       (image_id, step, pipeline_version, status, attempt_count, lease_expires_at, started_at, finished_at, error)
     values ($1, $2, $3, 'IN_PROGRESS', 1, now() + ($4 * interval '1 second'), now(), null, null)
     on conflict (image_id, step, pipeline_version) do update
       set status = 'IN_PROGRESS',
           attempt_count = racepic_processing_step.attempt_count + 1,
           lease_expires_at = now() + ($4 * interval '1 second'),
           started_at = now(),
           finished_at = null,
           error = null
     where racepic_processing_step.status = 'FAILED'
        or (racepic_processing_step.status = 'IN_PROGRESS' and racepic_processing_step.lease_expires_at < now())
     returning id`,
    [imageId, step, pipelineVersion, LEASE_SECONDS[step]]
  );
  return result.rowCount === 1;
};

export const finishProcessingStep = async (
  imageId: string,
  step: RacePicProcessingStage,
  pipelineVersion: string
): Promise<void> => {
  const pool = await getPool();
  await pool.query(
    `update racepic_processing_step
        set status = 'DONE', finished_at = now(), lease_expires_at = null, error = null
      where image_id = $1 and step = $2 and pipeline_version = $3`,
    [imageId, step, pipelineVersion]
  );
};

export const failProcessingStep = async (
  imageId: string,
  step: RacePicProcessingStage,
  pipelineVersion: string,
  error: unknown
): Promise<void> => {
  const message = error instanceof Error ? error.message : String(error);
  const pool = await getPool();
  await pool.query(
    `update racepic_processing_step
        set status = 'FAILED', finished_at = now(), lease_expires_at = null, error = $4
      where image_id = $1 and step = $2 and pipeline_version = $3`,
    [imageId, step, pipelineVersion, message.slice(0, 500)]
  );
};
