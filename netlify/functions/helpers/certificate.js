const fs = require("fs");
const path = require("path");
const { PDFDocument, rgb } = require("pdf-lib");
const fontkit = require("@pdf-lib/fontkit");

/**
 * CERTIFICATE_CONFIG
 * ------------------
 * Single place to adjust how the candidate name is rendered on the
 * certificate template. Coordinates are in TEMPLATE PIXEL space
 * (origin = TOP-LEFT), matching the source PNG (1447 x 2048).
 *
 * Only the candidate name is drawn onto the template. Nothing else changes.
 *
 * NOTE: these values were re-measured against the current template
 * (1447 x 2048, portrait). The template's yellow divider line sits at
 * y = 973px; the name baseline is placed 40px above it so it reads as a
 * signature sitting just above the line, not on top of it.
 *
 * IMPORTANT — why centering isn't simply "page width / 2":
 * the template has a solid navy ribbon down the left edge (through
 * x≈425, including its drop-shadow) and a gold border inset on the
 * right (starting around x≈1353). Centering the name on the FULL page
 * width visually looks left-shifted, because the ribbon eats up space
 * on the left that the name shouldn't be centered against. Instead we
 * center within the actual white content area, bounded by
 * contentAreaLeft/contentAreaRight below.
 */
const CERTIFICATE_CONFIG = {
  // Left/right bounds of the usable white content area (measured on the
  // template, excluding the left ribbon+shadow and the right gold border).
  contentAreaLeft: 425,
  contentAreaRight: 1353,
  // Vertical baseline of the name, measured from the TOP of the template.
  // Divider line is at y=973; name sits 40px above it.
  y: 933,
  fontSize: 80,
  // Deep navy to match the template's "CERTIFICATE" heading / body text.
  fontColor: { r: 0x0B / 255, g: 0x1F / 255, b: 0x63 / 255 },
  // Auto-shrink the font if a very long name would overflow this width (px).
  maxWidth: 800,
  minFontSize: 34
};

/**
 * Resolve the certificate template file. Netlify's esbuild bundler can
 * relocate bundled assets, so we try several likely locations and use the
 * first that exists. This makes the function work in `netlify dev`,
 * production, and plain `node` runs alike.
 */
function resolveTemplatePath() {
  const candidates = [
    // Preferred: template sits next to this file, in helpers/.
    path.join(__dirname, "certificate-template.png"),
    // Original layout: functions/assets/.
    path.join(__dirname, "..", "assets", "certificate-template.png"),
    // Flattened bundle layout seen in netlify dev.
    path.join(__dirname, "..", "..", "assets", "certificate-template.png"),
    path.join(process.cwd(), "netlify", "functions", "assets", "certificate-template.png"),
    path.join(process.cwd(), "netlify", "functions", "helpers", "certificate-template.png")
  ];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (_) {
      // ignore and try next
    }
  }

  // Fall back to the preferred path so the thrown error is informative.
  return candidates[0];
}

/**
 * Resolve the Alex Brush font file, mirroring the same search strategy
 * used for the template image so it works in `netlify dev`, production,
 * and plain `node` runs alike.
 */
function resolveFontPath() {
  const candidates = [
    path.join(__dirname, "AlexBrush-Regular.ttf"),
    path.join(__dirname, "..", "assets", "AlexBrush-Regular.ttf"),
    path.join(__dirname, "..", "..", "assets", "AlexBrush-Regular.ttf"),
    path.join(process.cwd(), "netlify", "functions", "assets", "AlexBrush-Regular.ttf"),
    path.join(process.cwd(), "netlify", "functions", "helpers", "AlexBrush-Regular.ttf")
  ];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (_) {
      // ignore and try next
    }
  }

  return candidates[0];
}


/**
 * Generate a one-page PDF certificate with the candidate's name drawn
 * onto the existing template. Returns a Buffer (the single source of truth
 * used for BOTH the email attachment and the download button).
 *
 * @param {string} candidateName
 * @returns {Promise<Buffer>} PDF bytes
 */
async function generateCertificate(candidateName) {
  const name = (candidateName || "").trim();

  const templateBytes = fs.readFileSync(resolveTemplatePath());

  const pdfDoc = await PDFDocument.create();

  // Required so pdf-lib can embed a custom (non-standard) font like Alex Brush.
  pdfDoc.registerFontkit(fontkit);

  const pngImage = await pdfDoc.embedPng(templateBytes);

  // Page matches the template's native pixel dimensions 1:1, so the pixel
  // coordinates in CERTIFICATE_CONFIG map directly onto the page.
  const { width, height } = pngImage.scale(1);
  const page = pdfDoc.addPage([width, height]);
  page.drawImage(pngImage, { x: 0, y: 0, width, height });

  const fontBytes = fs.readFileSync(resolveFontPath());
  const font = await pdfDoc.embedFont(fontBytes);

  // Fit the name within maxWidth by shrinking the font if needed.
  let fontSize = CERTIFICATE_CONFIG.fontSize;
  let textWidth = font.widthOfTextAtSize(name, fontSize);
  while (textWidth > CERTIFICATE_CONFIG.maxWidth && fontSize > CERTIFICATE_CONFIG.minFontSize) {
    fontSize -= 2;
    textWidth = font.widthOfTextAtSize(name, fontSize);
  }

  const { r, g, b } = CERTIFICATE_CONFIG.fontColor;

  // Centre within the usable white content area (right of the ribbon,
  // left of the gold border) rather than the full page width — see the
  // comment on CERTIFICATE_CONFIG for why.
  // pdf-lib origin is BOTTOM-left; the config y is measured from the TOP,
  // so convert. drawText's y is the text baseline.
  const contentAreaCenterX =
    (CERTIFICATE_CONFIG.contentAreaLeft + CERTIFICATE_CONFIG.contentAreaRight) / 2;
  const drawX = contentAreaCenterX - textWidth / 2;
  const drawY = height - CERTIFICATE_CONFIG.y;

  page.drawText(name, {
    x: drawX,
    y: drawY,
    size: fontSize,
    font,
    color: rgb(r, g, b)
  });

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

/**
 * Generate the certificate PDF (via generateCertificate) and rasterize its
 * single page to a PNG image, for inline display on the results page
 * (an <img> preview is far cheaper to render in a browser than embedding
 * an actual PDF viewer, and works identically on every device).
 *
 * Uses mupdf (MuPDF's official WASM bindings) rather than pdf-to-img.
 * pdf-to-img depends on pdfjs-dist's canvas backend, which needs browser
 * APIs (DOMMatrix, ImageData, Path2D) that plain Node.js doesn't provide
 * and whose polyfills are unreliable across platforms — this fails with
 * "DOMMatrix is not defined" in real Netlify Dev / Windows environments,
 * confirmed by actually running it. mupdf is WASM-based (no native
 * compilation, no browser API dependency) and was verified working here.
 *
 * mupdf is ESM-only; this file is CommonJS, so it's loaded via a dynamic
 * import() rather than require() — the standard, esbuild-safe way to
 * consume an ESM-only dependency from CJS.
 *
 * @param {string} candidateName
 * @param {Buffer} [pdfBuffer] - optional, reuse an already-generated PDF
 *   instead of generating a second one (avoids duplicate work when the
 *   caller already has the PDF, e.g. submit.js generating both).
 * @returns {Promise<Buffer>} PNG image bytes
 */
async function generateCertificateImage(candidateName, pdfBuffer) {
  const mupdf = await import("mupdf");

  const buffer = pdfBuffer || (await generateCertificate(candidateName));

  const doc = mupdf.Document.openDocument(buffer, "application/pdf");
  const page = doc.loadPage(0); // certificate is always a single page

  // scale:2 gives a crisp preview image without being excessively large.
  const matrix = mupdf.Matrix.scale(2, 2);
  const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);
  const pngBytes = pixmap.asPNG();

  return Buffer.from(pngBytes);
}

module.exports = { generateCertificate, generateCertificateImage, CERTIFICATE_CONFIG };