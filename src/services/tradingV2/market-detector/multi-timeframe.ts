import { marketDetectorLogger } from "../logger";
import { Candle, ConfigType, TargetCandle, OrderSide } from "../type";
import { MarketDetector } from "./market-detector";
import { evaluateBreakoutTrade } from "./master-breakout-system";
import { getRollingATRPercentAvg } from "./indicators";
import { Utils } from "../utils";

export type TradeDecision = "STRONG_TRADE" | "GOOD_TRADE" | "WEAK_TRADE" | "SKIP" | "TEST_TRADE";

export interface TripleTFResult {
    entryScore: number;
    confirmationProbability: number;
    structureProbability: number;
    finalScore: number;
    decision: TradeDecision;
    isAllowed: boolean;
    direction: "BUY" | "SELL" | "NONE";
    breakoutTimeframe?: string;

    // 🔥 NEW
    tp: number;
    sl: number;
    rr: number;
    tpPerc: number;
    slPerc: number;
    slLimit: number;
    tpLimit: number;
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
        logContext?: any,
        positionSideOverride?: OrderSide
    ): TripleTFResult {

        // 🔥 Use current price if provided, otherwise fallback to candle close (Hybrid/Real-time MTF Evaluation)
        const entryPrice = currentPriceParam && currentPriceParam > 0 ? currentPriceParam : entryTarget.close;

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
        let direction = positionSideOverride
            ? (positionSideOverride.toUpperCase() as "BUY" | "SELL")
            : breakout.direction;
        const entryScore = breakout.score;

        // Evaluate breakout trade on confirmation and structure timeframes
        const confirmationBreakout = evaluateBreakoutTrade(confirmationCandles, confirmationTarget, confirmationConfig);
        const structureBreakout = evaluateBreakoutTrade(structureCandles, structureTarget, structureConfig);

        // 🔥 HIGHEST TIMEFRAME BREAKOUT PRIORITY: 1h > 15m > 5m
        let breakoutTimeframe: string = entryConfig.TIMEFRAME || "5m";
        if (structureBreakout.direction !== "NONE") {
            breakoutTimeframe = entryConfig.STRUCTURE_TIMEFRAME || "1h";
        } else if (confirmationBreakout.direction !== "NONE") {
            breakoutTimeframe = entryConfig.CONFIRMATION_TIMEFRAME || "15m";
        } else if (breakout.direction !== "NONE") {
            breakoutTimeframe = entryConfig.TIMEFRAME || "5m";
        }

        // Blend confirmation breakout score with general confirmation probability
        // 🔥 Prioritize 1h Breakout: Increased weight from 0.60 to 0.80
        const confirmationProbability = Math.round(
            (confirmationBreakout.score * 0.80) +
            (rawConfirmationProbability * 0.20)
        );

        const evalTag = positionSideOverride ? `[MTF-PosMgmt:${positionSideOverride}]` : `[MTF-NewEntry]`;

        marketDetectorLogger.info(`${evalTag} Sub-scores for ${entryConfig.SYMBOL}: Entry=${entryScore}, Confirmation=${confirmationProbability} (BO:${confirmationBreakout.score}, Prob:${rawConfirmationProbability}), Structure=${structureProbability}`);
        marketDetectorLogger.debug(`${evalTag} Breakout details for ${entryConfig.SYMBOL}: 5m Entry Dir=${breakout.direction}, Score=${breakout.score}, Reason=${breakout.reason}`);
        marketDetectorLogger.debug(`${evalTag} 15m Confirmation Breakout details: Dir=${confirmationBreakout.direction}, Score=${confirmationBreakout.score}, Reason=${confirmationBreakout.reason}`);
        marketDetectorLogger.debug(`${evalTag} 1h Structure Breakout details: Dir=${structureBreakout.direction}, Score=${structureBreakout.score}, Reason=${structureBreakout.reason}`);
        marketDetectorLogger.info(`${evalTag} ${entryConfig.SYMBOL}: Active Breakout Timeframe identified: ${breakoutTimeframe} (Priority: 1h > 15m > 5m)`);

        const symbol = entryConfig.SYMBOL;

        // 🔥 FALLBACK TO 15M BREAKOUT: If 5m entry has no breakout, but 15m confirmation does, inherit direction from 15m
        let isDirectionFromConfirmation = false;
        if (direction === "NONE" && confirmationBreakout.direction !== "NONE") {
            direction = confirmationBreakout.direction;
            isDirectionFromConfirmation = true;
            marketDetectorLogger.info(`${evalTag} ${symbol}: No 5m breakout. Inheriting 15m confirmation breakout direction instead: ${direction}`);
        }

        // 🔥 TESTING OVERRIDE: If testing and no breakout, force BUY
        if (direction === "NONE" && entryConfig.IS_TESTING) {
            marketDetectorLogger.info(`[TESTING] ${symbol}: Forcing BUY direction since entry search was NONE`);
            direction = "BUY";
        }

        // Direct conflict check: If confirmation timeframe has a breakout in opposite direction
        const hasConfBreakoutMismatch =
            !positionSideOverride &&
            !entryConfig.IS_TESTING &&
            direction !== "NONE" &&
            confirmationBreakout.direction !== "NONE" &&
            confirmationBreakout.direction !== direction;

        if (direction === "NONE" || hasConfBreakoutMismatch) {
            if (hasConfBreakoutMismatch) {
                marketDetectorLogger.info(`${evalTag}[Skip] ${symbol}: Direction mismatch between Entry (${direction}) and Confirmation (${confirmationBreakout.direction}) breakouts.`);
            }
            return {
                entryScore,
                confirmationProbability,
                structureProbability,
                finalScore: 0,
                decision: "SKIP",
                isAllowed: false,
                direction: "NONE",
                breakoutTimeframe,
                tp: 0,
                sl: 0,
                rr: 0,
                tpPerc: 0,
                slPerc: 0,
                slLimit: 0,
                tpLimit: 0,
            };
        }

        /* ================= STRUCTURE TREND DIRECTION ALIGNMENT ================= */
        const structEma20 = Utils.calculateEMA(structureCandles, 20);
        let isStructTrendAligned = true;
        if (structEma20 > 0) {
            // 🔥 Hybrid approach: Compare the real-time entryPrice against the structure EMA
            if (direction === "BUY" && entryPrice < structEma20) {
                isStructTrendAligned = false;
            } else if (direction === "SELL" && entryPrice > structEma20) {
                isStructTrendAligned = false;
            }
        }

        /* ================= FINAL SCORE ================= */

        // 🔥 Highly Balanced Win-Rate Strategy: 25% Entry, 45% Confirmation, 30% Structure
        let finalScore = Math.round(
            (entryScore * 0.25) +
            (confirmationProbability * 0.45) +
            (structureProbability * 0.30)
        );

        // 🔥 Breakout Alignment Bonus: If both 5m entry and 15m confirmation breakouts are active and aligned in the same direction
        const is5mBreakoutActive = breakout.direction !== "NONE";
        const is15mBreakoutActive = confirmationBreakout.direction !== "NONE";
        if (is5mBreakoutActive && is15mBreakoutActive && breakout.direction === confirmationBreakout.direction) {
            finalScore = Math.min(100, finalScore + 10);
            marketDetectorLogger.info(`${evalTag} ${symbol}: Breakout Alignment Bonus! Both 5m (${breakout.direction}) and 15m (${confirmationBreakout.direction}) breakouts aligned. +10 added to score (Final: ${finalScore})`);
        }

        // 🔥 Trend Alignment Score Adjustment (Instead of blocking the trade)
        const isAligned = confirmationProbability >= 50 && structureProbability >= 50 && isStructTrendAligned;
        if (isAligned) {
            finalScore = Math.min(100, finalScore + 5);
            marketDetectorLogger.info(`${evalTag} ${symbol}: Trend Aligned Bonus! 1h EMA trend aligned. +5 added to score (Final: ${finalScore})`);
        } else {
            const penalty = 15;
            const reasons = [];
            if (confirmationProbability < 50) reasons.push(`Confirmation Prob < 50 (${confirmationProbability})`);
            if (structureProbability < 50) reasons.push(`Structure Prob < 50 (${structureProbability})`);
            if (!isStructTrendAligned) reasons.push("Structure EMA trend mismatch");

            finalScore = Math.max(0, finalScore - penalty);
            marketDetectorLogger.info(`${evalTag} ${symbol}: Trend Alignment Mismatch (${reasons.join(", ")}). -${penalty} penalty applied to score (Final: ${finalScore})`);
        }

        marketDetectorLogger.info(`${evalTag} Final Score Calculation: (5m:${entryScore} * 0.25) + (15m:${confirmationProbability} * 0.45) + (1h:${structureProbability} * 0.30) [with adjustments] = Final: ${finalScore}`);

        let decision: TradeDecision = "SKIP";

        if (finalScore >= 75) decision = "STRONG_TRADE";
        else if (finalScore >= 70) decision = "GOOD_TRADE";
        else if (finalScore >= 50) decision = "WEAK_TRADE";

        const minEntry = entryConfig.MIN_ENTRY_SCORE ?? 60;
        const minConf = entryConfig.MIN_CONFIRMATION_SCORE ?? 60;
        const minStruct = entryConfig.MIN_STRUCTURE_SCORE ?? 60;

        const isPassingMinScores =
            entryScore >= minEntry &&
            confirmationProbability >= minConf &&
            structureProbability >= minStruct;

        const minFinal = entryConfig.MIN_FINAL_SCORE ?? 70;

        // Preliminary permission based on score
        let isAllowedScore = entryConfig.IS_TESTING || (finalScore >= minFinal && isPassingMinScores);

        /* ================= EXTRA FILTER (OPTIONAL BUT STRONG) ================= */

        const isStrongTrend =
            confirmationProbability > 60 &&
            structureProbability > 60;

        if (!entryConfig.IS_TESTING && !isStrongTrend) {
            const primaryScore = isDirectionFromConfirmation ? confirmationBreakout.score : entryScore;
            if (primaryScore < 65) {
                isAllowedScore = false;
                marketDetectorLogger.info(`${evalTag}[Skip] ${symbol}: Breakout source score ${primaryScore} too low under non-strong trend conditions`);
            }
        }

        /* ================= 🔥 DYNAMIC TP/SL ================= */
        const levels = this.calculateSlTpLevels(
            direction,
            entryPrice,
            structureTarget,
            confirmationTarget,
            entryConfig,
            confirmationCandles,
            structureCandles,
            finalScore,
            isAllowedScore
        );

        const {
            tp,
            sl,
            rr,
            tpPerc,
            slPerc,
            slLimit,
            tpLimit,
            isSlAlreadyCrossed,
            crossedReason,
            isExceededMovementLimit,
            structSlPerc,
            confSlPerc
        } = levels;

        /* ================= FINAL PERMISSION ================= */
        // If we are overriding the side for an already open trade, bypass entry-based safety checks.
        const minRr = Math.max(1.0, entryConfig.MIN_RR ?? 1.0);
        let isAllowed = positionSideOverride
            ? tp > 0 && sl > 0
            : entryConfig.IS_TESTING
                ? tp > 0 && sl > 0
                : isAllowedScore && tp > 0 && sl > 0 && !isExceededMovementLimit && !isSlAlreadyCrossed && rr >= minRr;

        if (entryConfig.IS_TESTING && isAllowed && decision === "SKIP") {
            decision = "TEST_TRADE";
        }

        /* ================= LOG ================= */

        const mtfLogPrefix = isAllowed ? `${evalTag}[Allowed]` : `${evalTag}[Skip]`;
        marketDetectorLogger.info(`${mtfLogPrefix} ${symbol} | FS: ${finalScore} | Dir: ${direction} | Dec: ${decision}${entryConfig.IS_TESTING ? " [IS_TESTING=true]" : ""} | CurrentPrice: ${entryPrice} | TP Trigger: ${tp} | TP Limit: ${tpLimit} | SL Trigger: ${sl} | RR: ${rr.toFixed(2)}`);

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

            if (entryConfig.IS_TESTING) {
                const warnings: string[] = [];
                if (rr < minRr) {
                    warnings.push(`Risk-Reward ratio below minimum: RR=${rr.toFixed(2)} (Min:${minRr})`);
                }
                if (isSlAlreadyCrossed) {
                    warnings.push(`Stop loss boundary already crossed before entry: ${crossedReason}`);
                }
                if (isExceededMovementLimit) {
                    warnings.push(`Stop loss percentage limit exceeded: Structure SL Distance=${structSlPerc.toFixed(2)}%, Confirmation SL Distance=${confSlPerc.toFixed(2)}% (Max Limit=${entryConfig.MAX_ALLOWED_PRICE_MOVEMENT_PERCENT}%)`);
                }
                if (!isPassingMinScores) {
                    warnings.push(`Individual timeframe score below minimum: Entry=${entryScore} (Min:${minEntry}), Confirmation=${confirmationProbability} (Min:${minConf}), Structure=${structureProbability} (Min:${minStruct})`);
                }
                if (finalScore < minFinal) {
                    warnings.push(`Final score below minimum: Score=${finalScore} (Min:${minFinal})`);
                }

                if (warnings.length > 0) {
                    marketDetectorLogger.warn(`⚠️ [TESTING-WARNING] ${symbol} (Would be skipped in Production): \n${warnings.map(w => `      * ${w}`).join('\n')}`);
                }
            }
        } else if (!entryConfig.IS_TESTING && !isPassingMinScores) {
            marketDetectorLogger.info(`[MTF-Skip] ${symbol} | Individual timeframe score below minimum: Entry=${entryScore} (Min:${minEntry}), Confirmation=${confirmationProbability} (Min:${minConf}), Structure=${structureProbability} (Min:${minStruct})`);
        } else if (isSlAlreadyCrossed) {
            marketDetectorLogger.info(`[MTF-Skip] ${symbol} | Stop loss boundary already crossed before entry: ${crossedReason}`);
        } else if (isExceededMovementLimit) {
            marketDetectorLogger.info(`[MTF-Skip] ${symbol} | Stop loss percentage limit exceeded: Structure SL Distance=${structSlPerc.toFixed(2)}%, Confirmation SL Distance=${confSlPerc.toFixed(2)}% (Max Limit=${entryConfig.MAX_ALLOWED_PRICE_MOVEMENT_PERCENT}%)`);
        } else if (rr < minRr) {
            marketDetectorLogger.info(`[MTF-Skip] ${symbol} | Risk-Reward ratio below minimum: RR=${rr.toFixed(2)} (Min:${minRr})`);
        }

        return {
            entryScore,
            confirmationProbability,
            structureProbability,
            finalScore,
            decision,
            isAllowed,
            direction,
            breakoutTimeframe,
            tp,
            sl,
            rr,
            tpPerc,
            slPerc,
            slLimit,
            tpLimit,
        };
    }

    /**
     * Calculates dynamic Stop Loss and Take Profit levels, along with risk metrics and bounds.
     * Structured as a separate helper for readability, maintainability, and testing.
     */
    private static calculateSlTpLevels(
        direction: "BUY" | "SELL",
        entryPrice: number,
        structureTarget: TargetCandle,
        confirmationTarget: TargetCandle,
        entryConfig: ConfigType,
        confirmationCandles: Candle[],
        structureCandles: Candle[],
        finalScore: number,
        isAllowedScore: boolean = false
    ): {
        sl: number;
        tp: number;
        rr: number;
        tpPerc: number;
        slPerc: number;
        slLimit: number;
        tpLimit: number;
        isSlAlreadyCrossed: boolean;
        crossedReason: string;
        isExceededMovementLimit: boolean;
        structSlPerc: number;
        confSlPerc: number;
    } {
        let tp = 0;
        let sl = 0;
        let rr = 0;
        let tpPerc = 0;
        let slPerc = 0;
        let structSlPerc = 0;
        let confSlPerc = 0;
        let slLimit = 0;
        let tpLimit = 0;
        let isSlAlreadyCrossed = false;
        let crossedReason = "";
        let isExceededMovementLimit = false;
        const leverage = entryConfig.LEVERAGE;

        if (entryPrice > 0) {
            /* ================= DYNAMIC ATR CALCULATION ================= */
            const structSlPrice = direction === "BUY" ? structureTarget.low : structureTarget.high;
            const confSlPrice = direction === "BUY" ? confirmationTarget.low : confirmationTarget.high;

            structSlPerc = (Math.abs(entryPrice - structSlPrice) / entryPrice) * 100;
            confSlPerc = (Math.abs(entryPrice - confSlPrice) / entryPrice) * 100;

            const maxLimit = entryConfig.MAX_ALLOWED_PRICE_MOVEMENT_PERCENT;
            let sourceCandle = confirmationTarget;
            let sourceCandles = confirmationCandles;

            if (structSlPerc <= maxLimit) {
                sourceCandle = structureTarget;
                sourceCandles = structureCandles;
            } else {
                if (confSlPerc > maxLimit) {
                    isExceededMovementLimit = true;
                }
            }

            let atrPercent = getRollingATRPercentAvg(sourceCandles, 14);
            if (!atrPercent || isNaN(atrPercent) || atrPercent <= 0) {
                atrPercent = 1.0; // fallback default volatility
            }
            const atrDistance = entryPrice * (atrPercent / 100);

            /* ================= ATR EXTREME REGIME FILTER ================= */
            if (atrPercent < 0.15) {
                marketDetectorLogger.warn(`[ATR-Filter] ${entryConfig.SYMBOL} ATR% is extremely low (${atrPercent.toFixed(4)}%), market may be range-bound/dead`);
            } else if (atrPercent > 4.5) {
                marketDetectorLogger.warn(`[ATR-Filter] ${entryConfig.SYMBOL} ATR% is abnormally high (${atrPercent.toFixed(4)}%), market shows extreme volatility`);
            }

            /* ================= CANDLE LOW / HIGH SL ================= */
            let structSl: number;

            if (direction === "BUY") {
                const rawSwingLow = sourceCandle.low;
                structSl = rawSwingLow;
                sl = rawSwingLow * (1 - entryConfig.SL_TRIGGER_BUFFER_PERCENT / 100);
            } else {
                const rawSwingHigh = sourceCandle.high;
                structSl = rawSwingHigh;
                sl = rawSwingHigh * (1 + entryConfig.SL_TRIGGER_BUFFER_PERCENT / 100);
            }
            sl = parseFloat(sl.toFixed(entryConfig.PRICE_DECIMAL_PLACES));

            marketDetectorLogger.info(
                `[CandleSL] ${entryConfig.SYMBOL} | Candle ${direction === "BUY" ? "Low" : "High"}=${structSl.toFixed(entryConfig.PRICE_DECIMAL_PLACES)} | Trigger Buffer=${entryConfig.SL_TRIGGER_BUFFER_PERCENT}% | Final SL=${sl}`
            );

            /* ================= SL CROSSING SAFETIES ================= */
            if (direction === "BUY") {
                if (entryPrice <= sl) {
                    isSlAlreadyCrossed = true;
                    crossedReason = `Current price (${entryPrice}) is already below or equal to SL trigger (${sl})`;
                } else if (entryPrice <= sourceCandle.low) {
                    isSlAlreadyCrossed = true;
                    crossedReason = `Current price (${entryPrice}) is already below or equal to source candle low (${sourceCandle.low})`;
                }
            } else if (direction === "SELL") {
                if (entryPrice >= sl) {
                    isSlAlreadyCrossed = true;
                    crossedReason = `Current price (${entryPrice}) is already above or equal to SL trigger (${sl})`;
                } else if (entryPrice >= sourceCandle.high) {
                    isSlAlreadyCrossed = true;
                    crossedReason = `Current price (${entryPrice}) is already above or equal to source candle high (${sourceCandle.high})`;
                }
            }

            /* ================= METRICS & RR (PRELIMINARY) ================= */
            slLimit = sl;

            const riskPriceDist = Math.abs(entryPrice - sl);

            // Include Estimated Fees in RR
            const feePercent = entryConfig.ESTIMATED_FEE_PERCENT / 100;
            const entryFee = entryPrice * (feePercent / 2);
            const exitFeeSl = sl * (feePercent / 2);
            const netRisk = riskPriceDist + (entryFee + exitFeeSl);

            /* ================= DYNAMIC TP (ATR BASED) ================= */
            const minTpPerc = entryConfig.MIN_TP_PRICE_MOVEMENT_PERCENT ?? 0.5;
            const maxTpPerc = entryConfig.MAX_TP_PRICE_MOVEMENT_PERCENT ?? 3.0;

            // Scale multiplier: 50 score -> 1.0x ATR, 100 score -> 2.0x ATR
            const scoreFactor = Math.max(50, Math.min(100, finalScore));
            const multiplier = 1.0 + ((scoreFactor - 50) / 50) * 1.0;

            const rawTpPercent = atrPercent * multiplier;

            // Clamp tpPercent between config bounds
            const tpPercent = Math.max(minTpPerc, Math.min(maxTpPerc, rawTpPercent));

            marketDetectorLogger.info(`[DynamicTP] ${entryConfig.SYMBOL} Volatility Analysis: ATR%=${atrPercent.toFixed(4)}% (Timeframe: ${sourceCandles === structureCandles ? 'Structure' : 'Confirmation'}) | Score=${finalScore} | Multiplier=${multiplier.toFixed(2)}x | Raw TP%=${rawTpPercent.toFixed(4)}% | Config Limits=[${minTpPerc.toFixed(2)}%, ${maxTpPerc.toFixed(2)}%] | Final TP%=${tpPercent.toFixed(4)}%`);

            let baseTp: number;
            if (direction === "BUY") {
                baseTp = entryPrice * (1 + tpPercent / 100);
            } else {
                baseTp = entryPrice * (1 - tpPercent / 100);
            }

            const tpTriggerFactor = 1 - (direction === "BUY" ? entryConfig.TP_TRIGGER_BUFFER_PERCENT : -entryConfig.TP_TRIGGER_BUFFER_PERCENT) / 100;
            tp = baseTp * tpTriggerFactor;

            if (tp <= 0) {
                tp = parseFloat((1 / Math.pow(10, entryConfig.PRICE_DECIMAL_PLACES)).toFixed(entryConfig.PRICE_DECIMAL_PLACES));
            } else {
                tp = parseFloat(tp.toFixed(entryConfig.PRICE_DECIMAL_PLACES));
            }

            /* ================= METRICS & RR (PRELIMINARY CALCULATIONS) ================= */
            const tpLimitFactor = 1 - (direction === "BUY" ? entryConfig.TP_LIMIT_BUFFER_PERCENT : -entryConfig.TP_LIMIT_BUFFER_PERCENT) / 100;
            const rawTpLimit = baseTp * tpLimitFactor;
            if (rawTpLimit <= 0) {
                tpLimit = parseFloat((1 / Math.pow(10, entryConfig.PRICE_DECIMAL_PLACES)).toFixed(entryConfig.PRICE_DECIMAL_PLACES));
            } else {
                tpLimit = parseFloat(rawTpLimit.toFixed(entryConfig.PRICE_DECIMAL_PLACES));
            }

            let rewardPriceDist = Math.abs(tp - entryPrice);
            let exitFeeTp = tp * (feePercent / 2);
            let netReward = rewardPriceDist - (entryFee + exitFeeTp);

            rr = netRisk > 0 ? netReward / netRisk : 0;

            tpPerc = entryPrice > 0 ? (rewardPriceDist / entryPrice) * 100 : 0;
            slPerc = entryPrice > 0 ? (riskPriceDist / entryPrice) * 100 : 0;

            /* ================= FORCED TP ADJUSTMENT IF RR < MIN_RR (MIN 1.0) ================= */
            const targetMinRr = Math.max(1.0, entryConfig.MIN_RR ?? 1.0);
            if (rr < targetMinRr && !isSlAlreadyCrossed && !isExceededMovementLimit && netRisk > 0) {
                const initialRr = rr;
                const initialTp = tp;
                const requiredNetReward = targetMinRr * netRisk;

                let forcedTp: number;
                if (direction === "BUY") {
                    forcedTp = (requiredNetReward + entryPrice * (1 + feePercent / 2)) / (1 - feePercent / 2);
                } else {
                    forcedTp = (entryPrice * (1 - feePercent / 2) - requiredNetReward) / (1 + feePercent / 2);
                }

                tp = parseFloat(forcedTp.toFixed(entryConfig.PRICE_DECIMAL_PLACES));

                // Recalculate baseTp & tpLimit based on forced tp
                baseTp = tp / tpTriggerFactor;
                const rawTpLimitForced = baseTp * tpLimitFactor;
                if (rawTpLimitForced <= 0) {
                    tpLimit = parseFloat((1 / Math.pow(10, entryConfig.PRICE_DECIMAL_PLACES)).toFixed(entryConfig.PRICE_DECIMAL_PLACES));
                } else {
                    tpLimit = parseFloat(rawTpLimitForced.toFixed(entryConfig.PRICE_DECIMAL_PLACES));
                }

                // Recalculate metrics with forced TP
                rewardPriceDist = Math.abs(tp - entryPrice);
                exitFeeTp = tp * (feePercent / 2);
                const forcedNetReward = rewardPriceDist - (entryFee + exitFeeTp);
                rr = netRisk > 0 ? forcedNetReward / netRisk : 0;

                // Adjust by tick step if decimal rounding placed rr slightly below targetMinRr
                const tick = 1 / Math.pow(10, entryConfig.PRICE_DECIMAL_PLACES);
                let loopCount = 0;
                while (rr < targetMinRr && loopCount < 10) {
                    tp = parseFloat((tp + (direction === "BUY" ? tick : -tick)).toFixed(entryConfig.PRICE_DECIMAL_PLACES));
                    rewardPriceDist = Math.abs(tp - entryPrice);
                    exitFeeTp = tp * (feePercent / 2);
                    const currentNetReward = rewardPriceDist - (entryFee + exitFeeTp);
                    rr = netRisk > 0 ? currentNetReward / netRisk : 0;
                    loopCount++;
                }

                tpPerc = entryPrice > 0 ? (rewardPriceDist / entryPrice) * 100 : 0;

                marketDetectorLogger.info(
                    `[DynamicTP] ${entryConfig.SYMBOL}: Initial RR (${initialRr.toFixed(2)}) < target min RR (${targetMinRr.toFixed(2)}). Forced TP by adjusting TP: initial TP=${initialTp} -> adjusted TP=${tp}, updated RR=${rr.toFixed(2)}`
                );
            }

            /* ================= TESTING MODE TP/SL GUARANTEE ================= */
            if (entryConfig.IS_TESTING) {
                // Ensure SL is strictly valid for exchange order placement
                if (direction === "BUY" && (sl <= 0 || sl >= entryPrice)) {
                    sl = parseFloat((entryPrice * 0.99).toFixed(entryConfig.PRICE_DECIMAL_PLACES));
                    slLimit = sl;
                    isSlAlreadyCrossed = false;
                    marketDetectorLogger.info(`[TESTING] ${entryConfig.SYMBOL}: Adjusted BUY SL to valid price below entry: SL=${sl}`);
                } else if (direction === "SELL" && (sl <= 0 || sl <= entryPrice)) {
                    sl = parseFloat((entryPrice * 1.01).toFixed(entryConfig.PRICE_DECIMAL_PLACES));
                    slLimit = sl;
                    isSlAlreadyCrossed = false;
                    marketDetectorLogger.info(`[TESTING] ${entryConfig.SYMBOL}: Adjusted SELL SL to valid price above entry: SL=${sl}`);
                }

                // Ensure TP is strictly valid for exchange order placement
                if (direction === "BUY" && (tp <= 0 || tp <= entryPrice || tp <= sl)) {
                    tp = parseFloat((entryPrice * 1.02).toFixed(entryConfig.PRICE_DECIMAL_PLACES));
                    marketDetectorLogger.info(`[TESTING] ${entryConfig.SYMBOL}: Adjusted BUY TP to valid price above entry: TP=${tp}`);
                } else if (direction === "SELL" && (tp <= 0 || tp >= entryPrice || tp >= sl)) {
                    tp = parseFloat((entryPrice * 0.98).toFixed(entryConfig.PRICE_DECIMAL_PLACES));
                    marketDetectorLogger.info(`[TESTING] ${entryConfig.SYMBOL}: Adjusted SELL TP to valid price below entry: TP=${tp}`);
                }

                // Recalculate metrics for testing logs
                const finalRiskDist = Math.abs(entryPrice - sl);
                const finalRewardDist = Math.abs(tp - entryPrice);
                slPerc = entryPrice > 0 ? (finalRiskDist / entryPrice) * 100 : 0;
                tpPerc = entryPrice > 0 ? (finalRewardDist / entryPrice) * 100 : 0;
                rr = finalRiskDist > 0 ? finalRewardDist / finalRiskDist : 1.0;
            }

            const slRoe = (slPerc * leverage).toFixed(2);
            const tpRoe = (tpPerc * leverage).toFixed(2);

            marketDetectorLogger.info(
                `[SlTpLevels] ${entryConfig.SYMBOL} (${direction}) | Entry: ${entryPrice} | SL: ${sl} (-${slPerc.toFixed(2)}% price, -${slRoe}% ROE @ ${leverage}x) | TP: ${tp} (+${tpPerc.toFixed(2)}% price, +${tpRoe}% ROE @ ${leverage}x) | RR: ${rr.toFixed(2)} | Testing: ${entryConfig.IS_TESTING}`
            );
        }

        return {
            sl,
            tp,
            rr,
            tpPerc,
            slPerc,
            slLimit,
            tpLimit,
            isSlAlreadyCrossed,
            crossedReason,
            isExceededMovementLimit,
            structSlPerc,
            confSlPerc
        };
    }
}