import { Data } from "./data";
import { deltaExchange } from "./delta-exchange";
import { tradingCycleErrorLogger, skipTradingLogger, tradingCronLogger, marketDetectorLogger, getContextualLogger, tradesLogger, mtfAllowedLogger } from "./logger";
import { ConfigType, TargetCandle, Candle, OrderSide } from "./type";
import { Utils } from "./utils";
import { ProcessPendingState } from "./ProcessPendingState";
import { TradeState } from "../../models/tradeState.model";

import { MultiTimeframeAlignment } from "./market-detector/multi-timeframe";
import { BotError } from "../../models/botError.model";
import errorLogger from "../../utils/errorLogger";

export class TradingV2 {
    private static candleCache = new Map<string, Promise<{ target: TargetCandle; candles: Candle[] } | null>>();
    private static priceCache = new Map<string, Promise<number>>();

    static clearCaches() {
        this.candleCache.clear();
        this.priceCache.clear();
        tradingCronLogger.debug(`[TradingV2] Market data caches cleared`);
    }

    /* =========================================================================
       TARGET CANDLE
    ========================================================================= */

    static async getTargetCandle(
        c: {
            SYMBOL: string;
            TIMEFRAME: string;
            CONFIRMATION_TIMEFRAME: string;
            STRUCTURE_TIMEFRAME: string;
        }, timeframeType: 'ENTRY' | 'CONFIRMATION' | 'STRUCTURE'): Promise<{ target: TargetCandle; candles: Candle[] } | null> {

        const timeframe = timeframeType === 'ENTRY' ? c.TIMEFRAME : timeframeType === 'CONFIRMATION' ? c.CONFIRMATION_TIMEFRAME : c.STRUCTURE_TIMEFRAME;
        const cacheKey = `${c.SYMBOL}:${timeframe}`;

        if (this.candleCache.has(cacheKey)) {
            return this.candleCache.get(cacheKey)!;
        }

        const fetchPromise = (async () => {
            const dur = Utils.getTimeframeDurationMs(timeframe);
            const now = Date.now();
            const currentCandleStart = Math.floor(now / dur) * dur;

            const cd = await deltaExchange.getCandlestickData(
                c.SYMBOL,
                timeframe,
                currentCandleStart - 80 * dur,
                now
            );

            const candles = Utils.parseCandleResponse(cd);
            if (!candles.length) return null;

            candles.sort((a, b) => a.timestamp - b.timestamp);
            const closedCandles = candles.filter(
                candle => candle.timestamp < currentCandleStart
            );

            if (!closedCandles.length) {
                tradingCycleErrorLogger.error(`[getTargetCandle:${c.SYMBOL}] No closed candles found`);
                return null;
            }

            const target = closedCandles[closedCandles.length - 1];
            return {
                target: {
                    ...target,
                    color: Utils.getCandleColor(target)
                },
                candles: closedCandles
            };
        })();

        fetchPromise.catch(() => {
            this.candleCache.delete(cacheKey);
        });
        this.candleCache.set(cacheKey, fetchPromise);
        return fetchPromise;
    }

    private static async getCurrentPrice(sym: string): Promise<number> {
        if (this.priceCache.has(sym)) {
            return this.priceCache.get(sym)!;
        }

        const fetchPromise = (async () => {
            const ticker = await deltaExchange.getTickerData(sym);
            if (!ticker) {
                throw new Error(`[workflow] No ticker data for ${sym}`);
            }
            return Number(ticker.mark_price);
        })();

        fetchPromise.catch(() => {
            this.priceCache.delete(sym);
        });
        this.priceCache.set(sym, fetchPromise);
        return fetchPromise;
    }

    /* =========================================================================
       PUBLIC ENTRY POINT
    ========================================================================= */

    static async runTradingCycle(c: ConfigType) {
        const { id: tradingBotId, SYMBOL: symbol, USER_ID: userId } = c;
        const cycleId = `cycle-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

        const cronLogger = getContextualLogger(tradingCronLogger, { cycleId, symbol, tradingBotId });
        const skipLogger = getContextualLogger(skipTradingLogger, { cycleId, symbol, tradingBotId });
        const errorLogger = getContextualLogger(tradingCycleErrorLogger, { cycleId, symbol, tradingBotId });
        const detectorLogger = getContextualLogger(marketDetectorLogger, { cycleId, symbol, tradingBotId });
        const tradeLogger = getContextualLogger(tradesLogger, { cycleId, symbol, tradingBotId });
        const mtfAllowedFileLogger = getContextualLogger(mtfAllowedLogger, { cycleId, symbol, tradingBotId });

        cronLogger.info(`[TradingCycle] ========== START PROCESSING BOT: ${symbol} (ID: ${tradingBotId}) ==========`);

        try {
            // ───────────────── SYNC LEVERAGE ─────────────────
            cronLogger.info(`[LeverageSync] Checking leverage for product ${c.PRODUCT_ID}...`);
            const leverageData = await deltaExchange.getOrderLeverage(c.PRODUCT_ID);
            if (leverageData && leverageData.success && leverageData.result) {
                const currentLeverage = leverageData.result.leverage;
                cronLogger.info(`[LeverageSync] Current leverage on Delta: ${currentLeverage}, Configured leverage: ${c.LEVERAGE}`);
                if (Number(currentLeverage) !== Number(c.LEVERAGE)) {
                    cronLogger.info(`[LeverageSync] Leverage mismatch. Changing leverage to ${c.LEVERAGE}...`);
                    const changeRes = await deltaExchange.changeOrderLeverage(c.PRODUCT_ID, c.LEVERAGE);
                    if (changeRes && changeRes.success) {
                        cronLogger.info(`[LeverageSync] Leverage changed successfully to ${c.LEVERAGE}`);
                    } else {
                        cronLogger.warn(`[LeverageSync] Failed to change leverage: ${JSON.stringify(changeRes)}`);
                    }
                } else {
                    cronLogger.info(`[LeverageSync] Leverage is already set correctly to ${c.LEVERAGE}`);
                }
            } else {
                cronLogger.warn(`[LeverageSync] Failed to retrieve leverage: ${JSON.stringify(leverageData)}`);
            }

            // ───────────────── MARKET DATA ─────────────────
            const targetDataEntry = await TradingV2.getTargetCandle(c, 'ENTRY');
            const targetDataConfirmation = await TradingV2.getTargetCandle(c, 'CONFIRMATION');
            const targetDataStructure = await TradingV2.getTargetCandle(c, 'STRUCTURE');

            if (!targetDataEntry || !targetDataConfirmation || !targetDataStructure) {
                const missing = [];
                if (!targetDataEntry) missing.push('ENTRY');
                if (!targetDataConfirmation) missing.push('CONFIRMATION');
                if (!targetDataStructure) missing.push('STRUCTURE');

                skipLogger.info(`[MarketData] SKIP: Missing closed candles for ${symbol} on: ${missing.join(', ')}`);
                return;
            }

            cronLogger.info(`[MarketData] Candlestick Data Fetched:
              ENTRY (${c.TIMEFRAME}): ${targetDataEntry.candles.length} candles, Target: [O:${targetDataEntry.target.open}, H:${targetDataEntry.target.high}, L:${targetDataEntry.target.low}, C:${targetDataEntry.target.close}, Color:${targetDataEntry.target.color}]
              CONFIRMATION (${c.CONFIRMATION_TIMEFRAME}): ${targetDataConfirmation.candles.length} candles, Target: [O:${targetDataConfirmation.target.open}, H:${targetDataConfirmation.target.high}, L:${targetDataConfirmation.target.low}, C:${targetDataConfirmation.target.close}, Color:${targetDataConfirmation.target.color}]
              STRUCTURE (${c.STRUCTURE_TIMEFRAME}): ${targetDataStructure.candles.length} candles, Target: [O:${targetDataStructure.target.open}, H:${targetDataStructure.target.high}, L:${targetDataStructure.target.low}, C:${targetDataStructure.target.close}, Color:${targetDataStructure.target.color}]`);

            const { target: targetCandle, candles: entryCandles } = targetDataEntry;
            const { target: confirmationTargetCandle, candles: confirmationCandles } = targetDataConfirmation;
            const { target: structureTargetCandle, candles: structureCandles } = targetDataStructure;

            cronLogger.debug(`[MarketPrice] Fetching latest price for ${symbol}...`);
            const currentPrice = await TradingV2.getCurrentPrice(symbol);
            cronLogger.info(`[MarketPrice] Current Mark Price: ${currentPrice}`);

            // ───────────────── CONVERT USD TO LOTS ─────────────────
            if (c.MIN_TRADE_SIZE && currentPrice > 0) {
                const oldQty = c.INITIAL_BASE_QUANTITY;
                c.INITIAL_BASE_QUANTITY = Math.max(1, Math.floor(c.MIN_TRADE_SIZE / (currentPrice * c.LOT_SIZE)));
                cronLogger.info(`[Config] Converted MIN_TRADE_SIZE ($${c.MIN_TRADE_SIZE}) to INITIAL_BASE_QUANTITY (${c.INITIAL_BASE_QUANTITY} lots). Previous: ${oldQty}`);
            }
            if (c.MAX_TRADE_SIZE && currentPrice > 0) {
                const oldMaxQty = c.MAX_QUANTITY;
                c.MAX_QUANTITY = Math.max(1, Math.floor(c.MAX_TRADE_SIZE / (currentPrice * c.LOT_SIZE)));
                cronLogger.info(`[Config] Converted MAX_TRADE_SIZE ($${c.MAX_TRADE_SIZE}) to MAX_QUANTITY (${c.MAX_QUANTITY} lots). Previous: ${oldMaxQty}`);
            }

            cronLogger.info(`[Config] Quantities after conversion: INITIAL_BASE_QUANTITY = ${c.INITIAL_BASE_QUANTITY ?? 'undefined'}, MAX_QUANTITY = ${c.MAX_QUANTITY ?? 'undefined'}`);

            if (!c.INITIAL_BASE_QUANTITY || c.INITIAL_BASE_QUANTITY <= 0 || !c.MAX_QUANTITY || c.MAX_QUANTITY <= 0) {
                skipLogger.warn(`[SKIP] Trade not allowed: INITIAL_BASE_QUANTITY (${c.INITIAL_BASE_QUANTITY}) or MAX_QUANTITY (${c.MAX_QUANTITY}) is invalid or missing.`);
                return;
            }

            // ───────────────── MULTI TIMEFRAME ALIGNMENT ─────────────────
            const configConfirmation: ConfigType = { ...c, TIMEFRAME: c.CONFIRMATION_TIMEFRAME };
            const configStructure: ConfigType = { ...c, TIMEFRAME: c.STRUCTURE_TIMEFRAME };

            const mtf = MultiTimeframeAlignment.evaluate(
                targetCandle,
                confirmationTargetCandle,
                structureTargetCandle,
                entryCandles,
                confirmationCandles,
                structureCandles,
                c,
                configConfirmation,
                configStructure,
                currentPrice,
                { cycleId, tradingBotId }
            );

            detectorLogger.info(`[MTF-RESULT] ${symbol}: Score=${mtf.finalScore}, Direction=${mtf.direction}, Decision=${mtf.decision}, Allowed=${mtf.isAllowed}`);
            cronLogger.info(`[MTF] Result: Score=${mtf.finalScore}, Direction=${mtf.direction}, Decision=${mtf.decision}, Allowed=${mtf.isAllowed}`);
            if (mtf.isAllowed) {
                detectorLogger.info(`[MTF-ALLOWED] ${symbol}: Price Levels target: TP=${mtf.tp} (${mtf.tpPerc.toFixed(2)}%), SL=${mtf.sl} (${mtf.slPerc.toFixed(2)}%), Net RR=${mtf.rr.toFixed(2)}`);
                cronLogger.info(`[MTF] Price Levels target: TP=${mtf.tp} (${mtf.tpPerc.toFixed(2)}%), SL=${mtf.sl} (${mtf.slPerc.toFixed(2)}%), Net RR=${mtf.rr.toFixed(2)}`);

                // Log to separate file for MTF allowed trades
                mtfAllowedFileLogger.info(`[ALLOWED] ${symbol} | Entry: ${currentPrice} | Score: ${mtf.finalScore} (Entry:${mtf.entryScore}, Conf:${mtf.confirmationProbability}, Struct:${mtf.structureProbability}) | TP: ${mtf.tp} (${mtf.tpPerc.toFixed(2)}%) | SL: ${mtf.sl} (${mtf.slPerc.toFixed(2)}%) | RR: ${mtf.rr.toFixed(2)} | Fees: ${c.ESTIMATED_FEE_PERCENT}% | Dir: ${mtf.direction}`);
            }

            const scoreMultiplier = mtf.finalScore > 85 ? 1.5 : mtf.finalScore > 80 ? 1 : mtf.finalScore > 75 ? 0.5 : 0;

            // ───────────────── STATE ─────────────────
            let state = await Data.getOrCreateState(
                c.id,
                c.USER_ID,
                c.SYMBOL,
                c.PRODUCT_ID,
                scoreMultiplier,
                currentPrice
            );

            cronLogger.info(`[State] Loaded state: ID=${state.id}, Level=${state.currentLevel}, DailyPnL=$${state.dailyPnl.toFixed(2)}, Outcome=${state.tradeOutcome}, Status=${state.status}`);

            // ───────────────── HANDLE PENDING TRADE ─────────────────
            if (state.entryOrderId && Utils.isTradePending(state)) {

                cronLogger.info(
                    `Found pending trade with order ID: ${state.entryOrderId}. Fetching order details...`
                );

                const orderDetails = await deltaExchange.getOrderDetails(state.entryOrderId);

                if (!orderDetails) {
                    throw new Error("Failed to fetch order details for pending trade.");
                }

                cronLogger.info(
                    `Order details retrieved: Status=${orderDetails.status}`
                );

                cronLogger.info(
                    `Processing pending trade state with multiplier: ${scoreMultiplier}`
                );

                state = await ProcessPendingState.processStateOfPendingTrade(
                    symbol,
                    state,
                    orderDetails,
                    mtf,
                    currentPrice,
                    scoreMultiplier,
                    { cycleId, tradingBotId } // Pass context for logging
                );

                cronLogger.info(
                    `Pending state processed: NewOutcome=${state.tradeOutcome}`
                );

                if (Utils.isTradePending(state)) return;

                if (state.status === 'closed') {
                    cronLogger.info(`State was closed. Fetching/Creating new active state...`);
                    state = await Data.getOrCreateState(
                        c.id,
                        c.USER_ID,
                        c.SYMBOL,
                        c.PRODUCT_ID,
                        scoreMultiplier,
                        currentPrice
                    );
                }
            }

            // ───────────────── DAILY LOSS CHECK ─────────────────
            const dailyLossLimitUSD = state.dailyLossLimitUSD || (c.CAPITAL_AMOUNT * (c.DAILY_LOSS_LIMIT / 100));
            if (state.dailyPnl < 0 && Math.abs(state.dailyPnl) >= dailyLossLimitUSD && dailyLossLimitUSD > 0) {
                skipLogger.warn(`[DailyLoss] SKIP: Daily loss limit reached for ${symbol}. Current Loss: $${Math.abs(state.dailyPnl).toFixed(2)}, Limit: $${dailyLossLimitUSD.toFixed(2)} (${c.DAILY_LOSS_LIMIT}%)`);
                return;
            }

            const now = new Date();
            const istMinutes = Number(
                now.toLocaleString("en-IN", {
                    timeZone: "Asia/Kolkata",
                    minute: "numeric"
                })
            )
            cronLogger.debug(`Current time check for run minutes`, { istMinutes, now });

            if (!c.IS_TESTING && !c.RUN_MINUTES.includes(istMinutes)) {
                skipLogger.info(
                    `[SKIP] ${symbol}: Not in RUN_MINUTES (Current: ${istMinutes}, Target List: ${c.RUN_MINUTES.join(',')})`
                );
                return;
            }

            if (c.IS_TESTING && !c.RUN_MINUTES.includes(istMinutes)) {
                cronLogger.info(`[TESTING] Bypassing RUN_MINUTES check for ${symbol} (Current: ${istMinutes})`);
            }

            if (!mtf.isAllowed) {
                skipLogger.info(`[SKIP] ${symbol}: MTF evaluation result is not allowed (Score: ${mtf.finalScore}, Decision: ${mtf.decision})`);
                return;
            }

            // ───────────────── TRADE SIDE ─────────────────
            const sideRaw = mtf.direction.toLowerCase() as "buy" | "sell" | "none";

            if (sideRaw === "none") {
                skipLogger.info(`[MarketRegime] SKIP: No breakout direction`, {
                    timeframe: c.TIMEFRAME
                });
                return;
            }

            const side: OrderSide = sideRaw;

            // ───────────────── PRICE VALIDATION ─────────────────
            if (!await Utils.isPriceMovingInOrderSideDirection(
                targetCandle,
                side,
                currentPrice,
                tradingBotId,
                userId,
                symbol,
                c.TIMEFRAME
            )) return;

            // ───────────────── DRY RUN ─────────────────
            if (c.DRY_RUN) {
                skipLogger.info(`[MarketRegime] SKIP: DRY_RUN mode enabled`, {
                    timeframe: c.TIMEFRAME
                });
                return;
            }

            // ───────────────── QUANTITY ─────────────────
            const qty = c.IS_TESTING ? 1 : state.quantity;
            if (!qty) throw new Error("Quantity not found");

            if (qty && qty > c.MAX_QUANTITY) {
                skipLogger.info(`[Quantity] SKIP: Quantity exceeds MAX_QUANTITY`, {
                    timeframe: c.TIMEFRAME,
                    qty,
                    maxQuantity: c.MAX_QUANTITY
                });
                return;
            }

            cronLogger.info(
                `Quantity: ${qty} (IS_TESTING=${c.IS_TESTING})`
            );

            if (!qty || qty <= 0) {
                throw new Error("Invalid trade quantity");
            }

            // ───────────────── ENTRY ORDER ─────────────────
            tradeLogger.info(`[Trade] Placing ${side.toUpperCase()} entry order for ${qty} lots on ${symbol}...`);
            const entry = await deltaExchange.placeEntryOrder(symbol, side, qty);

            cronLogger.info(
                `[Trade] Entry order response: success=${!!entry.result?.id}, OrderID=${entry.result?.id}, Status=${entry.result?.status}, AveragePrice=${entry.result?.average_fill_price}`
            );

            const entryPrice = Utils.resolveEntryPrice(entry);
            const tp = mtf.tp;
            const sl = mtf.sl;

            if (!tp || !sl) {
                cronLogger.error(`[Trade] INVALID TP/SL values generated: TP=${tp}, SL=${sl}`);
                throw new Error(`[Trade] Invalid TP/SL from MTF: TP=${tp}, SL=${sl}`);
            }

            tradeLogger.info(
                `Price levels - Entry: ${entryPrice}, TP: ${tp} (${mtf.tpPerc.toFixed(2)}%), SL: ${sl} (${mtf.slPerc.toFixed(2)}%)`
            );

            // ───────────────── TP / SL ─────────────────
            const tpSlResult = await deltaExchange.placeTPSLBracketOrder(tp, sl, side, { cycleId, tradingBotId });

            if (!tpSlResult.success || !tpSlResult.ids.tp || !tpSlResult.ids.sl) {
                throw new Error(`[Trade] Failed to place TP/SL bracket orders after retries. TP_ID=${tpSlResult.ids.tp}, SL_ID=${tpSlResult.ids.sl}`);
            }

            cronLogger.info(
                `[Trade] TP/SL orders placed: TP_ID=${tpSlResult.ids.tp}, SL_ID=${tpSlResult.ids.sl}`
            );

            // ───────────────── UPDATE STATE ─────────────────
            tradeLogger.info(`[State] Updating trade state with order IDs and price levels...`);
            const updatedState = await TradeState.findOneAndUpdate(
                { tradingBotId: c.id, status: 'open' },
                {
                    $set: {
                        tradeOutcome: "pending",
                        entryOrderId: String(entry.result.id),
                        stopLossOrderId: String(tpSlResult.ids.sl),
                        takeProfitOrderId: String(tpSlResult.ids.tp),
                        entryPrice: entryPrice,
                        slPrice: sl,
                        tpPrice: tp,
                        quantity: qty,
                        currentLevel: state.currentLevel,
                        pnl: state.pnl,
                        cumulativeFees: state.cumulativeFees,
                        allTimePnl: state.allTimePnl,
                        allTimeFees: state.allTimeFees,
                        lastTradeSettledAt: new Date()
                    }
                },
                { new: true }
            );

            if (!updatedState) {
                cronLogger.error(`[State] FAILED to update trade state for bot ${c.id}`);
                throw new Error("Failed to update trade state");
            }

            tradeLogger.info(
                `[State] Trade state updated successfully: Outcome=pending, Level=${updatedState.currentLevel}`
            );



            tradeLogger.info(
                `✓ TRADE COMPLETED SUCCESSFULLY\n`
            );

            // ───────────────── CLEAR LOCAL ERROR ─────────────────
            // Mark the bot as error-free locally so it gets synced to clear on server
            // We also clear status/isActive so we don't accidentally overwrite backend state with old error status
            await BotError.findOneAndUpdate(
                { botId: tradingBotId },
                {
                    message: "",
                    status: 'active',
                    isActive: true,
                    updatedAt: new Date()
                },
                { upsert: true }
            );

        } catch (err) {
            const errorStr = String(err).toLowerCase();
            let errorMessage = "";
            let shouldStop = false;

            if (errorStr.includes("insufficient_balance") || errorStr.includes("insufficient balance") || errorStr.includes("insufficient_margin")) {
                errorMessage = "Insufficient Balance/Margin: Please add funds to your Delta Exchange account.";
                shouldStop = true;
            } else if (errorStr.includes("ip_not_whitelisted") || errorStr.includes("ip not whitelisted")) {
                errorMessage = "IP Not Whitelisted: Ensure your Delta API key allows our server IP.";
                shouldStop = true;
            } else if (errorStr.includes("api_key_invalid") || errorStr.includes("invalid api key") || errorStr.includes("invalid_api_key")) {
                errorMessage = "Invalid API Key: Please check your exchange connection settings.";
                shouldStop = true;
            } else if (errorStr.includes("order_size_too_small")) {
                errorMessage = "Order Size Too Small: Your trade size is below the exchange minimum.";
                shouldStop = false; // Maybe just a temporary config issue
            } else if (errorStr.includes("account_locked")) {
                errorMessage = "Account Locked: Your Delta Exchange account is restricted.";
                shouldStop = true;
            } else if (errorStr.includes("leverage_too_high")) {
                errorMessage = "Leverage Too High: The selected leverage exceeds the allowed limit for this product.";
                shouldStop = true;
            } else if (errorStr.includes("product_not_tradable")) {
                errorMessage = "Product Not Tradable: This symbol is currently not available for trading.";
                shouldStop = true;
            }

            if (errorMessage) {
                cronLogger.error(`[TradingCycle] Specific Error Detected: ${errorMessage}`);
                await BotError.findOneAndUpdate(
                    { botId: tradingBotId },
                    {
                        message: errorMessage,
                        status: shouldStop ? 'stopped' : undefined,
                        isActive: shouldStop ? false : undefined,
                        updatedAt: new Date()
                    },
                    { upsert: true }
                );
            } else {
                // For unknown errors, we still want to log them but maybe not stop the bot
                cronLogger.error(`[TradingCycle] Unknown Error: ${errorStr}`);
                await BotError.findOneAndUpdate(
                    { botId: tradingBotId },
                    {
                        message: `System Error: ${errorStr.substring(0, 100)}...`,
                        // Don't update status/isActive for unknown errors to avoid false deactivations
                        updatedAt: new Date()
                    },
                    { upsert: true }
                );
            }

            errorLogger.error(
                `✗ ERROR in trading cycle:`,
                err as any
            );
            throw err;
        }
    }

}

export const runTradingCycle = (c: ConfigType) =>
    TradingV2.runTradingCycle(c);