require("dotenv").config();
const { google } = require("googleapis");

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

  try {
    const data = JSON.parse(event.body);

    const auth = new google.auth.GoogleAuth({
    credentials: {
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  },
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

const client = await auth.getClient();

    const sheets = google.sheets({
  version: "v4",
  auth: client
  });

    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: "R360Quiz!A:K",
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

          JSON.stringify(data.answers || [])
        ]]
      }
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        message: "Quiz submitted successfully."
      })
    };

  } catch (err) {

    console.error(err);

    return {
      statusCode: 500,
      body: JSON.stringify({
        success: false,
        error: err.message
      })
    };
  }
};