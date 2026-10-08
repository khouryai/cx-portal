#!/usr/bin/env bash
# Point the PostgREST container app at the database, and tell it who signs tokens.
#
#   Email + password (the standard sign-in card, like Supabase):
#     PGRST_PW='<authenticator password>' bash azure/configure-postgrest.sh --local
#
#   Microsoft Entra (redirect to Microsoft):
#     PGRST_PW='<authenticator password>' bash azure/configure-postgrest.sh --entra
#
# PostgREST accepts ONE JWT secret, so this is genuinely either/or: whichever
# issuer you configure here is the only one whose tokens the database will
# accept. Switching is re-running this script and redeploying the front end with
# a matching IDENTITY — nothing in the schema or the 349 RLS policies changes.
#
# Run it from Cloud Shell, AFTER giving the authenticator role a password
# inside the database container:
#     psql -U cxadmin -d postgres -c "alter role authenticator with login password '<pw>';"
#
# Everything except that password is discovered from Azure, so this keeps
# working after a rebuild.
set -uo pipefail

RG="${RG:-rg-cxportal-dev}"
TENANT="${TENANT:-e62c5154-d15d-4c22-a489-aa656aff64a4}"
APPID="${APPID:-a1301867-e12c-43c7-85e2-80cc5bd9d325}"
PGRST_PW="${PGRST_PW:?set PGRST_PW to the password you gave the authenticator role}"

MODE="${1:-${MODE:-local}}"
case "$MODE" in
  --local|local)  MODE=local ;;
  --entra|entra)  MODE=entra ;;
  *) echo "usage: $0 [--local|--entra]"; exit 1 ;;
esac

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

say "1/5  finding the database and the API"
# TCP ingress is addressed by APP NAME and exposed port from inside the
# environment — NOT by the .internal.<domain> FQDN. That FQDN belongs to HTTP
# ingress: it resolves (to the environment's envoy endpoint) and then times out,
# because nothing there serves 5432. The symptom is PGRST002 "could not query
# the database for the schema cache" with "Operation timed out" in the logs,
# which reads like a firewall or a wrong password and is neither.
PGAPP="ca-postgres-dev"
az containerapp show -g "$RG" -n "$PGAPP" --query name -o tsv >/dev/null 2>&1 \
  || { echo "could not find $PGAPP"; exit 1; }
PGHOST="$PGAPP"
echo "  database: $PGHOST:5432 (app name — TCP ingress is not addressed by FQDN)"

say "2/5  the signing secret"
if [ "$MODE" = "local" ]; then
  # The database mints its own tokens (supabase/sql/azure_local_auth.sql), signed
  # with a shared secret that BOTH sides must hold. They are set from one value
  # here so they cannot drift; if they ever do, every correct password is
  # rejected with JWSError and it looks like the password is wrong.
  # azure/setup-local-auth.sh generated this and put the SAME value into the
  # database. Reading it back is the whole point: a secret typed twice is a
  # secret that eventually differs, and when it does, every correct password is
  # rejected with a message indistinguishable from a wrong one.
  SECRET_FILE="azure/.local-auth-secret"
  if [ -n "${JWT_SECRET:-}" ]; then
    echo "  using the JWT_SECRET from your environment"
  elif [ -f "$SECRET_FILE" ]; then
    JWT_SECRET="$(cat "$SECRET_FILE")"
    echo "  using the secret from $SECRET_FILE"
  else
    cat <<NOTE

  No secret found at $SECRET_FILE.

  The database has to be holding the same value before PostgREST can accept a
  single token, so generating one here would guarantee a mismatch. Run this
  first — it creates the secret, loads the SQL and sets your first password:

      bash azure/setup-local-auth.sh

NOTE
    exit 1
  fi
  JWT_AUD="${JWT_AUD:-cx-portal}"
  echo "  mode: LOCAL PASSWORDS — the database issues the tokens"
  echo "  audience: $JWT_AUD"
else
  # PostgREST cannot fetch Microsoft's signing keys from a URL, and Microsoft
  # rotates them every few weeks. So PostgREST reads them from the database
  # (PGRST_DB_PRE_CONFIG) and the 'jwks-refresh' sidecar keeps them current —
  # supabase/sql/azure_pgrst_jwks.sql must already be applied (RUNBOOK step 3).
  echo "  mode: MICROSOFT ENTRA — Microsoft issues the tokens"
  echo "  keys: read from the database, kept current by the jwks-refresh sidecar"

  # THE AUDIENCE DEPENDS ON THE TOKEN VERSION, and getting it wrong gives
  # PGRST301 JWTNotInAudience — which looks like a broken token and is not: the
  # signature has already validated by that point.
  #   v1 access tokens: aud = the App ID URI,  api://<client-id>
  #   v2 access tokens: aud = the bare client-id GUID
  # The app registration sets requestedAccessTokenVersion: 2, so it is the GUID.
  JWT_AUD="${JWT_AUD:-$APPID}"
  echo "  jwt audience: $JWT_AUD  (v2 token = bare client id, not api://...)"
fi

say "3/5  configuring PostgREST"
DB_URI="postgres://authenticator:${PGRST_PW}@${PGHOST}:5432/postgres"
# Exactly one source of keys per mode. Under Entra a leftover PGRST_JWT_SECRET
# would be stale within weeks; under local passwords a key set left in the
# database would override the shared secret and reject every password.
if [ "$MODE" = "local" ]; then
  KEYS_VAR="PGRST_JWT_SECRET=${JWT_SECRET}"; DROP_VAR="PGRST_DB_PRE_CONFIG"
else
  KEYS_VAR="PGRST_DB_PRE_CONFIG=private.pgrst_pre_config"; DROP_VAR="PGRST_JWT_SECRET"
fi
# The connection string carries the password: store it as a Container Apps
# secret (not readable with Reader access) and point both containers at it.
az containerapp secret set -g "$RG" -n ca-postgrest-dev \
  --secrets "pgrst-db-uri=${DB_URI}" -o none || exit 1
az containerapp update -g "$RG" -n ca-postgrest-dev --container-name postgrest \
  --min-replicas 1 \
  --set-env-vars \
    "PGRST_DB_URI=secretref:pgrst-db-uri" \
    "PGRST_DB_SCHEMAS=public" \
    "PGRST_DB_ANON_ROLE=anon" \
    "PGRST_JWT_AUD=${JWT_AUD}" \
    "PGRST_JWT_ROLE_CLAIM_KEY=.roles[0]" \
    "$KEYS_VAR" \
    "PGRST_LOG_LEVEL=info" \
    "PGRST_OPENAPI_MODE=ignore-privileges" \
  --remove-env-vars "$DROP_VAR" \
  --query "properties.provisioningState" -o tsv || exit 1

# The key refresher connects with the same login. It exists only on an app
# deployed from the current infra/main.bicep.
if [ "$MODE" = "entra" ]; then
  if az containerapp show -g "$RG" -n ca-postgrest-dev \
       --query "properties.template.containers[?name=='jwks-refresh'].name" -o tsv | grep -q jwks-refresh; then
    az containerapp update -g "$RG" -n ca-postgrest-dev --container-name jwks-refresh \
      --set-env-vars "PGRST_DB_URI=secretref:pgrst-db-uri" \
      --query "properties.provisioningState" -o tsv || exit 1
  else
    echo "  NOTE: no jwks-refresh container on this app. Redeploy infra/main.bicep to add it;"
    echo "        until then no keys are loaded and Entra sign-in is refused."
  fi
fi

say "4/5  waiting for the new revision"
sleep 45
API="$(az containerapp show -g "$RG" -n ca-postgrest-dev \
  --query properties.configuration.ingress.fqdn -o tsv)"
echo "  API: https://$API"

say "5/5  does it answer?"
# Anonymous: PostgREST switches to the anon role, RLS denies everything, and an
# empty array comes back. That is SUCCESS — it means the API reached the
# database and the policies are doing their job. A 5xx means it could not
# connect; a connection error means the revision never started.
code=$(curl -s -o /tmp/pgrst-body.txt -w '%{http_code}' "https://$API/profiles")
echo "  GET /profiles (no token) -> HTTP $code"
echo "  body: $(head -c 200 /tmp/pgrst-body.txt)"
echo
code=$(curl -s -o /tmp/pgrst-root.txt -w '%{http_code}' "https://$API/")
echo "  GET / -> HTTP $code"
echo "  body: $(head -c 200 /tmp/pgrst-root.txt)"

if [ "$code" != "200" ]; then
  say "it did not come up — last 40 log lines"
  az containerapp logs show -g "$RG" -n ca-postgrest-dev --tail 40 --type console 2>/dev/null \
    || echo "  (could not read logs)"
fi

say "deploy the front end to match"
if [ "$MODE" = "local" ]; then
cat <<VALS
  The sign-in screen must agree with the issuer configured above:

      IDENTITY=postgrest bash azure/deploy-frontend.sh

  That gives the normal email + password card — no redirect anywhere.
VALS
else
cat <<VALS
      IDENTITY=entra bash azure/deploy-frontend.sh

  IDENTITY:         'entra'
  ENTRA_TENANT_ID:  '$TENANT'
  ENTRA_CLIENT_ID:  '$APPID'
  ENTRA_API_SCOPE:  'api://$APPID/access_as_user'
VALS
fi
