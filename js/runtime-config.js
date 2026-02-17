const DEFAULT_SITE_ORIGIN = 'https://monochrome.tf';
const DEFAULT_POCKETBASE_URL = 'https://monodb.samidy.com';
const DEFAULT_INSTANCES_URL = 'instances.json';

const getWindowValue = (key) => {
    if (typeof window === 'undefined') return undefined;
    return window[key];
};

const getFirstNonEmptyString = (...values) => {
    for (const value of values) {
        if (typeof value === 'string' && value.trim() !== '') {
            return value.trim();
        }
    }
    return null;
};

const toUrlList = (rawValue) => {
    if (!rawValue) return [];

    if (Array.isArray(rawValue)) {
        return rawValue.map((url) => (typeof url === 'string' ? url.trim() : '')).filter(Boolean);
    }

    if (typeof rawValue !== 'string') return [];

    const value = rawValue.trim();
    if (!value) return [];

    try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) {
            return parsed.map((url) => (typeof url === 'string' ? url.trim() : '')).filter(Boolean);
        }
    } catch {
        // Treat as comma/newline-separated values when not valid JSON.
    }

    return value
        .split(/[\r\n,]+/)
        .map((url) => url.trim())
        .filter(Boolean);
};

const env = import.meta.env || {};

const configuredApiInstances = toUrlList(
    getWindowValue('__DEFAULT_API_INSTANCES__') || env.VITE_DEFAULT_API_INSTANCES || null
);
const configuredStreamingInstances = toUrlList(
    getWindowValue('__DEFAULT_STREAMING_INSTANCES__') || env.VITE_DEFAULT_STREAMING_INSTANCES || null
);

export const appConfig = {
    siteOrigin:
        getFirstNonEmptyString(getWindowValue('__SITE_ORIGIN__'), env.VITE_SITE_ORIGIN) || DEFAULT_SITE_ORIGIN,
    pocketBaseUrl:
        getFirstNonEmptyString(getWindowValue('__POCKETBASE_URL__'), env.VITE_POCKETBASE_URL) ||
        DEFAULT_POCKETBASE_URL,
    instancesUrl:
        getFirstNonEmptyString(getWindowValue('__INSTANCES_URL__'), env.VITE_INSTANCES_URL) || DEFAULT_INSTANCES_URL,
    defaultApiInstances: configuredApiInstances,
    defaultStreamingInstances: configuredStreamingInstances,
};

export const isPocketBaseConfiguredByEnv = () =>
    Boolean(getFirstNonEmptyString(getWindowValue('__POCKETBASE_URL__'), env.VITE_POCKETBASE_URL));

export const resolveDefaultInstances = (fallbackApi = [], fallbackStreaming = []) => {
    const api = appConfig.defaultApiInstances.length > 0 ? appConfig.defaultApiInstances : fallbackApi;
    const streaming =
        appConfig.defaultStreamingInstances.length > 0
            ? appConfig.defaultStreamingInstances
            : appConfig.defaultApiInstances.length > 0
              ? appConfig.defaultApiInstances
              : fallbackStreaming;

    return {
        api: [...api],
        streaming: [...streaming],
    };
};
