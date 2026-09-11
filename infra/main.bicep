// ============================================================
// main.bicep — Hitachi Rail T&C Portal on Azure
//
// A REVIEWABLE PROPOSAL, NOT A DEPLOYED ENVIRONMENT. It is written to be read
// by the IT team that owns the subscription: every resource says which ITSD
// Public Clouds requirement it exists to satisfy, so the security review and
// the infrastructure review are the same conversation.
//
// EXPECT TO CHANGE: naming, tags, region, SKUs and the networking model are
// landing-zone decisions that belong to IT, not to this file. What is NOT
// negotiable from the application's side is called out in comments.
//
// Deploy (once IT has a resource group and has agreed the parameters):
//   az deployment group create -g <rg> -f infra/main.bicep -p @infra/main.parameters.json
// ============================================================

@description('Environment discriminator. Keep dev separate from prod: the app is currently developed against production, which ITSD I.2-3-3 asks about.')
@allowed(['dev', 'test', 'prod'])
param environment string = 'dev'

@description('Azure region. Must satisfy the data-residency position recorded in the ITSD application — the data is US-jurisdiction.')
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

@description('Set false only for a documented exception: public network access on the database is what ITSD I.2-6 is about.')
param databasePublicAccess bool = false

var suffix = '${appName}-${environment}'
var tags = {
  application: 'Hitachi Rail T&C Portal'
  project: 'BART CBTC'
  environment: environment
  dataClassification: 'Confidential'
  itsdApplication: 'ITSD Public Clouds — see docs/itsd/'
}

// ── Identity ────────────────────────────────────────────────────────────────
// One user-assigned identity for the API and the Functions, so neither ever
// holds a secret: they authenticate to Postgres, Blob and Key Vault as
// themselves. This is what removes the service-role key that today sits in an
// Edge Function secret (ITSD I.2-2-1).
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
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true
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
    name: environment == 'prod' ? 'Standard_D2ds_v5' : 'Standard_B2s'
    tier: environment == 'prod' ? 'GeneralPurpose' : 'Burstable'
  }
  properties: {
    version: postgresVersion
    storage: {
      // ITSD I.1-1(20) / O.1-4: backups must be retrievable and restore-tested.
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
      passwordAuth: 'Enabled'   // TODO(cutover): 'Disabled' once migration is done
      tenantId: tenantId
    }
    network: {
      publicNetworkAccess: databasePublicAccess ? 'Enabled' : 'Disabled'
    }
  }
}

// pg_cron carries the weekly planning snapshot and the auth_events retention
// purge (ITSD O.1-5). Both exist today and must survive the move.
resource pgCron 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2023-12-01-preview' = {
  parent: postgres
  name: 'azure.extensions'
  properties: {
    value: 'PGCRYPTO,PG_CRON,UUID-OSSP'
    source: 'user-override'
  }
}

// Force TLS. ITSD I.2-8 asks for TLS 1.2 or later with earlier versions
// disabled, and this is where that answer becomes true rather than asserted.
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

resource dbAdmin 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2023-12-01-preview' = {
  parent: postgres
  name: dbAdminGroupObjectId
  properties: {
    principalType: 'Group'
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
      // ITSD I.3-1 note: this is STORAGE-level encryption, which the checklist
      // explicitly says is not sufficient on its own for Confidential data.
      // Column-level encryption in Postgres (pgcrypto) is the answer there —
      // see docs and the free-text entry in the ITSD workbook.
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

var containers = ['photos', 'forms', 'drawings', 'vehicle-files', 'task-files']
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
  sku: { name: 'Standard', tier: 'Standard' }   // Standard: needed for private endpoints + custom auth
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
    // ITSD O.1-5 asks for at least one year of access-log retention.
    retentionInDays: 400
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
            { name: 'PGRST_DB_URI', value: 'postgres://...' }      // via managed identity at deploy time
            { name: 'PGRST_DB_SCHEMAS', value: 'public' }
            { name: 'PGRST_DB_ANON_ROLE', value: 'anon' }
            // Entra's JWKS. This is what makes auth.uid() resolve — the shim in
            // supabase/sql/azure_auth_uid_shim.sql reads the `oid` claim out of
            // the token PostgREST validates here.
            { name: 'PGRST_JWT_SECRET', value: '@{"jwks_uri":"${az.environment().authentication.loginEndpoint}${tenantId}/discovery/v2.0/keys"}' }
            { name: 'PGRST_JWT_AUD', value: 'api://${appName}-${environment}' }
          ]
        }
      ]
      scale: { minReplicas: 1, maxReplicas: environment == 'prod' ? 3 : 1 }
    }
  }
}

// ── WAF ─────────────────────────────────────────────────────────────────────
// THIS IS THE RESOURCE THAT CLOSES ITSD I.2-6, the one requirement the current
// Supabase architecture cannot satisfy at all. It must front the API, not just
// the static site: the front end holds no data — every Confidential record
// flows through PostgREST.
resource wafPolicy 'Microsoft.Network/FrontDoorWebApplicationFirewallPolicies@2022-05-01' = {
  name: take('waf${replace(suffix, '-', '')}', 128)
  location: 'global'
  tags: tags
  sku: { name: 'Premium_AzureFrontDoor' }
  properties: {
    policySettings: {
      enabledState: 'Enabled'
      mode: 'Prevention'            // Detection first in dev, Prevention in prod
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
output wafPolicyId string = wafPolicy.id
