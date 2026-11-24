import Foundation

/// One place decides how an error is phrased for a person. `LocalizedError`
/// supplies the message where a type defines one; everything else falls back to
/// Foundation's description rather than to a blank string.
enum ErrorMessage {
    static func text(for error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }
}
