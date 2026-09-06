alter table "event"
  alter column "stamp_card_accent_color" set default '#153A81';

-- Move only the automatically assigned legacy colors to the new design
-- palette. Explicitly customized event colors remain untouched.
update "event"
set "stamp_card_accent_color" = case extract(year from "starts_at")::int
  when 2026 then '#153A81'
  when 2027 then '#B5121B'
  when 2028 then '#1F7A4D'
  when 2029 then '#C9A227'
end
where
  (extract(year from "starts_at")::int = 2026 and upper("stamp_card_accent_color") = '#0F6B65')
  or (extract(year from "starts_at")::int = 2027 and upper("stamp_card_accent_color") = '#8B1E3F')
  or (extract(year from "starts_at")::int = 2028 and upper("stamp_card_accent_color") = '#2F6B3C')
  or (extract(year from "starts_at")::int = 2029 and upper("stamp_card_accent_color") = '#6B4E9B');
