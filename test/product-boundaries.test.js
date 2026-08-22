import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertWebsiteProductRequest,
  normalizeLmsEmailFrom,
  websiteProductForOrigin
} from '../lib/product-boundaries.js';

test('identifies each public website without treating native admin origins as a website', () => {
  assert.equal(websiteProductForOrigin('https://nextgenusmle.live'), 'lms');
  assert.equal(websiteProductForOrigin('https://www.nextgenusmle.live'), 'lms');
  assert.equal(websiteProductForOrigin('https://mccqe.aylamedapp.com'), 'aylamed');
  assert.equal(websiteProductForOrigin('https://lectureslibrary.online'), 'library');
  assert.equal(websiteProductForOrigin('capacitor://localhost'), null);
});

test('website invitation requests stay inside their product', () => {
  assert.equal(assertWebsiteProductRequest({ origin: 'https://nextgenusmle.live', product: 'lms' }), true);
  assert.equal(assertWebsiteProductRequest({ origin: 'https://aylamedapp.com', product: 'aylamed' }), true);
  assert.equal(assertWebsiteProductRequest({ origin: 'capacitor://localhost', product: 'both' }), true);
  assert.throws(
    () => assertWebsiteProductRequest({ origin: 'https://nextgenusmle.live', product: 'aylamed' }),
    /Product boundary violation/
  );
  assert.throws(
    () => assertWebsiteProductRequest({ origin: 'https://aylamedapp.com', product: 'both' }),
    /Product boundary violation/
  );
  assert.throws(
    () => assertWebsiteProductRequest({ origin: 'https://lectureslibrary.online', product: 'lms' }),
    /Lectures Library cannot issue/
  );
});

test('retired LMS sender domains can never be used for outbound email', () => {
  assert.equal(
    normalizeLmsEmailFrom('NextGen USMLE <support@nextgenusmlelms.com>'),
    'NextGen USMLE <support@nextgenusmle.live>'
  );
  assert.equal(
    normalizeLmsEmailFrom('Student Team <support@nextgenusmle.live>'),
    'Student Team <support@nextgenusmle.live>'
  );
});

test('AylaMed checkout fallbacks use AylaMed routes, never the LMS domain', async () => {
  const source = await import('node:fs/promises').then((fs) => fs.readFile(new URL('../server.js', import.meta.url), 'utf8'));
  assert.match(source, /AYLA_DEFAULT_SUCCESS_URL[^\n]+https:\/\/aylamedapp\.com\/checkout\/success/);
  assert.match(source, /AYLA_DEFAULT_CANCEL_URL[^\n]+https:\/\/aylamedapp\.com\/checkout\/cancelled/);
  assert.doesNotMatch(source, /nextgenusmle\.live\/aylamed\/payment-/);
});
