# DataManagement CDK

AWS CDK infrastructure for a document management pipeline that ingests, processes, classifies, and archives documents from multiple input channels (UI upload, email, bulk upload). The system extracts text and metadata using Textract and Comprehend, stores results in DynamoDB, and exposes a REST API for querying, reviewing, and managing documents.

## Architecture

```
                         ┌─────────────────────────────────────────────────┐
                         │              Input Channels                     │
                         │   Web App  ·  Email (SES)  ·  Bulk Upload      │
                         └────────────────────┬────────────────────────────┘
                                              │
                                    ┌─────────▼─────────┐
                                    │  S3 Landing Bucket │
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
              │ Textract │   │Comprehend │  │Glacier Bucket│
              │   OCR    │   │  NLP      │  └──────────────┘
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
              │  DynamoDB Metadata      │
              │  (GSIs: ByType,         │
              │   ByVendor, ByStatus)   │
              └────────────┬────────────┘
                           │
                    ┌──────▼──────┐
                    │  HTTP API   │◄── Cognito JWT Auth
                    │  Gateway    │
                    └─────────────┘
```

## Stacks

Each stage (Beta, Prod) deploys 4 stacks:

| Stack | Purpose |
|-------|---------|
| `{Stage}-DataMgmtAuthStack` | Cognito User Pool and client for authentication |
| `{Stage}-DataMgmtIngestionStack` | S3 landing bucket, EventBridge rule, SQS ingestion queue |
| `{Stage}-DataMgmtProcessingStack` | Processing + archive Lambdas, processed/Glacier buckets, DynamoDB tables |
| `{Stage}-DataMgmtApiStack` | API Gateway HTTP API, upload/documents/classifications Lambdas |

## API Endpoints

All endpoints require a Cognito JWT in the `Authorization` header.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/upload` | Generate presigned S3 upload URLs (1–25 files per request) |
| `GET` | `/documents` | List documents with filters (status, type, vendor, date range) |
| `GET` | `/documents/{id}` | Get document detail with presigned download URLs |
| `PATCH` | `/documents/{id}` | Update status, classification, or review notes |
| `GET` | `/classifications` | List all classification keyword configs |
| `PUT` | `/classifications/{documentType}` | Create or update a classification config |
| `DELETE` | `/classifications/{documentType}` | Remove a classification config |

Full endpoint documentation with request/response schemas is in `.kiro/specs/phase-3-api.md`.

## Prerequisites

- Node.js 20+
- AWS CLI configured with credentials
- CDK bootstrapped in target account/region: `npx cdk bootstrap aws://<ACCOUNT_ID>/<REGION>`

## Getting Started

```bash
# Install dependencies
npm install

# Run tests
npm test

# Synthesize CloudFormation templates
npx cdk synth

# Deploy all stacks (Beta)
npx cdk deploy "Beta-DataMgmt*"

# Deploy all stacks (all stages)
npx cdk deploy --all
```

## Post-Deploy Setup

### 1. Seed the classification config table

The processing Lambda uses keyword matching from the classification config table to classify documents. An empty table means every document gets `status: needs_review`.

```bash
# Get the table name from CloudFormation outputs
aws cloudformation describe-stacks \
  --stack-name Beta-DataMgmtProcessingStack \
  --query "Stacks[0].Outputs[?contains(OutputKey,'ClassificationConfig')].OutputValue" \
  --output text

# Seed with default classifications
AWS_REGION=<REGION> TABLE_NAME=<ClassificationConfigTableName> npx ts-node data/seed-classifications.ts
```

Default classifications seeded: `invoice`, `receipt`, `contract`, `statement`, `purchase_order`, `tax_form`. Edit `data/seed-classifications.json` or use the `PUT /classifications/{documentType}` API to modify at runtime.

### 2. Create the first Cognito user

Self-signup is disabled. Create users via CLI:

```bash
# Get the User Pool ID from CloudFormation outputs
aws cloudformation describe-stacks \
  --stack-name Beta-DataMgmtAuthStack \
  --query "Stacks[0].Outputs[?contains(OutputKey,'UserPoolId')].OutputValue" \
  --output text

# Create a user
aws cognito-idp admin-create-user \
  --user-pool-id <USER_POOL_ID> \
  --username your@email.com \
  --temporary-password 'TempPass1!' \
  --user-attributes Name=email,Value=your@email.com
```

### 3. Note the API URL

```bash
aws cloudformation describe-stacks \
  --stack-name Beta-DataMgmtApiStack \
  --query "Stacks[0].Outputs[?contains(OutputKey,'ApiUrl')].OutputValue" \
  --output text
```

## Project Structure

```
data-management-cdk/
├── bin/
│   └── data-management-cdk.ts          # CDK app entry point (stage loop)
├── lib/
│   ├── config.ts                       # Stage definitions (Beta, Prod)
│   ├── auth-stack.ts                   # Cognito User Pool
│   ├── ingestion-stack.ts              # S3 landing bucket, EventBridge, SQS
│   ├── processing-stack.ts             # Processing/archive Lambdas, buckets, DynamoDB
│   ├── api-stack.ts                    # API Gateway, upload/documents/classifications Lambdas
│   └── utils/
│       └── getSuffixFromStack.ts       # Unique suffix utility for resource naming
├── lambdas/
│   ├── archive/index.ts                # Copies files to Glacier bucket
│   ├── processing/index.ts             # File detection, email parsing, Textract, Comprehend, classification
│   ├── upload/index.ts                 # Presigned URL generation
│   ├── documents/index.ts              # Document list/get/patch
│   └── classifications/index.ts        # Classification config CRUD
├── data/
│   ├── seed-classifications.json       # Default classification keyword configs
│   └── seed-classifications.ts         # Seed script for classification table
├── test/
│   ├── auth-stack.test.ts
│   ├── ingestion-stack.test.ts
│   ├── processing-stack.test.ts
│   └── api-stack.test.ts
├── package.json
├── tsconfig.json
└── cdk.json
```

## Useful Commands

| Command | Description |
|---------|-------------|
| `npm test` | Run all CDK assertion tests |
| `npx cdk synth` | Synthesize CloudFormation templates |
| `npx cdk deploy --all` | Deploy all stacks (all stages) |
| `npx cdk deploy "Beta-DataMgmt*"` | Deploy all Beta stacks |
| `npx cdk diff` | Show pending infrastructure changes |
| `npx cdk destroy "Beta-DataMgmt*"` | Tear down Beta stacks (stateful resources retained) |

## Security

- All data encrypted at rest with customer-managed KMS keys (one per stack, auto-rotation enabled)
- S3 buckets: block all public access, enforce SSL, versioning enabled
- SQS queues: KMS encrypted, dead-letter queues with 3-retry policy
- DynamoDB tables: customer-managed KMS encryption
- API Gateway: Cognito JWT authorization on all routes
- File uploads: presigned URLs scoped to user namespace, 15-minute expiry, content type enforced
- Stateful resources use `RemovalPolicy.RETAIN` to prevent accidental data loss

## Coding Conventions

- Arrow functions only (`const fn = () => {}`) — no `function` keyword
- CDK stacks in `lib/`, Lambda handlers in `lambdas/{function-name}/index.ts`
- One test file per stack in `test/`
- Stack naming: `{Stage}-DataMgmt{Purpose}Stack`
- Cross-stack references via direct CDK construct passing (not SSM)
