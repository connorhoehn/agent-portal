# Dependency advisory inventory — September 19, 2026

## Remediation result

The refreshed middleware, portal and infrastructure lockfiles contain 1,133
unique public npm package/version pairs. A second OSV querybatch scan returned
**zero affected pairs** after the updates below. Pagination was handled by the
scan; no response needed it. This includes the newly installed editor peers. The original inventory below is retained as a
before-change record: it found 25 affected pairs and 44 distinct advisories.

Source: [OSV API](https://google.github.io/osv.dev/post-v1-querybatch/).
The result covers public npm versions in these three lockfiles, not Python,
internal Git dependencies, container OS packages, or proof of exploitability.
npm's audit service returned HTTP 503 during the original scan.

Updates preserve the full internal Git commit pins. Install lifecycle scripts
were disabled and certificate verification stayed enabled. Patched direct
minimums are ws 8.21.3, React Router 7.18.4, Vite 7.3.6, Cognito Identity JS
6.3.20, tsx 4.23.13, and aws-cdk-lib 2.270.0. Compatible transitive updates
address the remaining Babel, parser, CSS, archive and build-tool advisories.

Three scoped overrides bridge upstream version constraints:

- `distributed-core` receives OpenTelemetry SDK/exporter 0.220.0 and automatic
  instrumentation 0.78.0 together. This keeps the telemetry packages on their
  matching 2.9.0 stable line while fixing core, Jaeger and Prometheus issues.
- `node-cron` receives uuid 11.1.1, which still provides CommonJS `v4()`—the
  only UUID API its installed source uses. Task creation/stop was exercised.
- `@smithy/middleware-compression` receives fflate 0.8.3 instead of its exact
  vulnerable 0.8.1 dependency. This is a patch within the same 0.8 release line.

Validation: portal production build and all 911 tests passed; infrastructure
build and all 195 tests passed; middleware typecheck passed. Dependency-tree
checks passed for portal and middleware production dependencies. OpenTelemetry
SDK, exporter and automatic instrumentation construction/shutdown passed.
The integrated middleware regression suite is recorded in the repository audit
report after all concurrent source fixes land. Vite retains its existing large
chunk warning. No live telemetry export or deployed Cognito login was exercised.

## Original inventory (before remediation)

Advisory severity below is the database rating, not an application-specific risk
score. Package versions and exposure notes describe the original lockfiles.

## Application exposure triage

- **Prioritize ws:** middleware directly opens a WebSocket server at `/ws` in
  `src/index.ts` using locked ws 8.20.0. This upgrade path bypasses Express
  authentication and origin middleware; the connection handler only swallows
  disconnect errors. The fragmentation memory-exhaustion advisory therefore
  merits priority, even though the stub does not process application messages.
  OSV lists 8.21.0 as the fix for that advisory. No exploit traffic was sent.
- **React Router:** portal uses client-side React routing. SSR hydration/RSC
  advisories require features whose use has not been established here; do not
  equate package presence with six remotely exploitable production defects.
  Client navigation handling still needs review.
- **Vite/esbuild:** several findings concern Windows development servers.
  This audit runs on macOS; deployment and other developers may differ.
- **aws-cdk-lib:** the reported issue involves NodejsFunction Docker bundling.
  No NodejsFunction use was found in infra/lib in this pass.
- **body-parser:** the middleware uses express.json() with its default limit;
  the invalid-limit configuration in the advisory was not observed.
- **Other transitives:** presence is confirmed by lockfiles. Reachability,
  safe compatible upgrade paths and internal-library dependency constraints
  still need checking. Dev flags below are npm lockfile metadata only.

## Locked packages

| Package/version | Projects | Lockfile scope | Advisories |
| --- | --- | --- | --- |
| @babel/core 7.29.0 | middleware, portal | dev only | [GHSA-4x5r-pxfx-6jf8](https://osv.dev/vulnerability/GHSA-4x5r-pxfx-6jf8) |
| @opentelemetry/auto-instrumentations-node 0.73.0 | middleware, portal | includes non-dev | [GHSA-q7rr-3cgh-j5r3](https://osv.dev/vulnerability/GHSA-q7rr-3cgh-j5r3) |
| @opentelemetry/core 2.7.0 | middleware, portal | includes non-dev | [GHSA-8988-4f7v-96qf](https://osv.dev/vulnerability/GHSA-8988-4f7v-96qf) |
| @opentelemetry/exporter-prometheus 0.215.0 | middleware, portal | includes non-dev | [GHSA-q7rr-3cgh-j5r3](https://osv.dev/vulnerability/GHSA-q7rr-3cgh-j5r3) |
| @opentelemetry/propagator-jaeger 2.7.0 | middleware, portal | includes non-dev | [GHSA-45rx-2jwx-cxfr](https://osv.dev/vulnerability/GHSA-45rx-2jwx-cxfr) |
| @opentelemetry/sdk-node 0.215.0 | middleware, portal | includes non-dev | [GHSA-q7rr-3cgh-j5r3](https://osv.dev/vulnerability/GHSA-q7rr-3cgh-j5r3) |
| aws-cdk-lib 2.253.1 | infra | includes non-dev | [GHSA-vcrf-j523-4mrf](https://osv.dev/vulnerability/GHSA-vcrf-j523-4mrf) |
| baseline-browser-mapping 2.10.28 | portal | dev only | [GHSA-w5vr-8v7q-w6rv](https://osv.dev/vulnerability/GHSA-w5vr-8v7q-w6rv) |
| baseline-browser-mapping 2.10.31 | middleware | dev only | [GHSA-w5vr-8v7q-w6rv](https://osv.dev/vulnerability/GHSA-w5vr-8v7q-w6rv) |
| body-parser 2.2.2 | middleware | includes non-dev | [GHSA-v422-hmwv-36x6](https://osv.dev/vulnerability/GHSA-v422-hmwv-36x6) |
| brace-expansion 1.1.14 | middleware | dev only | [GHSA-3jxr-9vmj-r5cp](https://osv.dev/vulnerability/GHSA-3jxr-9vmj-r5cp), [GHSA-mh99-v99m-4gvg](https://osv.dev/vulnerability/GHSA-mh99-v99m-4gvg), [GHSA-rgw5-rvv9-x895](https://osv.dev/vulnerability/GHSA-rgw5-rvv9-x895) |
| browserslist 4.28.2 | middleware, portal | dev only | [GHSA-73wf-gq98-2v4g](https://osv.dev/vulnerability/GHSA-73wf-gq98-2v4g), [GHSA-c83g-rgw3-j3cx](https://osv.dev/vulnerability/GHSA-c83g-rgw3-j3cx) |
| esbuild 0.27.7 | middleware, portal | dev only | [GHSA-g7r4-m6w7-qqqr](https://osv.dev/vulnerability/GHSA-g7r4-m6w7-qqqr) |
| fast-uri 3.1.2 | middleware | includes non-dev | [GHSA-4c8g-83qw-93j6](https://osv.dev/vulnerability/GHSA-4c8g-83qw-93j6), [GHSA-7p8r-x3mc-p8w7](https://osv.dev/vulnerability/GHSA-7p8r-x3mc-p8w7), [GHSA-f65p-4m7j-42xc](https://osv.dev/vulnerability/GHSA-f65p-4m7j-42xc), [GHSA-fph4-wmhf-6fwf](https://osv.dev/vulnerability/GHSA-fph4-wmhf-6fwf), [GHSA-jqff-g426-hqxp](https://osv.dev/vulnerability/GHSA-jqff-g426-hqxp), [GHSA-v2hh-gcrm-f6hx](https://osv.dev/vulnerability/GHSA-v2hh-gcrm-f6hx) |
| fflate 0.8.1 | middleware | includes non-dev | [GHSA-px8p-9vwx-vf98](https://osv.dev/vulnerability/GHSA-px8p-9vwx-vf98) |
| form-data 4.0.5 | middleware | dev only | [GHSA-hmw2-7cc7-3qxx](https://osv.dev/vulnerability/GHSA-hmw2-7cc7-3qxx) |
| js-cookie 2.2.1 | portal | includes non-dev | [GHSA-qjx8-664m-686j](https://osv.dev/vulnerability/GHSA-qjx8-664m-686j) |
| js-yaml 3.14.2 | middleware | dev only | [GHSA-2883-xcg3-v3hh](https://osv.dev/vulnerability/GHSA-2883-xcg3-v3hh), [GHSA-52cp-r559-cp3m](https://osv.dev/vulnerability/GHSA-52cp-r559-cp3m), [GHSA-5p4m-2wfm-xmqj](https://osv.dev/vulnerability/GHSA-5p4m-2wfm-xmqj), [GHSA-h67p-54hq-rp68](https://osv.dev/vulnerability/GHSA-h67p-54hq-rp68) |
| nanoid 3.3.12 | portal | dev only | [GHSA-28wg-ghj8-5hjv](https://osv.dev/vulnerability/GHSA-28wg-ghj8-5hjv), [GHSA-2v37-7h3g-55p8](https://osv.dev/vulnerability/GHSA-2v37-7h3g-55p8) |
| postcss 8.5.14 | portal | dev only | [GHSA-fxqj-rqcc-2cmp](https://osv.dev/vulnerability/GHSA-fxqj-rqcc-2cmp), [GHSA-r28c-9q8g-f849](https://osv.dev/vulnerability/GHSA-r28c-9q8g-f849) |
| qs 6.15.1 | middleware | includes non-dev | [GHSA-4mjr-xmp4-gh2g](https://osv.dev/vulnerability/GHSA-4mjr-xmp4-gh2g), [GHSA-q8mj-m7cp-5q26](https://osv.dev/vulnerability/GHSA-q8mj-m7cp-5q26), [GHSA-x5fp-wj9c-mxmx](https://osv.dev/vulnerability/GHSA-x5fp-wj9c-mxmx) |
| react-router 7.15.0 | portal | includes non-dev | [GHSA-337j-9hxr-rhxg](https://osv.dev/vulnerability/GHSA-337j-9hxr-rhxg), [GHSA-84g9-w2xq-vcv6](https://osv.dev/vulnerability/GHSA-84g9-w2xq-vcv6), [GHSA-chx6-hx7r-mcp5](https://osv.dev/vulnerability/GHSA-chx6-hx7r-mcp5), [GHSA-h8fp-f39c-q6mh](https://osv.dev/vulnerability/GHSA-h8fp-f39c-q6mh), [GHSA-qwww-vcr4-c8h2](https://osv.dev/vulnerability/GHSA-qwww-vcr4-c8h2), [GHSA-wrjc-x8rr-h8h6](https://osv.dev/vulnerability/GHSA-wrjc-x8rr-h8h6) |
| uuid 8.3.2 | middleware | includes non-dev | [GHSA-w5hq-g745-h8pq](https://osv.dev/vulnerability/GHSA-w5hq-g745-h8pq) |
| vite 7.3.3 | portal | dev only | [GHSA-fx2h-pf6j-xcff](https://osv.dev/vulnerability/GHSA-fx2h-pf6j-xcff), [GHSA-v6wh-96g9-6wx3](https://osv.dev/vulnerability/GHSA-v6wh-96g9-6wx3) |
| ws 8.20.0 | middleware | includes non-dev | [GHSA-58qx-3vcg-4xpx](https://osv.dev/vulnerability/GHSA-58qx-3vcg-4xpx), [GHSA-96hv-2xvq-fx4p](https://osv.dev/vulnerability/GHSA-96hv-2xvq-fx4p) |

## Advisory details

Fixed versions below are all branches reported by OSV. They are not a command
to jump major versions or a substitute for checking each affected range.

| Advisory | Severity | Summary | Reported fixed versions |
| --- | --- | --- | --- |
| [GHSA-2883-xcg3-v3hh](https://osv.dev/vulnerability/GHSA-2883-xcg3-v3hh) | HIGH | js-yaml: maxTotalMergeKeys does not limit CPU use for empty merge sources | 3.15.2, 4.3.2 |
| [GHSA-28wg-ghj8-5hjv](https://osv.dev/vulnerability/GHSA-28wg-ghj8-5hjv) | HIGH | nanoid: non-secure generators can loop indefinitely with negative size | 3.3.16, 5.1.16 |
| [GHSA-2v37-7h3g-55p8](https://osv.dev/vulnerability/GHSA-2v37-7h3g-55p8) | HIGH | nanoid: custom generators can loop indefinitely when size is zero | 3.3.18, 5.1.6 |
| [GHSA-337j-9hxr-rhxg](https://osv.dev/vulnerability/GHSA-337j-9hxr-rhxg) | MODERATE | React Router: Arbitrary Constructor Injection via deserializeErrors() in React Router SSR Hydration | 7.18.0 |
| [GHSA-3jxr-9vmj-r5cp](https://osv.dev/vulnerability/GHSA-3jxr-9vmj-r5cp) | HIGH | brace-expansion: DoS via exponential-time expansion of consecutive non-expanding {} groups | 1.1.16, 2.1.2, 5.0.7 |
| [GHSA-45rx-2jwx-cxfr](https://osv.dev/vulnerability/GHSA-45rx-2jwx-cxfr) | HIGH | OpenTelemetry JavaScript: Denial of service in `JaegerPropagator` via unhandled exception on a malformed header | 2.9.0 |
| [GHSA-4c8g-83qw-93j6](https://osv.dev/vulnerability/GHSA-4c8g-83qw-93j6) | HIGH | fast-uri vulnerable to host confusion via failed IDN canonicalization | 2.4.2, 3.1.3, 4.0.1 |
| [GHSA-4mjr-xmp4-gh2g](https://osv.dev/vulnerability/GHSA-4mjr-xmp4-gh2g) | MODERATE | qs: Denial of Service via Attacker Controlled isBuffer | 6.16.0 |
| [GHSA-4x5r-pxfx-6jf8](https://osv.dev/vulnerability/GHSA-4x5r-pxfx-6jf8) | LOW | @babel/core: Arbitrary File Read via sourceMappingURL Comment | 7.29.6, 8.0.0-rc.6 |
| [GHSA-52cp-r559-cp3m](https://osv.dev/vulnerability/GHSA-52cp-r559-cp3m) | HIGH | js-yaml: YAML merge-key chains can force quadratic CPU consumption | 3.15.0, 4.3.0 |
| [GHSA-58qx-3vcg-4xpx](https://osv.dev/vulnerability/GHSA-58qx-3vcg-4xpx) | MODERATE | ws: Uninitialized memory disclosure | 8.20.1 |
| [GHSA-5p4m-2wfm-xmqj](https://osv.dev/vulnerability/GHSA-5p4m-2wfm-xmqj) | HIGH | JS-YAML: Quadratic CPU consumption in !!omap resolution (3.x and 4.x) — CVE-2026-59870 fix not backported | 3.15.1, 4.3.1 |
| [GHSA-73wf-gq98-2v4g](https://osv.dev/vulnerability/GHSA-73wf-gq98-2v4g) | HIGH | Browserslist: Uncaught crash / prototype write via untrusted browserslist-stats.json custom stats (normalizeStats) | 4.28.7 |
| [GHSA-7p8r-x3mc-p8w7](https://osv.dev/vulnerability/GHSA-7p8r-x3mc-p8w7) | HIGH | fast-uri vulnerable to host confusion via backslash authority introducer | 2.4.4, 3.1.5, 4.1.2 |
| [GHSA-84g9-w2xq-vcv6](https://osv.dev/vulnerability/GHSA-84g9-w2xq-vcv6) | LOW | React Router: Potential CSRF via PUT/PATCH/DELETE document requests | 2.17.5, 7.15.1 |
| [GHSA-8988-4f7v-96qf](https://osv.dev/vulnerability/GHSA-8988-4f7v-96qf) | MODERATE | OpenTelemetry Core: Unbounded memory allocation in W3C Baggage propagation | 2.8.0 |
| [GHSA-96hv-2xvq-fx4p](https://osv.dev/vulnerability/GHSA-96hv-2xvq-fx4p) | HIGH | ws: Memory exhaustion DoS from tiny fragments and data chunks | 5.2.5, 6.2.4, 7.5.11, 8.21.0 |
| [GHSA-c83g-rgw3-j3cx](https://osv.dev/vulnerability/GHSA-c83g-rgw3-j3cx) | HIGH | Browserslist: Unbounded memory growth (no cache eviction) via distinct query results, leading to eventual OOM | 4.28.7 |
| [GHSA-chx6-hx7r-mcp5](https://osv.dev/vulnerability/GHSA-chx6-hx7r-mcp5) | HIGH | React Router: Unauthenticated Denial of Service via Inefficient Route Matching | 7.18.0 |
| [GHSA-f65p-4m7j-42xc](https://osv.dev/vulnerability/GHSA-f65p-4m7j-42xc) | HIGH | fast-uri vulnerable to server-side request forgery via malformed IPv6 normalization | 2.4.5, 3.1.6, 4.1.3 |
| [GHSA-fph4-wmhf-6fwf](https://osv.dev/vulnerability/GHSA-fph4-wmhf-6fwf) | HIGH | fast-uri vulnerable to server-side request forgery via repeated hostname percent-decoding | 2.4.5, 3.1.6, 4.1.3 |
| [GHSA-fx2h-pf6j-xcff](https://osv.dev/vulnerability/GHSA-fx2h-pf6j-xcff) | HIGH | vite: `server.fs.deny` bypass on Windows alternate paths | 0.1.24, 6.4.3, 7.3.5, 8.0.16 |
| [GHSA-fxqj-rqcc-2cmp](https://osv.dev/vulnerability/GHSA-fxqj-rqcc-2cmp) | MODERATE | PostCSS: incomplete fix of GHSA-6g55-p6wh-862q — attacker-controlled sourceMappingURL reads arbitrary .map files when `from` is unset | 8.5.23 |
| [GHSA-g7r4-m6w7-qqqr](https://osv.dev/vulnerability/GHSA-g7r4-m6w7-qqqr) | LOW | esbuild allows arbitrary file read when running the development server on Windows | 0.28.1 |
| [GHSA-h67p-54hq-rp68](https://osv.dev/vulnerability/GHSA-h67p-54hq-rp68) | MODERATE | JS-YAML: Quadratic-complexity DoS in merge key handling via repeated aliases | 3.15.0, 4.2.0 |
| [GHSA-h8fp-f39c-q6mh](https://osv.dev/vulnerability/GHSA-h8fp-f39c-q6mh) | MODERATE | React Router: RSCErrorHandler Missing Protocol Validation (XSS) | 7.18.0 |
| [GHSA-hmw2-7cc7-3qxx](https://osv.dev/vulnerability/GHSA-hmw2-7cc7-3qxx) | HIGH | form-data: CRLF injection in form-data via unescaped multipart field names and filenames | 2.5.6, 3.0.5, 4.0.6 |
| [GHSA-jqff-g426-hqxp](https://osv.dev/vulnerability/GHSA-jqff-g426-hqxp) | HIGH | fast-uri vulnerable to host confusion via percent-encoded scheme normalization | 2.4.5, 3.1.6, 4.1.3 |
| [GHSA-mh99-v99m-4gvg](https://osv.dev/vulnerability/GHSA-mh99-v99m-4gvg) | HIGH | brace-expansion: DoS via unbounded expansion length causing an out-of-memory process crash | 1.1.17, 2.1.3, 3.0.3, 5.0.8 |
| [GHSA-px8p-9vwx-vf98](https://osv.dev/vulnerability/GHSA-px8p-9vwx-vf98) | MODERATE | fflate unzipSync can enter an infinite loop when parsing malformed ZIP64 archives | 0.4.9, 0.5.4, 0.6.11, 0.7.5, 0.8.3 |
| [GHSA-q7rr-3cgh-j5r3](https://osv.dev/vulnerability/GHSA-q7rr-3cgh-j5r3) | HIGH | Prometheus exporter process crash via malformed HTTP request | 0.217.0, 0.75.0 |
| [GHSA-q8mj-m7cp-5q26](https://osv.dev/vulnerability/GHSA-q8mj-m7cp-5q26) | MODERATE | qs has a remotely triggerable DoS: qs.stringify crashes with TypeError on null/undefined entries in comma-format arrays when encodeValuesOnly is set | 6.15.2 |
| [GHSA-qjx8-664m-686j](https://osv.dev/vulnerability/GHSA-qjx8-664m-686j) | HIGH | JavaScript Cookie: Per-instance prototype hijack in assign() enables cookie-attribute injection | 3.0.7 |
| [GHSA-qwww-vcr4-c8h2](https://osv.dev/vulnerability/GHSA-qwww-vcr4-c8h2) | HIGH | React Router: RSC Mode CSRF Bypass Allows Action Execution Before 400 Response | 7.18.2, 8.3.0 |
| [GHSA-r28c-9q8g-f849](https://osv.dev/vulnerability/GHSA-r28c-9q8g-f849) | HIGH | PostCSS: Path Traversal in Previous Source Map Auto-Loading (sourceMappingURL) leads to Arbitrary .map File Disclosure | 8.5.18 |
| [GHSA-rgw5-rvv9-x895](https://osv.dev/vulnerability/GHSA-rgw5-rvv9-x895) | HIGH | brace-expansion: DoS via unbounded intermediate arrays, bypassing the CVE-2026-14257 mitigation | 1.1.18, 2.1.4, 3.0.6, 5.0.9 |
| [GHSA-v2hh-gcrm-f6hx](https://osv.dev/vulnerability/GHSA-v2hh-gcrm-f6hx) | HIGH | fast-uri vulnerable to host confusion via literal backslash authority delimiter | 2.4.3, 3.1.4, 4.1.1 |
| [GHSA-v422-hmwv-36x6](https://osv.dev/vulnerability/GHSA-v422-hmwv-36x6) | LOW | body-parser vulnerable to denial of service when invalid limit value silently disables size enforcement | 1.20.6, 2.3.0 |
| [GHSA-v6wh-96g9-6wx3](https://osv.dev/vulnerability/GHSA-v6wh-96g9-6wx3) | MODERATE | launch-editor: NTLMv2 hash disclosure via UNC path handling on Windows | 0.1.24, 2.14.1, 6.4.3, 7.3.5, 8.0.16 |
| [GHSA-vcrf-j523-4mrf](https://osv.dev/vulnerability/GHSA-vcrf-j523-4mrf) | HIGH | aws-cdk-lib: OS Command Injection in NodejsFunction Docker Bundling | 2.260.0 |
| [GHSA-w5hq-g745-h8pq](https://osv.dev/vulnerability/GHSA-w5hq-g745-h8pq) | MODERATE | uuid: Missing buffer bounds check in v3/v5/v6 when buf is provided | 11.1.1, 12.0.1, 13.0.1 |
| [GHSA-w5vr-8v7q-w6rv](https://osv.dev/vulnerability/GHSA-w5vr-8v7q-w6rv) | MODERATE | baseline-browser-mapping process termination on invalid input causes denial of service | 2.11.0 |
| [GHSA-wrjc-x8rr-h8h6](https://osv.dev/vulnerability/GHSA-wrjc-x8rr-h8h6) | MODERATE | React Router: Open redirect via backslash in <Link> and useNavigate (CVE-2025-68470 bypass) | 7.18.0 |
| [GHSA-x5fp-wj9c-mxmx](https://osv.dev/vulnerability/GHSA-x5fp-wj9c-mxmx) | MODERATE | qs array-limit bypass via bracket-key comma parsing | 6.16.0 |
