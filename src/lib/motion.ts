import { Haptics, ImpactStyle } from "@capacitor/haptics";
import { isNativeApp } from "./nativeAuth";

function lightImpact(): void {
  if (!isNativeApp()) return;
  void Haptics.impact({ style: ImpactStyle.Light }).catch(() => undefined);
}

/** Short, non-blocking tactile feedback for a completed check-in. */
export function hapticCheckIn(isLate = false): void {
  if (isNativeApp()) {
    lightImpact();
    return;
  }
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
  navigator.vibrate(isLate ? [18, 36, 18] : 18);
}

/** A distinct double tick for a refused or invalid check-in. */
export function hapticCheckInError(): void {
  if (isNativeApp()) {
    lightImpact();
    return;
  }
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
  navigator.vibrate([12, 32, 12]);
}
