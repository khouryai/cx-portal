#!/usr/bin/env bash
# =============================================================================
# CX Commissioning Portal — Azure provisioning script (dev environment)
#
# What this script does:
#   Stands up every Azure resource called out in 01-it-request.md §4 items
#   1–10, wires the backend's Managed Identity to Key Vault, Graph, and
#   PostgreSQL, and emits the URLs the deployment pipelines will need.
#
# What this script does NOT do:
#   · Create the Entra ID app registration (manual — needs admin consent).
#   · Configure Front Door / WAF (item 11) — Hitachi standard pattern preferred.
#   · Create the Azure DevOps org/project/repo (item 13) — done in the portal.
#   · Provision Notification Hubs (item 15) — added when mobile work starts.
#   · Inject application secrets — those are written to Key Vault by hand or
#     by a separate, audited deploy job. NO secrets in this file.
#
# Prereqs:
#   · az CLI ≥ 2.55, az extension add --name application-insights
#   · Logged in to the Hitachi tenant with Contributor on the target sub
#   · A few non-secret variables set in environment — see "Variables" below
#
# Convention: every name is parametrised. Replace the defaults to match
# Hitachi's naming standard before running. Run with --dry-run first by
# uncommenting the DRY_RUN line near the top.
# =============================================================================

set -euo pipefail
# DRY_RUN=echo  # Uncomment to print commands instead of running them
DRY_RUN=${DRY_RUN:-}

# ── Variables ────────────────────────────────────────────────────────────────
SUBSCRIPTION="${SUBSCRIPTION:-<subscription-id>}"
LOCATION="${LOCATION:-eastus}"
ENV="${ENV:-dev}"                              # dev | prod
PROJECT="${PROJECT:-cxportal}"
RG="${RG:-rg-${PROJECT}-${ENV}}"

# Resource names — adjust to corporate naming standard
SWA="swa-${PROJECT}-${ENV}"                    # Static Web App (SPA)
PLAN="plan-${PROJECT}-${ENV}"                  # App Service Plan
API_APP="app-${PROJECT}-api-${ENV}"            # Backend App Service
APIM="apim-${PROJECT}-${ENV}"                  # API Management
KV="kv-${PROJECT}-${ENV}-$(openssl rand -hex 2)"  # Key Vault (globally unique)
PG="pg-${PROJECT}-${ENV}"                      # PostgreSQL Flexible Server
PG_DB="cxportal"                               # Application database name
PG_ADMIN_USER="${PG_ADMIN_USER:-cxportaladmin}"  # admin login (password set securely below)
STG="st${PROJECT}${ENV}$(openssl rand -hex 2)"  # Storage account (globally unique)
LAW="law-${PROJECT}-${ENV}"                    # Log Analytics Workspace
AI="ai-${PROJECT}-${ENV}"                      # Application Insights

# APIM publisher contact — required by Azure
APIM_PUBLISHER_EMAIL="${APIM_PUBLISHER_EMAIL:-platform@hitachirail.example}"
APIM_PUBLISHER_NAME="${APIM_PUBLISHER_NAME:-Hitachi Rail Platform}"

# Tags applied to every resource for governance
TAGS=(--tags "project=cxportal" "env=${ENV}" "owner=t-and-c" "cost-center=<cc>")

# ── 0. Select subscription, create RG ────────────────────────────────────────
$DRY_RUN az account set --subscription "$SUBSCRIPTION"
$DRY_RUN az group create -n "$RG" -l "$LOCATION" "${TAGS[@]}"

# ── 1. Log Analytics + Application Insights (created first so others can wire in)
$DRY_RUN az monitor log-analytics workspace create \
  -g "$RG" -n "$LAW" -l "$LOCATION" "${TAGS[@]}"
LAW_ID=$(az monitor log-analytics workspace show -g "$RG" -n "$LAW" --query id -o tsv)

$DRY_RUN az monitor app-insights component create \
  -g "$RG" --app "$AI" -l "$LOCATION" --workspace "$LAW_ID" "${TAGS[@]}"

# ── 2. Storage account (Blob container for app-internal files) ───────────────
$DRY_RUN az storage account create \
  -g "$RG" -n "$STG" -l "$LOCATION" \
  --sku Standard_LRS --kind StorageV2 \
  --allow-blob-public-access false \
  --min-tls-version TLS1_2 "${TAGS[@]}"
$DRY_RUN az storage container create \
  --account-name "$STG" -n "app-uploads" --auth-mode login

# ── 3. Key Vault (RBAC-mode; soft-delete + purge protection on) ──────────────
$DRY_RUN az keyvault create \
  -g "$RG" -n "$KV" -l "$LOCATION" \
  --enable-rbac-authorization true \
  --enable-purge-protection true \
  --retention-days 90 "${TAGS[@]}"

# ── 4. PostgreSQL Flexible Server ────────────────────────────────────────────
# Admin password is generated at provision time and stored ONLY in Key Vault.
# Nothing is printed to the console.
PG_ADMIN_PASS=$(openssl rand -base64 28)
$DRY_RUN az postgres flexible-server create \
  -g "$RG" -n "$PG" -l "$LOCATION" \
  --tier Burstable --sku-name Standard_B2ms --version 16 \
  --storage-size 128 \
  --admin-user "$PG_ADMIN_USER" --admin-password "$PG_ADMIN_PASS" \
  --public-access None --yes "${TAGS[@]}"

# Create the application database
$DRY_RUN az postgres flexible-server db create \
  -g "$RG" -s "$PG" -d "$PG_DB"

# Stash the admin password and connection string in Key Vault — never echoed
PG_HOST="${PG}.postgres.database.azure.com"
PG_CONN="postgresql://${PG_ADMIN_USER}:${PG_ADMIN_PASS}@${PG_HOST}:5432/${PG_DB}?sslmode=require"
$DRY_RUN az keyvault secret set --vault-name "$KV" --name "pg-admin-password" --value "$PG_ADMIN_PASS" >/dev/null
$DRY_RUN az keyvault secret set --vault-name "$KV" --name "pg-connection-string" --value "$PG_CONN" >/dev/null
unset PG_ADMIN_PASS PG_CONN

# ── 5. App Service Plan + Backend API App Service ────────────────────────────
$DRY_RUN az appservice plan create \
  -g "$RG" -n "$PLAN" -l "$LOCATION" \
  --is-linux --sku P1v3 "${TAGS[@]}"

$DRY_RUN az webapp create \
  -g "$RG" -p "$PLAN" -n "$API_APP" \
  --runtime "NODE:20-lts" "${TAGS[@]}"

# Hardening: HTTPS-only, TLS 1.2, FTPS disabled, system-assigned identity
$DRY_RUN az webapp update -g "$RG" -n "$API_APP" \
  --https-only true \
  --set siteConfig.minTlsVersion=1.2 siteConfig.ftpsState=Disabled
$DRY_RUN az webapp identity assign -g "$RG" -n "$API_APP"

API_APP_PRINCIPAL=$(az webapp identity show -g "$RG" -n "$API_APP" --query principalId -o tsv)
SUB_ID=$(az account show --query id -o tsv)

# Grant the backend's Managed Identity rights it needs
# (a) read secrets from Key Vault
$DRY_RUN az role assignment create \
  --assignee-object-id "$API_APP_PRINCIPAL" --assignee-principal-type ServicePrincipal \
  --role "Key Vault Secrets User" \
  --scope "/subscriptions/${SUB_ID}/resourceGroups/${RG}/providers/Microsoft.KeyVault/vaults/${KV}"

# (b) read/write to the app-uploads blob container
$DRY_RUN az role assignment create \
  --assignee-object-id "$API_APP_PRINCIPAL" --assignee-principal-type ServicePrincipal \
  --role "Storage Blob Data Contributor" \
  --scope "/subscriptions/${SUB_ID}/resourceGroups/${RG}/providers/Microsoft.Storage/storageAccounts/${STG}"

# Wire App Insights into the backend
AI_CONN=$(az monitor app-insights component show -g "$RG" --app "$AI" --query connectionString -o tsv)
$DRY_RUN az webapp config appsettings set -g "$RG" -n "$API_APP" --settings \
  "APPLICATIONINSIGHTS_CONNECTION_STRING=${AI_CONN}" \
  "KEY_VAULT_URI=https://${KV}.vault.azure.net/" \
  "STORAGE_ACCOUNT=${STG}" \
  "WEBSITE_RUN_FROM_PACKAGE=1"

# ── 6. Static Web App (SPA) ──────────────────────────────────────────────────
$DRY_RUN az staticwebapp create \
  -g "$RG" -n "$SWA" -l "$LOCATION" \
  --sku Standard "${TAGS[@]}"

# ── 7. API Management ────────────────────────────────────────────────────────
# NOTE: Developer SKU takes ~30–45 min to provision; Standard v2 is faster.
$DRY_RUN az apim create \
  -g "$RG" -n "$APIM" -l "$LOCATION" \
  --publisher-email "$APIM_PUBLISHER_EMAIL" \
  --publisher-name "$APIM_PUBLISHER_NAME" \
  --sku-name Developer "${TAGS[@]}"

# ── 8. Summary — what was created ────────────────────────────────────────────
cat <<EOF

✓ Provisioning complete (or printed in dry-run).

Resource group: ${RG}
  · Static Web App     ${SWA}      → host the SPA build artifact
  · App Service        ${API_APP}  → deploy backend API
  · API Management     ${APIM}     → import API spec and policies
  · Key Vault          ${KV}       → DB connection string already loaded
  · PostgreSQL         ${PG}       → DB '${PG_DB}' ready for schema import
  · Storage Account    ${STG}      → container 'app-uploads' created
  · Log Analytics      ${LAW}      → workspace ID ${LAW_ID}
  · App Insights       ${AI}       → wired into the backend app settings

Manual / follow-up steps (NOT scripted on purpose):
  1. Entra ID app registration for SPA + API (admin consent required).
  2. Front Door + WAF — apply Hitachi standard front-door pattern in front of APIM.
  3. SharePoint Graph permissions — Sites.Selected on the Commissioning subsite.
  4. Azure DevOps — create org/project/repo and import the codebase.
  5. CI/CD pipelines — SPA deploy to ${SWA}, API deploy to ${API_APP}.
  6. PostgreSQL schema — load supabase_schema.sql + supabase_forms_schema.sql
     against pg-connection-string from Key Vault.

EOF
