-- RacePic Commerce (AP18): lueckenlose Nummernkreise fuer Rechnungen, Gutschriften und Korrekturbelege.
-- Eine Nummer wird immer in derselben Transaktion vergeben, die den Beleg anlegt: bei einem Rollback verfaellt
-- auch die Nummer, es entstehen keine Luecken. Der Zeilenlock des Upserts serialisiert parallele Vergaben.

create table if not exists "commerce_document_sequence" (
  "kind" text not null,
  "year" integer not null,
  "last_number" integer not null default 0,
  primary key ("kind", "year"),
  constraint "commerce_document_sequence_kind_check" check ("kind" in ('INVOICE', 'CREDIT_NOTE', 'CORRECTION')),
  constraint "commerce_document_sequence_year_check" check ("year" between 2000 and 2999)
);
