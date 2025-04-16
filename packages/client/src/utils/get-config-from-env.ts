import camelcase from 'camelcase';
import { set } from 'lodash-es';

/**
 * Reads environment variables starting with a given prefix,
 * removes the prefix, and converts the remaining key to camelCase.
 *
 * Example:
 * If prefix is 'REDIS_' and env var is REDIS_HOST=localhost,
 * it returns { host: 'localhost' }.
 *
 * @param prefix The prefix to look for (case-insensitive).
 * @returns A record with camelCased keys and their corresponding values.
 */
export function getConfigFromEnv(prefix: string, env?: Record<string, any>): Record<string, string> {
  const config: Record<string, string> = {};
  const lowerCasePrefix = prefix.toLowerCase();

  env = env || process.env;
  for (const [key, value] of Object.entries(env)) {
    const lowerCaseKey = key.toLowerCase();

    if (lowerCaseKey.startsWith(lowerCasePrefix) && value !== undefined) {
      // Remove prefix, handle potential leading underscore if prefix didn't end with one
      const keyWithoutPrefix = key.substring(prefix.length);

      if (keyWithoutPrefix.includes('__')) {
        const path = keyWithoutPrefix.split('__').map((pathKey) => camelcase(pathKey));

        set(config, path.join('.'), value);
      } else {
        const camelCaseKey = camelcase(keyWithoutPrefix, { locale: false });
        config[camelCaseKey] = value;
      }
    }
  }

  return config;
}
