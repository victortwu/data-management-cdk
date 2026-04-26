#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { DataManagementCdkStack } from '../lib/data-management-cdk-stack';

const app = new cdk.App();
new DataManagementCdkStack(app, 'DataManagementCdkStack');
