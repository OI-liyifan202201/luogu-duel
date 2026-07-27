import { defineConfig } from "vite";

export default defineConfig({
  build: {
    // Keep the client bundle parseable on older browsers still represented in
    // production telemetry. Runtime APIs are handled in source where needed.
    target: "es2017"
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
