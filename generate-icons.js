// This script generates the extension icons from an SVG source.
// It uses the 'sharp' library, so you need to install it first:
// npm install sharp

const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const svgIcon = `
<svg width="128" height="128" viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg">
<circle cx="64" cy="64" r="60" fill="#625df5"/>
<path d="M86 64L54 82.3205L54 45.6795L86 64Z" fill="white"/>
</svg>
`;

const sizes = [16, 32, 48, 128];
const outputDir = path.join(__dirname, "icons");

if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir);
}

sizes.forEach((size) => {
  const outputPath = path.join(outputDir, `icon${size}.png`);
  sharp(Buffer.from(svgIcon))
    .resize(size, size)
    .toFile(outputPath, (err, info) => {
      if (err) {
        console.error(`Error generating icon${size}.png:`, err);
      } else {
        console.log(`Generated icon${size}.png`);
      }
    });
});
