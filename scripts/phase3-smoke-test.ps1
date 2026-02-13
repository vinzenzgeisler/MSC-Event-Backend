$ErrorActionPreference = "Stop"

$Region = "eu-central-1"
$Stage = "dev"

# ---- Configure ----
$AdminUsername = "admin@example.com"
$AdminPassword = "YourStr0ngPassw0rd!"
$SesVerifiedRecipient = "your-verified-ses@example.com"

# Use seeded IDs
$EventId = "11111111-1111-1111-1111-111111111111"
$EntryId = "55555555-5555-5555-5555-555555555555"
# -------------------

function Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }

Step "Load stack outputs"
$ApiUrl = (aws cloudformation describe-stacks `
  --stack-name "dreiecksrennen-$Stage-api-stack" `
  --region $Region `
  --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" `
  --output text).TrimEnd('/')

$UserPoolId = aws cloudformation describe-stacks `
  --stack-name "dreiecksrennen-$Stage-auth-stack" `
  --region $Region `
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" `
  --output text

$ClientId = aws cloudformation describe-stacks `
  --stack-name "dreiecksrennen-$Stage-auth-stack" `
  --region $Region `
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolClientId'].OutputValue" `
  --output text

Write-Host "API_URL: $ApiUrl"
Write-Host "USER_POOL_ID: $UserPoolId"
Write-Host "CLIENT_ID: $ClientId"

Step "Ensure admin group membership"
aws cognito-idp admin-add-user-to-group `
  --user-pool-id $UserPoolId `
  --username $AdminUsername `
  --group-name admin `
  --region $Region | Out-Null

Step "Get JWT"
$AuthJson = aws cognito-idp initiate-auth `
  --auth-flow USER_PASSWORD_AUTH `
  --client-id $ClientId `
  --auth-parameters "USERNAME=$AdminUsername,PASSWORD=$AdminPassword" `
  --region $Region | ConvertFrom-Json

$JwtAdmin = $AuthJson.AuthenticationResult.IdToken
if (-not $JwtAdmin) { throw "No IdToken returned. Check username/password/client-id." }

$Headers = @{
  Authorization = "Bearer $JwtAdmin"
  "Content-Type" = "application/json"
}

Step "1) Health"
$Health = Invoke-RestMethod -Method GET -Uri "$ApiUrl/health"
$Health | ConvertTo-Json -Depth 8

Step "2) Admin Ping"
$Ping = Invoke-RestMethod -Method GET -Uri "$ApiUrl/admin/ping" -Headers $Headers
$Ping | ConvertTo-Json -Depth 8

Step "3) DB Ping"
$DbPing = Invoke-RestMethod -Method GET -Uri "$ApiUrl/admin/db/ping" -Headers $Headers
$DbPing | ConvertTo-Json -Depth 8

Step "4) DB Schema"
$Schema = Invoke-RestMethod -Method GET -Uri "$ApiUrl/admin/db/schema" -Headers $Headers
$Schema | ConvertTo-Json -Depth 8

Step "5) Queue test mail"
$MailBody = @{
  eventId = $EventId
  templateId = "test-template"
  subject = "Phase 3 Test Mail"
  recipientEmails = @($SesVerifiedRecipient)
} | ConvertTo-Json -Depth 8

$MailResult = Invoke-RestMethod -Method POST -Uri "$ApiUrl/admin/mail/queue" -Headers $Headers -Body $MailBody
$MailResult | ConvertTo-Json -Depth 8

Step "6) Queue payment reminders"
$ReminderBody = @{
  eventId = $EventId
  templateId = "payment-reminder"
  subject = "Zahlungserinnerung"
} | ConvertTo-Json -Depth 8

$ReminderResult = Invoke-RestMethod -Method POST -Uri "$ApiUrl/admin/payment/reminders/queue" -Headers $Headers -Body $ReminderBody
$ReminderResult | ConvertTo-Json -Depth 8

Step "7) Generate waiver document"
$DocBody = @{
  eventId = $EventId
  entryId = $EntryId
} | ConvertTo-Json -Depth 8

$DocResult = Invoke-RestMethod -Method POST -Uri "$ApiUrl/admin/documents/waiver" -Headers $Headers -Body $DocBody
$DocResult | ConvertTo-Json -Depth 8

$DocumentId = $DocResult.documentId
if (-not $DocumentId) { throw "No documentId returned from /admin/documents/waiver." }

Step "8) Get presigned download URL"
$DownloadResult = Invoke-RestMethod -Method GET -Uri "$ApiUrl/admin/documents/$DocumentId/download" -Headers $Headers
$DownloadResult | ConvertTo-Json -Depth 8
$DownloadResult.url

Step "Done"
Write-Host "Phase 3 smoke test completed." -ForegroundColor Green
