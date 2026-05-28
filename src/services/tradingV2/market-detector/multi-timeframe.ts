import { marketDetectorLogger } from "../logger";
import { Candle, ConfigType, TargetCandle } from "../type";
import { MarketDetector } from "./market-detector";
import { evaluateBreakoutTrade } from "./master-breakout-system";
import { calculateATR } from "./indicators"; // 🔥 NEW
import { Utils } from "../utils";

export type TradeDecision = "STRONG_TRADE" | "GOOD_TRADE" | "WEAK_TRADE" | "SKIP";

export interface TripleTFResult {
    entryScore: number;
    confirmationProbability: number;
    structureProbability: number;
    finalScore: number;
    decision: TradeDecision;
    isAllowed: boolean;
    direction: "BUY" | "SELL" | "NONE";

    // 🔥 NEW
    tp: number;
    sl: number;
    rr: number;
    tpPerc: number;
    slPerc: number;
}

export class MultiTimeframeAlignment {
    static evaluate(
        entryTarget: TargetCandle,
        confirmationTarget: TargetCandle,
        structureTarget: TargetCandle,
        entryCandles: Candle[],
        confirmationCandles: Candle[],
        structureCandles: Candle[],
        entryConfig: ConfigType,
        confirmationConfig: ConfigType,
        structureConfig: ConfigType,
        currentPriceParam?: number,
        logContext?: any
    ): TripleTFResult {

        const confirmationResult = MarketDetector.getMarketProbability(
            confirmationTarget,
            confirmationCandles,
            confirmationConfig,
            "confirmation",
            logContext
        );

        const structureResult = MarketDetector.getMarketProbability(
            structureTarget,
            structureCandles,
            structureConfig,
            "structure",
            logContext
        );

        const confirmationProbability = confirmationResult.probability;
        const structureProbability = structureResult.probability;

        const breakout = evaluateBreakoutTrade(entryCandles, entryTarget, entryConfig);
        let direction = breakout.direction;
        const entryScore = breakout.score;

        marketDetectorLogger.info(`[MTF] Sub-scores for ${entryConfig.SYMBOL}: Entry=${entryScore}, Confirmation=${confirmationProbability}, Structure=${structureProbability}`);
        marketDetectorLogger.debug(`[MTF] Breakout details for ${entryConfig.SYMBOL}: Direction=${breakout.direction}, Score=${breakout.score}, Reason=${breakout.reason}`);

        const symbol = entryConfig.SYMBOL;

        // 🔥 TESTING OVERRIDE: If testing and no breakout, force BUY
        if (direction === "NONE" && entryConfig.IS_TESTING) {
            marketDetectorLogger.info(`[TESTING] ${symbol}: Forcing BUY direction since entry search was NONE`);
            direction = "BUY";
        }

        if (direction === "NONE") {
            return {
                entryScore,
                confirmationProbability,
                structureProbability,
                finalScore: 0,
                decision: "SKIP",
                isAllowed: false,
                direction: "NONE",
                tp: 0,
                sl: 0,
                rr: 0,
                tpPerc: 0,
                slPerc: 0,
            };
        }

        /* ================= FINAL SCORE ================= */

        const finalScore = Math.round(
            (entryScore * 0.50) +
            (confirmationProbability * 0.25) +
            (structureProbability * 0.25)
        );

        marketDetectorLogger.info(`[MTF] Final Score Calculation: (${entryScore} * 0.5) + (${confirmationProbability} * 0.25) + (${structureProbability} * 0.25) = ${finalScore}`);

        let decision: TradeDecision = "SKIP";

        if (finalScore >= 75) decision = "STRONG_TRADE";
        else if (finalScore >= 65) decision = "GOOD_TRADE";
        else if (finalScore >= 50) decision = "WEAK_TRADE";

        // Preliminary permission based on score
        let isAllowedScore = entryConfig.IS_TESTING || finalScore >= 65;

        /* ================= EXTRA FILTER (OPTIONAL BUT STRONG) ================= */

        const isStrongTrend =
            confirmationProbability > 60 &&
            structureProbability > 60;

        if (!entryConfig.IS_TESTING && !isStrongTrend && entryScore < 65) {
            isAllowedScore = false;
        }

        /* ================= 🔥 DYNAMIC TP/SL ================= */

        let tp = 0;
        let sl = 0;
        let rr = 0;
        let tpPerc = 0;
        let slPerc = 0;
        const leverage = entryConfig.LEVERAGE;

        // 🔥 Use current price if provided, otherwise fallback to candle close
        const entryPrice = currentPriceParam && currentPriceParam > 0 ? currentPriceParam : entryTarget.close;

        if (entryPrice > 0) {
            /* ================= DYNAMIC SL ================= */
            const isStructAligned = (direction === "BUY" && structureTarget.color === "green") ||
                                    (direction === "SELL" && structureTarget.color === "red");
            
            const sourceCandle = isStructAligned ? structureTarget : confirmationTarget;

            if (direction === "BUY") {
                sl = sourceCandle.low * (1 - entryConfig.SL_TRIGGER_BUFFER_PERCENT / 100);
            } else {
                sl = sourceCandle.high * (1 + entryConfig.SL_TRIGGER_BUFFER_PERCENT / 100);
            }
            sl = parseFloat(sl.toFixed(entryConfig.PRICE_DECIMAL_PLACES));

            /* ================= FIXED 30% TP ================= */
            if (direction === "BUY") {
                tp = entryPrice * 1.30;
            } else {
                tp = entryPrice * 0.70;
            }

            if (tp <= 0) {
                // Minimum positive value based on decimals (e.g., 0.0001 for 4)
                tp = parseFloat((1 / Math.pow(10, entryConfig.PRICE_DECIMAL_PLACES)).toFixed(entryConfig.PRICE_DECIMAL_PLACES));
            } else {
                tp = parseFloat(tp.toFixed(entryConfig.PRICE_DECIMAL_PLACES));
            }

            /* ================= METRICS & RR ================= */
            const slLimit = direction === "BUY"
                ? sourceCandle.low * (1 - entryConfig.SL_LIMIT_BUFFER_PERCENT / 100)
                : sourceCandle.high * (1 + entryConfig.SL_LIMIT_BUFFER_PERCENT / 100);

            const rawRisk = Math.abs(entryPrice - sl);
            const riskPriceDist = Math.abs(entryPrice - slLimit);
            const rewardPriceDist = Math.abs(tp - entryPrice);

            // Include Estimated Fees in RR
            const feePercent = entryConfig.ESTIMATED_FEE_PERCENT / 100;
            const entryFee = entryPrice * (feePercent / 2);
            const exitFeeTp = tp * (feePercent / 2);
            const exitFeeSl = sl * (feePercent / 2);

            const netReward = rewardPriceDist - (entryFee + exitFeeTp);
            const netRisk = riskPriceDist + (entryFee + exitFeeSl);

            rr = netRisk > 0 ? netReward / netRisk : 0;

            tpPerc = entryPrice > 0 ? (rewardPriceDist / entryPrice) * 100 * leverage : 0;
            slPerc = entryPrice > 0 ? (riskPriceDist / entryPrice) * 100 * leverage : 0;

            marketDetectorLogger.info(`[MTF] Structural TP/SL for ${symbol}: Entry=${entryPrice}, TP=${tp} (${tpPerc.toFixed(2)}%), SL=${sl} (${slPerc.toFixed(2)}%), Net RR=${rr.toFixed(2)} (Fees incl.)`);
        }

        /* ================= FINAL PERMISSION ================= */

        let isAllowed = isAllowedScore && tp > 0 && sl > 0;


        // 🔥 TREND ALIGNMENT FILTER
        const isAligned = confirmationProbability >= 50 && structureProbability >= 50;
        if (!entryConfig.IS_TESTING && !isAligned) {
            isAllowed = false;
        }

        // 🔥 TREND DIRECTION ALIGNMENT FILTER (EMA 20/50 on higher timeframes)
        const confEma20 = Utils.calculateEMA(confirmationCandles, 20);
        const confEma50 = Utils.calculateEMA(confirmationCandles, 50);
        const structEma20 = Utils.calculateEMA(structureCandles, 20);
        const structEma50 = Utils.calculateEMA(structureCandles, 50);

        let isTrendDirectionAligned = true;
        let trendAlignReason = "";
        if (direction === "BUY") {
            const isConfBullish = confEma20 > confEma50;
            const isStructBullish = structEma20 > structEma50;
            isTrendDirectionAligned = isConfBullish && isStructBullish;
            if (!isTrendDirectionAligned) {
                trendAlignReason = `BUY direction but not aligned: Confirmation (1h) Bullish=${isConfBullish} (EMA20/50: ${confEma20.toFixed(4)}/${confEma50.toFixed(4)}), Structure (4h) Bullish=${isStructBullish} (EMA20/50: ${structEma20.toFixed(4)}/${structEma50.toFixed(4)})`;
            }
        } else if (direction === "SELL") {
            const isConfBearish = confEma20 < confEma50;
            const isStructBearish = structEma20 < structEma50;
            isTrendDirectionAligned = isConfBearish && isStructBearish;
            if (!isTrendDirectionAligned) {
                trendAlignReason = `SELL direction but not aligned: Confirmation (1h) Bearish=${isConfBearish} (EMA20/50: ${confEma20.toFixed(4)}/${confEma50.toFixed(4)}), Structure (4h) Bearish=${isStructBearish} (EMA20/50: ${structEma20.toFixed(4)}/${structEma50.toFixed(4)})`;
            }
        }

        if (!entryConfig.IS_TESTING && !isTrendDirectionAligned) {
            isAllowed = false;
        }

        /* ================= LOG ================= */

        /* ================= LOG ================= */
        const mtfLogPrefix = isAllowed ? '[MTF-Allowed]' : '[MTF-Skip]';
        marketDetectorLogger.info(`${mtfLogPrefix} ${symbol} | FS: ${finalScore} | Dir: ${direction} | Dec: ${decision} | RR: ${rr.toFixed(2)} | TP: ${tp} | SL: ${sl}`);

        if (isAllowed) {
            marketDetectorLogger.debug(`[MarketProbability] ${symbol} Confirmation`, {
                probability: confirmationResult.probability,
                isAllowed: confirmationResult.isAllowed,
                mode: confirmationResult.mode,
                details: confirmationResult.details,
            });

            marketDetectorLogger.debug(`[MarketProbability] ${symbol} Structure`, {
                probability: structureResult.probability,
                isAllowed: structureResult.isAllowed,
                mode: structureResult.mode,
                details: structureResult.details,
            });
        } else if (!entryConfig.IS_TESTING && !isAligned) {
            marketDetectorLogger.info(`[MTF-Skip] ${symbol} | Trend not aligned: Confirmation=${confirmationProbability}, Structure=${structureProbability}`);
        } else if (!entryConfig.IS_TESTING && !isTrendDirectionAligned) {
            marketDetectorLogger.info(`[MTF-Skip] ${symbol} | ${trendAlignReason}`);
        }

        return {
            entryScore,
            confirmationProbability,
            structureProbability,
            finalScore,
            decision,
            isAllowed,
            direction,
            tp,
            sl,
            rr,
            tpPerc,
            slPerc,
        };
    }
}
