-- Paper-fallback waiver export: a ZIP of pre-personalized, printable waiver PDFs for all
-- accepted drivers of an event, for use when the digital terminal signing flow is unavailable.
alter table "export_job" drop constraint if exists "export_job_type_check";
alter table "export_job" add constraint "export_job_type_check"
  check ("type" in ('entries_csv', 'startlist_csv', 'participants_csv', 'payments_open_csv', 'checkin_status_csv', 'programmheft_xlsx', 'stamp_cards_pdf', 'waiver_paper_zip'));
