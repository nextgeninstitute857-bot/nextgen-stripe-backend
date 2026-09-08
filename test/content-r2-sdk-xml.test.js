import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Readable } from "node:stream";
import { createRequire } from "node:module";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { parseXmlBody } from "@aws-sdk/core/protocols";

// This file runs in its own test process. It never reads host credentials, calls
// real storage, or enables metadata credential discovery. Unexpected HTTP fails.
Object.assign(process.env, {
  CLOUDFLARE_R2_ACCOUNT_ID: "synthetic-account",
  CLOUDFLARE_R2_ACCESS_KEY_ID: "synthetic-access-key",
  CLOUDFLARE_R2_SECRET_ACCESS_KEY: "synthetic-secret-key",
  CLOUDFLARE_R2_BUCKET: "synthetic-bucket",
  CLOUDFLARE_R2_ENDPOINT: "https://synthetic-account.r2.invalid",
  CLOUDFLARE_R2_REGION: "auto",
});
const originalHandle = NodeHttpHandler.prototype.handle;
NodeHttpHandler.prototype.handle = () => { throw new Error("Network is forbidden in the offline R2 SDK test"); };
const r2 = await import("../lib/content-r2-storage.js");
const client = r2.getContentR2Client();
const responses = [];
const requests = [];
client.config.requestHandler = {
  metadata: { handlerProtocol: "http/1.1" },
  async handle(request) {
    const expected = responses.shift();
    assert.ok(expected, "Unexpected storage request");
    assert.match(request.hostname, /\.r2\.invalid$/);
    assert.match(request.headers.authorization, /^AWS4-HMAC-SHA256 Credential=synthetic-access-key\//);
    assert.equal(request.method, expected.method);
    if (expected.check) await expected.check(request);
    requests.push(request);
    return { response: { statusCode: expected.status || 200, headers: {
      "content-type": "application/xml", "x-amz-request-id": "synthetic-request", ...(expected.headers || {}),
    }, body: Readable.from([Buffer.from(expected.body || "")]) } };
  },
  destroy() {},
};
after(() => {
  assert.equal(responses.length, 0, "All expected synthetic requests were consumed");
  client.destroy();
  NodeHttpHandler.prototype.handle = originalHandle;
});
const parse = xml => parseXmlBody(Buffer.from(xml), { streamCollector: async body => body,
  utf8Encoder: bytes => Buffer.from(bytes).toString("utf8") });

test("the installed AWS core resolves the patched parser without updating the SDK", () => {
  const requireFromCore = createRequire(import.meta.resolve("@aws-sdk/core"));
  const resolved = requireFromCore.resolve("fast-xml-parser");
  const parserPackage = JSON.parse(fs.readFileSync(new URL("../node_modules/fast-xml-parser/package.json", import.meta.url), "utf8"));
  assert.equal(parserPackage.version, "5.11.1");
  assert.match(resolved.replaceAll("\\", "/"), /\/node_modules\/fast-xml-parser\//);
  assert.equal(requireFromCore("@aws-sdk/core/package.json").version, "3.883.0");
});

test("actual SDK XML parsing preserves repeated nodes, namespaces, whitespace, entities and opaque IDs", async () => {
  const result = await parse('<ListPartsResult xmlns="urn:synthetic"><UploadId>000123</UploadId><Part><PartNumber>1</PartNumber><ETag>&quot;a&amp;b&quot;</ETag></Part><Part><PartNumber>2</PartNumber><ETag>β&#xD;&#10;</ETag></Part></ListPartsResult>');
  assert.equal(result.UploadId, "000123");
  assert.equal(result.Part.length, 2);
  assert.equal(result.Part[0].ETag, '"a&b"');
  assert.equal(result.Part[1].ETag, "β\r\n");
  await assert.rejects(parse('<Result><Broken></Result>'));
});

test("the maintainer's entity-name shadowing case cannot substitute a built-in XML entity", async () => {
  const xml = '<!DOCTYPE Error [<!ENTITY am. "SYNTHETIC_SHADOW">]><Error><Code>AccessDenied</Code><Message>O&amp;Brien</Message></Error>';
  const result = await parse(xml);
  assert.equal(result.Message, "O&Brien");
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_SHADOW/);
});

test("actual R2 multipart helpers parse create/list/complete XML and retain request serialization", async () => {
  responses.push({ method: "POST", body: '<InitiateMultipartUploadResult><UploadId>000123</UploadId></InitiateMultipartUploadResult>',
    check: request => assert.ok(Object.hasOwn(request.query, "uploads")) });
  assert.deepEqual(await r2.createContentR2Multipart({ objectKey: "synthetic/archive.zip" }), { uploadId: "000123", objectKey: "synthetic/archive.zip" });
  responses.push({ method: "GET", body: '<ListPartsResult><IsTruncated>true</IsTruncated><NextPartNumberMarker>2</NextPartNumberMarker><Part><PartNumber>2</PartNumber><ETag>&quot;b&quot;</ETag><Size>5</Size></Part><Part><PartNumber>1</PartNumber><ETag>&quot;a&quot;</ETag><Size>5</Size></Part></ListPartsResult>' });
  responses.push({ method: "GET", body: '<ListPartsResult><IsTruncated>false</IsTruncated><Part><PartNumber>3</PartNumber><ETag>&quot;c&quot;</ETag><Size>3</Size></Part></ListPartsResult>',
    check: request => assert.equal(request.query["part-number-marker"], "2") });
  const parts = await r2.listContentR2Parts({ objectKey: "synthetic/archive.zip", uploadId: "000123" });
  assert.deepEqual(parts, [{ PartNumber: 1, ETag: '"a"', Size: 5 }, { PartNumber: 2, ETag: '"b"', Size: 5 }, { PartNumber: 3, ETag: '"c"', Size: 3 }]);
  responses.push({ method: "POST", body: '<CompleteMultipartUploadResult><ETag>&quot;complete&quot;</ETag></CompleteMultipartUploadResult>',
    check: request => { assert.match(request.body, /<PartNumber>1<\/PartNumber>/); assert.match(request.body, /<ETag>(&quot;|")a(&quot;|")<\/ETag>/); } });
  responses.push({ method: "HEAD", headers: { "content-length": "13", etag: '"complete"' } });
  assert.deepEqual(await r2.completeContentR2Multipart({ objectKey: "synthetic/archive.zip", uploadId: "000123", parts }), { objectKey: "synthetic/archive.zip", sizeBytes: 13, etag: "complete" });
});

test("actual R2 upload and ranged download preserve binary bodies and checksum compatibility", async () => {
  responses.push({ method: "PUT", headers: { etag: '"part-etag"' }, check: request => {
    assert.equal(request.headers["content-length"], "3");
    assert.equal(request.headers["x-amz-sdk-checksum-algorithm"], undefined);
    assert.equal(request.query["x-amz-checksum-crc32"], undefined);
  } });
  assert.deepEqual(await r2.uploadContentR2Part({ objectKey: "synthetic/archive.zip", uploadId: "000123", partNumber: 1,
    body: Buffer.from("abc"), contentLength: 3 }), { partNumber: 1, etag: "part-etag", sizeBytes: 3 });
  const bytes = '<not-valid-xml\u0000binary';
  responses.push({ method: "GET", status: 206, headers: { "content-type": "application/octet-stream" }, body: bytes,
    check: request => assert.equal(request.headers.range, "bytes=3-8") });
  const body = await r2.getContentR2ObjectStream("synthetic/archive.zip", { start: 3, endExclusive: 9 });
  assert.equal(await body.transformToString(), bytes, "GetObject remains a byte stream rather than parsing object contents as XML");
});

test("actual R2 errors retain service code, decoded message and request metadata", async () => {
  responses.push({ method: "HEAD", status: 403, body: '<Error><Code>AccessDenied</Code><Message>O&amp;Brien cannot read this item</Message></Error>' });
  await assert.rejects(r2.headContentR2Object("synthetic/denied"), error => {
    assert.equal(error.name, "AccessDenied");
    assert.equal(error.message, "O&Brien cannot read this item");
    assert.equal(error.$metadata.httpStatusCode, 403);
    assert.equal(error.$metadata.requestId, "synthetic-request");
    return true;
  });
});

test("actual app presigners retain private R2 endpoint, opaque query values and no optional upload checksum", async () => {
  const previousRequests = requests.length;
  const upload = new URL(await r2.signContentR2UploadPart({ objectKey: "synthetic/α folder.zip", uploadId: "000123+a/b=", partNumber: 2, expiresIn: 900 }));
  assert.match(upload.hostname, /\.r2\.invalid$/);
  assert.equal(decodeURIComponent(upload.pathname), "/synthetic/α folder.zip");
  assert.equal(upload.searchParams.get("uploadId"), "000123+a/b=");
  assert.equal(upload.searchParams.get("partNumber"), "2");
  assert.equal(upload.searchParams.get("X-Amz-Expires"), "900");
  assert.match(upload.searchParams.get("X-Amz-Signature"), /^[0-9a-f]{64}$/);
  assert.equal(upload.searchParams.has("x-amz-checksum-crc32"), false);
  assert.equal(upload.searchParams.has("x-amz-sdk-checksum-algorithm"), false);
  const download = new URL(await r2.signPrivateContentR2Url("synthetic/private.pdf", 300));
  assert.equal(download.searchParams.get("X-Amz-Expires"), "300");
  assert.match(download.searchParams.get("X-Amz-Signature"), /^[0-9a-f]{64}$/);
  assert.equal(requests.length, previousRequests, "Presigning sends no request");
});
