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

        const rawConfirmationProbability = confirmationResult.probability;
        const structureProbability = structureResult.probability;

        const breakout = evaluateBreakoutTrade(entryCandles, entryTarget, entryConfig);
        let direction = breakout.direction;
        const entryScore = breakout.score;

        // Evaluate breakout trade on confirmation timeframe
        const confirmationBreakout = evaluateBreakoutTrade(confirmationCandles, confirmationTarget, confirmationConfig);

        // Blend confirmation breakout score with general confirmation probability
        // 🔥 Prioritize 1h Breakout: Increased weight from 0.60 to 0.80
        const confirmationProbability = Math.round(
            (confirmationBreakout.score * 0.80) +
            (rawConfirmationProbability * 0.20)
        );

        marketDetectorLogger.info(`[MTF] Sub-scores for ${entryConfig.SYMBOL}: Entry=${entryScore}, Confirmation=${confirmationProbability} (BO:${confirmationBreakout.score}, Prob:${rawConfirmationProbability}), Structure=${structureProbability}`);
        marketDetectorLogger.debug(`[MTF] Breakout details for ${entryConfig.SYMBOL}: Direction=${breakout.direction}, Score=${breakout.score}, Reason=${breakout.reason}`);
        marketDetectorLogger.debug(`[MTF] Confirmation Breakout details: Direction=${confirmationBreakout.direction}, Score=${confirmationBreakout.score}, Reason=${confirmationBreakout.reason}`);

        const symbol = entryConfig.SYMBOL;

        // 🔥 FALLBACK TO 1H BREAKOUT: If entry (15m) has no breakout, but confirmation (1h) does, inherit direction from 1h
        let isDirectionFromConfirmation = false;
        if (direction === "NONE" && confirmationBreakout.direction !== "NONE") {
            direction = confirmationBreakout.direction;
            isDirectionFromConfirmation = true;
            marketDetectorLogger.info(`[MTF] ${symbol}: No 15m breakout. Inheriting 1h breakout direction instead: ${direction}`);
        }

        // 🔥 TESTING OVERRIDE: If testing and no breakout, force BUY
        if (direction === "NONE" && entryConfig.IS_TESTING) {
            marketDetectorLogger.info(`[TESTING] ${symbol}: Forcing BUY direction since entry search was NONE`);
            direction = "BUY";
        }

        // Direct conflict check: If confirmation timeframe has a breakout in opposite direction
        const hasConfBreakoutMismatch =
            !entryConfig.IS_TESTING &&
            direction !== "NONE" &&
            confirmationBreakout.direction !== "NONE" &&
            confirmationBreakout.direction !== direction;

        if (direction === "NONE" || hasConfBreakoutMismatch) {
            if (hasConfBreakoutMismatch) {
                marketDetectorLogger.info(`[MTF-SKIP] ${symbol}: Direction mismatch between Entry (${direction}) and Confirmation (${confirmationBreakout.direction}) breakouts.`);
            }
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

        // 🔥 Highly Balanced Win-Rate Strategy: 25% Entry, 45% Confirmation, 30% Structure
        let finalScore = Math.round(
            (entryScore * 0.25) +
            (confirmationProbability * 0.45) +
            (structureProbability * 0.30)
        );

        // 🔥 Alignment Bonus: If both 15m and 1h breakouts are aligned, add +10 to final score
        if (!isDirectionFromConfirmation && confirmationBreakout.direction === direction) {
            finalScore = Math.min(100, finalScore + 10);
            marketDetectorLogger.info(`[MTF] ${symbol}: Alignment Bonus! Both 15m and 1h breakouts aligned in ${direction} direction. Added +10 to final score (Final: ${finalScore})`);
        }

        marketDetectorLogger.info(`[MTF] Final Score Calculation: (${entryScore} * 0.25) + (${confirmationProbability} * 0.45) + (${structureProbability} * 0.30) = Final: ${finalScore}`);

        let decision: TradeDecision = "SKIP";

        if (finalScore >= 75) decision = "STRONG_TRADE";
        else if (finalScore >= 70) decision = "GOOD_TRADE";
        else if (finalScore >= 50) decision = "WEAK_TRADE";

        // Preliminary permission based on score
        let isAllowedScore = entryConfig.IS_TESTING || finalScore >= 70;

        /* ================= EXTRA FILTER (OPTIONAL BUT STRONG) ================= */

        const isStrongTrend =
            confirmationProbability > 60 &&
            structureProbability > 60;

        if (!entryConfig.IS_TESTING && !isStrongTrend) {
            const primaryScore = isDirectionFromConfirmation ? confirmationBreakout.score : entryScore;
            if (primaryScore < 65) {
                isAllowedScore = false;
                marketDetectorLogger.info(`[MTF-SKIP] ${symbol}: Breakout source score ${primaryScore} too low under non-strong trend conditions`);
            }
        }

        /* ================= 🔥 DYNAMIC TP/SL ================= */

        let tp = 0;
        let sl = 0;
        let rr = 0;
        let tpPerc = 0;
        let slPerc = 0;
        let structSlPerc = 0;
        let confSlPerc = 0;
        let isExceededMovementLimit = false;
        const leverage = entryConfig.LEVERAGE;

        // 🔥 Use current price if provided, otherwise fallback to candle close
        const entryPrice = currentPriceParam && currentPriceParam > 0 ? currentPriceParam : entryTarget.close;

        if (entryPrice > 0) {
            /* ================= DYNAMIC SL ================= */
            const isStructAligned = (direction === "BUY" && structureTarget.color === "green") ||
                (direction === "SELL" && structureTarget.color === "red");

            const structSlPrice = direction === "BUY" ? structureTarget.low : structureTarget.high;
            const confSlPrice = direction === "BUY" ? confirmationTarget.low : confirmationTarget.high;

            structSlPerc = (Math.abs(entryPrice - structSlPrice) / entryPrice) * 100;
            confSlPerc = (Math.abs(entryPrice - confSlPrice) / entryPrice) * 100;

            const maxLimit = entryConfig.MAX_ALLOWED_PRICE_MOVEMENT_PERCENT;
            let sourceCandle = confirmationTarget;

            if (isStructAligned && structSlPerc <= maxLimit) {
                sourceCandle = structureTarget;
            } else {
                if (confSlPerc > maxLimit) {
                    isExceededMovementLimit = true;
                }
            }

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

        let isAllowed = isAllowedScore && tp > 0 && sl > 0 && !isExceededMovementLimit;


        // 🔥 TREND ALIGNMENT FILTER
        const isAligned = confirmationProbability >= 50 && structureProbability >= 50;
        if (!entryConfig.IS_TESTING && !isAligned) {
            isAllowed = false;
        }

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
            marketDetectorLogger.info(`[MTF-Skip] ${symbol} | Higher timeframe market conditions too weak or choppy: Confirmation=${confirmationProbability}, Structure=${structureProbability}`);
        } else if (isExceededMovementLimit) {
            marketDetectorLogger.info(`[MTF-Skip] ${symbol} | Stop loss percentage limit exceeded: Structure SL Distance=${structSlPerc.toFixed(2)}%, Confirmation SL Distance=${confSlPerc.toFixed(2)}% (Max Limit=${entryConfig.MAX_ALLOWED_PRICE_MOVEMENT_PERCENT}%)`);
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
