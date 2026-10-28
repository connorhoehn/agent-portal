# DE-22 Custodian preflight

Status: spec, 2026-10-27. Backlog: `docs/deployment-enhancements-2026-10-27.md`.
Runs inside DE-21's infra tier. Its probe answers the custodian question that
DE-23's TURN option depends on.

## Current state (read from the code, 2026-10-27)

**What was observed.** `custodian-restrict-security-group-admin-ingress`
revoked `0.0.0.0/0:80` on the middleware ALB six seconds after
CloudFormation added it, with no stack event and no drift
(`infra/lib/middleware-service-stack.ts:1121-1136`,
`infra/lib/social-media-stack.ts:113-118`). Every stack therefore uses
explicit ingress lists, and synth warns on an empty or open list
(`middleware-service-stack.ts:1209-1216`, `social-media-stack.ts:251-263`,
`:629-636`).

**What was inferred, not watched.** The claim that the custodian "strips
bucket policies" rests on the stock `autoDeleteObjects` grant being gone at
teardown (`infra/lib/foundation-stack.ts:79-93`). No one saw it happen. The
fix that came out of it (an emptier Lambda with an identity-based role,
`foundation-stack.ts:96-100,233-247`, reused by `portal-stack.ts:141-155`)
means teardown no longer needs any bucket policy.

**What is still open.**

- 0.0.0.0/0 on UDP or high TCP ports has never been measured: the SFU comment
  still says "unmeasured" (`social-media-stack.ts:117`). The phase-0 probe in
  `docs/social-calls-deploy-plan.md:317-319` is an operator step with no
  script and no recorded result.
- The CloudFront prefix-list rule (`middleware-service-stack.ts:1267-1276`)
  and the portal's OAC bucket policy (`portal-stack.ts:117-129`) are both
  marked "unverified" in code. Both specs passed through CloudFront at
  `ad97de16` (open-items doc), so both had survived *at that time*. Whether
  the custodian comes back on a schedule is unknown.
- /32 rules on the SFU's high ports survived: the call spec got audio from the
  one allowlisted address.

**CIDR and prefix-list rules a deploy creates** (the only kind the custodian
is known to act on; SG-to-SG rules such as `social-stack.ts:288,579-583,663,691`
and `aurora-stack.ts:89` are out of scope):

| Rule | Source | Code |
|---|---|---|
| ALB listener port from each `albAllowCidr` | middleware ALB SG | `middleware-service-stack.ts:1193-1206` |
| ALB listener port from the CloudFront prefix list | `CloudFrontOriginSecurityGroup` | `:1267-1276` |
| SFU UDP/TCP media from each `sfuAllowCidr` | `${prefix}-social-sfu` | `social-media-stack.ts:244-250` |
| SFU media from the TURN EIP | same | `:375-376` |
| TURN 3478/443 from each `turnAllowCidr`; relay ports from the SFU EIP | `${prefix}-social-turn` | `:621-639` |

**What checks exist today.** `portal-publish.mjs` checks the OAC statement on
every publish and puts it back only with `--repair-bucket-policy`
(`scripts/portal-publish.mjs:203-218`, helper `policyAdmitsDistribution`
at `:114`). No security-group rule is checked anywhere. The
`CloudFrontPrefixListId` output just tells a human to check
(`middleware-service-stack.ts:1316-1319`). deploy.sh trusts `*_COMPLETE`
(`infra/scripts/deploy.sh:694-728`).

One trap the check must handle: CloudFormation does not know that a rule was
revoked, so a redeploy with an unchanged template leaves the rule missing.
Rerunning `deploy.sh` does not repair it.

## Change

**`infra/scripts/custodian-check.mjs`** (Node, no dependencies, calls the
AWS CLI through `execFile` the way `portal-publish.mjs` does):

1. **Expected rules come from the deployed templates**, not a hand list.
   For each live stack in the table above, it runs `aws cloudformation
   get-template --stack-name <s> --template-stage Processed`. From the
   template it collects inline `SecurityGroupIngress` entries and
   `AWS::EC2::SecurityGroupIngress` resources that carry `CidrIp`,
   `CidrIpv6` or `SourcePrefixListId`. It resolves each `Ref`/`GetAtt`
   through `describe-stack-resources`: the group id, and the EIP, whose
   physical id is its address. The prefix-list id comes from the
   `CloudFrontPrefixListId` output.
2. **Live rules** come from `aws ec2 describe-security-groups --group-ids …`.
   Match on (group, protocol, from, to, cidr or prefix list).
3. **Two reads**: one right after the deploy and one after a bounded dwell
   (`CUSTODIAN_DWELL_S`, default 90; the observed revocation took 6 s). A rule
   present at the first read and gone at the second is reported as "revoked
   after deploy". That is the custodian's fingerprint, and it is different
   from a rule that was never created.
4. **The OAC policy**: `get-bucket-policy` on `PortalBucketName`, judged by
   `policyAdmitsDistribution` (imported from `portal-publish.mjs`, so the
   rule lives in one place).
5. **Output**: one line per rule, plus a ready-to-run restore command for each
   missing one (`aws ec2 authorize-security-group-ingress …` or
   `node scripts/portal-publish.mjs --repair-bucket-policy`). The script
   reports and never repairs: putting an open rule back loses the same race
   (`middleware-service-stack.ts:1130-1132`). Exit 0 if every rule survived,
   3 if one is missing.

**`--probe` (the phase-0 measurement, before a deploy that needs an open
range).** It creates an unattached throwaway SG `${PREFIX}-custodian-probe` in
the middleware VPC. The SG carries the rules the coming deploy wants:
`0.0.0.0/0` on UDP 40000 and TCP 40010 (SFU), 443/3478 (TURN), and a /32 on
TCP 80 as the control. The script reads the SG after 60 s and after 300 s,
then deletes it in a `finally` block. The result goes to SSM
`/${PREFIX}/custodian/probe` (JSON: ports, survived or revoked, revoke
latency, date), and DE-23 reads it to decide whether TURN can be opened.

**Wiring.** DE-21's tier 1 runs it without `--probe`. Separately, `deploy.sh`
warns before deploying when the context asks for an open range
(`sfuAllowCidr` or `turnAllowCidr` containing `0.0.0.0/0`) and the probe
record is missing or more than 30 days old.

## Decisions owed

- **Running the probe in the shared account.** It authorizes `0.0.0.0/0` on
  an SG with no ENIs for up to 5 minutes, which may alert the account owner.
  Proposal: allow it only behind `--probe` with a confirmation prompt, and
  tell the account owner first.
- **Asking for an exception instead.** A scoped custodian exception tagged to
  the SFU and TURN groups would make the probe's answer irrelevant. Proposal:
  run the probe once; ask for the exception only if TURN on 443 is revoked.
- **Scheduled re-checks.** If the custodian also runs on a schedule, a rule
  can disappear days after a green gate. Proposal: defer this to DE-50
  (alerts). This spec checks at deploy time only.

## Done when

- A unit test (`node --test`, fixtures under `infra/test/fixtures/custodian/`)
  feeds a processed template and two `describe-security-groups` reads:
  - a missing `albAllowCidr` rule fails with its group, port and CIDR;
  - a rule present at read 1 and absent at read 2 is labelled "revoked after
    deploy";
  - a prefix-list rule is matched by list id;
  - the TURN EIP `GetAtt` resolves to its address;
  - every missing rule prints its restore command.
- A unit test shows a policy without the distribution's `AWS:SourceArn`
  statement fails, using the same helper `portal-publish.mjs` uses.
- `infra/test/deploy-config.test.ts` asserts that deploy.sh warns on an open
  `sfuAllowCidr`/`turnAllowCidr` when there is no fresh probe record.
- Live: `node infra/scripts/custodian-check.mjs` exits 0 against the deployed
  stack. After `aws ec2 revoke-security-group-ingress` on the operator's ALB
  rule it exits 3 and names that rule, and running the printed restore
  command brings it back to 0.
- Live, after the decision: `--probe` writes `/orgiq/custodian/probe` and
  leaves no `orgiq-custodian-probe` group behind
  (`aws ec2 describe-security-groups --filters Name=group-name,Values=orgiq-custodian-probe`
  returns none).
