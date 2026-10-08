// ============================================================
// main.bicep — Hitachi Rail T&C Portal on Azure
//
// A REVIEWABLE PROPOSAL, NOT A DEPLOYED ENVIRONMENT. It is written to be read
// by the IT team that owns the subscription: every resource says what security
// property it exists to provide, so the security review and the infrastructure
// review are the same conversation.
//
// EXPECT TO CHANGE: naming, tags, region, SKUs and the networking model are
// landing-zone decisions that belong to IT, not to this file. What is NOT
// negotiable from the application's side is called out in comments.
//
// Deploy (once IT has a resource group and has agreed the parameters):
//   az deployment group create -g <rg> -f infra/main.bicep -p @infra/main.parameters.json
// ============================================================

@description('Type of the Postgres admin principal. \'Group\' for a corporate deployment with a real admin group (IT\'s norm); \'User\' for a personal subscription where dbAdminGroupObjectId is just your own account.')
@allowed(['Group', 'User'])
param dbAdminPrincipalType string = 'Group'

@description('Environment discriminator. Keep dev separate from prod: the app is currently developed against production, which this is intended to fix.')
@allowed(['dev', 'test', 'prod'])
param environment string = 'dev'

@description('Azure region. The data is US-jurisdiction and must stay in a US region.')
param location string = 'westus2'

@description('Short name used to build resource names.')
param appName string = 'cxportal'

@description('Entra ID tenant that issues tokens for the app.')
param tenantId string = subscription().tenantId

@description('Object ID of the Entra group whose members administer the database.')
param dbAdminGroupObjectId string

@description('Entra group display name matching dbAdminGroupObjectId.')
param dbAdminGroupName string

@description('PostgreSQL version. 17 matches what the app runs on today.')
param postgresVersion string = '17'

@description('Set false only for a documented exception: the database must not be reachable from the public internet.')
param databasePublicAccess bool = false

@description('Postgres admin username for password authentication. Needed during migration, because pg_restore authenticates with a password.')
param administratorLogin string = 'cxadmin'

@secure()
@description('Password for administratorLogin. NEVER put this in a parameters file — pass it on the command line. Leave it EMPTY to deploy with Microsoft Entra authentication only, which is the target state once the migration is finished.')
param administratorLoginPassword string = ''

@description('Create the Microsoft Entra administrator on the database. Set FALSE when the admin principal is a guest (#EXT#) account — as it is on a personal subscription created with a Gmail/outlook address — because guest principals are not reliable as a Postgres Entra admin. A password admin is used instead. NOTE: do not set this false AND leave administratorLoginPassword empty, or the server has no administrator at all.')
param deployDbEntraAdmin bool = true

@description('Deploy Azure Database for PostgreSQL. Set FALSE on a free-trial subscription: the managed offer is blocked outright there (OfferRestricted), in every region. Pair with deployContainerPostgres.')
param deployManagedPostgres bool = true

@description('Run PostgreSQL as a container in the Container Apps environment instead of the managed service. A DEVELOPMENT ESCAPE HATCH, not an architecture: same engine, so RLS, the auth.uid() shim and PostgREST behave identically, but there are no managed backups, no HA, no Entra-auth-to-database, and DATA DOES NOT SURVIVE A RESTART (see the note on the resource). Never set this true for anything holding real data.')
param deployContainerPostgres bool = false

@description('Grant dbAdminGroupObjectId the Storage Blob Data Contributor role. Needed on a dev subscription because allowSharedKeyAccess is false, so a human cannot touch blobs without an RBAC assignment — owning the subscription is not data-plane access. Leave FALSE for anything else: production blob access belongs to the application identity, not a person.')
param grantDeveloperBlobAccess bool = false

@secure()
@description('PostgREST connection string, as the `authenticator` role. Empty until the database is restored — the API container is deployed unconfigured and set later (azure/RUNBOOK.md step 4), because this value cannot exist before the server does.')
param postgrestDbUri string = ''

@description('Deploy the Front Door WAF. Leave true for anything internet-facing. Set FALSE only for a throwaway personal/learning subscription: Premium_AzureFrontDoor costs roughly USD 330/month and teaches you nothing the rest of the stack does not. Forced true when environment == prod.')
param deployWaf bool = true

@description('Use the cheapest viable SKUs. Personal-subscription escape hatch ONLY: Static Web Apps drops to Free (no private endpoints, no custom auth) and log retention drops to 30 days. Ignored when environment == prod.')
param cheapMode bool = false

@description('Audience PostgREST requires in caller tokens — the API app registration\'s application id (v2 tokens) or app id URI. Empty until the Entra app registration exists.')
param entraApiAudience string = ''

@description('Let browsers reach file storage over the internet. Leave TRUE unless every user (field tablets and BART guests included) reaches Azure over a private network: the browser downloads and uploads files directly, and access is still gated by Entra sign-in, group membership and short-lived signed links.')
param storagePublicAccess bool = true

@description('The portal\'s web address, e.g. https://<name>.azurestaticapps.net. Storage CORS allows exactly this origin; empty means the browser cannot reach files yet.')
param allowedOrigin string = ''

@description('Object id of the Entra security group of portal users (Hitachi staff and BART guests). It is granted Storage Blob Data Contributor on the file storage account: the browser signs short-lived file links with each user\'s own delegation key, so this grant IS the file access rule. Empty until the group exists.')
param portalUsersGroupObjectId string = ''

var isProd = environment == 'prod'
var usePasswordAuth = !empty(administratorLoginPassword)
// Guard rails: prod never gets the cheap path, whatever the parameter file says.
var thrifty = cheapMode && !isProd
var wantWaf = deployWaf || isProd
var suffix = '${appName}-${environment}'

// The 'jwks-refresh' sidecar beside PostgREST (see the API section). Keeps
// PostgREST's copy of Microsoft's sign-in keys current: every REFRESH_SECONDS
// it downloads them and hands them to private.set_pgrst_jwks(), which stores
// them only if they changed and tells PostgREST to reload — no restart. A
// failed download or a malformed key set changes nothing and retries in five
// minutes. Database side: supabase/sql/azure_pgrst_jwks.sql. Tested end to end
// against a real PostgREST by tools/test_jwks_refresh.js, which runs THIS text.
var jwksRefreshScript = '''
set -u
while true; do
  if jwks="$(wget -qO- -T 30 "$JWKS_URL")" && [ -n "$jwks" ] &&
     changed="$(echo "select private.set_pgrst_jwks(:'jwks');" |
       psql "$PGRST_DB_URI" -XAtq -v ON_ERROR_STOP=1 -v jwks="$jwks")"; then
    if [ "$changed" = t ]; then echo "jwks-refresh: new keys loaded"; else echo "jwks-refresh: keys unchanged"; fi
    wait_s="${REFRESH_SECONDS:-21600}"
  else
    echo "jwks-refresh: refresh failed; current keys stay in force; retrying in 5 minutes" >&2
    wait_s=300
  fi
  [ "${RUN_ONCE:-}" = 1 ] && exit 0
  sleep "$wait_s"
done
'''
var tags = {
  application: 'Hitachi Rail T&C Portal'
  project: 'BART CBTC'
  environment: environment
  dataClassification: 'Confidential'
}

// ── Identity ────────────────────────────────────────────────────────────────
// One user-assigned identity for the API, so it never holds a secret: they authenticate to Postgres, Blob and Key Vault as
// themselves. This is what removes the service-role key that today sits in an
// Edge Function secret.
resource appIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-${suffix}'
  location: location
  tags: tags
}

// ── Secrets ─────────────────────────────────────────────────────────────────
// Key Vault exists for the few secrets that cannot be replaced by managed
// identity — the SharePoint sync's client secret, mail credentials. RBAC
// rather than access policies, so grants show up in Entra audit.
resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: take('kv-${replace(suffix, '-', '')}${uniqueString(resourceGroup().id)}', 24)
  location: location
  tags: tags
  properties: {
    tenantId: tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    // Purge protection cannot be turned off once on, and a soft-deleted vault
    // keeps its NAME reserved. Because that name is derived from the resource
    // group id, deleting the group and redeploying it under the same name would
    // collide with the tombstone and fail — for 90 days. Correct for prod,
    // actively harmful for an environment meant to be torn down and rebuilt.
    softDeleteRetentionInDays: thrifty ? 7 : 90
    ...(isProd ? { enablePurgeProtection: true } : {})
    publicNetworkAccess: databasePublicAccess ? 'Enabled' : 'Disabled'
  }
}

// ── Database ────────────────────────────────────────────────────────────────
// Azure Database for PostgreSQL Flexible Server. NOT Azure SQL: the
// authorization model is 349 RLS policies, 53 triggers and 27 jsonb + 20 array
// columns, which have no SQL Server equivalent. pg_dump/pg_restore moves all of
// it verbatim — proven by tools/test_rls_portability.js.
//
// Entra authentication for people (administrators sign in with their Entra
// account). Password authentication must STAY ON: PostgREST and its jwks-refresh
// helper log in as `authenticator` with a password — PostgREST cannot use an
// Entra token to reach the database. So always deploy with an admin password.
resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2023-12-01-preview' = if (deployManagedPostgres) {
  name: 'psql-${suffix}'
  location: location
  tags: tags
  sku: {
    name: isProd ? 'Standard_D2ds_v5' : (thrifty ? 'Standard_B1ms' : 'Standard_B2s')
    tier: isProd ? 'GeneralPurpose' : 'Burstable'
  }
  properties: {
    // administratorLogin/Password are only legal when passwordAuth is Enabled,
    // and are REQUIRED when it is — so the two move together or the create
    // call is rejected.
    ...(usePasswordAuth ? {
      administratorLogin: administratorLogin
      administratorLoginPassword: administratorLoginPassword
    } : {})
    version: postgresVersion
    storage: {
      // Backups must be retrievable and restore-tested, not merely configured.
      storageSizeGB: 32
      autoGrow: 'Enabled'
    }
    backup: {
      backupRetentionDays: 35
      geoRedundantBackup: environment == 'prod' ? 'Enabled' : 'Disabled'
    }
    highAvailability: {
      mode: environment == 'prod' ? 'ZoneRedundant' : 'Disabled'
    }
    authConfig: {
      activeDirectoryAuth: 'Enabled'
      passwordAuth: usePasswordAuth ? 'Enabled' : 'Disabled'   // must be Enabled for the gateway's login
      tenantId: tenantId
    }
    network: {
      publicNetworkAccess: databasePublicAccess ? 'Enabled' : 'Disabled'
    }
  }
}

// Extensions the schema uses. No pg_cron: the app has no scheduled jobs.
// pgcrypto also covers column encryption if cyber asks for it.
resource pgExtensions 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2023-12-01-preview' = if (deployManagedPostgres) {
  parent: postgres
  name: 'azure.extensions'
  properties: {
    value: 'PGCRYPTO,UUID-OSSP'
    source: 'user-override'
  }
}

// Force TLS 1.2 or later with earlier versions disabled. This is where that
// becomes true of the server rather than merely asserted of the client.
resource requireTls 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2023-12-01-preview' = if (deployManagedPostgres) {
  parent: postgres
  name: 'require_secure_transport'
  properties: { value: 'ON', source: 'user-override' }
}
resource minTls 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2023-12-01-preview' = if (deployManagedPostgres) {
  parent: postgres
  name: 'ssl_min_protocol_version'
  properties: { value: 'TLSv1.2', source: 'user-override' }
}

// Public network access on its own grants NOTHING — Flexible Server denies every
// connection until a firewall rule exists. Without this, psql from Cloud Shell
// and PostgREST from Container Apps are both refused, which looks like a
// hostname or credential problem and is neither.
//
// 0.0.0.0-0.0.0.0 is Azure's special idiom for "any Azure service", NOT "the
// whole internet" (that would be 0.0.0.0-255.255.255.255). Cloud Shell and the
// Container App both run inside Azure, so this is the tightest rule that lets
// them in. Only created when public access is deliberately on; a private-
// endpoint deployment needs none of it.
resource allowAzureServices 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2023-12-01-preview' = if (deployManagedPostgres && databasePublicAccess) {
  parent: postgres
  name: 'AllowAllAzureServicesAndResourcesWithinAzureIps'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

resource dbAdmin 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2023-12-01-preview' = if (deployManagedPostgres && deployDbEntraAdmin) {
  parent: postgres
  name: dbAdminGroupObjectId
  properties: {
    principalType: dbAdminPrincipalType
    principalName: dbAdminGroupName
    tenantId: tenantId
  }
}

// ── Object storage ──────────────────────────────────────────────────────────
// Replaces the five Supabase buckets. One container each, so a per-container
// access grant stays possible.
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: take('st${replace(suffix, '-', '')}${uniqueString(resourceGroup().id)}', 24)
  location: location
  tags: tags
  sku: { name: environment == 'prod' ? 'Standard_ZRS' : 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false       // signed access only — never anonymous
    allowSharedKeyAccess: false        // forces user-delegation SAS via Entra
    publicNetworkAccess: storagePublicAccess ? 'Enabled' : 'Disabled'
    encryption: {
      services: {
        blob: { enabled: true, keyType: 'Account' }
      }
      keySource: 'Microsoft.Storage'
      // NOTE: this is STORAGE-level encryption only, which is not sufficient
      // on its own for Confidential data — it protects the disk, not the row
      // from anyone holding a database connection. Column-level encryption in
      // Postgres (pgcrypto) is the control that actually covers those fields.
    }
  }
}

resource blobServices 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    deleteRetentionPolicy: { enabled: true, days: 30 }
    containerDeleteRetentionPolicy: { enabled: true, days: 30 }
    // The browser talks to Blob Storage directly (cx-storage.js): it fetches a
    // user delegation key with the user's Microsoft token, then GETs/PUTs/
    // DELETEs through short-lived signed URLs. Exactly the portal's origin.
    cors: {
      corsRules: empty(allowedOrigin) ? [] : [
        {
          allowedOrigins: [allowedOrigin]
          allowedMethods: ['GET', 'HEAD', 'PUT', 'DELETE', 'POST', 'OPTIONS']
          allowedHeaders: ['authorization', 'content-type', 'x-ms-blob-type', 'x-ms-version']
          exposedHeaders: ['content-type', 'content-length', 'etag']
          maxAgeInSeconds: 3600
        }
      ]
    }
  }
}

var containers = ['photos', 'forms', 'drawings', 'documents', 'vehicle-files']
resource blobContainers 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = [for c in containers: {
  parent: blobServices
  name: c
  properties: { publicAccess: 'None' }
}]

// ── Front end ───────────────────────────────────────────────────────────────
// Static files only: deploy the dist/ folder from `node tools/build.js`.
// Verified portable (no hardcoded host, relative PWA scope).
resource staticSite 'Microsoft.Web/staticSites@2023-01-01' = {
  name: 'stapp-${suffix}'
  location: location
  tags: tags
  // Standard is needed for private endpoints + custom auth. Free has neither,
  // which is acceptable only on a throwaway learning subscription.
  sku: thrifty ? { name: 'Free', tier: 'Free' } : { name: 'Standard', tier: 'Standard' }
  properties: {
    allowConfigFileUpdates: true
    stagingEnvironmentPolicy: 'Enabled'
  }
}

// ── API ─────────────────────────────────────────────────────────────────────
// Self-hosted PostgREST. The client already speaks plain PostgREST — supabase-js
// talks to it unchanged — so this is a container, not a rewrite.
resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-${suffix}'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    // At least one year of access-log retention. Retention beyond 90 days is
    // billed per GB/month, so a learning subscription drops to the free 30.
    retentionInDays: thrifty ? 30 : 400
  }
}

resource containerEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'cae-${suffix}'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
}

// ── PostgreSQL as a container (DEVELOPMENT ESCAPE HATCH) ────────────────────
// Azure free-trial subscriptions are blocked from provisioning Azure Database
// for PostgreSQL at all — every region reports OfferRestricted with an empty
// supportedServerEditions list. This runs the official postgres:17 image in the
// Container Apps environment instead, so the migration can be rehearsed on a
// subscription that cannot have the managed service.
//
// IT IS THE SAME DATABASE ENGINE. Every RLS policy, the auth.uid() shim, the
// jsonb and array columns and PostgREST all behave exactly as they will on the
// managed service. What is missing is the managed-service WRAPPER: automated
// backups, point-in-time restore, high availability, Entra authentication to
// the database, and TLS enforcement at the server.
//
// *** DATA DOES NOT SURVIVE A RESTART. *** Deliberately ephemeral: Postgres
// refuses to start on an Azure Files (CIFS) mount because it demands 0700
// ownership of its data directory, and working around that is more moving parts
// than a throwaway environment deserves. Re-run the schema load after a restart.
// Which is exactly why this must never hold anything real.
resource pgContainer 'Microsoft.App/containerApps@2024-03-01' = if (deployContainerPostgres) {
  name: 'ca-postgres-${environment}'
  location: location
  tags: tags
  properties: {
    managedEnvironmentId: containerEnv.id
    configuration: {
      // The password is a container-app secret, not a plain env var, so it does
      // not appear in `az containerapp show` output.
      secrets: [
        { name: 'pg-password', value: administratorLoginPassword }
      ]
      ingress: {
        // TCP, not HTTP — this speaks the Postgres wire protocol.
        //
        // INTERNAL, not external: Azure refuses external TCP ingress on an
        // environment without a custom VNet (ContainerAppTcpRequiresVnet), and
        // adding one would mean destroying and recreating the environment. So
        // the database is reachable from inside the environment — which is what
        // PostgREST needs — and NOT from Cloud Shell. See azure/RUNBOOK.md for
        // how the schema gets in without a direct psql connection.
        external: false
        transport: 'tcp'
        targetPort: 5432
        exposedPort: 5432
      }
    }
    template: {
      containers: [
        {
          name: 'postgres'
          image: 'postgres:17'
          env: [
            { name: 'POSTGRES_USER', value: administratorLogin }
            { name: 'POSTGRES_PASSWORD', secretRef: 'pg-password' }
            { name: 'POSTGRES_DB', value: 'postgres' }
          ]
          resources: { cpu: json('0.5'), memory: '1Gi' }
        }
      ]
      // Exactly one replica, always on. Postgres is stateful: a second replica
      // would be a second unrelated database, and scaling to zero would discard
      // the first one.
      scale: { minReplicas: 1, maxReplicas: 1 }
    }
  }
}

resource postgrest 'Microsoft.App/containerApps@2024-03-01' = {
  name: 'ca-postgrest-${environment}'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${appIdentity.id}': {} }
  }
  properties: {
    managedEnvironmentId: containerEnv.id
    configuration: {
      ingress: {
        external: true
        targetPort: 3000
        transport: 'http'
        allowInsecure: false
      }
    }
    template: {
      containers: [
        {
          name: 'postgrest'
          image: 'postgrest/postgrest:v12.2.3'   // pin; mirror to ACR before prod
          env: [
            // Empty at deploy time; set once the database exists and has been
            // restored. PostgREST will not serve until then, by design.
            { name: 'PGRST_DB_URI', value: postgrestDbUri }
            { name: 'PGRST_DB_SCHEMAS', value: 'public' }
            { name: 'PGRST_DB_ANON_ROLE', value: 'anon' }
            // Microsoft's signing keys. PostgREST cannot fetch them from a URL,
            // so it reads them from the database whenever it loads its config;
            // the jwks-refresh sidecar below keeps them current. This is what
            // makes auth.uid() resolve — the shim in azure_auth_uid_shim.sql
            // reads the `oid` claim out of the token validated with them.
            { name: 'PGRST_DB_PRE_CONFIG', value: 'private.pgrst_pre_config' }
            // The app registration's 'authenticated' app role arrives in the
            // `roles` claim; PostgREST switches to that database role.
            { name: 'PGRST_JWT_ROLE_CLAIM_KEY', value: '.roles[0]' }
            // Must match the app registration exactly. entraApiAudience is
            // empty until that registration exists; the placeholder below is a
            // name-shaped guess that will NOT match a real token.
            { name: 'PGRST_JWT_AUD', value: empty(entraApiAudience) ? 'api://${appName}-${environment}' : entraApiAudience }
          ]
          resources: { cpu: json('0.5'), memory: '1Gi' }
        }
        {
          // Keeps PostgREST's copy of Microsoft's sign-in keys current. Stock
          // image (psql + wget); the script is jwksRefreshScript above.
          name: 'jwks-refresh'
          image: 'postgres:17-alpine'   // pin; mirror to ACR before prod
          command: [ '/bin/sh', '-c', jwksRefreshScript ]
          env: [
            { name: 'PGRST_DB_URI', value: postgrestDbUri }
            { name: 'JWKS_URL', value: '${az.environment().authentication.loginEndpoint}${tenantId}/discovery/v2.0/keys' }
            { name: 'REFRESH_SECONDS', value: '21600' }   // every 6 hours
          ]
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
        }
      ]
      // Scale to zero on a learning subscription: an unconfigured PostgREST
      // will crash-loop, and there is no reason to pay for that. Costs a cold
      // start on the first request.
      scale: { minReplicas: thrifty ? 0 : 1, maxReplicas: isProd ? 3 : 1 }
    }
  }
}

// Storage Blob Data Contributor on the storage account. It includes
// generateUserDelegationKey, which is what lets a portal user's browser sign
// short-lived read/write/delete links for the files — and nothing beyond what
// the role itself allows. Scoped to this one account, revocable by group
// membership, and no key anywhere to rotate.
var blobDataContributor = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')

// The storage account has allowSharedKeyAccess: false, so there is no account
// key to fall back on and Owner on the subscription grants nothing on the data
// plane. Without this, a developer cannot upload or read a single blob.
resource devBlobRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (grantDeveloperBlobAccess) {
  scope: storage
  name: guid(storage.id, dbAdminGroupObjectId, blobDataContributor, 'dev')
  properties: {
    roleDefinitionId: blobDataContributor
    principalId: dbAdminGroupObjectId
    principalType: dbAdminPrincipalType == 'User' ? 'User' : 'Group'
  }
}

resource portalUsersBlobRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(portalUsersGroupObjectId)) {
  scope: storage
  name: guid(storage.id, portalUsersGroupObjectId, blobDataContributor)
  properties: {
    roleDefinitionId: blobDataContributor
    principalId: portalUsersGroupObjectId
    principalType: 'Group'
  }
}

// ── WAF ─────────────────────────────────────────────────────────────────────
// THIS IS THE INTRUSION-PREVENTION LAYER the current Supabase architecture
// cannot provide at all. It must front the API, not just
// the static site: the front end holds no data — every Confidential record
// flows through PostgREST.
resource wafPolicy 'Microsoft.Network/FrontDoorWebApplicationFirewallPolicies@2022-05-01' = if (wantWaf) {
  name: take('waf${replace(suffix, '-', '')}', 128)
  location: 'global'
  tags: tags
  sku: { name: 'Premium_AzureFrontDoor' }
  properties: {
    policySettings: {
      enabledState: 'Enabled'
      mode: isProd ? 'Prevention' : 'Detection'   // Detection first in dev, Prevention in prod
    }
    managedRules: {
      managedRuleSets: [
        { ruleSetType: 'Microsoft_DefaultRuleSet', ruleSetVersion: '2.1', ruleSetAction: 'Block' }
        { ruleSetType: 'Microsoft_BotManagerRuleSet', ruleSetVersion: '1.0' }
      ]
    }
  }
}

output staticSiteName string = staticSite.name
// The portal's address: the app registration's redirect URI and allowedOrigin.
output siteUrl string = 'https://${staticSite.properties.defaultHostname}'
output postgresFqdn string = deployManagedPostgres
  ? (postgres.?properties.fullyQualifiedDomainName ?? '')
  : (deployContainerPostgres ? (pgContainer.?properties.configuration.ingress.fqdn ?? '') : '')
output storageAccountName string = storage.name
output apiFqdn string = postgrest.properties.configuration.ingress.fqdn
output appIdentityClientId string = appIdentity.properties.clientId
output keyVaultName string = keyVault.name
output wafPolicyId string = wantWaf ? wafPolicy.id : ''
// BLOB_ORIGIN for the portal's config.js (no trailing slash).
output blobOrigin string = 'https://${storage.name}.blob.${az.environment().suffixes.storage}'
output wafDeployed bool = wantWaf
output thriftyMode bool = thrifty
