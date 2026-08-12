import { ActiveSubscribedBot, CancelAllOrdersFilter, ConfigType, OrderDetails, OrderSide, TickerData } from "../type";
import { IExchangeAdapter } from "./IExchangeAdapter";
import { tradingCronLogger } from "../logger";
import { decrypt } from "../../../utils/crypto";
import { TradingConfig } from "../config";

/**
 * ZerodhaAdapter — Implements IExchangeAdapter for Zerodha Kite.
 *
 * Authentication: OAuth WebView flow (handled by the mobile app + backend).
 *   - accessToken is stored encrypted in the Exchanges collection.
 *   - This adapter reads the decrypted accessToken per-bot from ConfigType.
 *
 * Note: Zerodha is an equity/F&O broker. Leverage is not applicable for equity.
 * The adapter returns sensible no-op responses for leverage methods.
 *
 * TODO: Full Kite Connect API integration after backend endpoints are live.
 */
export class ZerodhaAdapter implements IExchangeAdapter {
    readonly exchangeName = "zerodha";

    mapSymbol(symbol: string): string {
        // Zerodha uses NSE:SYMBOL or NFO:SYMBOL format
        // e.g. XRPUSDT -> not applicable for Zerodha; symbol mapping will be configured per-bot
        return symbol;
    }

    prepareConfig(
        bot: ActiveSubscribedBot,
        _defaultConfig: Partial<ConfigType>,
        _productDataMap: Map<string, any>
    ): ConfigType {
        const adapterSpecs: Partial<ConfigType> = {
            id: bot.id,
            EXCHANGE: this.exchangeName,
            API_KEY: decrypt(bot.API_KEY),
            SECRET_KEY: decrypt(bot.SECRET_KEY),
            BASE_URL: "https://api.kite.trade",
            LOT_SIZE: 1,
            PRODUCT_ID: Number(bot.PRODUCT_ID) || 0,
            SYMBOL: bot.SYMBOL,
            PRICE_DECIMAL_PLACES: 2,
        };

        tradingCronLogger.info(`[ZerodhaAdapter] ✓ Configured bot ${bot.id} [${bot.SYMBOL}]`);
        return TradingConfig.buildConfig(bot, adapterSpecs);
    }

    async getCandlestickData(symbol: string, resolution: string, start: number, end: number): Promise<any> {
        // TODO: Call Kite Historical Data API
        // GET /instruments/historical/{instrument_token}/{interval}?from=...&to=...
        tradingCronLogger.warn(`[ZerodhaAdapter] getCandlestickData not yet implemented for ${symbol}`);
        return [];
    }

    async getTickerData(symbol: string): Promise<TickerData | null> {
        // TODO: GET /quote?i=NSE:{symbol}
        tradingCronLogger.warn(`[ZerodhaAdapter] getTickerData not yet implemented for ${symbol}`);
        return null;
    }

    async getOrderDetails(id: string): Promise<OrderDetails | null> {
        // TODO: GET /orders/{order_id}
        tradingCronLogger.warn(`[ZerodhaAdapter] getOrderDetails not yet implemented for ${id}`);
        return null;
    }

    async placeEntryOrder(symbol: string, side: OrderSide, qty: number, cid?: string): Promise<any> {
        // TODO: POST /orders/{variety}
        tradingCronLogger.warn(`[ZerodhaAdapter] placeEntryOrder not yet implemented`);
        return { success: false, error: "ZerodhaAdapter: placeEntryOrder not implemented" };
    }

    async placeTPSLBracketOrder(
        tp: number,
        sl: number,
        side: OrderSide,
        logContext?: any,
        entryPrice?: number
    ): Promise<{ success: boolean; ids: { tp: string; sl: string }; isNoPosition?: boolean }> {
        // TODO: Place bracket / GTT orders on Kite
        tradingCronLogger.warn(`[ZerodhaAdapter] placeTPSLBracketOrder not yet implemented`);
        return { success: false, ids: { tp: "", sl: "" } };
    }

    async updateStopLossOrder(
        id: number | string,
        slPrice: number,
        productId: number | string,
        productSymbol: string,
        orderSide: OrderSide,
        sl: number,
        logContext?: any
    ): Promise<{ success: boolean; slPrice: number; isSlSame?: boolean; isSlReversed?: boolean; isAlreadyTriggered?: boolean }> {
        tradingCronLogger.warn(`[ZerodhaAdapter] updateStopLossOrder not yet implemented`);
        return { success: false, slPrice };
    }

    async updateTakeProfitOrder(
        id: number | string,
        tpPrice: number,
        productId: number | string,
        productSymbol: string,
        orderSide: OrderSide,
        tp: number,
        logContext?: any
    ): Promise<{ success: boolean; tpPrice: number; isTpSame?: boolean; isAlreadyTriggered?: boolean }> {
        tradingCronLogger.warn(`[ZerodhaAdapter] updateTakeProfitOrder not yet implemented`);
        return { success: false, tpPrice };
    }

    async cancelStopOrders(filter: CancelAllOrdersFilter, logContext?: any): Promise<{ success: boolean }> {
        tradingCronLogger.warn(`[ZerodhaAdapter] cancelStopOrders not yet implemented`);
        return { success: false };
    }

    async getPositions(productId?: number | string): Promise<any> {
        // TODO: GET /portfolio/positions
        tradingCronLogger.warn(`[ZerodhaAdapter] getPositions not yet implemented`);
        return [];
    }

    /** Leverage is not applicable for Zerodha equity — return 1x */
    async getOrderLeverage(_productId: number | string): Promise<any> {
        return { leverage: 1 };
    }

    /** Leverage is not applicable for Zerodha equity — no-op */
    async changeOrderLeverage(_productId: number | string, _leverage: number): Promise<any> {
        return { success: true };
    }
}
