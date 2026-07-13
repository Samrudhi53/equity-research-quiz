/**
 * Email the participation certificate to the candidate.
 *
 * Sending is delegated to a Google Apps Script Web App (which sends via
 * Gmail). The PDF is generated in Netlify and passed here as a Buffer;
 * we forward it to Apps Script as base64.
 *
 * Requires env vars:
 *   APPS_SCRIPT_URL     - the deployed Web App URL (ends in /exec)
 *   APPS_SCRIPT_SECRET  - shared secret; must match SHARED_SECRET in the script
 *
 * @param {Object} params
 * @param {string} params.name        Candidate name
 * @param {string} params.email       Candidate email (recipient)
 * @param {Buffer} params.pdfBuffer   The SAME PDF used for the download button
 * @returns {Promise<void>} resolves on success, throws on failure
 */
async function sendCertificateEmail({ name, email, pdfBuffer }) {
  const url = process.env.APPS_SCRIPT_URL;
  if (!url) {
    throw new Error("APPS_SCRIPT_URL is not configured");
  }

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      secret: process.env.APPS_SCRIPT_SECRET || "",
      name: name || "",
      email: email || "",
      pdfBase64: pdfBuffer.toString("base64")
    })
  });

  // Apps Script returns 200 even for handled errors, so inspect the body.
  let result;
  try {
    result = await response.json();
  } catch (err) {
    throw new Error("Invalid response from email service");
  }

  if (!response.ok || !result.success) {
    throw new Error(result.error || "Email sending failed");
  }
}

module.exports = { sendCertificateEmail };
