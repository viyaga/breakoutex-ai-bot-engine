import { TradingV2 } from ".";
import { ITradeState, TradeState } from "../../models/tradeState.model";

import { TradingConfig } from "./config";
import { deltaExchange } from "./delta-exchange";
import { tradingCycleErrorLogger, tradesLogger, getContextualLogger } from "./logger";
import { Candle, OrderDetails, TargetCandle } from "./type";
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

            return {
                ...s,
                entryOrderId: null,
                stopLossOrderId: null,
                takeProfitOrderId: null,
                tradeOutcome: "none",
                cumulativeFees: s.cumulativeFees + entryCommission,
                allTimeFees: (s.allTimeFees || 0) + entryCommission,
            };
        }

        const tp = await deltaExchange.getOrderDetails(s.takeProfitOrderId);
        if (tp && tp.status === "CLOSED") {
            const incrementalPnl = Number(tp.meta_data?.pnl || 0);
            const incrementalFees = Number(tp.paid_commission || 0) + entryCommission;
            const netPnl = s.pnl + incrementalPnl;
            const fees = s.cumulativeFees + incrementalFees;
            const exitPrice = Number(tp.average_fill_price || tp.limit_price || 0);

            logger.info(`[PositionOutcome] TAKE PROFIT reached for ${s.symbol}. Incremental PnL: ${incrementalPnl}, Fees: ${incrementalFees}, Exit Price: ${exitPrice}`);

            return await this.handleWin(s, netPnl, fees, incrementalPnl, incrementalFees, exitPrice, logContext);
        }

        const sl = await deltaExchange.getOrderDetails(s.stopLossOrderId);
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

    static async placeCancelledBracketOrders(
        state: ITradeState,
        e: OrderDetails,
        sl: number,
        logContext?: any,
        forceReplace: boolean = false
    ): Promise<ITradeState> {
        if (!forceReplace) {
            const slOrder = await deltaExchange.getOrderDetails(
                state.stopLossOrderId!
            );

            if (slOrder?.status !== "CANCELLED") {
                throw new Error("SL update failed");
            }
        }

        const cancelRes = await deltaExchange.cancelStopOrders({
            product_id: TradingConfig.getConfig().PRODUCT_ID,
            cancel_limit_orders: true,
        });
        getContextualLogger(tradesLogger, logContext).debug("Cancelled existing stop orders during bracket replacement", { cancelRes });

        const entryPriceValue = Number(e.average_fill_price ?? e.meta_data?.entry_price ?? 0);

        if (!entryPriceValue) {
            throw new Error("Entry price not found");
        }

        const tp = state.tpPrice;
        if (!tp) {
            throw new Error("[placeCancelledBracketOrders] TP price not found in state");
        }

        const bracketRes =
            await deltaExchange.placeTPSLBracketOrder(tp, sl, e.side, logContext);

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

            // 🔍 Query TP and SL order details to check if either was manually cancelled
            const slOrder = s.stopLossOrderId ? await deltaExchange.getOrderDetails(s.stopLossOrderId) : null;
            const tpOrder = s.takeProfitOrderId ? await deltaExchange.getOrderDetails(s.takeProfitOrderId) : null;

            // 🔥 Recovery: If slPrice or tpPrice is missing in state, try to recover from active orders
            if (slOrder && !slPrice) {
                const stopPriceVal = slOrder.stop_price ? Number(slOrder.stop_price) : (slOrder.limit_price ? Number(slOrder.limit_price) : 0);
                if (stopPriceVal) {
                    slPrice = stopPriceVal;
                    logger.info(`[Recovery] Recovered missing slPrice for ${sym} from order details: ${slPrice}`);
                    await TradeState.findByIdAndUpdate(s.id || (s as any)._id, { $set: { slPrice } });
                    s.slPrice = slPrice;
                }
            }

            if (tpOrder && !tpPrice) {
                const limitPriceVal = tpOrder.limit_price ? Number(tpOrder.limit_price) : (tpOrder.stop_price ? Number(tpOrder.stop_price) : 0);
                if (limitPriceVal) {
                    tpPrice = limitPriceVal;
                    logger.info(`[Recovery] Recovered missing tpPrice for ${sym} from order details: ${tpPrice}`);
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

            const sl = mtf.sl;
            const tp = tpPrice || mtf.tp;

            const updateRes = await deltaExchange.updateStopLossOrder(
                s.stopLossOrderId,
                slPrice,
                TradingConfig.getConfig().PRODUCT_ID,
                sym,
                e.side,
                sl,
                logContext
            );

            let tpUpdatedValue = tpPrice || 0;
            let isTpAlreadyTriggered = false;
            if (s.takeProfitOrderId && tpPrice && tp) {
                const updateTpRes = await deltaExchange.updateTakeProfitOrder(
                    s.takeProfitOrderId,
                    tpPrice,
                    TradingConfig.getConfig().PRODUCT_ID,
                    sym,
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

            if (!updateRes.success && updateRes.isSlSame && tpUpdatedValue === tpPrice) return s;
            if (!updateRes.success && updateRes.isSlReversed) return s;

            if (!updateRes.success && !updateRes.isSlSame && !updateRes.isSlReversed)
                return this.placeCancelledBracketOrders(s, e, sl, logContext);

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

        const tpSlResult = await deltaExchange.placeTPSLBracketOrder(tp, sl, e.side, logContext);

        if (!tpSlResult.success || !tpSlResult.ids.tp || !tpSlResult.ids.sl) {
            throw new Error(`[Recovery] Failed to re-place TP/SL bracket orders during recovery. TP_ID=${tpSlResult.ids.tp}, SL_ID=${tpSlResult.ids.sl}`);
        }

        const updated = await TradeState.findOneAndUpdate(
            { tradingBotId: s.tradingBotId, userId: s.userId, symbol: s.symbol },
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
        const positions = await deltaExchange.getPositions(cfg.PRODUCT_ID);
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

            const tpPrice = s.tpPrice || mtf.tp;
            const slPrice = s.slPrice || mtf.sl;

            const metrics = this.calculateMetrics(entryPrice, tpPrice!, slPrice!, cfg.LEVERAGE);

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
                tpPrice,
                slPrice,
                ...metrics
            };

            // Optimization: Only update if anything meaningful changed
            const isUnchanged =
                s.entryPrice === entryPrice &&
                s.tradeAmountInUse === tradeAmountInUse &&
                s.finalScore === mtf.finalScore &&
                s.tpPrice === tpPrice &&
                s.slPrice === slPrice;

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