import { createHash } from 'node:crypto';
import { copyFileSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';

// Bundle the canonical guard with the tools: the Lambda must run the same
// security boundary tested by the agents, not a separately maintained copy.
export function gatewayToolCode(): lambda.Code {
  const source = resolve('lambda/gateway-tools');
  const guard = resolve('../agents/_shared/sql_guard.py');
  const files = readdirSync(source).filter(name => name.endsWith('.py')).sort();
  const digest = createHash('sha256').update(readFileSync(guard));
  for (const name of files) digest.update(name).update(readFileSync(join(source, name)));
  return lambda.Code.fromAsset(source, {
    assetHash: digest.digest('hex'),
    assetHashType: cdk.AssetHashType.CUSTOM,
    bundling: {
      image: lambda.Runtime.PYTHON_3_12.bundlingImage,
      local: {
        tryBundle(outputDir: string): boolean {
          for (const name of files) copyFileSync(join(source, name), join(outputDir, name));
          copyFileSync(guard, join(outputDir, 'sql_guard.py'));
          return true;
        },
      },
    },
  });
}
