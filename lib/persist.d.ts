/**
 * Persistence for the notify plugin's configuration when it is edited from the
 * Web settings page.
 *
 * The settings page writes through the /dsh-notify RPC channel, which applies
 * the new config to the running service and persists it to a JSON file under
 * DSH_HOME so the choice survives restarts. The file path and shape are
 * internal to the plugin; the Web page never reads it directly.
 */
import type { NotifyPluginConfig } from './types.js';
/**
 * Resolve DSH_HOME, falling back to ~/.dsh.
 * @returns the absolute DSH home directory.
 */
export declare function dshHome(): string;
/**
 * The absolute path of the persisted notify config file.
 * @returns the config file path.
 */
export declare function configFilePath(): string;
/**
 * Read the persisted notify config, if any.
 * @returns the parsed config, or null when absent or malformed.
 */
export declare function loadPersistedConfig(): NotifyPluginConfig | null;
/**
 * Merge a persisted config over the base config, favoring the persisted keys.
 * @param base - the config passed to the plugin (e.g. from cordis.patch.yml).
 * @param persisted - the persisted overrides, or null.
 * @returns the merged config.
 */
export declare function mergePersisted(base: NotifyPluginConfig, persisted: NotifyPluginConfig | null): NotifyPluginConfig;
/**
 * Serialize the notify config to disk. Creates the parent directory on demand.
 * @param config - the config to persist.
 * @throws when the write fails (caller may log and continue).
 */
export declare function persistConfig(config: NotifyPluginConfig): void;
/** Drop the persisted config file, if present. */
export declare function clearPersistedConfig(): void;
//# sourceMappingURL=persist.d.ts.map