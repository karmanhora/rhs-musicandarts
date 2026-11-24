import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "org.rhsattendance.app",
  appName: "RHS Music & Arts",
  webDir: "dist",
  // The CSS page token. It is set here too so the native WebView shows the same
  // surface between launch and the first React paint.
  backgroundColor: "#f7f5ee",
  plugins: {
    Keyboard: {
      resize: "body",
      resizeOnFullScreen: true,
    },
    StatusBar: {
      overlaysWebView: false,
      style: "LIGHT",
    },
  },
};

export default config;
