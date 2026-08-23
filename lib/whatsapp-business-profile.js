const PROFILE_FIELDS = [
  "about",
  "address",
  "description",
  "email",
  "profile_picture_url",
  "websites",
  "vertical",
];

export const WHATSAPP_BUSINESS_PROFILE_VERTICALS = Object.freeze([
  "UNDEFINED",
  "OTHER",
  "AUTO",
  "BEAUTY",
  "APPAREL",
  "EDU",
  "ENTERTAIN",
  "EVENT_PLAN",
  "FINANCE",
  "GROCERY",
  "GOVT",
  "HOTEL",
  "HEALTH",
  "NONPROFIT",
  "PROF_SERVICES",
  "RETAIL",
  "TRAVEL",
  "RESTAURANT",
  "NOT_A_BIZ",
]);

const VERTICAL_SET = new Set(WHATSAPP_BUSINESS_PROFILE_VERTICALS);
const MAX_PROFILE_PICTURE_BYTES = 5 * 1024 * 1024;
const ALLOWED_PROFILE_PICTURE_TYPES = new Set(["image/jpeg", "image/png"]);

function cleanText(value, maxLength) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function graphVersion(value = "") {
  const candidate = String(value || "v19.0").trim();
  if (/^v\d+\.\d+$/.test(candidate)) return candidate;
  if (/^\d+\.\d+$/.test(candidate)) return `v${candidate}`;
  return "v19.0";
}

function validHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function graphError(error, fallback) {
  const metaMessage = cleanText(
    error?.response?.data?.error?.error_user_msg ||
      error?.response?.data?.error?.message ||
      error?.message ||
      fallback,
    500,
  );
  const message = /^an unknown error has occurred\.?$/i.test(metaMessage)
    ? fallback
    : metaMessage;
  const wrapped = new Error(message || fallback);
  wrapped.statusCode = Number(error?.response?.status || 502) || 502;
  wrapped.metaCode = error?.response?.data?.error?.code || null;
  wrapped.metaSubcode = error?.response?.data?.error?.error_subcode || null;
  return wrapped;
}

export function normalizeWhatsAppBusinessProfile(input = {}) {
  const rawWebsites = Array.isArray(input.websites)
    ? input.websites
    : [input.website, input.website_2].filter(Boolean);
  const websites = [...new Set(rawWebsites.map((value) => cleanText(value, 256)).filter(Boolean))].slice(0, 2);
  const vertical = cleanText(input.vertical || input.category || "EDU", 40).toUpperCase();

  return {
    about: cleanText(input.about || input.bio, 139),
    address: cleanText(input.address, 256),
    description: cleanText(input.description || input.business_description, 256),
    email: cleanText(input.email, 128).toLowerCase(),
    websites,
    vertical: VERTICAL_SET.has(vertical) ? vertical : "EDU",
  };
}

export function validateWhatsAppBusinessProfile(profile = {}) {
  const normalized = normalizeWhatsAppBusinessProfile(profile);
  const errors = [];

  if (normalized.about && normalized.about.length < 1) errors.push("About must contain at least one character.");
  if (normalized.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized.email)) {
    errors.push("Enter a valid support email address.");
  }
  normalized.websites.forEach((website) => {
    if (!validHttpUrl(website)) errors.push(`Website must begin with http:// or https://: ${website}`);
  });
  if (!VERTICAL_SET.has(normalized.vertical)) errors.push("Choose a supported WhatsApp business category.");

  return { profile: normalized, errors, valid: errors.length === 0 };
}

export function decodeWhatsAppProfilePicture(dataUrl = "", fileName = "profile-picture") {
  const raw = String(dataUrl || "").trim();
  const match = raw.match(/^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=\r\n]+)$/i);
  if (!match) {
    const error = new Error("Profile photo must be a JPG or PNG image.");
    error.statusCode = 400;
    throw error;
  }

  const mimeType = match[1].toLowerCase();
  if (!ALLOWED_PROFILE_PICTURE_TYPES.has(mimeType)) {
    const error = new Error("Profile photo must be a JPG or PNG image.");
    error.statusCode = 400;
    throw error;
  }

  const buffer = Buffer.from(match[2].replace(/\s+/g, ""), "base64");
  if (!buffer.length || buffer.length > MAX_PROFILE_PICTURE_BYTES) {
    const error = new Error("Profile photo must be smaller than 5 MB.");
    error.statusCode = 400;
    throw error;
  }

  const extension = mimeType === "image/png" ? ".png" : ".jpg";
  const cleanName = cleanText(fileName, 120).replace(/[^a-zA-Z0-9._-]+/g, "-") || "profile-picture";
  return {
    buffer,
    mimeType,
    fileName: /\.(?:png|jpe?g)$/i.test(cleanName) ? cleanName : `${cleanName}${extension}`,
  };
}

export async function fetchWhatsAppBusinessProfile({
  axiosClient,
  token,
  phoneNumberId,
  version = "v19.0",
}) {
  try {
    const response = await axiosClient.get(
      `https://graph.facebook.com/${graphVersion(version)}/${phoneNumberId}/whatsapp_business_profile`,
      {
        params: { fields: PROFILE_FIELDS.join(",") },
        headers: { Authorization: `Bearer ${token}` },
        timeout: 20000,
      },
    );
    const first = Array.isArray(response.data?.data) ? response.data.data[0] || {} : response.data || {};
    return first.business_profile || first;
  } catch (error) {
    throw graphError(error, "Meta could not load the WhatsApp business profile.");
  }
}

export async function fetchWhatsAppPhoneIdentity({
  axiosClient,
  token,
  phoneNumberId,
  version = "v19.0",
}) {
  try {
    const response = await axiosClient.get(
      `https://graph.facebook.com/${graphVersion(version)}/${phoneNumberId}`,
      {
        params: {
          fields: "display_phone_number,verified_name,quality_rating,code_verification_status",
        },
        headers: { Authorization: `Bearer ${token}` },
        timeout: 20000,
      },
    );
    return response.data || {};
  } catch (error) {
    throw graphError(error, "Meta could not load the WhatsApp phone-number status.");
  }
}

export async function uploadWhatsAppProfilePicture({
  axiosClient,
  token,
  appId,
  dataUrl,
  fileName,
  version = "v19.0",
}) {
  if (!appId) {
    const error = new Error("The Meta app ID is missing, so the profile photo cannot be uploaded yet.");
    error.statusCode = 503;
    throw error;
  }
  const image = decodeWhatsAppProfilePicture(dataUrl, fileName);

  try {
    const session = await axiosClient.post(
      `https://graph.facebook.com/${graphVersion(version)}/${appId}/uploads`,
      null,
      {
        params: {
          file_length: image.buffer.length,
          file_type: image.mimeType,
          file_name: image.fileName,
          access_token: token,
        },
        timeout: 20000,
      },
    );
    const uploadId = session.data?.id;
    if (!uploadId) throw new Error("Meta did not create a profile-photo upload session.");

    const uploaded = await axiosClient.post(
      `https://graph.facebook.com/${graphVersion(version)}/${uploadId}`,
      image.buffer,
      {
        headers: {
          Authorization: `OAuth ${token}`,
          "Content-Type": "application/octet-stream",
          file_offset: "0",
        },
        maxBodyLength: MAX_PROFILE_PICTURE_BYTES,
        maxContentLength: MAX_PROFILE_PICTURE_BYTES,
        timeout: 30000,
      },
    );
    const handle = uploaded.data?.h;
    if (!handle) throw new Error("Meta uploaded the photo but did not return its profile handle.");
    return { handle, mimeType: image.mimeType, size: image.buffer.length };
  } catch (error) {
    throw graphError(error, "Meta could not upload the WhatsApp profile photo.");
  }
}

export async function publishWhatsAppBusinessProfile({
  axiosClient,
  token,
  phoneNumberId,
  profile,
  profilePictureHandle = "",
  version = "v19.0",
}) {
  const validation = validateWhatsAppBusinessProfile(profile);
  if (!validation.valid) {
    const error = new Error(validation.errors.join(" "));
    error.statusCode = 400;
    throw error;
  }

  const payload = {
    messaging_product: "whatsapp",
    ...validation.profile,
    ...(profilePictureHandle ? { profile_picture_handle: profilePictureHandle } : {}),
  };

  try {
    const response = await axiosClient.post(
      `https://graph.facebook.com/${graphVersion(version)}/${phoneNumberId}/whatsapp_business_profile`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        timeout: 20000,
      },
    );
    if (response.data?.success !== true) {
      throw new Error("Meta did not confirm the WhatsApp business profile update.");
    }
    return { acknowledged: true, payload };
  } catch (error) {
    throw graphError(error, "Meta could not update the WhatsApp business profile.");
  }
}

export function whatsappBusinessProfileMatches(requested = {}, remote = {}) {
  const expected = normalizeWhatsAppBusinessProfile(requested);
  const actual = normalizeWhatsAppBusinessProfile(remote);
  const comparableWebsite = (value) => {
    try {
      const parsed = new URL(value);
      parsed.hash = "";
      return parsed.toString().replace(/\/$/, "");
    } catch {
      return String(value || "").replace(/\/$/, "");
    }
  };
  return (
    expected.about === actual.about &&
    expected.address === actual.address &&
    expected.description === actual.description &&
    expected.email === actual.email &&
    expected.vertical === actual.vertical &&
    JSON.stringify(expected.websites.map(comparableWebsite)) ===
      JSON.stringify(actual.websites.map(comparableWebsite))
  );
}
