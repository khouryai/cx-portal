#!/usr/bin/env bash
# Read-only: what exists in the dev environment right now?
#
#     bash azure/status.sh
#
# Creates nothing, changes nothing, costs nothing. Safe to run any time —
# after a Cloud Shell restart, mid-deployment, or just to check the bill.
set -uo pipefail

RG="${RG:-rg-cxportal-dev}"
SUB="b186eaed-6584-4822-9221-769c74072d8f"

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

az account set --subscription "$SUB" 2>/dev/null

say "Resource group"
if ! az group show -n "$RG" -o table 2>/dev/null; then
  echo "  '$RG' does not exist. Nothing has been created yet."
  echo "  Start with: bash azure/deploy-dev.sh"
  exit 0
fi

say "Deployments (did anything run, and did it finish?)"
# A deployment started before a Cloud Shell restart KEEPS RUNNING server-side.
# 'Running' here means Azure is still working; it is not waiting on your shell.
az deployment group list -g "$RG" \
  --query "[].{name:name, state:properties.provisioningState, timestamp:properties.timestamp}" \
  -o table 2>/dev/null || echo "  none"

# A deployment that says only "Failed" is useless — the reason lives in the
# per-operation log, which nobody remembers the command for. Print it here.
if az deployment group list -g "$RG" --query "[?properties.provisioningState=='Failed'] | length(@)" -o tsv 2>/dev/null | grep -qv '^0$'; then
  say "WHY THE LAST DEPLOYMENT FAILED"
  az deployment operation group list -g "$RG" -n main \
    --query "[?properties.provisioningState=='Failed'].{resource:properties.targetResource.resourceName, type:properties.targetResource.resourceType, error:properties.statusMessage}" \
    -o json 2>/dev/null || echo "  (could not read operation log)"
fi

say "Resources that exist"
az resource list -g "$RG" --query "[].{name:name, type:type}" -o table 2>/dev/null || echo "  none"

say "Database"
PG="$(az postgres flexible-server list -g "$RG" --query "[0].name" -o tsv 2>/dev/null)"
if [ -n "$PG" ]; then
  az postgres flexible-server show -g "$RG" -n "$PG" \
    --query "{name:name, state:state, host:fullyQualifiedDomainName, sku:sku.name}" -o table
  echo
  echo "  Stop it when you are not using it (this is the only thing billing while idle):"
  echo "    az postgres flexible-server stop -g $RG -n $PG"
  echo
  echo "  Lost the admin password? It cannot be read back, but it CAN be reset:"
  echo "    az postgres flexible-server update -g $RG -n $PG --admin-password '<new one>'"
else
  echo "  no MANAGED database (expected on a free trial — the offer is restricted)"
fi

PGC="$(az containerapp list -g "$RG" --query "[?starts_with(name,'ca-postgres')].name" -o tsv 2>/dev/null)"
if [ -n "$PGC" ]; then
  say "Database (container)"
  az containerapp show -g "$RG" -n "$PGC" \
    --query "{name:name, fqdn:properties.configuration.ingress.fqdn, state:properties.provisioningState, replicas:properties.template.scale.minReplicas}" -o table
  FQDN="$(az containerapp show -g "$RG" -n "$PGC" --query "properties.configuration.ingress.fqdn" -o tsv 2>/dev/null)"
  if [ -n "$FQDN" ]; then
    echo
    echo "  Connect with:"
    echo "    psql \"host=$FQDN port=5432 user=cxadmin dbname=postgres sslmode=disable\""
    echo
    echo "  NOTE: this database is EPHEMERAL. A restart loses everything in it."
  fi
fi

say "If the last deployment succeeded, these are the values the app needs"
az deployment group show -g "$RG" -n main \
  --query properties.outputs -o json 2>/dev/null \
  || echo "  no completed deployment named 'main' yet"
