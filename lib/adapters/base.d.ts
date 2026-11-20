import { NotifyEvent } from '../types.js';
/**
 * Base interface for all notification adapters
 */
export interface NotificationAdapter {
    /** Adapter name for logging */
    readonly name: string;
    /** Whether this adapter is enabled */
    readonly enabled: boolean;
    /** Send a notification */
    send(event: NotifyEvent): Promise<void>;
    /** Clean up resources */
    dispose?(): void | Promise<void>;
}
/**
 * Metadata entries worth appending to a chat push: keys outside the standard
 * turn-summary set (i.e. custom metadata from programmatic sends). Standard
 * keys are already conveyed by the title/body and dumping them — including
 * full prompt text — is noise.
 */
export declare function extraMetadataEntries(event: NotifyEvent): Array<[string, unknown]>;
//# sourceMappingURL=base.d.ts.map