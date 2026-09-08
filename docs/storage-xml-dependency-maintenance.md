# Storage XML dependency maintenance

The pinned AWS S3 packages remain at 3.883.0. That release's `@aws-sdk/core`
pins fast-xml-parser 5.2.5, which is affected by the maintainer's critical
[DOCTYPE entity-name escaping advisory](https://github.com/NaturalIntelligence/fast-xml-parser/security/advisories/GHSA-m7jm-9gc2-mpf2)
and subsequent parser advisories, including
[entity expansion limit handling](https://github.com/NaturalIntelligence/fast-xml-parser/security/advisories/GHSA-8r6m-32jq-jx6q).

The application now overrides **only** `@aws-sdk/core@3.883.0`'s parser to
fast-xml-parser **5.11.1**, a patched release in the same major version. The
parser's required dependencies are locked alongside it. No unrelated package
versions, S3 endpoints, credential handling, media metadata or application code
are changed. This is a deliberate tested override of the older SDK's exact
parser pin, rather than a claim that AWS has changed that old release. Remove
or reassess the override when the three S3 SDK packages are upgraded together.

## Offline validation

`test/content-r2-sdk-xml.test.js` runs the installed SDK XML parser and the actual
application R2 helpers with synthetic credentials and a request handler that
cannot send HTTP traffic. It exercises multipart create/list/complete parsing,
repeated XML nodes, namespaces, opaque IDs with leading zeros, built-in and
numeric entities, malformed XML rejection, escaped service-error messages,
upload checksum compatibility, ranged binary GET, and private presigned URLs.
The benign entity-name shadowing regression uses the actual AWS parser path.
Neither storage object contents nor provider credentials are needed.

```sh
node --test test/content-r2-sdk-xml.test.js test/content-media-r2.test.js
npm ci --ignore-scripts --no-audit --no-fund
npm audit --omit=dev
```

The focused suite passes 24 tests. The local runtime was Node 24.19.0; the
deployment runtime was independently confirmed as Node 24.14.1.

The official npm audit on September 8, 2026 reports **24 vulnerable nodes before**
(one critical, 23 moderate) and **six moderate nodes after**, with zero critical
or high findings. Remaining findings concern qs/Express/body-parser, stream-json,
and uuid/the S3 dependent node. They predate this change and require separate
compatibility work; this patch does not claim an entirely clean dependency tree.
The before/after audit files are retained in the private release evidence.

The bounded review found the parser reachable through configured storage service
responses. It did not demonstrate a public XML-to-unsafe-rendering exploit or a
breach. No live storage request or real-object mutation is part of this change's
validation.
