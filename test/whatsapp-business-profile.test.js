import test from "node:test";
import assert from "node:assert/strict";

import {
  decodeWhatsAppProfilePicture,
  fetchWhatsAppBusinessProfile,
  normalizeWhatsAppBusinessProfile,
  publishWhatsAppBusinessProfile,
  uploadWhatsAppProfilePicture,
  validateWhatsAppBusinessProfile,
  whatsappBusinessProfileMatches,
} from "../lib/whatsapp-business-profile.js";

test("normalizes a WhatsApp education profile and limits websites to two", () => {
  const profile = normalizeWhatsAppBusinessProfile({
    about: "  Structured USMLE preparation  ",
    description: "Live classes, recordings and QBank",
    email: "SUPPORT@NEXTGENUSMLE.LIVE",
    websites: [
      "https://nextgenusmle.live",
      "https://instagram.com/nextgenusmle.live",
      "https://example.com/ignored",
    ],
    vertical: "edu",
  });

  assert.equal(profile.about, "Structured USMLE preparation");
  assert.equal(profile.email, "support@nextgenusmle.live");
  assert.equal(profile.vertical, "EDU");
  assert.deepEqual(profile.websites, [
    "https://nextgenusmle.live",
    "https://instagram.com/nextgenusmle.live",
  ]);
});

test("rejects invalid email and website values before Meta receives them", () => {
  const validation = validateWhatsAppBusinessProfile({
    about: "NextGen USMLE",
    email: "not-an-email",
    websites: ["nextgenusmle.live"],
  });
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join(" "), /valid support email/i);
  assert.match(validation.errors.join(" "), /http:\/\/ or https:\/\//i);
});

test("decodes only safe JPG or PNG profile photos", () => {
  const decoded = decodeWhatsAppProfilePicture(
    `data:image/png;base64,${Buffer.from("profile-photo").toString("base64")}`,
    "nextgen-logo.png",
  );
  assert.equal(decoded.mimeType, "image/png");
  assert.equal(decoded.fileName, "nextgen-logo.png");
  assert.equal(decoded.buffer.toString(), "profile-photo");

  assert.throws(
    () => decodeWhatsAppProfilePicture("data:image/gif;base64,R0lGODlh"),
    /JPG or PNG/i,
  );
});

test("uploads a profile photo through Meta resumable upload and returns its handle", async () => {
  const calls = [];
  const axiosClient = {
    post: async (url, body, config) => {
      calls.push({ url, body, config });
      if (url.endsWith("/4536058860015817/uploads")) return { data: { id: "upload:session" } };
      if (url.endsWith("/upload:session")) return { data: { h: "profile-picture-handle" } };
      throw new Error(`Unexpected URL: ${url}`);
    },
  };

  const uploaded = await uploadWhatsAppProfilePicture({
    axiosClient,
    token: "secret-token",
    appId: "4536058860015817",
    dataUrl: `data:image/jpeg;base64,${Buffer.from("photo-bytes").toString("base64")}`,
    fileName: "profile.jpg",
    version: "v19.0",
  });

  assert.equal(uploaded.handle, "profile-picture-handle");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].config.params.file_length, Buffer.byteLength("photo-bytes"));
  assert.equal(calls[1].config.headers.file_offset, "0");
  assert.equal(calls[1].body.toString(), "photo-bytes");
});

test("publishes the validated business profile and includes the uploaded photo handle", async () => {
  let request = null;
  const axiosClient = {
    post: async (url, body, config) => {
      request = { url, body, config };
      return { data: { success: true } };
    },
  };

  const result = await publishWhatsAppBusinessProfile({
    axiosClient,
    token: "secret-token",
    phoneNumberId: "123456",
    profile: {
      about: "Organised USMLE preparation",
      description: "Live classes, recordings, QBank and adaptive study guidance.",
      email: "support@nextgenusmle.live",
      websites: ["https://nextgenusmle.live"],
      vertical: "EDU",
    },
    profilePictureHandle: "profile-handle",
  });

  assert.equal(result.acknowledged, true);
  assert.match(request.url, /123456\/whatsapp_business_profile$/);
  assert.equal(request.body.messaging_product, "whatsapp");
  assert.equal(request.body.profile_picture_handle, "profile-handle");
  assert.equal(request.config.headers.Authorization, "Bearer secret-token");
});

test("reads the live Meta profile and compares it with the submitted fields", async () => {
  const remote = {
    about: "Organised USMLE preparation",
    address: "",
    description: "Live classes and recordings",
    email: "support@nextgenusmle.live",
    websites: ["https://nextgenusmle.live"],
    vertical: "EDU",
    profile_picture_url: "https://meta.example/profile.jpg",
  };
  const axiosClient = {
    get: async () => ({ data: { data: [remote] } }),
  };
  const loaded = await fetchWhatsAppBusinessProfile({
    axiosClient,
    token: "secret-token",
    phoneNumberId: "123456",
  });

  assert.equal(loaded.profile_picture_url, remote.profile_picture_url);
  assert.equal(whatsappBusinessProfileMatches(remote, loaded), true);
  assert.equal(whatsappBusinessProfileMatches({ ...remote, about: "Different" }, loaded), false);
});
