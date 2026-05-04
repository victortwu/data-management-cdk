import { Stack, Fn } from "aws-cdk-lib";

/**
 * Extracts a unique suffix from the CDK stack ID for resource naming.
 * 
 * Parses the stack ID (format: arn:aws:cloudformation:region:account:stack/name/id)
 * and extracts the 5th segment from the stack name portion to use as a suffix
 * for creating unique resource names across deployments.
 * 
 * @param stack - The CDK Stack instance
 * @returns CloudFormation intrinsic function that resolves to the suffix string
 */
export const getSuffixFromStack = (stack: Stack) => {
  const shortStackId = Fn.select(2, Fn.split("/", stack.stackId));

  return Fn.select(4, Fn.split("-", shortStackId));
};
