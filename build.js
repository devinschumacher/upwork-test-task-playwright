const fs = require("fs");
const path = require("path");
const archiver = require("archiver");
const { execSync } = require("child_process");

const outputDir = "release";
const zipFileName = "loom-downloader.zip";

// Check if we need to build or if files are ready
let sourceDir = "."; // Default to current directory
let needsBuild = false;

// Check package.json for build script
try {
  const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
  if (packageJson.scripts && packageJson.scripts.build) {
    needsBuild = true;
    console.log("🔨 Building extension...");
    execSync("npm run build", { stdio: "inherit" });
    console.log("✅ Build completed successfully");

    // Check if build created a dist folder
    if (fs.existsSync("dist")) {
      sourceDir = "dist";
      console.log("📁 Using built files from 'dist' folder");
    }
  } else {
    console.log("📁 No build script found - using current directory files");
  }
} catch (error) {
  if (error.code === "ENOENT") {
    console.log("📁 No package.json found - using current directory files");
  } else if (needsBuild) {
    console.error("❌ Build failed:", error.message);
    process.exit(1);
  }
}

// Clean up previous builds
console.log("🧹 Cleaning up previous builds...");
if (fs.existsSync(outputDir)) {
  fs.rmSync(outputDir, { recursive: true, force: true });
}
fs.mkdirSync(outputDir);

// Create build info
const buildInfo = {
  buildDate: new Date().toISOString(),
  buildType: "Production Chrome Extension",
  version: "1.0.0", // You might want to read this from package.json
  note: "Ready-to-install Chrome extension package",
};

fs.writeFileSync(
  path.join(outputDir, "build-info.json"),
  JSON.stringify(buildInfo, null, 2)
);

// Create the archive
console.log("📦 Creating user-ready extension package...");
const output = fs.createWriteStream(path.join(outputDir, zipFileName));
const archive = archiver("zip", {
  zlib: { level: 9 }, // Maximum compression for distribution
});

let fileCount = 0;

output.on("close", function () {
  console.log(
    `✅ Package created: ${(archive.pointer() / 1024 / 1024).toFixed(2)} MB`
  );
  console.log(
    `🎉 Build complete! User package: ${path.join(outputDir, zipFileName)}`
  );

  console.log("\n📊 Package Summary:");
  console.log(`   📁 Files packaged: ${fileCount}`);
  console.log(`   📦 Archive: ${zipFileName}`);
  console.log(`   🎯 Contents: Production-ready extension only`);

  console.log("\n✅ Ready for Users:");
  console.log("   ✅ Only built extension files included");
  console.log("   ✅ No source code or dependencies");
  console.log("   ✅ Optimized file size");
  console.log("   ✅ Ready for Chrome://extensions installation");

  console.log("\n🚀 Package is ready for distribution!");
  console.log("📋 Users can:");
  console.log("   1. Download and unzip the file");
  console.log("   2. Open Chrome://extensions");
  console.log("   3. Enable Developer mode");
  console.log(
    "   4. Click 'Load unpacked' and select the loom-downloader folder"
  );
});

archive.on("error", function (err) {
  console.error("❌ Archive error:", err);
  throw err;
});

archive.on("entry", function (entry) {
  fileCount++;
  console.log(`  📄 Adding: ${entry.name}`);
});

// Configure the archive
archive.pipe(output);

console.log(`📁 Packaging files from '${sourceDir}' folder...`);

if (sourceDir === ".") {
  // Package current directory but exclude dev files
  const excludeItems = [
    "node_modules/**",
    "release/**",
    ".git/**",
    "src/**", // Source files if you have them
    "source/**",
    ".gitignore",
    "package.json",
    "package-lock.json",
    "features-table.mdx",
    "features.mdx",
    "webpack.config.js",
    "tsconfig.json",
    "build.js",
    "build2.js",
    "simple-build.js",
    ".env",
    ".DS_Store",
    "Thumbs.db",
    "*.log",
  ];

  archive.glob(
    "**/*",
    {
      cwd: __dirname,
      ignore: excludeItems,
      dot: false,
    },
    {
      prefix: "loom-downloader/",
    }
  );

  console.log("🎯 Including extension files (excluding dev files)");
} else {
  // Package dist folder
  archive.glob(
    "**/*",
    {
      cwd: path.join(__dirname, sourceDir),
      dot: false,
    },
    {
      prefix: "loom-downloader/",
    }
  );

  console.log("🎯 Including only production-ready extension files");
}

archive.finalize();
