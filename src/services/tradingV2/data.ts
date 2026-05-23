import { env } from "../../config";

import { ITradeState, TradeState } from "../../models/tradeState.model";
import { TradingConfig } from "./config";
import { configDebugLogger, tradingCronLogger } from "./logger";
import { ConfigType, ActiveSubscribedBot } from "./type";
import { ProcessPendingState } from "./ProcessPendingState";
import { decrypt } from "../../utils/crypto";

export class Data {

    static async getOrCreateState(
        tradingBotId: string, 
        userId: string, 
        sym: string, 
        pid: number | string, 
        multiplier: number = 0, 
        currentPrice: number = 0
    ): Promise<ITradeState> {
        // 1. Try to find existing active (open) state
        let st = await TradeState.findOne({
            tradingBotId,
            status: 'open'
        });

        if (st) {
            // Only update if fields actually differ (migration/sync safety)
            if (st.symbol !== sym || Number(st.productId) !== Number(pid) || st.userId !== userId) {
                tradingCronLogger.info(`[Data] Updating active state metadata for ${sym}`, { 
                    old: { symbol: st.symbol, pid: st.productId, userId: st.userId },
                    new: { symbol: sym, pid, userId }
                });
                st.symbol = sym;
                st.productId = Number(pid);
                st.userId = userId;
                await st.save();
            }
            
            tradingCronLogger.debug(`[Data] Loaded active state for ${sym}`, { id: st._id });
            return st;
        }

        // 2. No active state found. Look for the latest closed state to inherit lifetime stats.
        const lastClosed = await TradeState.findOne({ tradingBotId, status: 'closed' })
            .sort({ updatedAt: -1 });

        const allTimePnl = lastClosed?.allTimePnl || 0;
        const allTimeFees = lastClosed?.allTimeFees || 0;

        // 🗓 Daily PnL Reset Logic (UTC)
        const now = new Date();
        const lastUpdate = lastClosed?.updatedAt ? new Date(lastClosed.updatedAt) : null;
        const isSameDay = lastUpdate &&
            lastUpdate.getUTCDate() === now.getUTCDate() &&
            lastUpdate.getUTCMonth() === now.getUTCMonth() &&
            lastUpdate.getUTCFullYear() === now.getUTCFullYear();

        const dailyPnl = isSameDay ? (lastClosed?.dailyPnl || 0) : 0;
        
        const cfg = TradingConfig.getConfig();
        const dailyLossLimitUSD = cfg.CAPITAL_AMOUNT * (cfg.DAILY_LOSS_LIMIT / 100);

        // If the last session was a loss, we inherit its level and calculate next recovery quantity
        const isLoss = lastClosed?.tradeOutcome === 'loss';
        const currentLevel = isLoss ? (lastClosed?.currentLevel || 1) : 1;
        const sessionPnl = isLoss ? (lastClosed?.pnl || 0) : 0;
        const sessionFees = isLoss ? (lastClosed?.cumulativeFees || 0) : 0;

        let quantity = TradingConfig.getConfig().INITIAL_BASE_QUANTITY;
        if (isLoss && currentPrice > 0) {
            const netDebt = sessionPnl - sessionFees;
            quantity = ProcessPendingState.calculateMartingaleLots(netDebt, currentPrice, multiplier);
            tradingCronLogger.info(`[Data] Calculated recovery quantity for ${sym}: ${quantity} (Level: ${currentLevel}, NetDebt: ${netDebt.toFixed(2)}, Multiplier: ${multiplier})`);
        } else if (isLoss) {
            // Fallback to previous quantity if currentPrice is not available (safety)
            quantity = lastClosed?.quantity || quantity;
            tradingCronLogger.warn(`[Data] Falling back to previous quantity for ${sym} due to missing price: ${quantity}`);
        }

        // 3. Create a new open state
        st = await TradeState.create({
            tradingBotId,
            userId,
            symbol: sym,
            productId: Number(pid),
            status: 'open',
            currentLevel,
            tradeOutcome: "none",
            pnl: sessionPnl,
            cumulativeFees: sessionFees,
            dailyPnl,
            dailyLossLimitUSD,
            allTimePnl,
            allTimeFees,
            quantity
        });

        tradingCronLogger.info(`[Data] Created new active state for ${sym} (Inherited PnL: ${allTimePnl}, Quantity: ${quantity})`, { id: st._id });
        return st;
    }

    private static mapSymbol(symbol: string): string {
        if (!symbol) return symbol;
        // Delta India perpetuals typically use USD suffix instead of USDT
        if (symbol.endsWith("USDT")) {
            return symbol.replace("USDT", "USD");
        }
        return symbol;
    }

    static async fetchTradingConfigs(
        params: { limit: number; offset: number }
    ): Promise<ConfigType[]> {
        const { limit, offset } = params;

        const url = `${env.payloadUrl}/api/trading-bots/active-subscribed/delta?limit=${limit}&offset=${offset}&serverIp=${env.serverIp}`;

        let bots: ActiveSubscribedBot[] = [];
        const maxConfigRetries = 3;

        for (let attempt = 1; attempt <= maxConfigRetries; attempt++) {
            try {
                const res = await fetch(url);
                if (!res.ok) {
                    tradingCronLogger.warn(`[fetchTradingConfigs] HTTP ${res.status} for ${url} (Attempt ${attempt}/${maxConfigRetries})`);
                    if (attempt === maxConfigRetries) {
                        break;
                    }
                } else {
                    bots = (await res.json()) as ActiveSubscribedBot[];
                    break;
                }
            } catch (err: any) {
                tradingCronLogger.error(`[fetchTradingConfigs] Fetch error for ${url} (Attempt ${attempt}/${maxConfigRetries}):`, err);
                if (attempt === maxConfigRetries) {
                    break;
                }
            }
            // Wait with backoff before retrying
            await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
        }

        if (!Array.isArray(bots)) {
            tradingCronLogger.error(`[fetchTradingConfigs] Expected array of bots, got:`, { bots });
            return [];
        }

        const defaultConfig = TradingConfig.defaultConfig;

        // 1. Identify unique symbols to avoid redundant API calls
        const uniqueMappedSymbols = [...new Set(
            bots.map((bot) => this.mapSymbol(bot.SYMBOL || "")).filter(Boolean) as string[]
        )];

        tradingCronLogger.info(`[fetchTradingConfigs] Found ${uniqueMappedSymbols.length} unique symbols across ${bots.length} bots. Fetching product data...`);

        // 2. Fetch product data for each unique symbol in parallel
        const productDataMap = new Map<string, any>();
        await Promise.all(
            uniqueMappedSymbols.map(async (mappedSymbol) => {
                const productUrl = `${defaultConfig.BASE_URL}/products/${mappedSymbol}`;
                const maxProductRetries = 3;

                for (let attempt = 1; attempt <= maxProductRetries; attempt++) {
                    try {
                        tradingCronLogger.debug(`[fetchTradingConfigs] Fetching product data for unique symbol: ${mappedSymbol} from: ${productUrl} (Attempt ${attempt}/${maxProductRetries})`);
                        const productRes = await fetch(productUrl);
                        if (productRes.ok) {
                            const productData: any = await productRes.json();
                            if (productData.success && productData.result) {
                                productDataMap.set(mappedSymbol, productData.result);
                                tradingCronLogger.info(`[fetchTradingConfigs] ✓ Successfully fetched product data for ${mappedSymbol}`);
                                break;
                            }
                        } else {
                            tradingCronLogger.warn(`[fetchTradingConfigs] Failed to fetch product data for ${mappedSymbol}: ${productRes.status} (Attempt ${attempt}/${maxProductRetries})`);
                        }
                    } catch (err) {
                        tradingCronLogger.error(`[fetchTradingConfigs] Error fetching product data for ${mappedSymbol} (Attempt ${attempt}/${maxProductRetries}):`, err);
                    }
                    
                    if (attempt < maxProductRetries) {
                        await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
                    }
                }
            })
        );

        // 3. Merge product data into each bot configuration
        const mergedConfigs: ConfigType[] = bots.map((bot) => {
            const rawSymbol = bot.SYMBOL;
            const mappedSymbol = this.mapSymbol(rawSymbol);

            const config: ConfigType = {
                ...defaultConfig,
                ...bot,
                id: bot.id,
                API_KEY: decrypt(bot.API_KEY),
                SECRET_KEY: decrypt(bot.SECRET_KEY),
                INITIAL_BASE_QUANTITY: 0, // Will be calculated in TradingV2.runTradingCycle
                MAX_QUANTITY: 0,           // Will be calculated in TradingV2.runTradingCycle
            } as ConfigType;

            const p = productDataMap.get(mappedSymbol);
            if (p) {
                // Calculate decimals from tick size
                const decimals = p.tick_size.includes('.')
                    ? p.tick_size.split('.')[1].length
                    : 0;

                config.PRICE_DECIMAL_PLACES = decimals;
                config.LOT_SIZE = Number(p.contract_value);
                config.PRODUCT_ID = Number(p.id || bot.PRODUCT_ID);
                config.SYMBOL = p.symbol;

                tradingCronLogger.info(`[fetchTradingConfigs] ✓ Applied product data to bot ${config.id} [${rawSymbol}] (ID: ${p.id}, Decimals: ${decimals}, Lot: ${config.LOT_SIZE})`);
            } else {
                tradingCronLogger.warn(`[fetchTradingConfigs] ⚠ No product data available for bot ${config.id} [${rawSymbol}]`);
            }

            return config;
        });

        tradingCronLogger.info(`[fetchTradingConfigs] Successfully fetched and merged ${mergedConfigs.length} configs`);
        mergedConfigs.forEach(cfg => {
            configDebugLogger.debug(`[fetchTradingConfigs] Final merged config for bot ${cfg.id} (${cfg.SYMBOL})`, { config: cfg });
        });

        return mergedConfigs;
    }
}