param(
  [string]$Stage = "dev",
  [string]$Region = "eu-central-1",
  [string]$ApiUrl = "",
  [Parameter(Mandatory = $true)][string]$AdminUsername,
  [Parameter(Mandatory = $true)][string]$AdminPassword,
  [Parameter(Mandatory = $true)][string]$EmailDe,
  [Parameter(Mandatory = $true)][string]$EmailEn,
  [Parameter(Mandatory = $true)][string]$EmailCs,
  [Parameter(Mandatory = $true)][string]$EmailPl,
  [string]$OutputRoot = ".\artifacts\public-registration-dev-readiness"
)

$ErrorActionPreference = "Stop"

function Step($Message) {
  Write-Host "`n=== $Message ===" -ForegroundColor Cyan
}

function Ensure-Directory($Path) {
  if (-not (Test-Path $Path)) {
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
  }
}

function Get-StackOutput([string]$StackName, [string]$OutputKey) {
  $value = aws cloudformation describe-stacks `
    --stack-name $StackName `
    --region $Region `
    --query "Stacks[0].Outputs[?OutputKey=='$OutputKey'].OutputValue" `
    --output text
  return ($value | Out-String).Trim()
}

function Invoke-JsonRequest {
  param(
    [Parameter(Mandatory = $true)][ValidateSet("GET", "POST", "PUT", "PATCH", "DELETE")][string]$Method,
    [Parameter(Mandatory = $true)][string]$Uri,
    [hashtable]$Headers,
    $Body = $null
  )

  if ($null -eq $Body) {
    return Invoke-RestMethod -Method $Method -Uri $Uri -Headers $Headers
  }

  return Invoke-RestMethod -Method $Method -Uri $Uri -Headers $Headers -Body ($Body | ConvertTo-Json -Depth 20)
}

function New-ConsentPayload([string]$Locale) {
  $consentText = "MSC public registration consent $Locale"
  $consentBytes = [System.Text.Encoding]::UTF8.GetBytes($consentText)
  $hashBytes = [System.Security.Cryptography.SHA256]::HashData($consentBytes)
  $hash = [Convert]::ToHexString($hashBytes).ToLowerInvariant()

  return @{
    termsAccepted = $true
    privacyAccepted = $true
    waiverAccepted = $true
    mediaAccepted = $false
    clubInfoAccepted = $true
    consentVersion = "dev-readiness-2026-04-10"
    consentTextHash = $hash
    locale = $Locale
    consentSource = "public_form"
    consentCapturedAt = (Get-Date).ToUniversalTime().ToString("o")
  }
}

function New-DriverPayload {
  param(
    [string]$Email,
    [string]$Locale,
    [switch]$Minor
  )

  $nationalityByLocale = @{
    de = "de"
    en = "fr"
    cs = "cz"
    pl = "pl"
  }

  $birthdate = if ($Minor) { "2010-05-18" } else { "1988-03-14" }
  $payload = @{
    email = $Email
    firstName = "Test$($Locale.ToUpperInvariant())"
    lastName = if ($Minor) { "MinorDriver" } else { "Driver" }
    birthdate = $birthdate
    nationality = $nationalityByLocale[$Locale]
    street = "Musterstrasse 1"
    zip = "02763"
    city = "Bertsdorf-Hoernitz"
    phone = "01701234567"
    emergencyContactFirstName = "Notfall"
    emergencyContactLastName = "Kontakt"
    emergencyContactPhone = "01707654321"
    motorsportHistory = "Dev readiness test participant"
  }

  if ($Minor) {
    $payload.guardianFullName = "Guardian Test"
    $payload.guardianEmail = "guardian+$Locale@example.invalid"
    $payload.guardianPhone = "01705554444"
    $payload.guardianConsentAccepted = $true
  }

  return $payload
}

function New-VehiclePayload {
  param(
    [string]$VehicleType,
    [string]$Suffix
  )

  if ($VehicleType -eq "moto") {
    return @{
      vehicleType = "moto"
      make = "KTM"
      model = "EXC-$Suffix"
      year = "2019"
      displacementCcm = "250"
      cylinders = "1"
      vehicleHistory = "Ready for dev public registration test"
      ownerName = "MSC Test Team"
    }
  }

  return @{
    vehicleType = "auto"
    make = "NSU"
    model = "TT-$Suffix"
    year = "1971"
    displacementCcm = "1300"
    cylinders = "4"
    vehicleHistory = "Ready for dev public registration test"
    ownerName = "MSC Test Team"
  }
}

function New-CodriverPayload([string]$Locale) {
  return @{
    email = "codriver+$Locale@example.invalid"
    firstName = "Co$($Locale.ToUpperInvariant())"
    lastName = "Driver"
    birthdate = "1990-08-12"
    nationality = if ($Locale -eq "cs") { "cz" } elseif ($Locale -eq "pl") { "pl" } else { "de" }
    street = "Nebenweg 2"
    zip = "02763"
    city = "Bertsdorf-Hoernitz"
    phone = "01701112222"
  }
}

function Select-ClassIdByVehicleType($CurrentEvent, [string]$VehicleType, [int]$Index = 0) {
  $matches = @($CurrentEvent.classes | Where-Object { $_.vehicleType -eq $VehicleType })
  if ($matches.Count -le $Index) {
    throw "No class found for vehicleType=$VehicleType at index=$Index."
  }
  return $matches[$Index].id
}

function New-ScenarioEntries {
  param(
    $CurrentEvent,
    [string]$ScenarioName,
    [string]$Locale,
    [switch]$Codriver,
    [switch]$DoubleStarter,
    [switch]$BackupVehicle
  )

  $entries = @()
  $primaryType = if ($ScenarioName -match "moto") { "moto" } else { "auto" }
  $primaryClassId = Select-ClassIdByVehicleType -CurrentEvent $CurrentEvent -VehicleType $primaryType -Index 0
  $primaryEntry = @{
    classId = $primaryClassId
    codriverEnabled = [bool]$Codriver
    startNumber = "A$([Math]::Abs($ScenarioName.GetHashCode()) % 900 + 100)"
    vehicle = New-VehiclePayload -VehicleType $primaryType -Suffix "P"
  }
  if ($Codriver) {
    $primaryEntry.codriver = New-CodriverPayload -Locale $Locale
  }
  if ($BackupVehicle) {
    $primaryEntry.backupVehicle = New-VehiclePayload -VehicleType $primaryType -Suffix "B"
  }
  $entries += $primaryEntry

  if ($DoubleStarter) {
    $secondaryType = if ($primaryType -eq "moto") { "auto" } else { "moto" }
    $secondaryClassId = Select-ClassIdByVehicleType -CurrentEvent $CurrentEvent -VehicleType $secondaryType -Index 0
    $entries += @{
      classId = $secondaryClassId
      codriverEnabled = $false
      startNumber = "B$([Math]::Abs($ScenarioName.GetHashCode()) % 900 + 100)"
      vehicle = New-VehiclePayload -VehicleType $secondaryType -Suffix "S"
    }
  }

  return @($entries)
}

function Get-EntryIdsForEmail([string]$ApiUrl, $Headers, [string]$EventId, [string]$Email) {
  $encodedEmail = [System.Uri]::EscapeDataString($Email)
  $uri = "$ApiUrl/admin/entries?eventId=$EventId&q=$encodedEmail&limit=100"
  $response = Invoke-JsonRequest -Method GET -Uri $uri -Headers $Headers
  if (-not $response.entries) {
    return @()
  }
  return @($response.entries | Where-Object { $_.driverEmail -eq $Email } | ForEach-Object { $_.id })
}

function Remove-EntriesForEmail([string]$ApiUrl, $Headers, [string]$EventId, [string]$Email) {
  $entryIds = Get-EntryIdsForEmail -ApiUrl $ApiUrl -Headers $Headers -EventId $EventId -Email $Email
  foreach ($entryId in $entryIds) {
    Invoke-JsonRequest -Method DELETE -Uri "$ApiUrl/admin/entries/$entryId" -Headers $Headers -Body @{ deleteReason = "dev readiness cleanup" } | Out-Null
  }
  return $entryIds.Count
}

function Get-EntryDetail([string]$ApiUrl, $Headers, [string]$EntryId) {
  return Invoke-JsonRequest -Method GET -Uri "$ApiUrl/admin/entries/$EntryId" -Headers $Headers
}

function Save-MailPreviewArtifacts {
  param(
    [string]$ScenarioDir,
    [string]$TemplateKey,
    $Preview
  )

  Set-Content -Path (Join-Path $ScenarioDir "$TemplateKey.subject.txt") -Value $Preview.subjectRendered
  Set-Content -Path (Join-Path $ScenarioDir "$TemplateKey.body.txt") -Value $Preview.bodyTextRendered
  Set-Content -Path (Join-Path $ScenarioDir "$TemplateKey.body.html") -Value $Preview.bodyHtmlRendered
  Set-Content -Path (Join-Path $ScenarioDir "$TemplateKey.document.html") -Value $Preview.htmlDocument
  Set-Content -Path (Join-Path $ScenarioDir "$TemplateKey.meta.json") -Value ($Preview | ConvertTo-Json -Depth 20)
}

function Invoke-MailPreview {
  param(
    [string]$ApiUrl,
    $Headers,
    [string]$EntryId,
    [string]$TemplateKey
  )

  $body = @{
    templateKey = $TemplateKey
    entryId = $EntryId
    previewMode = "stored"
    renderOptions = @{
      showBadge = $true
      mailLabel = "Dev Readiness"
      includeEntryContext = $true
    }
  }

  return Invoke-JsonRequest -Method POST -Uri "$ApiUrl/admin/mail/templates/preview" -Headers $Headers -Body $body
}

function New-ScenarioResult([string]$Name, [string]$Locale, [string]$Email) {
  return [ordered]@{
    scenario = $Name
    locale = $Locale
    email = $Email
    cleanupDeleted = 0
    entryCount = 0
    verified = $false
    verificationResendOk = $false
    registrationStatus = $null
    consentLocale = $null
    communication = [ordered]@{
      registrationReceivedPreviewOk = $false
      reminderPreviewOk = $false
      registrationReceivedPreviewCode = $null
      reminderPreviewCode = $null
      missingPlaceholders = @()
      warnings = @()
    }
  }
}

Step "Prepare output"
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$outputDir = Join-Path $OutputRoot $timestamp
Ensure-Directory $outputDir

Step "Load stack outputs"
$apiUrl = if ($ApiUrl.Trim()) { $ApiUrl.Trim().TrimEnd('/') } else { (Get-StackOutput -StackName "dreiecksrennen-$Stage-api-stack" -OutputKey "ApiUrl").TrimEnd('/') }
$userPoolId = Get-StackOutput -StackName "dreiecksrennen-$Stage-auth-stack" -OutputKey "UserPoolId"
$clientId = Get-StackOutput -StackName "dreiecksrennen-$Stage-auth-stack" -OutputKey "UserPoolClientId"

Write-Host "API_URL: $apiUrl"
Write-Host "USER_POOL_ID: $userPoolId"
Write-Host "CLIENT_ID: $clientId"

Step "Authenticate admin"
$authJson = aws cognito-idp initiate-auth `
  --auth-flow USER_PASSWORD_AUTH `
  --client-id $clientId `
  --auth-parameters "USERNAME=$AdminUsername,PASSWORD=$AdminPassword" `
  --region $Region | ConvertFrom-Json
$jwt = $authJson.AuthenticationResult.IdToken
if (-not $jwt) {
  throw "No IdToken returned. Check admin credentials and Cognito client."
}
$headers = @{
  Authorization = "Bearer $jwt"
  "Content-Type" = "application/json"
}

Step "Load current public event"
$currentEvent = Invoke-JsonRequest -Method GET -Uri "$apiUrl/public/events/current"
if (-not $currentEvent.event.id) {
  throw "Current event missing."
}
$eventId = $currentEvent.event.id
$classCount = @($currentEvent.classes).Count
if ($classCount -lt 2) {
  throw "Public current event must expose at least two classes for dev readiness scenarios."
}

$summary = [ordered]@{
  generatedAt = (Get-Date).ToUniversalTime().ToString("o")
  stage = $Stage
  apiUrl = $apiUrl
  eventId = $eventId
  eventName = $currentEvent.event.name
  classCount = $classCount
  scenarios = @()
}

$scenarios = @(
  @{ name = "de-happy-moto"; locale = "de"; email = $EmailDe; codriver = $false; doubleStarter = $false; backupVehicle = $false; minor = $false; autoVerify = $true; previewReminder = $true },
  @{ name = "en-doublestarter-auto"; locale = "en"; email = $EmailEn; codriver = $false; doubleStarter = $true; backupVehicle = $false; minor = $false; autoVerify = $true; previewReminder = $false },
  @{ name = "cs-minor-moto"; locale = "cs"; email = $EmailCs; codriver = $false; doubleStarter = $false; backupVehicle = $false; minor = $true; autoVerify = $true; previewReminder = $false },
  @{ name = "pl-codriver-backup-auto"; locale = "pl"; email = $EmailPl; codriver = $true; doubleStarter = $false; backupVehicle = $true; minor = $false; autoVerify = $false; previewReminder = $true }
)

foreach ($scenario in $scenarios) {
  Step "Scenario $($scenario.name)"
  $scenarioDir = Join-Path $outputDir $scenario.name
  Ensure-Directory $scenarioDir
  $result = New-ScenarioResult -Name $scenario.name -Locale $scenario.locale -Email $scenario.email

  $deletedCount = Remove-EntriesForEmail -ApiUrl $apiUrl -Headers $headers -EventId $eventId -Email $scenario.email
  $result.cleanupDeleted = $deletedCount

  $payload = @{
    eventId = $eventId
    clientSubmissionKey = "dev-readiness-$($scenario.name)-$timestamp"
    driver = New-DriverPayload -Email $scenario.email -Locale $scenario.locale -Minor:([bool]$scenario.minor)
    consent = New-ConsentPayload -Locale $scenario.locale
    entries = @(New-ScenarioEntries -CurrentEvent $currentEvent -ScenarioName $scenario.name -Locale $scenario.locale -Codriver:([bool]$scenario.codriver) -DoubleStarter:([bool]$scenario.doubleStarter) -BackupVehicle:([bool]$scenario.backupVehicle))
  }

  Set-Content -Path (Join-Path $scenarioDir "request.json") -Value ($payload | ConvertTo-Json -Depth 20)

  $createResponse = Invoke-JsonRequest -Method POST -Uri "$apiUrl/public/events/$eventId/entries/batch" -Headers @{ "Content-Type" = "application/json" } -Body $payload
  Set-Content -Path (Join-Path $scenarioDir "create-response.json") -Value ($createResponse | ConvertTo-Json -Depth 20)

  $result.entryCount = @($createResponse.entryIds).Count

  foreach ($entryId in $createResponse.entryIds) {
    $detail = Get-EntryDetail -ApiUrl $apiUrl -Headers $headers -EntryId $entryId
    Set-Content -Path (Join-Path $scenarioDir "$entryId.detail.json") -Value ($detail | ConvertTo-Json -Depth 20)
  }

  $primaryEntryId = $createResponse.entryIds[0]
  $primaryDetail = Get-EntryDetail -ApiUrl $apiUrl -Headers $headers -EntryId $primaryEntryId
  $result.registrationStatus = $primaryDetail.entry.registrationStatus
  $result.consentLocale = $primaryDetail.entry.consent.locale

  try {
    $registrationPreview = Invoke-MailPreview -ApiUrl $apiUrl -Headers $headers -EntryId $primaryEntryId -TemplateKey "registration_received"
    Save-MailPreviewArtifacts -ScenarioDir $scenarioDir -TemplateKey "registration_received" -Preview $registrationPreview
    $result.communication.registrationReceivedPreviewOk = ($registrationPreview.missingPlaceholders.Count -eq 0)
    $result.communication.missingPlaceholders += @($registrationPreview.missingPlaceholders)
    $result.communication.warnings += @($registrationPreview.warnings)
  } catch {
    $errorPayload = $_.ErrorDetails.Message
    Set-Content -Path (Join-Path $scenarioDir "registration_received.preview-error.json") -Value $errorPayload
    try {
      $parsedError = $errorPayload | ConvertFrom-Json
      $result.communication.registrationReceivedPreviewCode = $parsedError.code
      $result.communication.warnings += @("registration_received preview failed: $($parsedError.code)")
    } catch {
      $result.communication.warnings += @('registration_received preview failed')
    }
  }

  if ($scenario.autoVerify) {
    $verifyResponse = Invoke-JsonRequest -Method POST -Uri "$apiUrl/public/entries/$primaryEntryId/verify-email" -Headers @{ "Content-Type" = "application/json" } -Body @{ token = $createResponse.verificationToken }
    Set-Content -Path (Join-Path $scenarioDir "verify-response.json") -Value ($verifyResponse | ConvertTo-Json -Depth 20)
    $verifiedDetail = Get-EntryDetail -ApiUrl $apiUrl -Headers $headers -EntryId $primaryEntryId
    Set-Content -Path (Join-Path $scenarioDir "$primaryEntryId.verified-detail.json") -Value ($verifiedDetail | ConvertTo-Json -Depth 20)
    $result.verified = ($verifiedDetail.entry.registrationStatus -eq "submitted_verified")
    $result.registrationStatus = $verifiedDetail.entry.registrationStatus
  }

  if ($scenario.previewReminder) {
    try {
      $reminderPreview = Invoke-MailPreview -ApiUrl $apiUrl -Headers $headers -EntryId $primaryEntryId -TemplateKey "email_confirmation_reminder"
      Save-MailPreviewArtifacts -ScenarioDir $scenarioDir -TemplateKey "email_confirmation_reminder" -Preview $reminderPreview
      $result.communication.reminderPreviewOk = ($reminderPreview.missingPlaceholders.Count -eq 0)
      $result.communication.missingPlaceholders += @($reminderPreview.missingPlaceholders)
      $result.communication.warnings += @($reminderPreview.warnings)
    } catch {
      $errorPayload = $_.ErrorDetails.Message
      Set-Content -Path (Join-Path $scenarioDir "email_confirmation_reminder.preview-error.json") -Value $errorPayload
      try {
        $parsedError = $errorPayload | ConvertFrom-Json
        $result.communication.reminderPreviewCode = $parsedError.code
        $result.communication.warnings += @("email_confirmation_reminder preview failed: $($parsedError.code)")
      } catch {
        $result.communication.warnings += @('email_confirmation_reminder preview failed')
      }
    }

    try {
      $resendResponse = Invoke-JsonRequest -Method POST -Uri "$apiUrl/public/entries/$primaryEntryId/verification-resend" -Headers @{ "Content-Type" = "application/json" } -Body @{}
      Set-Content -Path (Join-Path $scenarioDir "verification-resend.json") -Value ($resendResponse | ConvertTo-Json -Depth 20)
      $result.verificationResendOk = [bool]$resendResponse.ok
    } catch {
      $errorPayload = $_.ErrorDetails.Message
      Set-Content -Path (Join-Path $scenarioDir "verification-resend.error.json") -Value $errorPayload
      try {
        $parsedError = $errorPayload | ConvertFrom-Json
        $result.communication.warnings += @("verification resend failed: $($parsedError.code)")
      } catch {
        $result.communication.warnings += @('verification resend failed')
      }
    }
  }

  $summary.scenarios += $result
}

$summaryPath = Join-Path $outputDir "summary.json"
Set-Content -Path $summaryPath -Value ($summary | ConvertTo-Json -Depth 20)

$markdown = @(
  "# Public Registration Dev Readiness",
  "",
  "- Generated at: $($summary.generatedAt)",
  "- Stage: $($summary.stage)",
  "- API URL: $($summary.apiUrl)",
  "- Event: $($summary.eventName) ($($summary.eventId))",
  "",
  "## Scenario Results"
)

foreach ($scenario in $summary.scenarios) {
  $markdown += ""
  $markdown += "### $($scenario.scenario)"
  $markdown += "- Locale: $($scenario.locale)"
  $markdown += "- Email: $($scenario.email)"
  $markdown += "- Deleted old entries before run: $($scenario.cleanupDeleted)"
  $markdown += "- Created entries: $($scenario.entryCount)"
  $markdown += "- Registration status: $($scenario.registrationStatus)"
  $markdown += "- Verified automatically: $($scenario.verified)"
  $markdown += "- Verification resend ok: $($scenario.verificationResendOk)"
  $markdown += "- Consent locale: $($scenario.consentLocale)"
  $markdown += "- registration_received preview ok: $($scenario.communication.registrationReceivedPreviewOk)"
  $markdown += "- reminder preview ok: $($scenario.communication.reminderPreviewOk)"
  $markdown += "- registration_received preview code: $($scenario.communication.registrationReceivedPreviewCode)"
  $markdown += "- reminder preview code: $($scenario.communication.reminderPreviewCode)"
  $markdown += "- Missing placeholders: $([string]::Join(', ', @($scenario.communication.missingPlaceholders | Select-Object -Unique)))"
  $markdown += "- Warnings: $([string]::Join(' | ', @($scenario.communication.warnings | Select-Object -Unique)))"
}

$reportPath = Join-Path $outputDir "summary.md"
Set-Content -Path $reportPath -Value ($markdown -join "`r`n")

Step "Done"
Write-Host "Artifacts written to: $outputDir" -ForegroundColor Green
Write-Host "Summary JSON: $summaryPath" -ForegroundColor Green
Write-Host "Summary Markdown: $reportPath" -ForegroundColor Green
