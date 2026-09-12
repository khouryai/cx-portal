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

@secure()
@description('PostgREST connection string, as the `authenticator` role. Empty until the database is restored — the API container is deployed unconfigured and set later (azure/RUNBOOK.md step 4), because this value cannot exist before the server does.')
param postgrestDbUri string = ''

@description('Deploy the Front Door WAF. Leave true for anything internet-facing. Set FALSE only for a throwaway personal/learning subscription: Premium_AzureFrontDoor costs roughly USD 330/month and teaches you nothing the rest of the stack does not. Forced true when environment == prod.')
param deployWaf bool = true

@description('Use the cheapest viable SKUs. Personal-subscription escape hatch ONLY: Static Web Apps drops to Free (no private endpoints, no custom auth) and log retention drops to 30 days. Ignored when environment == prod.')
param cheapMode bool = false

@description('Audience the SAS Function requires in caller tokens — the API app registration\'s application id or app id URI. Empty until the Entra app registration exists; the Function refuses every request until it is set.')
param entraApiAudience string = ''

@description('Origin allowed to call the SAS Function (the portal). Deliberately not a wildcard: this endpoint hands out credentials.')
param allowedOrigin string = ''

var isProd = environment == 'prod'
var usePasswordAuth = !empty(administratorLoginPassword)
// Guard rails: prod never gets the cheap path, whatever the parameter file says.
var thrifty = cheapMode && !isProd
var wantWaf = deployWaf || isProd
var suffix = '${appName}-${environment}'
var tags = {
  application: 'Hitachi Rail T&C Portal'
  project: 'BART CBTC'
  environment: environment
  dataClassification: 'Confidential'
}

// ── Identity ────────────────────────────────────────────────────────────────
// One user-assigned identity for the API and the Functions, so neither ever
// holds a secret: they authenticate to Postgres, Blob and Key Vault as
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
// Entra authentication is enabled and password auth left ON only so the
// migration can run; turn it off once cutover completes.
resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2023-12-01-preview' = {
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
      passwordAuth: usePasswordAuth ? 'Enabled' : 'Disabled'   // cutover: redeploy with an empty password
      tenantId: tenantId
    }
    network: {
      publicNetworkAccess: databasePublicAccess ? 'Enabled' : 'Disabled'
    }
  }
}

// pg_cron carries the weekly planning snapshot and the auth_events retention
// purge. Both exist today and must survive the move.
resource pgCron 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2023-12-01-preview' = {
  parent: postgres
  name: 'azure.extensions'
  properties: {
    value: 'PGCRYPTO,PG_CRON,UUID-OSSP'
    source: 'user-override'
  }
}

// Force TLS 1.2 or later with earlier versions disabled. This is where that
// becomes true of the server rather than merely asserted of the client.
resource requireTls 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2023-12-01-preview' = {
  parent: postgres
  name: 'require_secure_transport'
  properties: { value: 'ON', source: 'user-override' }
}
resource minTls 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2023-12-01-preview' = {
  parent: postgres
  name: 'ssl_min_protocol_version'
  properties: { value: 'TLSv1.2', source: 'user-override' }
}

resource dbAdmin 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2023-12-01-preview' = if (deployDbEntraAdmin) {
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
    publicNetworkAccess: databasePublicAccess ? 'Enabled' : 'Disabled'
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
  }
}

var containers = ['photos', 'forms', 'drawings', 'documents', 'vehicle-files', 'task-files']
resource blobContainers 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = [for c in containers: {
  parent: blobServices
  name: c
  properties: { publicAccess: 'None' }
}]

// ── Front end ───────────────────────────────────────────────────────────────
// The repo root IS the site — no build step. Static Web Apps serves it as-is;
// verified portable (no hardcoded host, relative PWA scope).
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
            // Entra's JWKS. This is what makes auth.uid() resolve — the shim in
            // supabase/sql/azure_auth_uid_shim.sql reads the `oid` claim out of
            // the token PostgREST validates here.
            // NO leading '@' — PostgREST treats that as "read this from a file"
            // and would try to open a path named after the JSON.
            //
            // UNVERIFIED: whether this PostgREST build fetches a remote
            // jwks_uri at all, or requires the keys inline. If it does not,
            // this is where the first sign-in fails, and the fix is to fetch
            // Entra's JWKS and set it as a literal JWKS. See RUNBOOK step 4.
            { name: 'PGRST_JWT_SECRET', value: '{"jwks_uri":"${az.environment().authentication.loginEndpoint}${tenantId}/discovery/v2.0/keys"}' }
            // Must match the app registration exactly. entraApiAudience is
            // empty until that registration exists; the placeholder below is a
            // name-shaped guess that will NOT match a real token.
            { name: 'PGRST_JWT_AUD', value: empty(entraApiAudience) ? 'api://${appName}-${environment}' : entraApiAudience }
          ]
        }
      ]
      // Scale to zero on a learning subscription: an unconfigured PostgREST
      // will crash-loop, and there is no reason to pay for that. Costs a cold
      // start on the first request.
      scale: { minReplicas: thrifty ? 0 : 1, maxReplicas: isProd ? 3 : 1 }
    }
  }
}

// ── SAS-minting Function ────────────────────────────────────────────────────
// Supabase let the BROWSER sign storage URLs. Azure cannot: a SAS needs a key,
// and no key may reach page script. This Function verifies the caller's Entra
// token and signs on their behalf, using a USER DELEGATION key obtained through
// the managed identity below — the storage account key is never used, never
// configured, and can stay disabled.
//
// Source: azure/functions/sas/. Its request-validation half is covered by
// tools/test_sas_function.js, which needs no subscription.
resource functionPlan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: 'plan-${suffix}'
  location: location
  tags: tags
  kind: 'functionapp'
  sku: { name: 'Y1', tier: 'Dynamic' }   // consumption: no idle cost
  properties: { reserved: true }         // reserved => Linux
}

resource sasFunction 'Microsoft.Web/sites@2023-12-01' = {
  name: 'func-sas-${suffix}'
  location: location
  tags: tags
  kind: 'functionapp,linux'
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${appIdentity.id}': {} }
  }
  properties: {
    serverFarmId: functionPlan.id
    httpsOnly: true
    keyVaultReferenceIdentity: appIdentity.id
    siteConfig: {
      linuxFxVersion: 'Node|20'
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      http20Enabled: true
      cors: {
        // The Function sets its own CORS headers from ALLOWED_ORIGIN; this is
        // the platform-level belt to that braces. Never '*' on an endpoint that
        // issues credentials.
        allowedOrigins: empty(allowedOrigin) ? [] : [allowedOrigin]
        supportCredentials: false
      }
      appSettings: [
        { name: 'FUNCTIONS_EXTENSION_VERSION', value: '~4' }
        { name: 'FUNCTIONS_WORKER_RUNTIME', value: 'node' }
        { name: 'WEBSITE_NODE_DEFAULT_VERSION', value: '~20' }
        // Identity-based connection for the runtime's own storage: no
        // AzureWebJobsStorage connection string, so no account key anywhere.
        { name: 'AzureWebJobsStorage__accountName', value: storage.name }
        { name: 'AzureWebJobsStorage__credential', value: 'managedidentity' }
        { name: 'AzureWebJobsStorage__clientId', value: appIdentity.properties.clientId }
        { name: 'AZURE_CLIENT_ID', value: appIdentity.properties.clientId }
        { name: 'ENTRA_TENANT_ID', value: tenantId }
        { name: 'ENTRA_API_AUDIENCE', value: entraApiAudience }
        { name: 'BLOB_ACCOUNT', value: storage.name }
        { name: 'ALLOWED_ORIGIN', value: allowedOrigin }
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: '' }
      ]
    }
  }
}

// Storage Blob Data Contributor on the storage account. This is what lets the
// Function call getUserDelegationKey and sign read, write and delete SAS. It is
// also the blast radius if the Function is ever compromised — scoped to this
// one account, and revocable without rotating anything.
var blobDataContributor = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')

resource sasBlobRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storage
  name: guid(storage.id, appIdentity.id, blobDataContributor)
  properties: {
    roleDefinitionId: blobDataContributor
    principalId: appIdentity.properties.principalId
    principalType: 'ServicePrincipal'
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
output postgresFqdn string = postgres.properties.fullyQualifiedDomainName
output storageAccountName string = storage.name
output apiFqdn string = postgrest.properties.configuration.ingress.fqdn
output appIdentityClientId string = appIdentity.properties.clientId
output keyVaultName string = keyVault.name
output wafPolicyId string = wantWaf ? wafPolicy.id : ''
output sasFunctionName string = sasFunction.name
output sasEndpoint string = 'https://${sasFunction.properties.defaultHostName}/api/sas'
output wafDeployed bool = wantWaf
output thriftyMode bool = thrifty
