# DE-23 Allowlists that follow people

Status: spec, 2026-10-27. Backlog: `docs/deployment-enhancements-2026-10-27.md`.
Depends on DE-22's probe, which decides whether TURN can face the internet.
Proven by DE-21's call tier.

## Current state (read from the code, 2026-10-27)

**Two of the three lists are literal CIDRs that deploy.sh copies forward.**
`albAllowCidr` (`infra/lib/middleware-service-stack.ts:1193-1206`, output
`MiddlewareAllowedCidrs` `:1218-1221`) and `sfuAllowCidr`
(`infra/lib/social-media-stack.ts:238-250`, output `SfuAllowedCidrs`
`:558-561`) are comma lists. The sticky inference in deploy.sh reads each one
back from its output and passes it again whenever the caller did not pass the
key (`infra/scripts/deploy.sh:377-381,391-392,420-421`). When the operator's
IP changed overnight, the old /32 kept coming back. Passing a new value
replaces the whole list, so the operator has to remember everyone else's
address. Nothing anywhere looks up the caller's current IP.

**The backlog line is partly stale: the ALB list no longer gates
participants.** With `deployPortal`, the listener's default action is a 403,
and a request is forwarded if it carries CloudFront's origin-verify header
*or* comes from an allowlisted IP (`middleware-service-stack.ts:1288-1310`).
The portal, `/api`, `/ws`, `/document-realtime`, platform-api and SFU
signalling all arrive through CloudFront, so anyone can load the app and join
signalling. `albAllowCidr` now only governs *direct* ALB access (operator
debugging, a load generator, `scripts/loadtest/README.md:416`). Three
statements are out of date:

- the synth warning "will accept no traffic" fires even when CloudFront
  admits everyone (`middleware-service-stack.ts:1209-1216`);
- the SFU header's "cannot load the portal either… put both participants'
  public IPs in BOTH lists" (`social-media-stack.ts:122-124`);
- the same advice in `docs/social-calls-deploy-plan.md:317-323`.

The only per-participant gate left is SFU **media**: UDP 40000-40001 and TCP
40010-40011 from `sfuAllowCidr` (`social-media-stack.ts:244-250`).

**TURN is built but off, and it is allowlisted too.** `deployTurn=true`
(`:361`) adds coturn on its own `t4g.small` with an Elastic IP (`:578-733`).
Plain TURN listens on 3478 UDP/TCP, plain TURN-over-TCP on 443 unless a
domain and certificate are given (`:588-597`), and relay ports 49152-49651
are open from the SFU's EIP only (`:637-639`). The SFU then admits the TURN
EIP on its media ports (`:375-376`), so relayed participants do not need to
be in `sfuAllowCidr`. **But TURN's own group admits only `turnAllowCidr`**
(`:621-631`). "Admit participants through TURN instead of per-IP" holds only
if `turnAllowCidr=0.0.0.0/0` on 443/3478 survives the custodian. The code
calls this "the same custodian question, moved to one port"
(`:601-604`, deploy plan `:1006-1007`), and DE-22 is what answers it.

Gaps if TURN were turned on today:

- deploy.sh infers neither `deployTurn` nor `turnAllowCidr`
  (`deploy.sh:414-423` covers only the SFU's keys), so the next deploy without
  the flags would delete the TURN host, its secret and its EIP.
- The client asks `<videoUrl>/api/ice-servers` and falls back to Google STUN
  (realtime-modules 0.140.0 `dist/client/video/lib/transport.js:261-273`). It
  builds `new RTCPeerConnection({ iceServers })` with no
  `iceTransportPolicy` (`useLVSHangout.js:714-723`). Relay is therefore a
  fallback reached after the direct candidates time out against the SFU's
  group, never a forced path. There is also no test that a relayed call
  works.

## Change

1. **One allowlist, kept in SSM, with owner and expiry.**
   `/${PREFIX}/allowlist` holds JSON
   `[{cidr, who, scope: "alb"|"sfu"|"turn", expires}]`. Addresses are personal
   data, so they never go in the repo. A small CLI,
   `infra/scripts/allowlist.sh add <cidr> --who <name> --scope sfu --days 3 | list | rm <cidr>`,
   edits it. deploy.sh builds `albAllowCidr`, `sfuAllowCidr` and
   `turnAllowCidr` from the unexpired entries when the caller did not pass
   them. That replaces the read-back from stack outputs for these three keys,
   and deploy.sh prints the add/drop diff against the live outputs before it
   deploys. The list is capped at 25 CIDRs per scope: the SFU spends two rules
   per CIDR against the 60-rule SG quota, and the ALB takes five source IPs
   per listener rule (`middleware-service-stack.ts:1302-1309`).
2. **The operator follows themselves.** Unless `DEPLOY_OPERATOR_IP=off`,
   deploy.sh runs `curl -fsS --max-time 5 https://checkip.amazonaws.com`,
   checks that the answer is an IPv4 address, and upserts
   `{cidr: <ip>/32, who: operator:<sts caller arn>, scope: alb+sfu, expires: +7d}`.
   It replaces that caller's previous entry rather than appending one. If the
   lookup fails, the deploy warns and goes on.
3. **Participants come in through TURN** once DE-22's probe shows
   443/3478 open survives. Then the deploy runs with `deployTurn=true` and
   `turnAllowCidr=0.0.0.0/0`, and `sfuAllowCidr` shrinks to operator entries.
   If the probe shows revocation, `turn`-scope entries are used instead (still
   per-IP, but on one group), and the exception request in DE-22 decides the
   rest.
4. **Sticky TURN.** deploy.sh infers `deployTurn` when `OrgIQ-SocialMedia`
   has the `TurnPublicIp` output, and passes `turnTlsDomain` and
   `turnTlsCertSecretName` back from new outputs, the same way it handles
   `sfuImageDigest`.
5. **Fix the stale claims.** Warn on an empty `albAllowCidr` only when
   CloudFront is not in front. Rewrite `social-media-stack.ts:122-124` and the
   deploy-plan paragraph to say that participants need only media admission.
6. **Prove relay.** `cloud-call-smoke.spec.ts` already wraps
   `RTCPeerConnection` (`:19-23`). With `CLOUD_FORCE_RELAY=1` the wrapper sets
   `iceTransportPolicy: 'relay'` on the constructor's config, and the test
   asserts that the selected candidate pair's local candidate has
   `candidateType === 'relay'` before it checks audio. This is a test-only
   change; forcing relay in the product is an upstream realtime-modules
   change and is not needed here.

## Decisions owed

- **Open TURN to the internet** on 443/3478 if the probe says it survives.
  Proposal: yes. TURN uses `use-auth-secret` short-lived credentials and
  denies private peers (`social-media-stack.ts:661-676`). Keep the SFU on
  operator-only.
- **TURN over TLS** needs a DNS name and a certificate. Neither exists on the
  CloudFront-only path. Proposal: accept plain TURN on 443 for now. It passes
  port filters but not TLS-inspecting proxies.
- **Who may add an allowlist entry, and the default expiry.** Proposal: the
  deploy operator only, 7 days for the operator and 3 days for participants.
- **Cost.** TURN adds a `t4g.small` plus an EIP, about $15 a month. Should
  DE-26's idle schedule stop it? Proposal: yes, together with the SFU.

## Done when

- `infra/test/deploy-config.test.ts` asserts that deploy.sh:
  - reads `/${PREFIX}/allowlist`, drops expired entries, and upserts the
    operator's `/32` unless `DEPLOY_OPERATOR_IP=off`;
  - infers `deployTurn` from `TurnPublicIp`;
  - lets a caller-passed `sfuAllowCidr` still win.
- A unit test of the allowlist merge: an expired entry is dropped; an
  operator's second IP replaces the first; scope `sfu` never reaches
  `albAllowCidr`; a 26th CIDR in one scope is refused.
- `infra/test/social-stacks.test.ts` adds two synth cases. With
  `deployTurn=true`, the SFU group holds the TURN-EIP media rules and synth
  emits no "accepts no media" warning for an operator-only `sfuAllowCidr`.
  With `deployPortal=true` and no `albAllowCidr`, synth emits no "accept no
  traffic" warning.
- Live: after an IP change, a bare `./scripts/deploy.sh OrgIQ-MiddlewareService`
  shows the new `/32` in `MiddlewareAllowedCidrs` and the old one gone, with
  no hand-passed context.
- Live, with TURN on: `CLOUD_FORCE_RELAY=1` `cloud-call-smoke` passes, with
  both browsers outside `sfuAllowCidr` and the relay assertion green.
