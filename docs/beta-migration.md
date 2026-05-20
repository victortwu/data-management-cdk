# Beta Migration Checklist — Multi-Tenancy Deploy

## Context
The multi-tenancy refactor changes DynamoDB key schemas (can't alter in-place) and S3 key prefixes. Existing Beta data is incompatible with the new structure and must be cleaned up before deploying.

## Pre-Deploy Cleanup

### DynamoDB (required — schema changed)
- [ ] Delete Document Metadata table (`Beta-DataMgmtProcessingStack-DocumentMetadata*`)
- [ ] Delete Config table (`Beta-DataMgmtProcessingStack-ConfigTable*`)
- [ ] Delete legacy Classification Config table (`Beta-DataMgmtProcessingStack-ClassificationConfig*`)
- [ ] Delete legacy Vendor Config table (`Beta-DataMgmtProcessingStack-VendorConfig*`)

> **Note:** Tables have `RemovalPolicy.RETAIN` so CloudFormation won't delete them automatically. Delete manually via AWS Console or CLI:
> ```bash
> aws dynamodb delete-table --table-name <table-name> --region us-west-2
> ```

### S3 (recommended — fresh start)
- [ ] Empty the processed bucket (`beta-datamgmtprocessingsta-processedbucketde59930c-*`)
- [ ] Empty the Glacier bucket

> ```bash
> aws s3 rm s3://<processed-bucket-name> --recursive --region us-west-2
> aws s3 rm s3://<glacier-bucket-name> --recursive --region us-west-2
> ```

- [ ] Landing bucket — no action needed (14-day lifecycle auto-cleans)

### Cognito
- [ ] Deploy will orphan the old User Pool (`UserPool6BA7E5F2-U8ZExkMjX3ea`) — delete it manually after deploy
- [ ] New pool `Beta-DataMgmt-UserPool` created automatically with `custom:tenantId` attribute + post-confirmation trigger
- [ ] Create a new test user after deploy (see Post-Deploy section)

### SSM Parameters
- [ ] No cleanup needed — deploy creates them fresh

## Deploy Order

```bash
# 1. Deploy ingestion first (writes SSM params other stacks read)
cdk deploy Beta-DataMgmtIngestionStack --require-approval never

# 2. Deploy processing (creates new tables, reads ingestion SSM params)
cdk deploy Beta-DataMgmtProcessingStack --require-approval never

# 3. Deploy auth (reads config table SSM param, creates post-confirmation trigger)
cdk deploy Beta-DataMgmtAuthStack --require-approval never

# 4. Deploy API (reads all SSM params)
cdk deploy Beta-DataMgmtApiStack --require-approval never
```

Or deploy all at once (CDK handles dependency order):
```bash
cdk deploy Beta-DataMgmt* --require-approval never
```

## Post-Deploy Verification

### 1. Verify SSM Parameters Created
```bash
aws ssm get-parameters-by-path --path /Beta/datamgmt --region us-west-2
```

### 2. Create Test User (triggers tenant provisioning)
```bash
aws cognito-idp admin-create-user \
  --user-pool-id <user-pool-id> \
  --username test@example.com \
  --temporary-password Test1234! \
  --user-attributes Name=email,Value=test@example.com Name=email_verified,Value=true \
  --region us-west-2
```

Then confirm the user (triggers post-confirmation Lambda):
```bash
aws cognito-idp admin-set-user-password \
  --user-pool-id <user-pool-id> \
  --username test@example.com \
  --password Test1234! \
  --permanent \
  --region us-west-2
```

### 3. Verify Tenant Created
```bash
aws dynamodb scan \
  --table-name <config-table-name> \
  --filter-expression "begins_with(sk, :prefix)" \
  --expression-attribute-values '{":prefix": {"S": "TENANT#"}}' \
  --region us-west-2
```

Should show a TENANT#meta record with plan=free, monthlyLimit=50, and 5 TYPE# default config items.

### 4. Upload Test Document
Use the API with a valid JWT token to upload a file and verify:
- Presigned URL is generated with `uploads/{tenantId}/...` prefix
- Processing Lambda picks it up and classifies it
- Document appears in `GET /documents` scoped to the tenant

## Troubleshooting

### "Resource already exists" on deploy
If CDK fails because old tables still exist with the same logical ID:
1. Delete the table manually (see above)
2. Re-run `cdk deploy`

### Post-confirmation Lambda not firing
- Check CloudWatch Logs for the post-confirmation Lambda
- Verify the trigger is attached: Console → Cognito → User Pool → Triggers tab
- For `admin-create-user`, the post-confirmation trigger only fires after the user confirms/sets password

### SSM parameter not found
Deploy stacks in order: Ingestion → Processing → Auth → API. Each stack writes params that downstream stacks read.

## Rollback
If something goes wrong, the old deployed stacks are still functional (just with empty tables). The code changes are backward-compatible — the new Lambda code works with the new schema, and old data was already deleted.

## Orphaned Resources (Manual Deletion After Successful Deploy)

These resources have `RemovalPolicy.RETAIN` and will survive stack destruction. Delete manually once the new stacks are confirmed working.

### S3 Buckets
| Bucket | Purpose |
|--------|---------|
| `beta-datamgmtingestionstack-landingbucket23fe90fb-uzsnoxp9ehbr` | Landing zone (14-day lifecycle, will self-clean) |
| `beta-datamgmtprocessingsta-processedbucketde59930c-kp0vwibarhzq` | Processed files (already emptied) |
| `beta-datamgmtprocessingstack-glacierbucket9b7456a0-qdktgg0ybeyf` | Glacier archive (already emptied) |

> **Note:** The landing bucket is still functional and will be reused by the new ingestion stack (same physical bucket, new CloudFormation management). Only delete if you want a completely fresh bucket.

### KMS Keys
| Alias | Key ID | Purpose |
|-------|--------|---------|
| `alias/ingestion-beta` | `610d8aaf-82da-4959-8e15-6694185ba6da` | Ingestion stack encryption |
| `alias/processing-beta` | `3509cf54-fd35-4207-9ee6-d403ffbbac9d` | Processing stack encryption |

> **Note:** KMS keys can't be immediately deleted — they have a 7-30 day waiting period. Schedule deletion via:
> ```bash
> aws kms schedule-key-deletion --key-id 610d8aaf-82da-4959-8e15-6694185ba6da --pending-window-in-days 7 --region us-west-2
> aws kms schedule-key-deletion --key-id 3509cf54-fd35-4207-9ee6-d403ffbbac9d --pending-window-in-days 7 --region us-west-2
> ```

### Cognito User Pool
| ID | Name |
|----|------|
| `us-west-2_F639KO3ZA` | `UserPool6BA7E5F2-U8ZExkMjX3ea` |

> ```bash
> aws cognito-idp delete-user-pool --user-pool-id us-west-2_F639KO3ZA --region us-west-2
> ```

### SSM Parameters (seeded manually during migration)
These will be overwritten by the new stacks on deploy, but can be cleaned up if deploy fails:
```bash
aws ssm delete-parameters --names \
  "/Beta/datamgmt/landing-bucket-name" \
  "/Beta/datamgmt/landing-bucket-arn" \
  "/Beta/datamgmt/ingestion-key-arn" \
  "/Beta/datamgmt/ingestion-queue-arn" \
  "/Beta/datamgmt/ingestion-queue-url" \
  "/Beta/datamgmt/processed-bucket-name" \
  "/Beta/datamgmt/processed-bucket-arn" \
  "/Beta/datamgmt/processing-key-arn" \
  "/Beta/datamgmt/document-table-name" \
  "/Beta/datamgmt/document-table-arn" \
  "/Beta/datamgmt/config-table-name" \
  "/Beta/datamgmt/config-table-arn" \
  --region us-west-2
```
