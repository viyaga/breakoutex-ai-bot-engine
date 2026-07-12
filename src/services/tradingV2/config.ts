// ===========================================================================
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
    ---------------------------------------------------------------------------- */
    static readonly configStore = new AsyncLocalStorage<ConfigType>();

    /* ------------------------------------------------------------------------
       BASE DEFAULT CONFIG
    ------------------------------------------------------------------------- */
    static readonly defaultConfig: Partial<ConfigType> = {
        BASE_URL: "https://api.india.delta.exchange/v2",
        RUN_MINUTES: [0, 15, 30, 45],
        TIMEFRAME: "1m",
        CONFIRMATION_TIMEFRAME: "5m",
        STRUCTURE_TIMEFRAME: "15m",
        SL_TRIGGER_BUFFER_PERCENT: 0.2,
        SL_LIMIT_BUFFER_PERCENT: 0.3,
        TP_TRIGGER_BUFFER_PERCENT: 0.2,
        TP_LIMIT_BUFFER_PERCENT: 0.3,
        MAX_ALLOWED_PRICE_MOVEMENT_PERCENT: 1.5,
        TP_PRICE_MOVEMENT_PERCENT: 3,
        DRY_RUN: false,
        IS_TESTING: process.env.IS_TESTING === "true",
        CONFIRMATION_LOOKBACK: 36,
        ESTIMATED_FEE_PERCENT: 0.1, // Round-trip fee (0.05% entry + 0.05% exit)
        IS_WEEKEND_SAFETY_ENABLED: true,
        MIN_ENTRY_SCORE: 0,
        MIN_CONFIRMATION_SCORE: 60,
        MIN_STRUCTURE_SCORE: 20,
        MIN_FINAL_SCORE: 60,
    }

    /* -------------------------------------------------------------------------
       CONFIG RESOLVER
    ---------------------------------------------------------------------------- */
    static getConfig(user_id?: string, product_symbol?: string): ConfigType {

        const stored = this.configStore.getStore();

        if (stored) {
            return stored;
        }

        throw new Error("No config found");
    }
}