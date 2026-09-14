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
  JWT_SECRET="${JWT_SECRET:-$(openssl rand -base64 48 | tr -d '\n')}"
  JWT_AUD="${JWT_AUD:-cx-portal}"
  echo "  mode: LOCAL PASSWORDS — the database issues the tokens"
  echo "  audience: $JWT_AUD"
  cat <<NOTE

  RUN THIS INSIDE THE DATABASE CONTAINER BEFORE ANYONE SIGNS IN, or the two
  halves of the secret will not match:

      az containerapp exec -g $RG -n ca-postgres-dev --command /bin/bash
      psql -U cxadmin -d postgres -c "select auth.set_jwt_secret('$JWT_SECRET');"

  Then give someone a password (the profile row must already exist):

      psql -U cxadmin -d postgres -c "select auth.set_password('you@hitachirail.com','a real passphrase');"

NOTE
else
  # PostgREST wants JWK/JWKS *material*, not a URI to fetch it from — it has no
  # remote-JWKS support. So the key set is pinned here as a literal value.
  #
  # CONSEQUENCE WORTH KNOWING: Entra rotates these keys roughly every six weeks.
  # When it does, this copy goes stale and every sign-in fails with an invalid
  # signature. Fine for a rebuildable dev environment; in production this is the
  # argument for a gateway that validates tokens, or a sidecar that refreshes the
  # key set on a schedule. Re-run this script to refresh it by hand.
  JWT_SECRET="$(curl -fsS "https://login.microsoftonline.com/$TENANT/discovery/v2.0/keys")"
  [ -n "$JWT_SECRET" ] || { echo "could not fetch JWKS"; exit 1; }
  echo "  mode: MICROSOFT ENTRA — Microsoft issues the tokens"
  echo "  got $(printf '%s' "$JWT_SECRET" | wc -c) bytes, $(printf '%s' "$JWT_SECRET" | grep -o '"kid"' | wc -l) keys"

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
az containerapp update -g "$RG" -n ca-postgrest-dev \
  --min-replicas 1 \
  --set-env-vars \
    "PGRST_DB_URI=postgres://authenticator:${PGRST_PW}@${PGHOST}:5432/postgres" \
    "PGRST_DB_SCHEMAS=public" \
    "PGRST_DB_ANON_ROLE=anon" \
    "PGRST_JWT_AUD=${JWT_AUD}" \
    "PGRST_JWT_ROLE_CLAIM_KEY=.roles[0]" \
    "PGRST_JWT_SECRET=${JWT_SECRET}" \
    "PGRST_LOG_LEVEL=info" \
    "PGRST_OPENAPI_MODE=ignore-privileges" \
  --query "properties.provisioningState" -o tsv || exit 1

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
