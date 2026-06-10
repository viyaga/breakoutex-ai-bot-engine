import { Data } from "./data";
import { deltaExchange } from "./delta-exchange";
import {
    tradingCycleErrorLogger,
    skipTradingLogger,
    tradingCronLogger,
    marketDetectorLogger,
    getContextualLogger,
    tradesLogger,
    mtfAllowedLogger
} from "./logger";
import { ConfigType, TargetCandle, Candle, OrderSide } from "./type";
import { Utils } from "./utils";
import { ProcessPendingState } from "./ProcessPendingState";
import { MultiTimeframeAlignment } from "./market-detector/multi-timeframe";
import { BotError } from "../../models/botError.model";

// Sub-services
import { LeverageManager } from "./leverage-manager";
import { MarketDataService } from "./market-data.service";
import { QuantityCalculator } from "./quantity-calculator";
import { SafetyValidator } from "./safety-validator";
import { OrderExecutor } from "./order-executor";

export class TradingV2 {
    static clearCaches(): void {
        MarketDataService.clearCaches();
    }

    static async getTargetCandle(
        c: {
            SYMBOL: string;
            TIMEFRAME: string;
            CONFIRMATION_TIMEFRAME: string;
            STRUCTURE_TIMEFRAME: string;
        },
        timeframeType: "ENTRY" | "CONFIRMATION" | "STRUCTURE"
    ): Promise<{ target: TargetCandle; candles: Candle[] } | null> {
        return MarketDataService.getTargetCandle(c, timeframeType);
    }

    /* =========================================================================
       PUBLIC ENTRY POINT
    ========================================================================= */

    static async runTradingCycle(c: ConfigType): Promise<void> {
        const { id: tradingBotId, SYMBOL: symbol, USER_ID: userId } = c;
        const cycleId = `cycle-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

        const cronLogger = getContextualLogger(tradingCronLogger, { cycleId, symbol, tradingBotId });
        const skipLogger = getContextualLogger(skipTradingLogger, { cycleId, symbol, tradingBotId });
        const errorLogger = getContextualLogger(tradingCycleErrorLogger, { cycleId, symbol, tradingBotId });
        const detectorLogger = getContextualLogger(marketDetectorLogger, { cycleId, symbol, tradingBotId });
        const tradeLogger = getContextualLogger(tradesLogger, { cycleId, symbol, tradingBotId });
        const mtfAllowedFileLogger = getContextualLogger(mtfAllowedLogger, { cycleId, symbol, tradingBotId });

        cronLogger.info(
            `[TradingCycle] ========== START PROCESSING BOT: ${symbol} (ID: ${tradingBotId}) ==========`
        );

        try {
            // ───────────────── SYNC LEVERAGE ─────────────────
            await LeverageManager.syncLeverage(c, cronLogger);

            // ───────────────── MARKET DATA ─────────────────
            const marketData = await MarketDataService.fetchMarketData(c, cronLogger, skipLogger);
            if (!marketData) {
                return;
            }

            const {
                targetCandle,
                entryCandles,
                confirmationTargetCandle,
                confirmationCandles,
                structureTargetCandle,
                structureCandles,
                currentPrice
            } = marketData;

            // ───────────────── CONVERT USD TO LOTS ─────────────────
            if (!QuantityCalculator.convertTradeSizes(c, currentPrice, cronLogger, skipLogger)) {
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

            detectorLogger.info(
                `[MTF-RESULT] ${symbol}: Score=${mtf.finalScore}, Direction=${mtf.direction}, Decision=${mtf.decision}, Allowed=${mtf.isAllowed}`
            );
            cronLogger.info(
                `[MTF] Result: Score=${mtf.finalScore}, Direction=${mtf.direction}, Decision=${mtf.decision}, Allowed=${mtf.isAllowed}`
            );
            if (mtf.isAllowed) {
                detectorLogger.info(
                    `[MTF-ALLOWED] ${symbol}: Price Levels target: CurrentPrice=${currentPrice}, TP Trigger=${
                        mtf.tp
                    } (${mtf.tpPerc.toFixed(2)}%), TP Limit=${mtf.tpLimit}, SL Trigger=${
                        mtf.sl
                    } (${mtf.slPerc.toFixed(2)}%), SL Limit=${mtf.slLimit}, Net RR=${mtf.rr.toFixed(
                        2
                    )}`
                );
                cronLogger.info(
                    `[MTF] Price Levels target: CurrentPrice=${currentPrice}, TP Trigger=${
                        mtf.tp
                    } (${mtf.tpPerc.toFixed(2)}%), TP Limit=${mtf.tpLimit}, SL Trigger=${
                        mtf.sl
                    } (${mtf.slPerc.toFixed(2)}%), SL Limit=${mtf.slLimit}, Net RR=${mtf.rr.toFixed(
                        2
                    )}`
                );

                // Log to separate file for MTF allowed trades
                mtfAllowedFileLogger.info(
                    `[ALLOWED] ${symbol} | CurrentPrice: ${currentPrice} | Score: ${
                        mtf.finalScore
                    } (Entry:${mtf.entryScore}, Conf:${mtf.confirmationProbability}, Struct:${
                        mtf.structureProbability
                    }) | TP Trigger: ${mtf.tp} (${mtf.tpPerc.toFixed(2)}%) | TP Limit: ${
                        mtf.tpLimit
                    } | SL Trigger: ${mtf.sl} (${mtf.slPerc.toFixed(2)}%) | SL Limit: ${
                        mtf.slLimit
                    } | RR: ${mtf.rr.toFixed(2)} | Fees: ${
                        c.ESTIMATED_FEE_PERCENT
                    }% | Dir: ${mtf.direction}`
                );
            }

            // 🔥 RISK REDUCTION: Cap max multiplier at 1.2 instead of 1.5 to reduce capital margin requirement by 20% while still recovering debt in profit
            const minFinal = c.MIN_FINAL_SCORE ?? 70;
            const scoreMultiplier =
                mtf.finalScore > 90
                    ? 2
                    : mtf.finalScore > 85
                    ? 1.5
                    : mtf.finalScore > 80
                    ? 1.2
                    : mtf.finalScore > 75
                    ? 1
                    : mtf.finalScore >= minFinal
                    ? 0.5
                    : 0;

            // ───────────────── STATE ─────────────────
            let state = await Data.getOrCreateState(
                c.id,
                c.USER_ID,
                c.SYMBOL,
                c.PRODUCT_ID,
                scoreMultiplier,
                currentPrice
            );

            cronLogger.info(
                `[State] Loaded state: ID=${state.id}, Level=${
                    state.currentLevel
                }, DailyPnL=$${state.dailyPnl.toFixed(2)}, Outcome=${state.tradeOutcome}, Status=${
                    state.status
                }`
            );

            // ───────────────── HANDLE PENDING TRADE ─────────────────
            if (state.entryOrderId && Utils.isTradePending(state)) {
                cronLogger.info(
                    `Found pending trade with order ID: ${state.entryOrderId}. Fetching order details...`
                );

                const orderDetails = await deltaExchange.getOrderDetails(state.entryOrderId);

                if (!orderDetails) {
                    throw new Error("Failed to fetch order details for pending trade.");
                }

                cronLogger.info(`Order details retrieved: Status=${orderDetails.status}`);

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

                cronLogger.info(`Pending state processed: NewOutcome=${state.tradeOutcome}`);

                if (Utils.isTradePending(state)) return;

                if (state.status === "closed") {
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

            // ───────────────── SAFETY VALIDATION (DAILY LOSS, WEEKEND, RUN MINUTES) ─────────────────
            const now = new Date();
            if (!SafetyValidator.validate(c, state, mtf, now, cronLogger, skipLogger)) {
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
            if (
                !(await Utils.isPriceMovingInOrderSideDirection(
                    targetCandle,
                    side,
                    currentPrice,
                    tradingBotId,
                    userId,
                    symbol,
                    c.TIMEFRAME
                ))
            ) {
                return;
            }

            // ───────────────── DRY RUN ─────────────────
            if (c.DRY_RUN) {
                skipLogger.info(`[MarketRegime] SKIP: DRY_RUN mode enabled`, {
                    timeframe: c.TIMEFRAME
                });
                return;
            }

            // ───────────────── EXECUTE ORDER ─────────────────
            await OrderExecutor.placeTrade(
                c,
                state,
                side,
                mtf,
                cycleId,
                cronLogger,
                tradeLogger
            );
        } catch (err) {
            const errorStr = String(err).toLowerCase();
            let errorMessage = "";
            let shouldStop = false;

            if (
                errorStr.includes("insufficient_balance") ||
                errorStr.includes("insufficient balance") ||
                errorStr.includes("insufficient_margin")
            ) {
                errorMessage =
                    "Insufficient Balance/Margin: Please add funds to your Delta Exchange account.";
                shouldStop = true;
            } else if (
                errorStr.includes("ip_not_whitelisted") ||
                errorStr.includes("ip not whitelisted")
            ) {
                errorMessage = "IP Not Whitelisted: Ensure your Delta API key allows our server IP.";
                shouldStop = true;
            } else if (
                errorStr.includes("api_key_invalid") ||
                errorStr.includes("invalid api key") ||
                errorStr.includes("invalid_api_key")
            ) {
                errorMessage =
                    "Invalid API Key: Please check your exchange connection settings.";
                shouldStop = true;
            } else if (errorStr.includes("order_size_too_small")) {
                errorMessage = "Order Size Too Small: Your trade size is below the exchange minimum.";
                shouldStop = false; // Maybe just a temporary config issue
            } else if (errorStr.includes("account_locked")) {
                errorMessage = "Account Locked: Your Delta Exchange account is restricted.";
                shouldStop = true;
            } else if (errorStr.includes("leverage_too_high")) {
                errorMessage =
                    "Leverage Too High: The selected leverage exceeds the allowed limit for this product.";
                shouldStop = true;
            } else if (errorStr.includes("product_not_tradable")) {
                errorMessage =
                    "Product Not Tradable: This symbol is currently not available for trading.";
                shouldStop = true;
            }

            if (errorMessage) {
                cronLogger.error(`[TradingCycle] Specific Error Detected: ${errorMessage}`);
                await BotError.findOneAndUpdate(
                    { botId: tradingBotId },
                    {
                        message: errorMessage,
                        status: shouldStop ? "stopped" : undefined,
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

            errorLogger.error(`✗ ERROR in trading cycle:`, err as any);
            throw err;
        }
    }
}

export const runTradingCycle = (c: ConfigType): Promise<void> => TradingV2.runTradingCycle(c);