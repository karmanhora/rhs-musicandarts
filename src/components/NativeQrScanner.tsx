import { useEffect, useState } from "react";
import { Camera, CameraOff, ScanLine } from "lucide-react";
import { Button, Spinner } from "./ui";

/**
 * The iOS camera path. ML Kit owns the camera preview and its cancel/torch
 * controls, so the WebView never has to render a getUserMedia stream. The page
 * keeps the same `onDecode` contract as the web scanner, which means check-in
 * submission does not know which camera implementation produced the code.
 */
export function NativeQrScanner({
  active,
  onDecode,
  onError,
}: {
  active: boolean;
  onDecode: (text: string) => void;
  onError?: (message: string) => void;
}) {
  const [support, setSupport] = useState<"checking" | "available" | "unavailable">("checking");
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void import("@capacitor-mlkit/barcode-scanning")
      .then(({ BarcodeScanner }) => BarcodeScanner.isSupported())
      .then(({ supported }) => {
        if (!cancelled) setSupport(supported ? "available" : "unavailable");
      })
      .catch(() => {
        if (!cancelled) setSupport("unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, [active]);

  async function openScanner() {
    setOpening(true);
    try {
      const { BarcodeScanner, BarcodeFormat } = await import(
        "@capacitor-mlkit/barcode-scanning"
      );
      const { barcodes } = await BarcodeScanner.scan({
        formats: [BarcodeFormat.QrCode],
        autoZoom: true,
      });
      const barcode = barcodes.find((item) => item.rawValue || item.displayValue);
      const text = barcode?.rawValue ?? barcode?.displayValue;
      if (text) onDecode(text);
    } catch (error) {
      // The native cancel button rejects with "scan canceled." — that is not a
      // failure and must not leave an error alert over the check-in form.
      if (error instanceof Error && /scan canceled/i.test(error.message)) return;
      onError?.(
        "The camera could not start. Allow camera access for RHS Music & Arts in Settings, then try again or enter the code instead."
      );
    } finally {
      setOpening(false);
    }
  }

  return (
    <div className="relative mx-auto flex aspect-square w-full max-w-sm flex-col items-center justify-center gap-3 overflow-hidden rounded-[var(--radius-panel)] border border-[var(--cue-border)] bg-[#111713] px-6 text-center text-sm text-white">
      {support === "checking" ? (
        <>
          <Spinner className="text-white" />
          <p role="status">Checking the camera…</p>
        </>
      ) : support === "unavailable" ? (
        <>
          <CameraOff aria-hidden="true" className="h-8 w-8 text-white/70" />
          <p className="font-semibold">Camera scanning isn’t available on this device.</p>
          <p className="text-white/70">Enter the check-in code instead.</p>
        </>
      ) : (
        <>
          <Camera aria-hidden="true" className="h-8 w-8 text-white/80" />
          <p className="font-semibold">Use the camera to scan the code</p>
          <p className="text-white/70">
            Opens a full-screen scanner. Come back here if you cancel.
          </p>
          <Button
            type="button"
            onClick={() => void openScanner()}
            loading={opening}
            icon={<ScanLine className="h-4 w-4" />}
          >
            Open camera scanner
          </Button>
        </>
      )}
    </div>
  );
}
