-- Bug (gefunden 2026-09-29): "racepic_photographer_cognito_sub_unique" war nicht auf "deleted_at is null"
-- eingeschraenkt (anders als der email_norm-Index direkt darueber). Ein soft-geloeschter Fotograf behaelt
-- seinen cognito_sub (deletePhotographer loescht ihn nicht, siehe repository.ts), eine erneute Einladung
-- derselben E-Mail-Adresse legt wegen des email_norm-Index korrekt eine neue Zeile an - aber /photographer/claim
-- scheitert dann mit Postgres 23505 (unique_violation), weil die alte, geloeschte Zeile denselben cognito_sub
-- noch belegt. Fix: denselben Deleted-At-Filter wie beim email_norm-Index anwenden.

drop index if exists "racepic_photographer_cognito_sub_unique";
create unique index if not exists "racepic_photographer_cognito_sub_unique"
  on "racepic_photographer" ("cognito_sub") where "cognito_sub" is not null and "deleted_at" is null;
