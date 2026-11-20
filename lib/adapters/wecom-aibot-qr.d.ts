/** How often the service polls query_result while waiting for a scan. */
export declare const QR_POLL_INTERVAL_MS = 3000;
/** A QR association attempt waits at most this long for scan + confirm. */
export declare const QR_LOGIN_TIMEOUT_MS: number;
/** Result of one QR-code generation. */
export interface QrGenerateResult {
    /** Opaque scan code, passed back to query_result. */
    scode: string;
    /** URL to encode as the QR code the user scans. */
    authUrl: string;
}
/** Terminal states of one association attempt. */
export type QrPollResult = {
    status: 'pending';
} | {
    status: 'success';
    botId: string;
    secret: string;
} | {
    status: 'expired';
};
/** Fetch a fresh QR payload. Throws on transport/protocol failure. */
export declare function generateQrCode(source?: string, baseUrl?: string, signal?: AbortSignal): Promise<QrGenerateResult>;
/**
 * Poll one association attempt once. Transport errors are reported as
 * 'pending' (a single blip must not kill the wait); only explicit server
 * states resolve the attempt.
 */
export declare function queryQrResult(scode: string, baseUrl?: string, signal?: AbortSignal): Promise<QrPollResult>;
//# sourceMappingURL=wecom-aibot-qr.d.ts.map