export const PRODUCT_BOUNDARIES = Object.freeze({
  lms: Object.freeze({
    canonicalHost: 'nextgenusmle.live',
    hosts: Object.freeze(['nextgenusmle.live'])
  }),
  aylamed: Object.freeze({
    canonicalHost: 'aylamedapp.com',
    hosts: Object.freeze(['aylamedapp.com'])
  }),
  library: Object.freeze({
    canonicalHost: 'lectureslibrary.online',
    hosts: Object.freeze(['lectureslibrary.online', 'lms.nextgenusmlelms.com'])
  })
});

const cleanHost = (hostname = '') => String(hostname || '').trim().toLowerCase().replace(/\.$/, '');

const hostMatches = (hostname, allowedHost) => {
  const host = cleanHost(hostname);
  const allowed = cleanHost(allowedHost);
  return host === allowed || host.endsWith(`.${allowed}`);
};

export function websiteProductForOrigin(origin = '') {
  let hostname = '';
  try {
    hostname = new URL(String(origin || '')).hostname;
  } catch {
    return null;
  }

  for (const [product, boundary] of Object.entries(PRODUCT_BOUNDARIES)) {
    if (boundary.hosts.some((host) => hostMatches(hostname, host))) return product;
  }
  return null;
}

export function assertWebsiteProductRequest({ origin = '', product = '' } = {}) {
  const websiteProduct = websiteProductForOrigin(origin);
  if (!websiteProduct) return true;

  const requestedProduct = String(product || '').trim().toLowerCase();
  if (websiteProduct === 'library') {
    const error = new Error('Product boundary violation: the Lectures Library cannot issue LMS or AylaMed access.');
    error.statusCode = 403;
    throw error;
  }

  if (requestedProduct !== websiteProduct) {
    const error = new Error(`Product boundary violation: ${websiteProduct} website requests may issue only ${websiteProduct} access.`);
    error.statusCode = 403;
    throw error;
  }

  return true;
}

export function normalizeLmsEmailFrom(value = '') {
  const clean = String(value || '').trim() || 'NextGen USMLE <support@nextgenusmle.live>';
  if (!/@(?:www\.)?nextgenusmlelms\.com\b/i.test(clean)) return clean;

  const displayName = clean.match(/^\s*([^<]+?)\s*</)?.[1]?.trim() || 'NextGen USMLE';
  return `${displayName} <support@nextgenusmle.live>`;
}
