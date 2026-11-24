import { useEffect, useRef, useState } from "react";
import { isNativeApp } from "../lib/nativeAuth";
import { NativeQrScanner } from "./NativeQrScanner";

const ELEMENT_ID = "band-qr-reader";

function cameraErrorMessage(error: unknown): string {
  if (!window.isSecureContext && !["localhost", "127.0.0.1"].includes(window.location.hostname)) {
    return "Camera scanning requires a secure HTTPS connection. Open the public school attendance website and allow camera access.";
  }

  const errorName = error instanceof DOMException ? error.name : "";
  switch (errorName) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      return "Camera access is blocked. Allow camera access for this website in your browser or phone settings, then try again.";
    case "NotFoundError":
    case "NotSupportedError":
      return "No usable camera was found. Enter the check-in code instead.";
    case "NotReadableError":
      return "The camera is busy in another app. Close other camera apps and try again.";
    case "OverconstrainedError":
      return "The rear camera could not be opened. Try again or enter the check-in code instead.";
    default:
      return "The camera could not start. Check this website’s camera permission, then try again or enter the check-in code.";
  }
}

/**
 * Choose the camera implementation once per render. The iOS shell uses ML Kit's
 * native scanner; the website keeps the html5-qrcode fallback below.
 */
export function QrScanner(props: {
  active: boolean;
  onDecode: (text: string) => void;
  onError?: (message: string) => void;
}) {
  if (isNativeApp()) return <NativeQrScanner {...props} />;
  return <WebQrScanner {...props} />;
}

/**
 * Web camera QR reader. `html5-qrcode` is imported lazily so the ~300 kB library
 * never lands in the initial bundle, and the camera is torn down the moment
 * `active` goes false (leaving a screen must always release the camera).
 *
 * `onDecode` MUST be wrapped in `useCallback` by the caller — a new function
 * identity restarts the camera.
 */
function WebQrScanner({
  active,
  onDecode,
  onError,
}: {
  active: boolean;
  onDecode: (text: string) => void;
  onError?: (message: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const teardown = useRef<Promise<void>>(Promise.resolve());
  const lastHit = useRef<{ text: string; at: number }>({ text: "", at: 0 });
  const [cameraState, setCameraState] = useState<"starting" | "ready" | "unavailable">("starting");

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let instance: import("html5-qrcode").Html5Qrcode | null = null;
    setCameraState("starting");

    const previousTeardown = teardown.current;
    const start = (async () => {
      await previousTeardown;
      if (cancelled || !host.current) return;

      const { Html5Qrcode } = await import("html5-qrcode");
      if (cancelled || !host.current) return;

      instance = new Html5Qrcode(ELEMENT_ID, { verbose: false });

      await instance.start(
        { facingMode: { ideal: "environment" } },
        {
          fps: 10,
          aspectRatio: 1,
          disableFlip: true,
          // WKWebView needs explicit, modest constraints; an unbounded request
          // can return a stream the inline video never renders.
          videoConstraints: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1280 },
            height: { ideal: 1280 },
          },
          qrbox: (width, height) => {
            const edge = Math.floor(Math.min(width, height) * 0.72);
            return { width: Math.min(edge, 320), height: Math.min(edge, 320) };
          },
        },
        (decoded) => {
          const now = Date.now();
          // The camera fires continuously; ignore the same code for 3s.
          if (decoded === lastHit.current.text && now - lastHit.current.at < 3000) return;
          lastHit.current = { text: decoded, at: now };
          onDecode(decoded);
        },
        () => {
          /* Per-frame "no QR found" is expected while the camera is searching. */
        }
      );

      // html5-qrcode creates the video element itself. On iOS it must carry the
      // playsinline attribute (not only the property) and fill the square well,
      // or Safari may open a native player or render a zero-height frame.
      const video = host.current?.querySelector<HTMLVideoElement>("video");
      if (video) {
        video.setAttribute("playsinline", "");
        video.setAttribute("webkit-playsinline", "true");
        video.muted = true;
        video.style.width = "100%";
        video.style.height = "100%";
        video.style.objectFit = "cover";
      }

      if (!cancelled) setCameraState("ready");
    })();

    void start.catch((error: unknown) => {
      if (!cancelled) {
        setCameraState("unavailable");
        onError?.(cameraErrorMessage(error));
      }
    });

    return () => {
      cancelled = true;
      teardown.current = (async () => {
        await start.catch(() => undefined);
        if (!instance) return;
        if (instance.isScanning) await instance.stop();
        instance.clear();
      })().catch((error: unknown) => {
        console.error("Could not stop the QR scanner cleanly.", error);
      });
    };
  }, [active, onDecode, onError]);

  return (
    <div
      className="relative mx-auto aspect-square w-full max-w-sm overflow-hidden rounded-[var(--radius-panel)] border border-[var(--cue-border)] bg-[#111713] text-center text-sm text-white"
    >
      <div
        id={ELEMENT_ID}
        ref={host}
        className="h-full w-full [&_video]:h-full [&_video]:w-full [&_video]:object-cover"
      />
      {cameraState !== "ready" ? (
        <p
          className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 py-8"
          role="status"
        >
          {cameraState === "starting"
            ? "Opening camera…"
            : "Camera unavailable. Enter the code instead."}
        </p>
      ) : null}
    </div>
  );
}
