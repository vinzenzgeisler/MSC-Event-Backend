-- Extend export_job.type CHECK constraint to include programmheft_xlsx
ALTER TABLE "export_job" DROP CONSTRAINT IF EXISTS "export_job_type_check";
ALTER TABLE "export_job" ADD CONSTRAINT "export_job_type_check"
  CHECK (type in (
    'entries_csv',
    'startlist_csv',
    'participants_csv',
    'payments_open_csv',
    'checkin_status_csv',
    'programmheft_xlsx'
  ));
