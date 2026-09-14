#!/usr/bin/env bash
# Turn on email + password sign-in. Run from the repo root in Cloud Shell:
#
#     cd ~/cx-portal && bash azure/setup-local-auth.sh
#
# THE PROBLEM THIS SOLVES. The database is a container with INTERNAL INGRESS
# ONLY — Azure refuses external TCP ingress without a custom VNet — so Cloud
# Shell cannot reach it with psql, and there is no `docker cp` to hand it a
# file. The runbook's other steps sidestep that by piping from inside the
# container, but azure_local_auth.sql is 20 KB of SQL that lives HERE.
#
# So it is compressed and base64-encoded into a single line you paste into the
# container's own shell. One paste, no heredoc, no quoting to get wrong.
#
# It also pins down the failure that is hardest to diagnose: the signing secret
# has to be IDENTICAL in the database and in PostgREST. If the two drift, every
# correct password is rejected with a message indistinguishable from a wrong
# one. The secret is generated ONCE here and written to azure/.local-auth-secret
# (gitignored), which azure/configure-postgrest.sh --local then reads, so you
# never type it twice and the two halves cannot disagree.
set -uo pipefail

SQL_FILE="supabase/sql/azure_local_auth.sql"
SECRET_FILE="azure/.local-auth-secret"
OUT="${OUT:-$HOME/cx-local-auth-paste.txt}"

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mSTOPPED: %s\033[0m\n' "$*" >&2; exit 1; }

[ -f "$SQL_FILE" ] || die "Run this from the repo root — $SQL_FILE not found.
  cd ~/cx-portal && git pull && bash azure/setup-local-auth.sh"

say "1/4  the signing secret"
if [ -f "$SECRET_FILE" ]; then
  JWT_SECRET="$(cat "$SECRET_FILE")"
  echo "  reusing the secret already in $SECRET_FILE"
  echo "  (delete that file if you want to rotate it — you must then re-run"
  echo "   BOTH this script and azure/configure-postgrest.sh --local)"
else
  JWT_SECRET="$(openssl rand -base64 48 | tr -d '\n')"
  mkdir -p azure
  printf '%s' "$JWT_SECRET" > "$SECRET_FILE"
  chmod 600 "$SECRET_FILE"
  echo "  generated and saved to $SECRET_FILE (gitignored)"
fi

say "2/4  the first account"
# The profile row must already exist: auth.set_password() takes the account id
# FROM it, which is what keeps auth.uid() resolving to the uuid every one of the
# 349 RLS policies already compares against. No re-keying, no policy edits.
read -r -p "  Email of an EXISTING profile row: " EMAIL
[ -n "$EMAIL" ] || die "An email is required."

# Checked here as well as in the database, so a rejected password is a message
# now rather than a confusing error after a 9 KB paste.
while :; do
  read -r -s -p "  Password (min 12 chars, 3 of: lower/upper/digit/symbol): " PW1; echo
  read -r -s -p "  Again: " PW2; echo
  [ "$PW1" = "$PW2" ] || { echo "  they do not match — try again"; continue; }
  [ ${#PW1} -ge 12 ]  || { echo "  too short (${#PW1} characters)"; continue; }
  classes=0
  case "$PW1" in *[a-z]*) classes=$((classes+1));; esac
  case "$PW1" in *[A-Z]*) classes=$((classes+1));; esac
  case "$PW1" in *[0-9]*) classes=$((classes+1));; esac
  case "$PW1" in *[!a-zA-Z0-9]*) classes=$((classes+1));; esac
  [ "$classes" -ge 3 ] || { echo "  needs 3 character classes, has $classes"; continue; }
  break
done

say "3/4  building the bundle"
# Single-quoted SQL literals: double any embedded quote. A password containing
# an apostrophe would otherwise end the literal and produce a syntax error that
# looks nothing like its cause.
esc() { printf '%s' "$1" | sed "s/'/''/g"; }
TMP="$(mktemp)"
{
  cat "$SQL_FILE"
  printf '\n\n-- appended by azure/setup-local-auth.sh --\n'
  printf "select auth.set_jwt_secret('%s');\n" "$(esc "$JWT_SECRET")"
  # Show whether the profile row exists BEFORE trying to use it. set_password()
  # raises a clear error when it does not, but ON_ERROR_STOP means that error is
  # the last thing printed — and "which addresses DO exist?" is then the next
  # question, answerable only from inside the container. Answer it up front.
  # printf '%s' and not a format string: printf reads \e as the ESC character,
  # so a psql backslash command written as a format turns into escape-cho.
  printf '%s\n' "\\echo '--- profiles matching that address ---'"
  printf "select id, email, is_active from public.profiles where lower(email) = lower('%s');\n" "$(esc "$EMAIL")"
  printf '%s\n' "\\echo '--- if that was empty, these are the first 20 that do exist ---'"
  printf "select email, is_active from public.profiles order by email limit 20;\n"
  printf "select auth.set_password('%s', '%s');\n" "$(esc "$EMAIL")" "$(esc "$PW1")"
  printf "select 'credential set for ' || email from auth.users;\n"
} > "$TMP"
echo "  $(wc -c < "$TMP") bytes of SQL"

B64="$(gzip -9 -c "$TMP" | base64 -w0)"
rm -f "$TMP"
printf 'echo %s | base64 -d | gunzip | psql -U cxadmin -d postgres -v ON_ERROR_STOP=1\n' "$B64" > "$OUT"
echo "  $(wc -c < "$OUT") bytes to paste, written to $OUT"

say "4/4  what to do now"
cat <<NOTE
The bundle carries the password you just typed, so treat $OUT
as a secret and delete it when you are done.

  1. Open a shell INSIDE the database container:

       az containerapp exec -g rg-cxportal-dev -n ca-postgres-dev --command /bin/bash

  2. Paste the ONE LINE in $OUT at its prompt.
     Print it with:   cat $OUT
     Expect it to end with: credential set for $EMAIL

  3. Back in Cloud Shell (type 'exit' first), point PostgREST at the same
     secret — the script reads $SECRET_FILE, so there is nothing to copy:

       PGRST_PW='<authenticator password>' bash azure/configure-postgrest.sh --local

  4. Deploy the front end with the matching sign-in screen:

       IDENTITY=postgrest bash azure/deploy-frontend.sh

  5. Then:  rm $OUT
NOTE
