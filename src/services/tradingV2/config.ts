// ============================================================================
// TradingConfigType
// Centralized configuration management with AsyncLocalStorage
// SINGLE CONFIG ONLY
// ZERO LOGIC CHANGES — mechanical refactor only
// ============================================================================

import { AsyncLocalStorage } from "node:async_hooks";
import { ConfigType } from "./type";

export class TradingConfig {

    /* -------------------------------------------------------------------------
       ASYNC STORAGE FOR PER-REQUEST CONFIG
    ------------------------------------------------------------------------- */
    static readonly configStore = new AsyncLocalStorage<ConfigType>();

    /* -------------------------------------------------------------------------
       BASE DEFAULT CONFIG
    ------------------------------------------------------------------------- */
    static readonly defaultConfig: Partial<ConfigType> = {
        BASE_URL: "https://api.india.delta.exchange/v2",
        RUN_MINUTES: [0, 15, 30, 45],
        TIMEFRAME: "15m",
        CONFIRMATION_TIMEFRAME: "1h",
        STRUCTURE_TIMEFRAME: "4h",
        SL_TRIGGER_BUFFER_PERCENT: 0,
        SL_LIMIT_BUFFER_PERCENT: 0,
        DRY_RUN: false,
        IS_TESTING: process.env.IS_TESTING === "true",
        MIN_RR: 1.6,
        ESTIMATED_FEE_PERCENT: 0.1, // Round-trip fee (0.05% entry + 0.05% exit)
    }

    /* -------------------------------------------------------------------------
       CONFIG RESOLVER
    ------------------------------------------------------------------------- */
    static getConfig(user_id?: string, product_symbol?: string): ConfigType {

        const stored = this.configStore.getStore();

        if (stored) {
            return stored;
        }

        throw new Error("No config found");
    }
}