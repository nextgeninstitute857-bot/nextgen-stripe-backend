export function resolveLmsSmtpAuthMethod(value = "") {
  const normalized = String(value || "").trim().toUpperCase();
  return normalized || "LOGIN";
}
