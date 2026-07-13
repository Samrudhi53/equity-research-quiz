require("dotenv").config();
const { google } = require("googleapis");

const TOP_N = 10;

/**
 * Parses a timeTaken string like "5 min 23 sec" (as saved by submit.js)
 * back into total seconds, for accurate sorting. Falls back to a very
 * large number (sorts last) if the format is unrecognized, so malformed
 * rows never accidentally rank above legitimate faster times.
 */
function parseTimeTakenToSeconds(timeTakenStr) {
  if (!timeTakenStr) return Number.MAX_SAFE_INTEGER;
  const match = /(\d+)\s*min\s*(\d+)\s*sec/i.exec(timeTakenStr);
  if (!match) return Number.MAX_SAFE_INTEGER;
  const minutes = parseInt(match[1], 10) || 0;
  const seconds = parseInt(match[2], 10) || 0;
  return minutes * 60 + seconds;
}

/**
 * Masks an email for privacy: keeps the first 2 characters of the local
 * part, replaces the rest with asterisks, keeps the domain as-is.
 * e.g. "samrudhimhatre868@gmail.com" -> "sa***@gmail.com"
 */
function maskEmail(email) {
  if (!email || typeof email !== "string" || !email.includes("@")) return "";
  const [local, domain] = email.split("@");
  if (local.length <= 2) return `${local}***@${domain}`;
  return `${local.slice(0, 2)}***@${domain}`;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      body: JSON.stringify({ success: false, message: "Method Not Allowed" })
    };
  }

  try {
    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n")
      },
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"]
    });

    const client = await auth.getClient();
    const sheets = google.sheets({ version: "v4", auth: client });

    // Columns per submit.js: A=Timestamp B=Name C=Email D=Correct E=Wrong
    // F=Skipped G=Score H=Percentage I=Status J=TimeTaken K=Answers
    // L=Institution M=Coupon
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: "R360Quiz!A:M"
    });

    const rows = result.data.values || [];

    // Skip header row if present (first cell not parseable as a date/timestamp
    // is a weak signal, so instead just skip row 0 if it looks like headers).
    const dataRows = rows.length && /name/i.test(rows[0][1] || "")
      ? rows.slice(1)
      : rows;

    const entries = dataRows
      .filter((row) => row && row[1]) // must have a name
      .map((row) => {
        const name = row[1] || "";
        const email = row[2] || "";
        const score = parseInt(row[6], 10) || 0;
        const timeTaken = row[9] || "";
        const timeTakenSeconds = parseTimeTakenToSeconds(timeTaken);
        return {
          name,
          email: maskEmail(email),
          score,
          timeTaken,
          timeTakenSeconds
        };
      });

    // Rank: higher score first; on a tie, lower time taken first.
    entries.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.timeTakenSeconds - b.timeTakenSeconds;
    });

    const top = entries.slice(0, TOP_N).map((entry, index) => ({
      rank: index + 1,
      name: entry.name,
      email: entry.email,
      score: entry.score,
      timeTaken: entry.timeTaken
    }));

    return {
      statusCode: 200,
      headers: { "Cache-Control": "no-store" },
      body: JSON.stringify({
        success: true,
        updatedAt: new Date().toISOString(),
        leaderboard: top
      })
    };
  } catch (err) {
    console.error("Leaderboard fetch failed:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({
        success: false,
        error: err.message,
        message: "Could not load the leaderboard. Please try again."
      })
    };
  }
};
