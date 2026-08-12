import { TradingConfig } from "./services/tradingV2/config";
import { DeltaExchangeAdapter } from "./services/tradingV2/adapters/delta.adapter";
import { ActiveSubscribedBot } from "./services/tradingV2/type";

async function testOverridedConfig() {
    console.log("=== TESTING OVERRIDED CONFIG IN BOT ENGINE ===");

    const mockBot: ActiveSubscribedBot = {
        id: "bot_123",
        USER_ID: "user_456",
        API_KEY: "enc_api_key",
        SECRET_KEY: "enc_secret_key",
        EXCHANGE: "delta",
        SYMBOL: "BTCUSD",
        PRODUCT_ID: 101,
        LEVERAGE: 10,
        MIN_TRADE_SIZE: 1,
        MAX_TRADE_SIZE: 100,
        DAILY_LOSS_LIMIT: 5,
        MAX_CONCURRENT_TRADES: 2,
        CAPITAL_AMOUNT: 1000,
        TRADING_MODE: "conservative",
        MIN_RR: 1.5,
    };

    const adapter = new DeltaExchangeAdapter();
    const productDataMap = new Map();

    // Test 1: Normal preparation without overrides
    TradingConfig.overridedConfig = {};
    const normalConfig = adapter.prepareConfig(mockBot, TradingConfig.defaultConfig, productDataMap);
    console.log("\n[Test 1] Normal config:");
    console.log(`  DRY_RUN: ${normalConfig.DRY_RUN} (Expected: false from defaultConfig)`);
    console.log(`  SL_ATR_MULTIPLIER: ${normalConfig.SL_ATR_MULTIPLIER} (Expected: 1.4 from defaultConfig)`);
    console.log(`  MIN_RR: ${normalConfig.MIN_RR} (Expected: 1.5 from API bot)`);
    console.log(`  TIMEFRAME: ${normalConfig.TIMEFRAME} (Expected: 5m from defaultConfig)`);

    if (normalConfig.DRY_RUN !== false || normalConfig.SL_ATR_MULTIPLIER !== 1.4 || normalConfig.MIN_RR !== 1.5 || normalConfig.TIMEFRAME !== "5m") {
        console.error("❌ Test 1 FAILED: Normal config does not match expected default/API values!");
        process.exit(1);
    }

    // Test 2: Set overridedConfig (overriding both defaultConfig AND API bot values)
    TradingConfig.overridedConfig = {
        DRY_RUN: true,
        SL_ATR_MULTIPLIER: 3.5,
        MIN_RR: 2.5,
        TIMEFRAME: "15m",
        CONFIRMATION_TIMEFRAME: "1h",
    };

    const overriddenConfig = adapter.prepareConfig(mockBot, TradingConfig.defaultConfig, productDataMap);
    console.log("\n[Test 2] Overridden config:");
    console.log(`  DRY_RUN: ${overriddenConfig.DRY_RUN} (Expected: true - OVERRIDDEN)`);
    console.log(`  SL_ATR_MULTIPLIER: ${overriddenConfig.SL_ATR_MULTIPLIER} (Expected: 3.5 - OVERRIDDEN over defaultConfig)`);
    console.log(`  MIN_RR: ${overriddenConfig.MIN_RR} (Expected: 2.5 - OVERRIDDEN over API bot)`);
    console.log(`  TIMEFRAME: ${overriddenConfig.TIMEFRAME} (Expected: 15m - OVERRIDDEN over defaultConfig)`);
    console.log(`  CONFIRMATION_TIMEFRAME: ${overriddenConfig.CONFIRMATION_TIMEFRAME} (Expected: 1h - OVERRIDDEN over defaultConfig)`);

    if (
        overriddenConfig.DRY_RUN !== true ||
        overriddenConfig.SL_ATR_MULTIPLIER !== 3.5 ||
        overriddenConfig.MIN_RR !== 2.5 ||
        overriddenConfig.TIMEFRAME !== "15m" ||
        overriddenConfig.CONFIRMATION_TIMEFRAME !== "1h"
    ) {
        console.error("❌ Test 2 FAILED: Overridden config did not take precedence!");
        process.exit(1);
    }

    // Test 3: Clear overrides
    TradingConfig.overridedConfig = {};
    const restoredConfig = adapter.prepareConfig(mockBot, TradingConfig.defaultConfig, productDataMap);
    console.log("\n[Test 3] Restored config after clearing overrides:");
    console.log(`  DRY_RUN: ${restoredConfig.DRY_RUN} (Expected: false)`);
    console.log(`  SL_ATR_MULTIPLIER: ${restoredConfig.SL_ATR_MULTIPLIER} (Expected: 1.4)`);
    console.log(`  MIN_RR: ${restoredConfig.MIN_RR} (Expected: 1.5)`);

    if (restoredConfig.DRY_RUN !== false || restoredConfig.SL_ATR_MULTIPLIER !== 1.4 || restoredConfig.MIN_RR !== 1.5) {
        console.error("❌ Test 3 FAILED: Overrides were not properly cleared!");
        process.exit(1);
    }

    console.log("\n✅ ALL OVERRIDED CONFIG TESTS PASSED SUCCESSFULLY!");
}

testOverridedConfig();
