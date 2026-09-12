#!/usr/bin/env bash
# Stand up the dev/learning environment in one command.
#
# Run it from Azure Cloud Shell (Bash), from the root of this repo:
#     bash azure/deploy-dev.sh
#
# It is deliberately chatty and it STOPS before doing anything billable, so you
# can read the preview and decide. Nothing is created until you type "yes".
#
# Everything it learns is written to azure/.deploy-output.txt, which is
# gitignored. Paste that file back into the conversation when it finishes.
set -euo pipefail

RG="${RG:-rg-cxportal-dev}"
LOCATION="${LOCATION:-westus2}"
SUB="b186eaed-6584-4822-9221-769c74072d8f"
OUT="azure/.deploy-output.txt"

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mSTOPPED: %s\033[0m\n' "$*" >&2; exit 1; }

[ -f infra/main.bicep ] || die "Run this from the repo root (infra/main.bicep not found)."

mkdir -p azure
# APPEND, never truncate. A previous run's transcript may hold the only copy of
# a password you have not stored yet — losing a Cloud Shell is exactly when you
# would re-run this, and exactly when you cannot afford to wipe that.
printf '\n\n========== run at %s ==========\n' "$(date -u '+%Y-%m-%d %H:%M:%SZ')" >> "$OUT"
exec > >(tee -a "$OUT") 2>&1

say "0/6  What already exists (a restart or a re-run is fine — this is idempotent)"
EXISTING="$(az resource list -g "$RG" --query "length(@)" -o tsv 2>/dev/null || echo 0)"
echo "  $EXISTING resource(s) already in $RG"
PG_EXISTING="$(az postgres flexible-server list -g "$RG" --query "[0].name" -o tsv 2>/dev/null || true)"
if [ -n "$PG_EXISTING" ]; then
  cat <<NOTE

  The database server '$PG_EXISTING' ALREADY EXISTS.

  Re-running this script generates a new password and will RESET the admin
  password to it. That is harmless, but any password you saved earlier stops
  working. To keep the existing one, stop now and re-run as:

      DBPW='<the password you saved>' bash azure/deploy-dev.sh

NOTE
  read -r -p "  Continue and reset the password? Type 'yes', or anything else to stop: " C
  [ "$C" = "yes" ] || { say "Stopped. Nothing changed."; exit 0; }
fi

say "1/6  Checking which subscription you are pointed at"
az account set --subscription "$SUB"
az account show --query "{name:name, id:id, state:state}" -o table

say "2/6  Confirming the spending limit"
# This is the safety net that stops Azure charging your card when the trial
# credit runs out. It is read-only; it only reports.
az consumption budget list -o table 2>/dev/null || echo "(no budgets set — see step 6)"

say "3/6  Database password"
if [ -z "${DBPW:-}" ]; then
  DBPW="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-20)Aa1!"
  echo "Generated a new password."
else
  echo "Using the DBPW already set in your shell."
fi
# Printed once, on purpose: you need it for pg_restore later and there is no
# way to read it back out of Azure afterwards.
printf '\n  >>> SAVE THIS IN YOUR PASSWORD MANAGER NOW <<<\n  %s\n\n' "$DBPW"
echo "  (it is in $OUT too — delete that file once you have stored it)"

say "4/6  Creating the resource group (free — a resource group costs nothing)"
az group create -n "$RG" -l "$LOCATION" -o table

say "5/6  PREVIEW — what would be created. Nothing is billable yet."
az deployment group what-if \
  -g "$RG" \
  -f infra/main.bicep \
  -p infra/main.parameters.personal.json \
  -p administratorLoginPassword="$DBPW" \
  || die "The preview failed. Paste everything above into the conversation — that output is the useful part."

say "6/6  Ready to deploy"
cat <<'NOTE'
Read the preview above. Lines marked + are resources that will be created.

This is the point where billing starts. With the personal parameters file the
expected cost is roughly USD 30-60/month, charged against your trial credit,
and the database is the only part that costs money while idle — stop it with:

    az postgres flexible-server stop -g rg-cxportal-dev -n psql-cxportal-dev

To remove absolutely everything later:

    az group delete --name rg-cxportal-dev

NOTE

read -r -p "Type 'yes' to deploy, anything else to stop: " CONFIRM
if [ "$CONFIRM" != "yes" ]; then
  say "Stopped. Nothing was created beyond the (free) resource group."
  echo "Paste $OUT into the conversation and we'll look at the preview together."
  exit 0
fi

say "Deploying — this takes 10-15 minutes, mostly the database"
echo "If Cloud Shell disconnects, THE DEPLOYMENT KEEPS RUNNING in Azure."
echo "Reconnect and run: bash azure/status.sh"

# NOWAIT=1 hands the deployment to Azure and returns immediately, so a Cloud
# Shell that naps mid-deploy cannot cost you anything. You lose live error
# reporting; run `bash azure/status.sh` to follow it and to read the outputs.
if [ "${NOWAIT:-0}" = "1" ]; then
  az deployment group create \
    -g "$RG" -n main \
    -f infra/main.bicep \
    -p infra/main.parameters.personal.json \
    -p administratorLoginPassword="$DBPW" \
    --no-wait
  say "Handed off to Azure. It is running now, with or without this shell."
  echo "Follow it with:  bash azure/status.sh"
  exit 0
fi

az deployment group create \
  -g "$RG" -n main \
  -f infra/main.bicep \
  -p infra/main.parameters.personal.json \
  -p administratorLoginPassword="$DBPW" \
  --query properties.outputs -o json

say "Done"
cat <<NOTE
Everything above is saved in $OUT.

NEXT: paste that file into the conversation. It carries the database hostname,
storage account name, API hostname and SAS endpoint — all of which go into
config.local.js.

Then, when you stop working for the day:
    az postgres flexible-server stop -g $RG -n psql-cxportal-dev
NOTE
