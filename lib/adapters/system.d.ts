import { Context } from '@deepseek-ai/cordis';
import { NotificationAdapter } from './base.js';
import { NotifyEvent, SystemNotifyConfig } from '../types.js';
/** Test seam: command runner signature (matches promisified child_process.execFile). */
type ExecFileFn = (cmd: string, args: string[]) => Promise<unknown>;
/**
 * System notification adapter — native desktop notifications per platform:
 *
 * - macOS:  osascript `display notification` + afplay for sound
 *           (avoids terminal-notifier's Rosetta warnings; the AppleScript
 *           `sound name` parameter silently fails on current macOS releases)
 * - Windows: PowerShell WinRT toast (ToastNotificationManager), no modules
 *           required; sound via System.Media
 * - Linux:  notify-send (libnotify); sound via paplay / canberra-gtk-play,
 *           best effort. Headless systems without libnotify get a one-time
 *           install hint instead of silent failure.
 */
export declare class SystemNotificationAdapter implements NotificationAdapter {
    readonly name = "system";
    readonly enabled: boolean;
    private config;
    private ctx;
    private platform;
    private execFile;
    /** One-time warn flags so a missing desktop tool does not spam the log. */
    private warnedUnavailable;
    /** Linux sound probe result: undefined = not probed, null = none available. */
    private linuxSoundCmd;
    constructor(ctx: Context, config: SystemNotifyConfig, internal?: {
        platform?: NodeJS.Platform;
        execFile?: ExecFileFn;
    });
    send(event: NotifyEvent): Promise<void>;
    private sendMacOS;
    /**
     * Resolve and play the alert sound (macOS).
     * Priority: per-event sound name > custom sound file > named macOS sound > default.
     */
    private playSoundMacOS;
    /**
     * Play a named macOS system sound via afplay.
     * Accepts either the bare name (`Ping`) or a full path
     * (`/System/Library/Sounds/Ping.aiff`).
     */
    private playNamedSound;
    private sendWindows;
    /**
     * Build the PowerShell toast script. Single-quoted PowerShell strings are
     * used throughout (no interpolation; `'` doubled); title/body are also
     * XML-escaped before embedding in the toast template. Sound plays in the
     * same process with a short sleep so playback is not cut off at exit.
     */
    private buildWindowsToastScript;
    private sendLinux;
    /**
     * Best-effort Linux sound: custom file via paplay, else the freedesktop
     * stock sound via paplay, else canberra-gtk-play. The probe result is
     * cached; when nothing is available the sound is skipped with one warning.
     */
    private playSoundLinux;
    /**
     * Escape text for embedding in a double-quoted AppleScript string literal.
     * @param multiLine - keep real newlines so AppleScript displays line breaks;
     *   when false collapse them to the two-char `\n` (single-line title).
     */
    private escapeAppleScript;
    /** Escape text for a single-quoted PowerShell string literal ('' doubling). */
    private escapePowerShell;
    /** Escape text for embedding in XML character data. */
    private escapeXml;
}
export {};
//# sourceMappingURL=system.d.ts.map