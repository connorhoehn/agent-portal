# Crawl network policy

Survey HTML, robots.txt, and HTTP crawl requests use `public-web-fetch.ts`.
Only HTTP(S), ports 80/443, and URLs without embedded credentials are accepted.
The resolver rejects the entire answer set when any address is non-public;
this includes loopback, private, link-local/metadata, shared address space,
multicast, documentation, IPv4-mapped IPv6, and IPv6 transition ranges.
Each connection uses the validated address through a pinned lookup callback,
with the original Host header and HTTPS certificate hostname. There is no
second DNS lookup between validation and connection and no shared socket pool.
Each redirect repeats validation, including DNS, up to five redirects. One
abort deadline covers the HTTP redirect chain and body, capped at 2 MiB.
Compressed responses are rejected, avoiding unbounded decompression. No
intranet override exists: use a purpose-built authenticated connector for
private content instead of exposing the middleware's network to crawl input.

Browser crawl and survey fallback preserve the managed browser feature. Before
creating a real session, `public-browser.ts` calls GetBrowser for the configured
BROWSER_ID and requires its actual network mode to be PUBLIC. Missing IDs,
control-plane errors (including missing GetBrowser IAM permission), unknown
modes and VPC browsers fail closed. Initial and explicitly navigated URLs are
also checked for public destinations. Fetch crawls do not create browser
sessions. The explicitly mocked provider skips the AWS lookup because it makes
no browser requests.

This browser boundary relies on AWS's managed PUBLIC network isolation; URL
prevalidation alone cannot stop browser redirects, DNS rebinding, subresources,
or JavaScript requests. AWS describes PUBLIC mode as accessing public internet
resources, and describes VPC mode as the mechanism for accessing a customer's
private resources. Our CDK Browser uses PUBLIC. See [browser network settings](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/browser-resource-session-management.html)
and [VPC connectivity](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-vpc.html).
This does not claim arbitrary browser requests are intercepted here or that
sandbox-local resources are inaccessible. PUBLIC mode is the boundary against
reaching the middleware/customer VPC, not a substitute for browser sandbox
security. Browser profile credentials remain subject to the existing Browser
permission model. A future private-browser deployment needs explicit network
egress enforcement rather than bypassing this check; AWS distinguishes proxy
flags from network-layer policy in its [proxy security guidance](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/browser-proxies.html).

Regression tests exercise alternate numeric loopback spellings, IPv6 special
ranges, mixed DNS answers, pinned lookup, redirect-to-metadata, DNS rebinding
between redirects, redirect bounds, configured browser ID, and fail-closed
browser mode lookup. AWS live isolation is documented service behavior, not a
claim of an integration test performed during the repository audit.
