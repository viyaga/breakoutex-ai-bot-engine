/**
 * EXCHANGE_REGISTRY — Single source of truth for all supported exchanges & brokers.
 *
 * To add a new exchange:
 *   1. Add a new entry here
 *   2. Create an adapter class implementing IExchangeAdapter
 *   3. Register it in exchange.factory.ts adapterMap
 *   Nothing else needs to change.
 */

export type ExchangeCategory = 'crypto' | 'stock';
export type CountryCode = 'IN' | 'US' | 'AE' | 'SG' | 'GB' | 'OTHER';

/**
 * How the exchange authenticates:
 *  - api_keys       : Standard API key + secret (crypto exchanges)
 *  - oauth_webview  : OAuth login via in-app WebView (Zerodha Kite)
 *  - totp_auto      : Auto TOTP login using stored secret (AngelOne)
 */
export type AuthFlow = 'api_keys' | 'oauth_webview' | 'totp_auto';

export interface CredentialField {
    /** Key used in DB document and API request body */
    key: string;
    /** Human-readable label for UI */
    label: string;
    /** Encrypt at rest + mask in UI */
    secret: boolean;
    required: boolean;
    placeholder?: string;
}

export interface ExchangeDefinition {
    /** Canonical identifier: 'delta', 'zerodha', etc. */
    id: string;
    /** Display name */
    label: string;
    category: ExchangeCategory;
    /**
     * Which auth pattern this exchange uses.
     * Drives both the mobile UI form and backend session management.
     */
    authFlow: AuthFlow;
    /** 'ALL' means no country restriction */
    supportedCountries: CountryCode[] | 'ALL';
    /**
     * Fields shown in the Add Exchange credential form.
     * OAuth/session tokens (e.g. accessToken) are NOT listed here —
     * they are generated automatically and never shown to the user.
     */
    credentialFields: CredentialField[];
    apiBaseUrl: string;
}

export const EXCHANGE_REGISTRY: Record<string, ExchangeDefinition> = {
    // --------------  CRYPTO EXCHANGES (Global) --------------
    delta: {
        id: 'delta',
        label: 'Delta Exchange',
        category: 'crypto',
        authFlow: 'api_keys',
        supportedCountries: 'ALL',
        credentialFields: [
            { key: 'apiKey',    label: 'API Key',    secret: false, required: true,  placeholder: 'your_delta_api_key' },
            { key: 'secretKey', label: 'Secret Key', secret: true,  required: true,  placeholder: 'your_delta_secret_key' },
        ],
        apiBaseUrl: 'https://api.india.delta.exchange/v2',
    },

    binance: {
        id: 'binance',
        label: 'Binance',
        category: 'crypto',
        authFlow: 'api_keys',
        supportedCountries: 'ALL',
        credentialFields: [
            { key: 'apiKey',    label: 'API Key',    secret: false, required: true,  placeholder: 'your_binance_api_key' },
            { key: 'secretKey', label: 'Secret Key', secret: true,  required: true,  placeholder: 'your_binance_secret_key' },
        ],
        apiBaseUrl: 'https://fapi.binance.com',
    },

    bybit: {
        id: 'bybit',
        label: 'Bybit',
        category: 'crypto',
        authFlow: 'api_keys',
        supportedCountries: 'ALL',
        credentialFields: [
            { key: 'apiKey',    label: 'API Key',    secret: false, required: true,  placeholder: 'your_bybit_api_key' },
            { key: 'secretKey', label: 'Secret Key', secret: true,  required: true,  placeholder: 'your_bybit_secret_key' },
        ],
        apiBaseUrl: 'https://api.bybit.com',
    },

    // -------------- INDIAN STOCK BROKERS --------------
    zerodha: {
        id: 'zerodha',
        label: 'Zerodha Kite',
        category: 'stock',
        authFlow: 'oauth_webview',
        supportedCountries: ['IN'],
        credentialFields: [
            { key: 'apiKey',    label: 'API Key',    secret: false, required: true,  placeholder: 'kite_api_key_xxxxx' },
            { key: 'secretKey', label: 'API Secret', secret: true,  required: true,  placeholder: 'kite_api_secret_xxxxx' },
        ],
        apiBaseUrl: 'https://api.kite.trade',
    },

    angelone: {
        id: 'angelone',
        label: 'AngelOne SmartAPI',
        category: 'stock',
        authFlow: 'totp_auto',
        supportedCountries: ['IN'],
        credentialFields: [
            { key: 'apiKey',     label: 'API Key',     secret: false, required: true,  placeholder: 'your_angelone_api_key' },
            { key: 'clientCode', label: 'Client Code', secret: false, required: true,  placeholder: 'your_client_code' },
            { key: 'mpin',       label: 'MPIN',        secret: true,  required: true,  placeholder: '4 or 6 digit MPIN' },
            { key: 'totpSecret', label: 'TOTP Secret', secret: true,  required: false, placeholder: 'Base32 TOTP secret (from AngelOne app QR)' },
        ],
        apiBaseUrl: 'https://apiconnect.angelone.in',
    },
};

// --------------------------------------------
// Utility functions
// --------------------------------------------

/** Returns all exchange definitions available for a given country */
export function getAvailableExchanges(country: CountryCode): ExchangeDefinition[] {
    return Object.values(EXCHANGE_REGISTRY).filter(
        (ex) => ex.supportedCountries === 'ALL' || (ex.supportedCountries as CountryCode[]).includes(country)
    );
}

/** Returns credential fields for a given exchange id */
export function getCredentialFields(exchangeId: string): CredentialField[] {
    return EXCHANGE_REGISTRY[exchangeId]?.credentialFields ?? [];
}

/** Returns the auth flow for a given exchange id */
export function getAuthFlow(exchangeId: string): AuthFlow {
    return EXCHANGE_REGISTRY[exchangeId]?.authFlow ?? 'api_keys';
}

/** Returns the exchange definition or throws if not found */
export function getExchangeDefinition(exchangeId: string): ExchangeDefinition {
    const def = EXCHANGE_REGISTRY[exchangeId];
    if (!def) throw new Error(`[ExchangeRegistry] Unknown exchange: "${exchangeId}"`);
    return def;
}

/** All registered exchange IDs */
export const EXCHANGE_IDS = Object.keys(EXCHANGE_REGISTRY) as string[];

/** All supported country codes */
export const SUPPORTED_COUNTRIES: { code: CountryCode; label: string }[] = [
    { code: 'IN',    label: '???? India' },
    { code: 'US',    label: '???? United States' },
    { code: 'AE',    label: '???? United Arab Emirates' },
    { code: 'SG',    label: '???? Singapore' },
    { code: 'GB',    label: '???? United Kingdom' },
    { code: 'OTHER', label: '?? Other / International' },
];
