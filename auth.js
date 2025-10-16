// auth.js - Authentication utilities for Loom Downloader

const AUTH_CONFIG = {
  get WORKER_URL() {
    return (window.SiteConfig && window.SiteConfig.WORKER_URL) ||
      "https://ghl-check-license-worker-v2.farleythecoder.workers.dev";
  },
  get GUMROAD_PRODUCT_ID() {
    return (window.SiteConfig && window.SiteConfig.GUMROAD_PRODUCT_ID) ||
      "OHxjL9F6j-RfWU-DNCNGOg==";
  },
  get GH_LICENSE_ID() {
    return (window.SiteConfig && window.SiteConfig.GH_LICENSE_ID) ||
      "ZfdcQd6QzSQwXQ7QI4ko";
  }
};

/**
 * Verify license key and email through the worker API
 * @param {string} licenseKey - The license key to verify
 * @param {string} email - The email address to verify
 * @param {string} [productId] - Optional Gumroad product ID (omit if user only registered via GHL)
 * @returns {Promise<{success: boolean, data?: any, error?: string}>}
 */
async function verifyLicense(licenseKey, email, productId = null, licenseId = AUTH_CONFIG.GH_LICENSE_ID) {
  if (!licenseKey) {
    return { success: false, error: "License key is required" };
  }

  if (!email) {
    return { success: false, error: "Email is required" };
  }

  try {
    const requestBody = {
      license_key: licenseKey,
      email: email,
      gh_license_id: licenseId
    };

    // Only include product_id if provided (some users may only be registered via GHL)
    if (productId) {
      requestBody.product_id = productId;
    }

    console.log("🔐 Sending license verification request to worker:", {
      license_key: "***",
      email: email,
      product_id: productId || "none (GHL only)",
      gh_license_id: licenseId
    });

    const response = await fetch(AUTH_CONFIG.WORKER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("❌ Worker API returned non-200 status:", response.status, errorText);
      return { 
        success: false, 
        error: `Server error: ${response.status}` 
      };
    }

    const data = await response.json();
    console.log("✅ Worker API response:", data);

    if (data.valid) {
      return {
        success: true,
        data: {
          valid: true,
          status: data.status,
          source: data.source,
          contact: data.contact,
          purchase: data.purchase,
          licenseLocation: data.licenseLocation
        }
      };
    } else {
      return {
        success: false,
        error: data.message || "License verification failed"
      };
    }

  } catch (error) {
    console.error("❌ Error verifying license:", error);
    return {
      success: false,
      error: "Network error occurred during verification. Please check your connection and try again."
    };
  }
}

/**
 * Check if the extension is currently activated
 * @returns {Promise<{isActivated: boolean, licenseKey?: string, email?: string}>}
 */
async function checkActivationStatus() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["isActivated", "licenseKey", "email"], (data) => {
      resolve({
        isActivated: !!data.isActivated,
        licenseKey: data.licenseKey || null,
        email: data.email || null
      });
    });
  });
}

/**
 * Save activation status to storage
 * @param {string} licenseKey - The verified license key
 * @param {string} email - The verified email
 * @returns {Promise<void>}
 */
async function saveActivation(licenseKey, email) {
  return new Promise((resolve) => {
    chrome.storage.local.set(
      { 
        isActivated: true, 
        licenseKey: licenseKey, 
        email: email 
      },
      () => {
        console.log("✅ Activation saved to storage");
        resolve();
      }
    );
  });
}

/**
 * Clear activation status from storage
 * @returns {Promise<void>}
 */
async function clearActivation() {
  return new Promise((resolve) => {
    chrome.storage.local.remove(["isActivated", "licenseKey", "email"], () => {
      console.log("🧹 Activation cleared from storage");
      resolve();
    });
  });
}

/**
 * Complete activation flow - verify license and save if valid
 * @param {string} licenseKey - The license key to verify
 * @param {string} email - The email address to verify
 * @param {string} [productId] - Optional Gumroad product ID (uses default for this app if not provided)
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function activateLicense(licenseKey, email, productId = AUTH_CONFIG.GUMROAD_PRODUCT_ID) {
  console.log("🔐 Starting license activation flow");
  
  const verificationResult = await verifyLicense(licenseKey, email, productId);
  
  if (verificationResult.success) {
    await saveActivation(licenseKey, email);
    console.log("🎉 License activation completed successfully");
    return { success: true };
  } else {
    console.log("❌ License activation failed:", verificationResult.error);
    return { 
      success: false, 
      error: verificationResult.error 
    };
  }
}

// Export functions for use in other files
window.Auth = {
  verifyLicense,
  checkActivationStatus,
  saveActivation,
  clearActivation,
  activateLicense,
  AUTH_CONFIG
};
