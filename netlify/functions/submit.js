require("dotenv").config();
const { google } = require("googleapis");
const { generateCertificate, generateCertificateImage } = require("./helpers/certificate");
const { sendCertificateEmail } = require("./helpers/email");

exports.handler = async (event) => {
  // Allow only POST requests
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({
        success: false,
        message: "Method Not Allowed"
      })
    };
  }

  let data;
  try {
    data = JSON.parse(event.body);
  } catch (err) {
    return {
      statusCode: 400,
      body: JSON.stringify({ success: false, error: "Invalid request body." })
    };
  }

  // ---------------------------------------------------------------
  // Guard: practice attempts (no coupon code, submitted as "NA") are
  // never saved and never issued a certificate. This mirrors the
  // frontend's behavior (which never calls this endpoint for NA
  // attempts) but is enforced here too in case this endpoint is ever
  // called directly, bypassing the UI.
  // ---------------------------------------------------------------
  const submittedCoupon = (data.coupon || "").trim().toUpperCase();
  if (submittedCoupon === "NA") {
    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        saved: false,
        certificateGenerated: false,
        emailed: false,
        message: "Practice attempt (no coupon code) — results are not saved and no certificate is issued."
      })
    };
  }

  // ---------------------------------------------------------------
  // STEP 1 + 2: Save to Google Sheet (with duplicate email check).
  // If this fails, we STOP: no certificate, no email.
  // ---------------------------------------------------------------
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n")
      },
      scopes: ["https://www.googleapis.com/auth/spreadsheets"]
    });

    const client = await auth.getClient();

    const sheets = google.sheets({
      version: "v4",
      auth: client
    });

    // One attempt per email: check existing rows before saving.
    const submittedEmail = (data.email || "").trim().toLowerCase();

    if (submittedEmail) {
      const existing = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: "R360Quiz!C:C" // Email column
      });

      const rows = existing.data.values || [];
      const emailExists = rows.some((row) => {
        const cell = (row[0] || "").trim().toLowerCase();
        return cell === submittedEmail;
      });

      if (emailExists) {
        return {
          statusCode: 409,
          body: JSON.stringify({
            success: false,
            duplicate: true,
            message: "This email has already attempted the quiz."
          })
        };
      }
    }

    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: "R360Quiz!A:M",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[
          new Date().toLocaleString(),
          data.name || "",
          data.email || "",
          data.correct || 0,
          data.wrong || 0,
          data.skipped || 0,
          data.score || 0,
          data.percentage || "",
          data.status || "",
          data.timeTaken || "",
          JSON.stringify(data.answers || []),
          data.institution || "",
          data.coupon || ""
        ]]
      }
    });
  } catch (err) {
    // Google Sheet save failed -> stop entirely.
    console.error("Google Sheet save failed:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({
        success: false,
        error: err.message,
        message: "Could not save your result. Please try again."
      })
    };
  }

  // At this point the Google Sheet row is SAVED. It stays saved regardless
  // of what happens with the certificate or email below.

  // ---------------------------------------------------------------
  // STEP 3: Generate certificate (only after sheet save succeeded).
  // ---------------------------------------------------------------
  let pdfBuffer;
  try {
    pdfBuffer = await generateCertificate(data.name || "");
  } catch (err) {
    console.error("Certificate generation failed:", err);
    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        saved: true,
        certificateGenerated: false,
        emailed: false,
        message: "Certificate generation failed."
      })
    };
  }

  const certificateBase64 = pdfBuffer.toString("base64");

  // ---------------------------------------------------------------
  // STEP 3b: Render the certificate as an image too, for inline display
  // on the results page. Reuses the already-generated PDF buffer instead
  // of generating a second one. Non-fatal: if this fails, the PDF is
  // still returned and used for download/email as before.
  // ---------------------------------------------------------------
  let certificateImageBase64 = null;
  try {
    const imageBuffer = await generateCertificateImage(data.name || "", pdfBuffer);
    certificateImageBase64 = imageBuffer.toString("base64");
  } catch (err) {
    console.error("Certificate image rendering failed:", err);
    // Leave certificateImageBase64 as null; the frontend falls back
    // gracefully (see index.html) rather than breaking the results page.
  }

  // ---------------------------------------------------------------
  // STEP 4: Email the certificate. If this fails, the result stays
  // saved and the certificate stays generated (returned for download).
  // ---------------------------------------------------------------
  let emailed = true;
  try {
    await sendCertificateEmail({
      name: data.name || "",
      email: data.email || "",
      pdfBuffer
    });
  } catch (err) {
    console.error("Email sending failed:", err);
    emailed = false;
  }

  // ---------------------------------------------------------------
  // STEP 5: Return success. Include the generated PDF (base64) so the
  // frontend Download button uses the SAME certificate — no re-generation.
  // Also include the rendered image (base64), used for the inline
  // certificate preview on the results page.
  // ---------------------------------------------------------------
  return {
    statusCode: 200,
    body: JSON.stringify({
      success: true,
      saved: true,
      certificateGenerated: true,
      emailed,
      certificateBase64,
      certificateImageBase64,
      message: emailed
        ? "Quiz submitted successfully."
        : "Result saved successfully. Certificate could not be emailed. Please download it below."
    })
  };
};