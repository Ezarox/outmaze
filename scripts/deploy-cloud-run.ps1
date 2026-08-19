param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern("^[a-z][a-z0-9-]{4,28}[a-z0-9]$")]
  [string]$ProjectId,

  [string]$Region = "australia-southeast1",

  [string]$Service = "outmaze"
)

$ErrorActionPreference = "Stop"

gcloud config set project $ProjectId
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
gcloud run deploy $Service `
  --source . `
  --project $ProjectId `
  --region $Region `
  --allow-unauthenticated `
  --execution-environment gen2 `
  --port 8080 `
  --timeout 3600 `
  --concurrency 80 `
  --min-instances 0 `
  --max-instances 1 `
  --memory 512Mi `
  --cpu 1 `
  --set-env-vars "NODE_ENV=production,ALLOWED_ORIGINS=https://ezarox.github.io,PUBLIC_SITE_URL=https://ezarox.github.io/outmaze/" `
  --quiet

gcloud run services describe $Service `
  --project $ProjectId `
  --region $Region `
  --format "value(status.url)"
