import { Keyboard, KeyboardResize } from "@capacitor/keyboard";
import { StatusBar, Style } from "@capacitor/status-bar";
import { isNativeApp } from "./nativeAuth";

let started = false;

/**
 * Apply the native-only presentation rules before React paints.
 *
 * The web build keeps its normal browser behaviour. Inside Capacitor we disable
 * pinch zoom, lock the page against rubber-band overscroll, keep the keyboard
 * from covering the focused control, and follow the app's light/dark theme in
 * the iOS status bar.
 */
export function initNativeShell(): void {
  if (started || !isNativeApp() || typeof document === "undefined") return;
  started = true;

  const root = document.documentElement;
  root.classList.add("native-app");

  // The viewport meta is shared with the website, so tighten it only here.
  document
    .querySelector('meta[name="viewport"]')
    ?.setAttribute(
      "content",
      "width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content, maximum-scale=1.0, user-scalable=no"
    );

  void Keyboard.setResizeMode({ mode: KeyboardResize.Body }).catch(() => undefined);

  const setStatusBarStyle = () => {
    const dark = root.classList.contains("dark");
    // Capacitor's names describe the text: Light text on a dark page, Dark text
    // on the cream light page.
    void StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light }).catch(() => undefined);
  };

  void StatusBar.setOverlaysWebView({ overlay: false }).catch(() => undefined);
  setStatusBarStyle();

  const observer = new MutationObserver(setStatusBarStyle);
  observer.observe(root, { attributes: true, attributeFilter: ["class"] });
}
