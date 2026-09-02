// login-page/config.js
// Configuration for the login page.
//
// 1. Set API_BASE_URL to your deployed Vercel API URL.
//    Example: "https://mcsrc.vercel.app"
//    (No trailing slash, no /api suffix — the script adds the path.)
//
// 2. (Optional) Add your GitHub Pages origin to the API allowlists at
//    api/items/allowlist.js, api/keys/allowlist.js, etc. — only needed
//    if you want the served website to also call the existing API
//    endpoints (items, keys, token, webhook, mcpe). The new endpoints
//    (/api/build, /api/heartbeat, /api/dashboard) accept any origin.

window.MCSRC_CONFIG = {
  // The Vercel URL where the api/ folder is deployed.
  API_BASE_URL: 'https://mcsrc.vercel.app',
};
