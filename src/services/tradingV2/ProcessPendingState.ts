import { TradingV2 } from ".";
import { ITradeState, TradeState } from "../../models/tradeState.model";

import { TradingConfig } from "./config";
import { ExchangeAdapterFactory } from "./adapters/exchange.factory";
import { tradingCycleErrorLogger, tradesLogger, getContextualLogger } from "./logger";
import { Candle, OrderDetails, OrderSide, TargetCandle } from "./type";
import { Utils } from "./utils";
import { TripleTFResult } from "./market-detector/multi-timeframe";

export class ProcessPendingState {

    static calculateMartingaleLots(netDebt: number, currentPrice: number, multiplier: number): number {
        const c = TradingConfig.getConfig();
        const targetAmount = Math.abs(netDebt) * multiplier; // Dynamic multiplier based on MTF score
        const marginRequiredPerLot = (currentPrice * c.LOT_SIZE) / c.LEVERAGE;
        return (c.INITIAL_BASE_QUANTITY ?? 0) + Math.ceil(
            targetAmount / marginRequiredPerLot
        );
    }

    static calculateMetrics(entryPrice: number, tpPrice: number, slPrice: number, leverage: number) {
        if (!entryPrice || !tpPrice || !slPrice) return {};

        const c = TradingConfig.getConfig();
        const tpDist = Math.abs(tpPrice - entryPrice);
        const rawSlDist = Math.abs(entryPrice - slPrice);

        // 🔥 Include SL buffer in risk for accurate metrics
        const slDist = rawSlDist + (slPrice * c.SL_LIMIT_BUFFER_PERCENT / 100);

        // 🔥 Include Estimated Fees in RR (Net RR)
        const feePercent = (c as any).ESTIMATED_FEE_PERCENT / 100 || 0.001;
        const entryFee = entryPrice * (feePercent / 2);
        const exitFeeTp = tpPrice * (feePercent / 2);
        const exitFeeSl = slPrice * (feePercent / 2);

        const netReward = tpDist - (entryFee + exitFeeTp);
        const netRisk = slDist + (entryFee + exitFeeSl);

        return {
            tpPercentage: (tpDist / entryPrice) * 100 * leverage,
            slPercentage: (slDist / entryPrice) * 100 * leverage,
            riskRewardRatio: netRisk > 0 ? netReward / netRisk : 0
        };
    }

    /* =========================================================================
       CANDLE ANALYSIS UTILITIES
     ========================================================================= */

    static resetState(s: ITradeState): ITradeState {
        const c = TradingConfig.getConfig();
        return {
            ...s,
            currentLevel: 1,
            tradeOutcome: "none",
            entryOrderId: null,
            stopLossOrderId: null,
            takeProfitOrderId: null,
            entryPrice: null,
            slPrice: null,
            tpPrice: null,
            quantity: c.INITIAL_BASE_QUANTITY ?? 0,
            pnl: 0,
            cumulativeFees: 0,
            allTimePnl: s.allTimePnl || 0,
            allTimeFees: s.allTimeFees || 0,
            side: null,
            leverage: null,
            tradeAmountInUse: null,
            pnlPercentage: null,
            riskRewardRatio: null,
            tpPercentage: null,
            slPercentage: null,
            exitPrice: null,
            finalScore: null,
            entryScore: null,
            confirmationProbability: null,
            structureProbability: null,
            tradingMode: null,
        };
    }

    static async handleWin(
        s: ITradeState,
        winPnl: number,
        tempFees: number,
        incrementalPnl: number,
        incrementalFees: number,
        exitPrice: number,
        logContext?: any
    ): Promise<ITradeState> {
        const logger = getContextualLogger(tradesLogger, logContext);
        logger.info(`[StateTransition] Outcome: WIN | Symbol: ${s.symbol} | Net PnL (Session): ${winPnl.toFixed(2)} | Total Fees (Session): ${tempFees.toFixed(2)}`);
        logger.info(`[StateTransition] WIN Details: Incremental PnL: ${incrementalPnl.toFixed(2)}, Incremental Fees: ${incrementalFees.toFixed(2)}`);

        const pnlPercentage = s.tradeAmountInUse ? (incrementalPnl / s.tradeAmountInUse) * 100 : 0;

        const updated = await TradeState.findByIdAndUpdate(s.id || (s as any)._id, {
            $set: {
                status: 'closed',
                tradeOutcome: "win",
                pnl: winPnl,
                cumulativeFees: tempFees,
                dailyPnl: (s.dailyPnl || 0) + incrementalPnl - incrementalFees,
                allTimePnl: (s.allTimePnl || 0) + incrementalPnl,
                allTimeFees: (s.allTimeFees || 0) + incrementalFees,
                lastTradeSettledAt: new Date(),
                exitPrice,
                pnlPercentage
            }
        }, { new: true });

        if (!updated) throw new Error("Failed to close trade state on win");
        return updated as ITradeState;
    }

    static async handleLoss(
        s: ITradeState,
        netDebt: number,
        pnl: number,
        fees: number,
        currentPrice: number,
        incrementalPnl: number,
        incrementalFees: number,
        multiplier: number,
        exitPrice: number,
        logContext?: any
    ): Promise<ITradeState> {
        const logger = getContextualLogger(tradesLogger, logContext);

        const c = TradingConfig.getConfig();

        const pnlPercentage = s.tradeAmountInUse ? (incrementalPnl / s.tradeAmountInUse) * 100 : 0;

        const nextLevel = s.currentLevel + 1;
        logger.info(`[StateTransition] Outcome: LOSS | Symbol: ${s.symbol} | Net Debt: ${netDebt.toFixed(2)} | Next Level: ${nextLevel}`);
        logger.info(`[StateTransition] LOSS Details: Incremental PnL: ${incrementalPnl.toFixed(2)}, Incremental Fees: ${incrementalFees.toFixed(2)}`);

        const updated = await TradeState.findByIdAndUpdate(s.id || (s as any)._id, {
            $set: {
                status: 'closed',
                currentLevel: nextLevel,
                tradeOutcome: "loss",
                pnl,
                cumulativeFees: fees,
                dailyPnl: (s.dailyPnl || 0) + incrementalPnl - incrementalFees,
                allTimePnl: (s.allTimePnl || 0) + incrementalPnl,
                allTimeFees: (s.allTimeFees || 0) + incrementalFees,
                lastTradeSettledAt: new Date(),
                exitPrice,
                pnlPercentage
            }
        }, { new: true });

        if (!updated) throw new Error("Failed to update trade state on loss");
        return updated as ITradeState;
    }

    static async markCancelled(s: ITradeState): Promise<ITradeState> {
        const updated = await TradeState.findByIdAndUpdate(s.id || (s as any)._id, {
            $set: { tradeOutcome: "cancelled" }
        }, { new: true });

        if (!updated) throw new Error("Failed to update trade state to cancelled");
        return updated as ITradeState;
    }

    /* =========================================================================
        PENDING ORDER HANDLING
    ========================================================================= */

    private static async handleCanceledEntryOrder(s: ITradeState): Promise<ITradeState> {
        return this.markCancelled(s);
    }

    /* =========================================================================
        CLOSED POSITION OUTCOME
    ========================================================================= */

    static async processClosedPosition(
        s: ITradeState,
        entryCommission: number,
        currentPrice: number,
        multiplier: number,
        logContext?: any
    ): Promise<ITradeState> {
        const logger = getContextualLogger(tradesLogger, logContext);

        if (!s.stopLossOrderId || !s.takeProfitOrderId) {
            logger.warn(`[PositionOutcome] Missing TP/SL order IDs for ${s.symbol} in state. Entry was CLOSED but bracket orders are unknown. Recovering status while PRESERVING trade metrics (Level, PnL, Fees).`);

            const updated = await TradeState.findByIdAndUpdate(
                s.id || (s as any)._id,
                {
                    $set: {
                        entryOrderId: null,
                        stopLossOrderId: null,
                        takeProfitOrderId: null,
                        tradeOutcome: "none",
                        cumulativeFees: s.cumulativeFees + entryCommission,
                        allTimeFees: (s.allTimeFees || 0) + entryCommission,
                    }
                },
                { new: true }
            );

            if (!updated) throw new Error("Failed to update trade state when bracket orders are missing");
            return updated as ITradeState;
        }

        const adapter = ExchangeAdapterFactory.getAdapter();
        const tp = await adapter.getOrderDetails(s.takeProfitOrderId);
        if (tp && tp.status === "CLOSED") {
            const incrementalPnl = Number(tp.meta_data?.pnl || 0);
            const incrementalFees = Number(tp.paid_commission || 0) + entryCommission;
            const netPnl = s.pnl + incrementalPnl;
            const fees = s.cumulativeFees + incrementalFees;
            const exitPrice = Number(tp.average_fill_price || tp.limit_price || 0);

            logger.info(`[PositionOutcome] TAKE PROFIT reached for ${s.symbol}. Incremental PnL: ${incrementalPnl}, Fees: ${incrementalFees}, Exit Price: ${exitPrice}`);

            return await this.handleWin(s, netPnl, fees, incrementalPnl, incrementalFees, exitPrice, logContext);
        }

        const sl = await adapter.getOrderDetails(s.stopLossOrderId);
        if (sl && sl.status === "CLOSED") {

            const incrementalPnl = Number(sl?.meta_data?.pnl || 0);
            const incrementalFees = Number(sl?.paid_commission || 0) + entryCommission;
            const netPnl = s.pnl + incrementalPnl;
            const fees = s.cumulativeFees + incrementalFees;
            const netDebt = netPnl - fees;
            const exitPrice = Number(sl.average_fill_price || sl.limit_price || 0);

            logger.info(`[PositionOutcome] STOP LOSS hit for ${s.symbol}. Incremental PnL: ${incrementalPnl}, Fees: ${incrementalFees}, Exit Price: ${exitPrice}, Net Debt: ${netDebt}`);

            return netDebt >= 0
                ? await this.handleWin(s, netPnl, fees, incrementalPnl, incrementalFees, exitPrice, logContext)
                : await this.handleLoss(s, netDebt, netPnl, fees, currentPrice, incrementalPnl, incrementalFees, multiplier, exitPrice, logContext);
        }

        if (tp?.status === "CANCELLED" && sl?.status === "CANCELLED") {
            const logger = getContextualLogger(tradesLogger, logContext);
            logger.warn("TP and SL orders were cancelled by user. Treating as LOSS.");

            const incrementalPnl = 0;
            const incrementalFees = entryCommission;
            const netPnl = s.pnl;
            const fees = s.cumulativeFees + incrementalFees;
            const netDebt = netPnl - fees;
            const exitPrice = currentPrice;
            return await this.handleLoss(s, netDebt, netPnl, fees, currentPrice, incrementalPnl, incrementalFees, multiplier, exitPrice, logContext);
        }

        throw new Error("[processClosedPosition] Neither TP nor SL orders are filled/closed.");
    }

    static async processTimeBasedClosedPosition(
        s: ITradeState,
        exitOrderRes: any,
        entryCommission: number,
        logContext?: any
    ): Promise<ITradeState> {
        const logger = getContextualLogger(tradesLogger, logContext);
        const adapter = ExchangeAdapterFactory.getAdapter();

        // 🔍 Fetch full exit order details if available
        const exitOrderId = exitOrderRes?.id || exitOrderRes?.result?.id;
        let exitOrderDetails: OrderDetails | null = null;
        if (exitOrderId) {
            try {
                exitOrderDetails = await adapter.getOrderDetails(String(exitOrderId));
            } catch (err) {
                logger.warn(`[TimeBasedExitOutcome] Failed to fetch exit order details for ${exitOrderId}`, { err });
            }
        }

        if (!exitOrderDetails && exitOrderRes?.result) {
            exitOrderDetails = exitOrderRes.result;
        }

        const exitPrice = Number(
            exitOrderDetails?.average_fill_price ||
            exitOrderDetails?.limit_price ||
            exitOrderRes?.result?.average_fill_price ||
            exitOrderRes?.result?.limit_price ||
            0
        );

        let incrementalPnl = Number(
            exitOrderDetails?.meta_data?.pnl ||
            exitOrderRes?.result?.meta_data?.pnl ||
            0
        );

        // 📐 If exchange metadata PnL is 0 or unpopulated, calculate PnL manually from entry vs exit price
        if (incrementalPnl === 0 && s.entryPrice && exitPrice > 0) {
            const qty = Number(s.quantity || 1);
            const lotSize = TradingConfig.getConfig().LOT_SIZE || 1;
            if (s.side === "buy") {
                incrementalPnl = (exitPrice - s.entryPrice) * qty * lotSize;
            } else {
                incrementalPnl = (s.entryPrice - exitPrice) * qty * lotSize;
            }
        }

        const exitCommission = Number(
            exitOrderDetails?.paid_commission ||
            exitOrderRes?.result?.paid_commission ||
            0
        );
        const incrementalFees = exitCommission + entryCommission;

        const netPnl = s.pnl + incrementalPnl;
        const fees = s.cumulativeFees + incrementalFees;
        const netDebt = netPnl - fees;

        logger.info(
            `[TimeBasedExitOutcome] ${s.symbol} market exit settled. Exit Price: ${exitPrice}, Incremental PnL: ${incrementalPnl.toFixed(2)}, Incremental Fees: ${incrementalFees.toFixed(2)}, Net Debt: ${netDebt.toFixed(2)}`
        );

        return netDebt >= 0
            ? await this.handleWin(s, netPnl, fees, incrementalPnl, incrementalFees, exitPrice, logContext)
            : await this.handleLoss(s, netDebt, netPnl, fees, exitPrice, incrementalPnl, incrementalFees, 1.0, exitPrice, logContext);
    }

    static async placeCancelledBracketOrders(
        state: ITradeState,
        e: OrderDetails,
        sl: number,
        logContext?: any,
        forceReplace: boolean = false
    ): Promise<ITradeState> {
        const adapter = ExchangeAdapterFactory.getAdapter();
        if (!forceReplace) {
            const slOrder = await adapter.getOrderDetails(
                state.stopLossOrderId!
            );

            if (slOrder?.status !== "CANCELLED") {
                throw new Error("SL update failed");
            }
        }

        const cancelRes = await adapter.cancelStopOrders({
            product_id: TradingConfig.getConfig().PRODUCT_ID,
            cancel_limit_orders: true,
        });
        getContextualLogger(tradesLogger, logContext).debug("Cancelled existing stop orders during bracket replacement", { cancelRes });

        const entryPriceValue = Number(e.average_fill_price ?? e.meta_data?.entry_price ?? 0);

        if (!entryPriceValue) {
            throw new Error("Entry price not found");
        }

        let tp = state.tpPrice;
        if (!tp) {
            const c = TradingConfig.getConfig();
            const side = e.side || state.side || "buy";
            const isBuy = side.toLowerCase() === "buy";

            const minTpPerc = c.MIN_TP_PRICE_MOVEMENT_PERCENT ?? 0.5;
            const maxTpPerc = c.MAX_TP_PRICE_MOVEMENT_PERCENT ?? 3.0;
            const tpPercent = (minTpPerc + maxTpPerc) / 2;

            let baseTp: number;
            if (isBuy) {
                baseTp = entryPriceValue * (1 + tpPercent / 100);
            } else {
                baseTp = entryPriceValue * (1 - tpPercent / 100);
            }

            const tpTriggerFactor = 1 - (isBuy ? c.TP_TRIGGER_BUFFER_PERCENT : -c.TP_TRIGGER_BUFFER_PERCENT) / 100;
            tp = baseTp * tpTriggerFactor;

            if (tp <= 0) {
                tp = parseFloat((1 / Math.pow(10, c.PRICE_DECIMAL_PLACES)).toFixed(c.PRICE_DECIMAL_PLACES));
            } else {
                tp = parseFloat(tp.toFixed(c.PRICE_DECIMAL_PLACES));
            }

            getContextualLogger(tradesLogger, logContext).warn(
                `[placeCancelledBracketOrders] TP price was missing in state. Recalculated dynamic fallback TP: ${tp} using entryPrice: ${entryPriceValue}, side: ${side}, dynamic tpPercent: ${tpPercent.toFixed(4)}%`
            );
        }

        const bracketRes =
            await ExchangeAdapterFactory.getAdapter().placeTPSLBracketOrder(tp, sl, e.side, logContext, entryPriceValue);

        if (!bracketRes.success) {
            if (bracketRes.isNoPosition) {
                getContextualLogger(tradesLogger, logContext).warn(`[Recovery] Bracket order placement failed because position is already closed. Skipping recovery.`);
                return state;
            }
            throw new Error("TP/SL placement failed");
        }

        const metrics = this.calculateMetrics(entryPriceValue, tp, sl, TradingConfig.getConfig().LEVERAGE);

        const updated = await TradeState.findOneAndUpdate(
            {
                tradingBotId: state.tradingBotId,
                userId: state.userId,
                symbol: state.symbol,
                status: "open",
            },
            {
                $set: {
                    slPrice: sl,
                    tpPrice: tp,
                    stopLossOrderId: bracketRes.ids.sl,
                    takeProfitOrderId: bracketRes.ids.tp,
                    ...metrics
                },
            },
            { new: true }
        );

        if (!updated) {
            throw new Error("Trade state not found");
        }

        return updated as ITradeState;
    }

    static async updateStatePrices(
        state: ITradeState,
        sl: number,
        tp: number
    ): Promise<ITradeState> {
        const metrics = state.entryPrice
            ? this.calculateMetrics(state.entryPrice, tp, sl, state.leverage || TradingConfig.getConfig().LEVERAGE)
            : {};

        const updated = await TradeState.findOneAndUpdate(
            {
                tradingBotId: state.tradingBotId,
                status: 'open',
            },
            { $set: { slPrice: sl, tpPrice: tp, ...metrics } },
            { new: true }
        );

        if (!updated) {
            throw new Error("Trade state not found");
        }

        return updated as ITradeState;
    }

    static async manageOpenPosition(
        sym: string,
        s: ITradeState,
        e: OrderDetails,
        mtf: TripleTFResult,
        logContext?: any
    ): Promise<ITradeState> {
        const logger = getContextualLogger(tradesLogger, logContext);
        try {
            let slPrice = s.slPrice;
            let tpPrice = s.tpPrice;

            logger.info(`[PriceTrailing] Managing open position for ${sym} | State SL: ${slPrice}, State TP: ${tpPrice} | Target SL: ${mtf.sl}, Target TP: ${mtf.tp}`);

            // 🔍 Query TP and SL order details to check if either was manually cancelled
            const adapter = ExchangeAdapterFactory.getAdapter();

            /* ================= CANDLE LIMIT / TIME-BASED EXIT CHECK ================= */
            const cfg = TradingConfig.getConfig();
            const isCandleLimitExitEnabled = cfg.IS_CANDLE_LIMIT_EXIT_ENABLED ?? true;

            if (isCandleLimitExitEnabled) {
                const timeframe = cfg.TIMEFRAME || "5m";
                const timeframeMinutesMap: Record<string, number> = {
                    "1m": 1,
                    "3m": 3,
                    "5m": 5,
                    "15m": 15,
                    "30m": 30,
                    "1h": 60,
                    "2h": 120,
                    "4h": 240,
                    "1d": 1440
                };
                const timeframeMinutes = timeframeMinutesMap[timeframe] || 5;

                const maxCandlesMap = cfg.MAX_HOLDING_CANDLES_MAP || {
                    "5m": 12,
                    "15m": 8,
                    "1h": 6,
                    "4h": 4
                };
                const maxHoldingCandles = maxCandlesMap[timeframe] || 8;

                // Entry timestamp: use trade creation/update time
                const entryTimeMs = s.createdAt ? new Date(s.createdAt).getTime() : Date.now();
                const elapsedMs = Math.max(0, Date.now() - entryTimeMs);
                const elapsedMinutes = elapsedMs / (60 * 1000);
                const elapsedCandles = Math.floor(elapsedMinutes / timeframeMinutes);

                logger.info(`[CandleLimitCheck] ${sym} | Timeframe: ${timeframe} (${timeframeMinutes}m) | Open for ${elapsedMinutes.toFixed(1)} mins (~${elapsedCandles} candles) | Max Limit: ${maxHoldingCandles} candles`);

                if (elapsedCandles >= maxHoldingCandles) {
                    logger.warn(`[TimeBasedExit] ${sym}: Position open for ${elapsedCandles} candles (${elapsedMinutes.toFixed(1)} mins), exceeding max limit of ${maxHoldingCandles} candles. Closing position at market due to stalled momentum.`);

                    // 1. Cancel active SL and TP bracket orders
                    try {
                        await adapter.cancelStopOrders({ product_id: cfg.PRODUCT_ID }, logContext);
                    } catch (err) {
                        logger.error(`[TimeBasedExit] Failed to cancel bracket orders for ${sym}`, { err });
                    }

                    // 2. Place market exit order (opposite side) to close position
                    const closeSide: OrderSide = e.side === "buy" ? "sell" : "buy";
                    let closeOrderRes: any = null;
                    try {
                        closeOrderRes = await adapter.placeEntryOrder(
                            sym,
                            closeSide,
                            Number(s.quantity || e.size)
                        );
                    } catch (err) {
                        logger.error(`[TimeBasedExit] Error placing market exit order for ${sym}`, { err });
                    }

                    // 3. Mark state as closed / settled using exact market exit order details
                    return await this.processTimeBasedClosedPosition(
                        s,
                        closeOrderRes,
                        Number(e.paid_commission || 0),
                        logContext
                    );
                }
            }

            const slOrder = s.stopLossOrderId ? await adapter.getOrderDetails(s.stopLossOrderId) : null;
            const tpOrder = s.takeProfitOrderId ? await adapter.getOrderDetails(s.takeProfitOrderId) : null;

            // 🔥 Recovery & Sync: Ensure DB state matches the actual active order prices on the exchange
            if (slOrder) {
                const stopPriceVal = slOrder.stop_price ? Number(slOrder.stop_price) : (slOrder.limit_price ? Number(slOrder.limit_price) : 0);
                if (stopPriceVal && slPrice !== stopPriceVal) {
                    logger.info(`[Recovery/Sync] Syncing slPrice for ${sym} to actual exchange order price: ${stopPriceVal} (was ${slPrice})`);
                    slPrice = stopPriceVal;
                    await TradeState.findByIdAndUpdate(s.id || (s as any)._id, { $set: { slPrice } });
                    s.slPrice = slPrice;
                }
            }

            if (tpOrder) {
                const limitPriceVal = tpOrder.limit_price ? Number(tpOrder.limit_price) : (tpOrder.stop_price ? Number(tpOrder.stop_price) : 0);
                if (limitPriceVal && tpPrice !== limitPriceVal) {
                    logger.info(`[Recovery/Sync] Syncing tpPrice for ${sym} to actual exchange order price: ${limitPriceVal} (was ${tpPrice})`);
                    tpPrice = limitPriceVal;
                    await TradeState.findByIdAndUpdate(s.id || (s as any)._id, { $set: { tpPrice } });
                    s.tpPrice = tpPrice;
                }
            }

            if (!s.stopLossOrderId || !slPrice) throw new Error("SL order or price missing in state");

            const isSlCancelled = !slOrder || slOrder.status === "CANCELLED";
            const isTpCancelled = s.takeProfitOrderId && (!tpOrder || tpOrder.status === "CANCELLED");

            if (isSlCancelled || isTpCancelled) {
                logger.warn(`[Recovery] Detected manually cancelled TP/SL order for ${sym} (SL Cancelled: ${isSlCancelled}, TP Cancelled: ${isTpCancelled}). Re-placing bracket orders...`);
                return this.placeCancelledBracketOrders(s, e, slPrice, logContext, true);
            }

            const isTrailingSlEnabled = TradingConfig.getConfig().IS_TRAILING_SL_ENABLED ?? true;
            const sl = isTrailingSlEnabled ? mtf.sl : slPrice;
            const tp = tpPrice || mtf.tp;

            let updateRes = { success: false, slPrice: slPrice, isSlSame: true, isSlReversed: false, isAlreadyTriggered: false };
            if (isTrailingSlEnabled) {
                const slUpdate = await adapter.updateStopLossOrder(
                    s.stopLossOrderId,
                    slPrice,
                    TradingConfig.getConfig().PRODUCT_ID,
                    sym,
                    e.side,
                    sl,
                    logContext
                );
                updateRes = {
                    success: slUpdate.success,
                    slPrice: slUpdate.slPrice,
                    isSlSame: slUpdate.isSlSame ?? false,
                    isSlReversed: slUpdate.isSlReversed ?? false,
                    isAlreadyTriggered: slUpdate.isAlreadyTriggered ?? false
                };
            } else {
                logger.info(`[PriceTrailing] Trailing stop loss is disabled for ${sym}. Skipping stop-loss update.`);
            }

            let tpUpdatedValue = tpPrice || 0;
            let isTpAlreadyTriggered = false;
            if (s.takeProfitOrderId && tpPrice && tp) {
                const updateTpRes = await adapter.updateTakeProfitOrder(
                    s.takeProfitOrderId,
                    tpPrice,
                    TradingConfig.getConfig().PRODUCT_ID,
                    sym,
                    e.side,
                    tp,
                    logContext
                );
                if (updateTpRes.success) {
                    tpUpdatedValue = updateTpRes.tpPrice;
                } else if (updateTpRes.isAlreadyTriggered) {
                    isTpAlreadyTriggered = true;
                }
            }

            if (!updateRes.success && updateRes.isAlreadyTriggered) {
                logger.warn(`Stop loss order for ${sym} is already triggered. Skipping trailing updates.`);
                return s;
            }

            if (isTpAlreadyTriggered) {
                logger.warn(`Take profit order for ${sym} is already triggered. Skipping trailing updates.`);
                return s;
            }

            if (!updateRes.success && updateRes.isSlSame && tpUpdatedValue === tpPrice) {
                logger.info(`[PriceTrailing] SL and TP unchanged for ${sym}. Skipping update.`);
                return s;
            }
            if (!updateRes.success && updateRes.isSlReversed) {
                logger.info(`[PriceTrailing] SL update skipped for ${sym} (new SL would move in reverse/wrong direction).`);
                return s;
            }

            if (!updateRes.success && !updateRes.isSlSame && !updateRes.isSlReversed) {
                logger.warn(`[PriceTrailing] SL update failed for ${sym} (not same/reversed). Re-placing bracket orders...`);
                return this.placeCancelledBracketOrders(s, e, sl, logContext);
            }

            const updated = await this.updateStatePrices(s, updateRes.slPrice, tpUpdatedValue || tpPrice || 0);

            if (!updated) throw new Error("Trade state not found");

            logger.info(`[PriceTrailing] Successfully updated SL/TP for ${sym}: SL=${updateRes.slPrice}, TP=${tpUpdatedValue}`);

            return updated as ITradeState;

        } catch (err) {
            logger.error("Error in manageOpenPosition", { error: err });
            throw err;
        }
    }


    static async recoverMissingBracketOrders(
        s: ITradeState,
        e: OrderDetails,
        mtf: TripleTFResult,
        logContext?: any
    ): Promise<ITradeState> {
        const logger = getContextualLogger(tradesLogger, logContext);
        logger.info(`[Recovery] Detected open position for ${s.symbol} but missing TP/SL IDs in state. Re-placing bracket orders...`);

        // Use existing prices from state if available, otherwise fallback to MTF
        const tp = s.tpPrice || mtf.tp;
        const sl = s.slPrice || mtf.sl;

        if (!tp || !sl) {
            throw new Error(`[Recovery] Invalid TP/SL during recovery: TP=${tp}, SL=${sl}`);
        }

        const entryPrice = Utils.resolveEntryPrice(e);
        const tpSlResult = await ExchangeAdapterFactory.getAdapter().placeTPSLBracketOrder(tp, sl, e.side, logContext, entryPrice);

        if (!tpSlResult.success || !tpSlResult.ids.tp || !tpSlResult.ids.sl) {
            throw new Error(`[Recovery] Failed to re-place TP/SL bracket orders during recovery. TP_ID=${tpSlResult.ids.tp}, SL_ID=${tpSlResult.ids.sl}`);
        }

        const updated = await TradeState.findOneAndUpdate(
            { tradingBotId: s.tradingBotId, userId: s.userId, symbol: s.symbol, status: "open" },
            {
                $set: {
                    stopLossOrderId: tpSlResult.ids.sl,
                    takeProfitOrderId: tpSlResult.ids.tp,
                    slPrice: sl,
                    tpPrice: tp
                }
            },
            { new: true }
        );

        if (!updated) throw new Error("[Recovery] Failed to update state after bracket recovery");

        logger.info(`[Recovery] Successfully re-placed TP/SL bracket orders: TP_ID=${tpSlResult.ids.tp}, SL_ID=${tpSlResult.ids.sl}`);

        return updated as ITradeState;
    }

    static async processStateOfPendingTrade(
        sym: string,
        state: ITradeState,
        order: OrderDetails,
        mtf: TripleTFResult,
        currentPrice: number,
        multiplier: number,
        logContext?: any
    ): Promise<ITradeState> {
        const logger = getContextualLogger(tradingCycleErrorLogger, logContext);
        try {

            switch (order.status.toUpperCase()) {
                case "CANCELLED":
                    return await this.handleCanceledEntryOrder(state);
                case "CLOSED":
                    return await this.handleClosedEntryOrder(sym, state, order, mtf, currentPrice, multiplier, logContext);
                default:
                    return state;
            }

        } catch (err) {
            logger.error("Error in processStateOfPendingTrade", { error: err });
            throw err;
        }
    }

    static async handleClosedEntryOrder(
        sym: string,
        s: ITradeState,
        e: OrderDetails,
        mtf: TripleTFResult,
        currentPrice: number,
        multiplier: number,
        logContext?: any
    ): Promise<ITradeState> {
        const cfg = TradingConfig.getConfig();
        const positions = await ExchangeAdapterFactory.getAdapter().getPositions(cfg.PRODUCT_ID);
        const hasOpenPosition = Array.isArray(positions)
            ? positions.some(p => Number(p.size) !== 0)
            : positions && Number(positions.size) !== 0;

        const cronLogger = getContextualLogger(tradesLogger, logContext);
        cronLogger.info(`[PendingState] Checking for open positions for ${sym}. hasOpenPosition: ${hasOpenPosition}`);
        if (!hasOpenPosition) {
            cronLogger.debug(`[PendingState] No open positions found for ${sym}. Raw positions data: ${JSON.stringify(positions)}`);
        }

        if (hasOpenPosition) {
            const entryPrice = Number(e.average_fill_price || e.limit_price || 0);
            const tradeAmountInUse = (Number(s.quantity || 0) * cfg.LOT_SIZE * entryPrice) / cfg.LEVERAGE;

            const tpPrice = s.tpPrice || null;
            const slPrice = s.slPrice || null;

            const metrics = this.calculateMetrics(entryPrice, s.tpPrice || mtf.tp, s.slPrice || mtf.sl, cfg.LEVERAGE);

            const updateData: any = {
                side: e.side,
                leverage: cfg.LEVERAGE,
                entryPrice,
                tradeAmountInUse,
                finalScore: mtf.finalScore,
                entryScore: mtf.entryScore,
                confirmationProbability: mtf.confirmationProbability,
                structureProbability: mtf.structureProbability,
                tradingMode: cfg.TRADING_MODE,
                ...metrics
            };

            if (tpPrice !== null) updateData.tpPrice = tpPrice;
            if (slPrice !== null) updateData.slPrice = slPrice;

            // Optimization: Only update if anything meaningful changed
            const isUnchanged =
                s.entryPrice === entryPrice &&
                s.tradeAmountInUse === tradeAmountInUse &&
                s.finalScore === mtf.finalScore &&
                s.tpPrice === (s.tpPrice || mtf.tp) &&
                s.slPrice === (s.slPrice || mtf.sl);

            if (isUnchanged && (s.stopLossOrderId && s.takeProfitOrderId)) {
                cronLogger.info(`[PendingState] Core state unchanged for ${sym}, proceeding to manage open position (trailing).`);
                // If core data is unchanged, still attempt price trailing
                return this.manageOpenPosition(sym, s, e, mtf, logContext);
            }

            // Safety Check: If position is open but TP/SL IDs are missing, re-place them
            if (!s.stopLossOrderId || !s.takeProfitOrderId) {
                const recovered = await this.recoverMissingBracketOrders(s, e, mtf, logContext);
                await TradeState.findByIdAndUpdate(s.id || (s as any)._id, { $set: updateData });
                return { ...recovered, ...updateData };
            }

            // Normal update
            const updated = await TradeState.findByIdAndUpdate(s.id || (s as any)._id, { $set: updateData }, { new: true });
            const finalState = (updated as ITradeState) || s;

            // Chain to trailing logic
            return this.manageOpenPosition(sym, finalState, e, mtf, logContext);
        }

        return this.processClosedPosition(s, Number(e.paid_commission || 0), currentPrice, multiplier, logContext);
    }
}