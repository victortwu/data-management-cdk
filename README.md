# Parsely — Document Intelligence Backend

AWS CDK infrastructure for a multi-tenant document intelligence pipeline that ingests, processes, classifies, and archives documents from multiple input channels (UI upload, email, bulk upload). The system extracts text using Textract, classifies and extracts metadata using Bedrock (Amazon Nova Lite), stores results in DynamoDB, and exposes a REST API for querying, reviewing, and managing documents.

## Architecture

```
                         ┌─────────────────────────────────────────────────┐
                         │              Input Channels                     │
                         │   React SPA  ·  Email (SES)  ·  Bulk Upload    │
                         └────────────────────┬────────────────────────────┘
                                              │
                                    ┌─────────▼─────────┐
                                    │  S3 Landing Bucket │
                                    │  uploads/{tenantId}│
                                    └─────────┬─────────┘
                                              │
                                        EventBridge
                                       (Object Created)
                                      ┌───────┴───────┐
                                      │               │
                              ┌───────▼──────┐ ┌──────▼───────┐
                              │ SQS Ingestion│ │ SQS Archive  │
                              │    Queue     │ │    Queue     │
                              └───────┬──────┘ └──────┬───────┘
                                      │               │
                              ┌───────▼──────┐ ┌──────▼───────┐
                              │  Processing  │ │   Archive    │
                              │   Lambda     │ │   Lambda     │
                              └──┬───┬───┬───┘ └──────┬───────┘
                                 │   │   │            │
                    ┌────────────┘   │   └──────┐     │
                    ▼                ▼          ▼     ▼
              ┌──────────┐   ┌───────────┐  ┌──────────────┐
              │ Textract │   │  Bedrock  │  │Glacier Bucket│
              │   OCR    │   │ Nova Lite │  └──────────────┘
              └────┬─────┘   └─────┬─────┘
                   │               │
                   └───────┬───────┘
                           ▼
              ┌─────────────────────────┐
              │   S3 Processed Bucket   │
              │  (originals, PDFs, text)│
              └─────────────────────────┘
                           │
                           ▼
              ┌─────────────────────────┐
              │  DynamoDB Document Table │
              │  PK: tenantId           │
              │  GSIs: ByType, ByVendor,│
              │   ByStatus, ByDate,     │
              │   BySource              │
              └────────────┬────────────┘
                           │
              ┌─────────────────────────┐
              │  DynamoDB Config Table   │
              │  TYPE#, VENDOR#,         │
              │  TENANT#meta            │
              └────────────┬────────────┘
                           │
                    ┌──────▼──────┐
                    │  HTTP API   │◄── Cognito JWT Auth
                    │  Gateway    │
                    └─────────────┘
```

## Processing Pipeline

For each uploaded file, the Processing Lambda:

1. Detects file type (PDF, image, text, CSV, email)
2. Converts to PDF (`pdf-lib` — images embedded, text wrapped)
3. Extracts text (Textract sync for images, async for multi-page PDFs)
4. Queries tenant's config table for known types/vendors
5. Classifies + extracts metadata via Bedrock (Amazon Nova Lite, temperature=0)
6. Saves metadata to DynamoDB, files to processed bucket

Config table items (TYPE# with subType keywords, VENDOR# with aliases) are injected into the LLM system prompt, directly influencing classification output.

## Stacks

Each stage (Beta, Gamma, Prod) deploys 4 core stacks + 1 optional email stack:

| Stack | Purpose |
|-------|---------|
| `{Stage}-DataMgmtIngestionStack` | S3 landing bucket, EventBridge rules, SQS queues, Email Lambda |
| `{Stage}-DataMgmtProcessingStack` | Processing + Archive Lambdas, processed/Glacier buckets, DynamoDB tables |
| `{Stage}-DataMgmtAuthStack` | Cognito User Pool, post-confirmation Lambda (tenant provisioning) |
| `{Stage}-DataMgmtApiStack` | API Gateway HTTP API, 4 Lambda handlers |
| `{Stage}-BDK-DataMgmtEmailStack` | SES receipt rule (us-east-1, optional) |

Cross-stack communication via SSM Parameter Store (`/{stage}/datamgmt/*`).

## API Endpoints

All 12 endpoints require a Cognito JWT in the `Authorization` header.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/upload` | Generate presigned S3 upload URLs (1–50 files) |
| `GET` | `/documents` | List documents with GSI routing + date range + pagination |
| `GET` | `/documents/{id}` | Document detail with presigned download URLs |
| `PATCH` | `/documents/{id}` | Update status/type/vendor/notes (9 editable fields) |
| `POST` | `/documents/reprocess` | Re-classify all documents against current config |
| `GET` | `/classifications` | List all TYPE# config items |
| `GET` | `/classifications/stats` | Aggregate counts by type/subType/vendor |
| `PUT` | `/classifications/{documentType}` | Create or update a classification config |
| `DELETE` | `/classifications/{documentType}` | Remove a classification config |
| `GET` | `/vendors` | List all VENDOR# config items |
| `PUT` | `/vendors/{vendorId}` | Create or update a vendor config |
| `DELETE` | `/vendors/{vendorId}` | Remove a vendor config |

## Prerequisites

- Node.js 20+
- AWS CLI configured with credentials
- CDK bootstrapped: `npx cdk bootstrap aws://<ACCOUNT_ID>/<REGION>`

## Getting Started

```bash
npm install
npm test              # CDK assertion + unit tests (62 tests)
npx cdk synth         # Synthesize all templates
npx cdk deploy "Beta-DataMgmt*"   # Deploy Beta
```

## Post-Deploy Setup

### 1. Seed the config table

```bash
# Get config table name from SSM
aws ssm get-parameter --name /Beta/datamgmt/config-table-name --query "Parameter.Value" --output text

# Seed types + vendors
AWS_REGION=us-west-2 CONFIG_TABLE=<name> npx ts-node data/seed-config.ts
```

### 2. Create a user (triggers tenant provisioning)

With self-signup disabled, create users via CLI:

```bash
aws cognito-idp admin-create-user \
  --user-pool-id <USER_POOL_ID> \
  --username your@email.com \
  --temporary-password 'TempPass1!' \
  --user-attributes Name=email,Value=your@email.com
```

Note: `admin-create-user` does NOT trigger the post-confirmation Lambda. Use the sign-up flow or manually provision the tenant (TENANT#meta + default TYPE# items in config table).

## Deployments

| Environment | Account | Profile | Command |
|-------------|---------|---------|---------|
| Beta | `653102291240` | default | `npx cdk deploy "Beta-DataMgmt*"` |
| Prod | `639914975031` | `datamgmt-prod` | `npx cdk deploy "Prod-DataMgmt*" --profile datamgmt-prod` |

Deploy order (fresh environment): Ingestion → Processing → Auth → API
Destroy order: API → Processing → Auth → Ingestion

## Testing

```bash
npm run test:unit         # CDK + unit tests (62 tests, no AWS calls)
npm run test:integration  # Real Bedrock calls (~7s, requires AWS creds)
```

Integration tests validate that config table content influences LLM classification output.

## Project Structure

```
data-management-cdk/
├── bin/
│   └── data-management-cdk.ts         # CDK app entry (stage loop + email stack)
├── config.ts                          # Stage definitions (Beta, Gamma, Prod)
├── lib/
│   ├── stacks/
│   │   ├── ingestion-stack.ts         # S3, EventBridge, SQS, Email Lambda
│   │   ├── processing-stack.ts        # Processing/Archive Lambdas, DynamoDB, S3
│   │   ├── auth-stack.ts              # Cognito + post-confirmation
│   │   ├── api-stack.ts               # API Gateway + 4 handler Lambdas
│   │   └── email-stack.ts             # SES receipt rule (us-east-1)
│   └── utils/
│       └── getSuffixFromStack.ts
├── lambdas/
│   ├── processing/                    # File detection, PDF conversion, Textract, Bedrock
│   │   ├── index.ts                   # Orchestrator
│   │   ├── adapters/                  # LLM strategy pattern (bedrock, ollama, openai, none)
│   │   ├── utils/                     # buildBedrockPrompt, extractText, imageToPdf, etc.
│   │   ├── constants/
│   │   └── types/
│   ├── email/index.ts                 # MIME parsing, attachment extraction
│   ├── post-confirmation/index.ts     # Tenant provisioning on signup
│   ├── upload/index.ts                # Presigned URL generation
│   ├── documents/                     # List/get/patch/reprocess/stats handlers
│   ├── classifications/index.ts       # Config CRUD
│   ├── vendors/index.ts               # Vendor CRUD
│   ├── archive/index.ts               # S3 copy to Glacier
│   └── shared/utils/                  # tenantContext, logger, metrics
├── data/
│   ├── seed-config.ts                 # Seeds config table (types + vendors)
│   ├── seed-classifications.json
│   └── seed-vendors.json
├── test/
│   ├── *.test.ts                      # CDK assertion tests (per stack)
│   ├── unit/                          # Lambda unit tests
│   └── integration/                   # Bedrock integration tests
├── jest.config.js                     # Unit tests (excludes integration/)
└── jest.integration.config.js         # Integration tests (30s timeout)
```

## Security

- All data encrypted at rest with customer-managed KMS keys (one per stack, auto-rotation)
- S3 buckets: block public access, enforce SSL, versioning
- SQS queues: KMS encrypted, 3-retry DLQ, 14-day retention
- DynamoDB tables: customer-managed KMS encryption, on-demand billing
- API Gateway: Cognito JWT authorization on all routes
- File uploads: presigned URLs scoped to tenant namespace, 15-minute expiry
- Multi-tenancy: every query uses tenantId partition key (no Scan operations)
- Stateful resources: `RemovalPolicy.RETAIN`

## Coding Conventions

- Arrow functions only (`const fn = () => {}`)
- Stacks in `lib/stacks/`, Lambdas in `lambdas/{function-name}/`
- Lambda structure: thin index.ts router → handlers/ + utils/ + constants/ + types/
- Cross-stack references via SSM Parameter Store (`/{stage}/datamgmt/*`)
- Stack naming: `{Stage}-DataMgmt{Purpose}Stack`
- Prettier: single quotes, no semicolons, trailing commas, 100 char width
