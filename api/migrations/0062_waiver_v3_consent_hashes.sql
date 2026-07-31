-- Update public_legal_texts in app_config to waiver-v3.0
-- New hashes reflect the updated Vertrags- und Verzichtserklärung text
-- (full paper-form wording including Führerschein, Ü70 Attestpflicht,
--  DMV insurance notice, explicit burnout clause and force-majeure clause).

update "app_config"
set
  "payload" = jsonb_build_object(
    'currentVersion', 'privacy-v2.1+terms-v2.0+waiver-v3.0+media-v2.0+club-info-v1.0',
    'locales',
    jsonb_build_object(
      'de-DE',
      jsonb_build_object(
        'consentLocale',   'de-DE',
        'consentVersion',  'privacy-v2.1+terms-v2.0+waiver-v3.0+media-v2.0+club-info-v1.0',
        'consentTextHash', 'a4e9c75e10f16a3240dd4d1444f1f140882f5c0995601baf25687aaf96631119',
        'publishedAt',     '2026-07-31T00:00:00.000Z'
      ),
      'en-GB',
      jsonb_build_object(
        'consentLocale',   'en-GB',
        'consentVersion',  'privacy-v2.1+terms-v2.0+waiver-v3.0+media-v2.0+club-info-v1.0',
        'consentTextHash', 'd9ba8149e58886ce225bee6deddd07069a77af151f72eaff0eb1f01d612548e1',
        'publishedAt',     '2026-07-31T00:00:00.000Z'
      ),
      'cs-CZ',
      jsonb_build_object(
        'consentLocale',   'cs-CZ',
        'consentVersion',  'privacy-v2.1+terms-v2.0+waiver-v3.0+media-v2.0+club-info-v1.0',
        'consentTextHash', '22cf2e07b91d56e934afc72370cedd6942a463ca6f05bd0d53566a965735b7c7',
        'publishedAt',     '2026-07-31T00:00:00.000Z'
      ),
      'pl-PL',
      jsonb_build_object(
        'consentLocale',   'pl-PL',
        'consentVersion',  'privacy-v2.1+terms-v2.0+waiver-v3.0+media-v2.0+club-info-v1.0',
        'consentTextHash', '982e41066a1e5f2643742cfa09bfcdb3bc6508800b4e8cbfa557718585113a34',
        'publishedAt',     '2026-07-31T00:00:00.000Z'
      )
    )
  )::jsonb,
  "updated_at" = now(),
  "updated_by" = 'system'
where "config_key" = 'public_legal_texts';
