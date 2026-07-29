import { defineConfig } from "vite";

export default defineConfig({
  build: {
    // Keep the client bundle parseable on older browsers still represented in
    // production telemetry. Runtime APIs are handled in source where needed.
    target: "es2017",
    // The sandbox's safe-delete wrapper aborts Vite's default outDir wipe
    // (it tries to move dist/ to the recycle bin, which fails). Don't wipe
    // automatically; stale hashed assets are harmless since index.html only
    // references the latest build.
    emptyOutDir: false
  },
  plugins: [
    {
      name: "cloudflare-rocket-loader-optout",
      transformIndexHtml(html) {
        return html.replaceAll("<script type=\"module\"", "<script data-cfasync=\"false\" type=\"module\"");
      }
    }
  ],
  server: {
    allowedHosts: ["hn.frp.one"]
  }
});
